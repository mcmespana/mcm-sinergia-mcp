/**
 * Tools MCP de consulta directa (solo lectura) a la base de datos de
 * SinergiaCRM. Solo se registran si están las variables CRM_BBDD_*.
 *
 * Sirven para explorar el modelo de datos y probar las queries que luego usan
 * otras herramientas (área privada, Comunica Tools…). La escritura sigue
 * siendo cosa de la API V8.
 */

import { z } from 'zod'
import { dbConfigured } from '../config'
import { DEFAULT_MAX_ROWS, MAX_ROWS, describeSchema, readFullColumn, runReadQuery } from '../db/client'
import { chunkInputShape } from '../field-chunk'
import { guarded, type ToolServer } from './tools'

const queryInput = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      'Una única sentencia de lectura en SQL de MySQL/MariaDB (SELECT, WITH, SHOW, DESCRIBE o EXPLAIN). Ejemplo: "SELECT c.id, c.first_name, c.last_name, cc.stic_identification_number_c FROM contacts c LEFT JOIN contacts_cstm cc ON cc.id_c = c.id WHERE c.deleted = 0 ORDER BY c.date_entered DESC LIMIT 20".',
    ),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROWS)
    .optional()
    .describe(`Filas máximas a devolver (${DEFAULT_MAX_ROWS} por defecto, tope ${MAX_ROWS}). Pon LIMIT en la propia consulta igualmente.`),
})

const schemaInput = z.object({
  table: z
    .string()
    .optional()
    .describe('Tabla a describir (columnas, índices y, si existe, su tabla _cstm). Sin ella se listan las tablas.'),
  name_contains: z
    .string()
    .optional()
    .describe('Solo al listar tablas: filtra por nombre, p.ej. "stic_" o "contacts".'),
})

const readFieldInput = z.object({
  table: z.string().describe('Tabla, p.ej. "emails_text" (el cuerpo de los emails está ahí, con email_id como clave) o "contacts".'),
  id: z.string().describe('Valor de la clave de la fila.'),
  column: z
    .string()
    .describe('Columna a leer entera, p.ej. "description_html". Si es un campo custom (_c) se busca sola en <tabla>_cstm.'),
  id_column: z
    .string()
    .optional()
    .describe('Columna clave si no es "id", p.ej. "email_id" en emails_text.'),
  ...chunkInputShape,
})

export function registerSqlTools(server: ToolServer): void {
  if (!dbConfigured()) {
    return
  }

  server.registerTool(
    'sql_schema',
    {
      title: 'Esquema de la BBDD',
      description:
        'Explora el esquema de la base de datos del CRM. Sin "table", lista las tablas con su número aproximado de filas (filtra con name_contains). Con "table", devuelve sus columnas e índices y las columnas custom de <tabla>_cstm. Úsalo antes de escribir una consulta con sql_query.',
      inputSchema: schemaInput,
    },
    guarded(async ({ table, name_contains }: z.infer<typeof schemaInput>) =>
      describeSchema({ table, nameContains: name_contains }),
    ),
  )

  server.registerTool(
    'sql_read_field',
    {
      title: 'Leer una columna completa (SQL)',
      description:
        'Lee UNA columna de UNA fila entera, sin el recorte a 800 caracteres de sql_query. Pensado para textos largos como el HTML de un email (tabla emails_text, id_column "email_id", columna "description_html"). Si no cabe en un trozo, la respuesta trae "siguiente_offset": vuelve a llamar con ese offset hasta que no haya más. Con format="text" se convierte el HTML a texto plano.',
      inputSchema: readFieldInput,
    },
    guarded(async (args: z.infer<typeof readFieldInput>) =>
      readFullColumn({
        table: args.table,
        id: args.id,
        column: args.column,
        idColumn: args.id_column,
        offset: args.offset,
        maxChars: args.max_chars,
        format: args.format,
      }),
    ),
  )

  server.registerTool(
    'sql_query',
    {
      title: 'Consulta SQL (solo lectura)',
      description: [
        'Ejecuta una consulta SQL de solo lectura directamente contra la base de datos MySQL/MariaDB de SinergiaCRM (SuiteCRM 7). Útil para cruces, agregados y probar queries que la API no permite. Para escribir usa las tools de la API.',
        'Convenciones del esquema SuiteCRM:',
        '- Las tablas van en minúscula (Contacts → contacts, stic_Payments → stic_payments).',
        '- Los campos custom (_c) están en <tabla>_cstm, unida por <tabla>_cstm.id_c = <tabla>.id.',
        '- Filtra SIEMPRE deleted = 0, también en las tablas de relación.',
        '- Las relaciones N:M están en tablas intermedias (p.ej. stic_registrations_contacts_c, con columnas *_ida / *_idb).',
        '- Las fechas se guardan en UTC.',
        '- Los desplegables guardan la clave, no la etiqueta.',
        'Cada llamada corre en una transacción READ ONLY con un tiempo máximo de 25 s.\nLos textos de más de 800 caracteres se recortan: para leer uno entero usa sql_read_field.',
      ].join('\n'),
      inputSchema: queryInput,
    },
    guarded(async ({ sql, max_rows }: z.infer<typeof queryInput>) => runReadQuery(sql, max_rows)),
  )
}
