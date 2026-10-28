/**
 * Acceso de solo lectura a la base de datos MySQL/MariaDB de SinergiaCRM.
 *
 * La escritura sigue yendo SIEMPRE por la API V8 (lib/sinergia). Aquí solo se
 * consulta, con tres barreras superpuestas:
 *
 *  1. El usuario de BBDD es de solo lectura (lo pone el proveedor).
 *  2. Solo se aceptan sentencias de consulta (SELECT, WITH, SHOW, DESCRIBE,
 *     EXPLAIN) y una única sentencia por llamada.
 *  3. Cada consulta corre dentro de una transacción READ ONLY que se deshace
 *     al acabar.
 *
 * Una conexión por llamada: en Vercel las instancias van y vienen y un pool
 * dejaría conexiones colgadas contra el servidor.
 */

import mysql from 'mysql2'
import { MAX_FIELD_CHARS, getDbConfig } from '../config'
import { chunkField, type FieldChunk, type FieldFormat } from '../field-chunk'
import { SinergiaError, SinergiaInputError } from '../sinergia/errors'

/** Error al conectar o al ejecutar SQL contra la BBDD. */
export class DbError extends SinergiaError {}

/** Filas devueltas por defecto y tope duro, para no reventar el contexto del modelo. */
export const DEFAULT_MAX_ROWS = 100
export const MAX_ROWS = 500

/** Tiempo máximo de una consulta (el endpoint MCP tiene maxDuration = 60 s). */
export const QUERY_TIMEOUT_MS = 25_000

const CONNECT_TIMEOUT_MS = 10_000

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

const READ_KEYWORDS = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain'])

/** Quita comentarios para poder inspeccionar la sentencia (no se usa para ejecutar). */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--\s|#)[^\n]*/g, ' ')
}

/** Quita literales de texto e identificadores entre comillas para buscar palabras clave sin falsos positivos. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, "''")
}

/** Valida que sea una única sentencia de lectura y la devuelve sin el ';' final. */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) {
    throw new SinergiaInputError('La consulta está vacía.')
  }

  const bare = stripLiterals(stripComments(trimmed))
  if (bare.includes(';')) {
    throw new SinergiaInputError('Solo se admite una sentencia por llamada (quita los ";" intermedios).')
  }

  const first = bare.trim().replace(/^\(+/, '').split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!READ_KEYWORDS.has(first)) {
    throw new SinergiaInputError(
      `Solo se admiten consultas de lectura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN); "${first.toUpperCase()}" no está permitido. Para escribir usa las tools de la API (create_entry, update_entry…).`,
    )
  }

  if (/\binto\s+(outfile|dumpfile)\b|\bload_file\s*\(|\bfor\s+update\b|\block\s+in\s+share\s+mode\b/i.test(bare)) {
    throw new SinergiaInputError('La consulta usa una cláusula no permitida (INTO OUTFILE, LOAD_FILE, FOR UPDATE…).')
  }

  return trimmed
}

function compactValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.length <= 64 ? `0x${value.toString('hex')}` : `[binario, ${value.length} bytes]`
  }
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}… [truncado, ${value.length} caracteres: léelo entero con sql_read_field]`
  }
  return value
}

function connect(): mysql.Connection {
  const config = getDbConfig()
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    charset: 'utf8mb4',
    // Fechas tal cual vienen de la BBDD (SuiteCRM las guarda en UTC) y enteros
    // grandes como texto, para no perder precisión ni desplazar horas.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  })
}

function run<T>(conn: mysql.Connection, sql: string, values?: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    conn.query({ sql, values, timeout: QUERY_TIMEOUT_MS }, (error, rows) => {
      if (error) reject(error)
      else resolve(rows as T)
    })
  })
}

function describeDbError(error: unknown): DbError {
  if (error instanceof SinergiaError) return error
  const e = error as { code?: string; sqlMessage?: string; message?: string }
  const code = e.code ?? ''
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
    return new DbError(
      `No se puede conectar con la base de datos (${code}). Lo más probable es que el servidor no acepte conexiones desde esta IP.`,
    )
  }
  if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return new DbError(
      `La consulta ha superado ${QUERY_TIMEOUT_MS / 1000} s. Acota con WHERE/LIMIT o usa índices (id, deleted, date_entered…).`,
    )
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
    return new DbError(`Acceso denegado a la base de datos: ${e.sqlMessage ?? e.message}`)
  }
  return new DbError(`Error de SQL${code ? ` (${code})` : ''}: ${e.sqlMessage ?? e.message ?? String(error)}`)
}

/** Ejecuta fn con una conexión abierta en la base de datos del CRM. */
async function withConnection<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = connect()
  try {
    if (!getDbConfig().database) {
      // Sin CRM_BBDD_NAME: si el usuario solo ve una base de datos (lo normal), se usa esa.
      const dbs = (await run<Array<Record<string, string>>>(conn, 'SHOW DATABASES'))
        .map((row) => Object.values(row)[0])
        .filter((name) => !SYSTEM_SCHEMAS.has(name.toLowerCase()))
      if (dbs.length !== 1) {
        throw new DbError(
          `No se ha definido CRM_BBDD_NAME y el usuario ve ${dbs.length} bases de datos (${dbs.join(', ')}). Define CRM_BBDD_NAME con la del CRM.`,
        )
      }
      await run(conn, `USE ${mysql.escapeId(dbs[0])}`)
    }
    return await fn(conn)
  } catch (error) {
    throw describeDbError(error)
  } finally {
    conn.destroy()
  }
}

export interface QueryResult {
  base_de_datos: string
  columnas: string[]
  filas: Array<Record<string, unknown>>
  total_filas_devueltas: number
  truncado: boolean
  aviso?: string
  ms: number
}

/** Ejecuta una consulta de lectura y devuelve como mucho maxRows filas. */
export async function runReadQuery(sql: string, maxRows = DEFAULT_MAX_ROWS): Promise<QueryResult> {
  const statement = assertReadOnly(sql)
  const limit = Math.min(Math.max(1, Math.trunc(maxRows)), MAX_ROWS)

  return withConnection(async (conn) => {
    const started = Date.now()
    await run(conn, 'START TRANSACTION READ ONLY')
    try {
      const raw = await run<unknown>(conn, statement)
      const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
      const shown = rows.slice(0, limit).map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, compactValue(value)])),
      )
      const [{ db }] = await run<Array<{ db: string }>>(conn, 'SELECT DATABASE() AS db')
      return {
        base_de_datos: db,
        columnas: shown[0] ? Object.keys(shown[0]) : [],
        filas: shown,
        total_filas_devueltas: rows.length,
        truncado: rows.length > limit,
        ...(rows.length > limit
          ? { aviso: `La consulta devolvió ${rows.length} filas; se muestran ${limit}. Añade LIMIT o filtra más.` }
          : {}),
        ms: Date.now() - started,
      }
    } finally {
      await run(conn, 'ROLLBACK').catch(() => undefined)
    }
  })
}

const IDENTIFIER = /^[A-Za-z0-9_$]{1,64}$/

/**
 * Sin tabla: lista las tablas (filtrables por nombre) con su número aproximado
 * de filas. Con tabla: sus columnas e índices, y si existe la tabla _cstm con
 * los campos custom, también sus columnas.
 */
export async function describeSchema(options: { table?: string; nameContains?: string }) {
  if (options.table && !IDENTIFIER.test(options.table)) {
    throw new SinergiaInputError(`Nombre de tabla no válido: "${options.table}"`)
  }

  return withConnection(async (conn) => {
    if (!options.table) {
      const like = options.nameContains ? `%${options.nameContains}%` : '%'
      const tables = await run<Array<Record<string, unknown>>>(
        conn,
        `SELECT TABLE_NAME AS tabla, TABLE_ROWS AS filas_aprox
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?
          ORDER BY TABLE_NAME`,
        [like],
      )
      return { total: tables.length, tablas: tables }
    }

    const columns = (table: string) =>
      run<Array<Record<string, unknown>>>(
        conn,
        `SELECT COLUMN_NAME AS columna, COLUMN_TYPE AS tipo, IS_NULLABLE AS nulo,
                COLUMN_KEY AS clave, COLUMN_DEFAULT AS por_defecto
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [table],
      )

    const main = await columns(options.table)
    if (main.length === 0) {
      throw new SinergiaInputError(
        `La tabla "${options.table}" no existe. Llama a sql_schema sin "table" (y con name_contains) para ver las tablas.`,
      )
    }
    const indexes = await run<Array<Record<string, unknown>>>(
      conn,
      `SELECT INDEX_NAME AS indice, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas,
              MIN(NON_UNIQUE) = 0 AS unico
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        GROUP BY INDEX_NAME`,
      [options.table],
    )
    const custom = options.table.endsWith('_cstm') ? [] : await columns(`${options.table}_cstm`)

    return {
      tabla: options.table,
      columnas: main,
      indices: indexes,
      ...(custom.length > 0
        ? {
            tabla_cstm: `${options.table}_cstm`,
            columnas_cstm: custom,
            nota: `Los campos custom están en ${options.table}_cstm: únela con ${options.table}_cstm.id_c = ${options.table}.id.`,
          }
        : {}),
    }
  })
}

/**
 * Lee una columna de una fila, entera y troceada por offset. Si la columna no
 * está en la tabla pero sí en <tabla>_cstm (campos custom), se lee de ahí.
 */
export async function readFullColumn(options: {
  table: string
  id: string
  column: string
  idColumn?: string
  offset?: number
  maxChars?: number
  format?: FieldFormat
}): Promise<FieldChunk & { tabla: string; id: string }> {
  for (const name of [options.table, options.column, options.idColumn ?? 'id']) {
    if (!IDENTIFIER.test(name)) {
      throw new SinergiaInputError(`Identificador no válido: "${name}"`)
    }
  }

  return withConnection(async (conn) => {
    const hasColumn = async (table: string, column: string) =>
      (
        await run<unknown[]>(
          conn,
          `SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          [table, column],
        )
      ).length > 0

    let table = options.table
    let idColumn = options.idColumn ?? 'id'
    if (!(await hasColumn(table, options.column))) {
      const cstm = `${options.table}_cstm`
      if (!options.idColumn && (await hasColumn(cstm, options.column))) {
        table = cstm
        idColumn = 'id_c'
      } else {
        throw new SinergiaInputError(
          `La columna "${options.column}" no existe en ${options.table}${options.idColumn ? '' : ` ni en ${cstm}`}. Compruébalo con sql_schema.`,
        )
      }
    }

    const rows = await run<Array<Record<string, unknown>>>(
      conn,
      `SELECT ${mysql.escapeId(options.column)} AS valor FROM ${mysql.escapeId(table)}
        WHERE ${mysql.escapeId(idColumn)} = ? LIMIT 2`,
      [options.id],
    )
    if (rows.length === 0) {
      throw new SinergiaInputError(`No hay ninguna fila en ${table} con ${idColumn} = "${options.id}".`)
    }

    return { tabla: table, id: options.id, ...chunkField(options.column, rows[0].valor, options) }
  })
}
