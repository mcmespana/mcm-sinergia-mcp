/**
 * Lectura y validación de la configuración desde variables de entorno.
 *
 * Todo se lee de forma perezosa (dentro de las funciones, nunca en el ámbito
 * del módulo) para que el build de Next no falle cuando las variables aún no
 * están inyectadas.
 */

import { ConfigError } from './sinergia/errors'

export type GrantType = 'password' | 'client_credentials'

export interface SinergiaConfig {
  /** URL base de la instancia, sin barra final y sin /Api */
  baseUrl: string
  clientId: string
  clientSecret: string
  username?: string
  password?: string
  grantType: GrantType
}

/** Tope duro de registros por página para no reventar el contexto del modelo. */
export const MAX_PAGE_SIZE = 50

/** Página por defecto cuando el cliente no pide un tamaño concreto. */
export const DEFAULT_PAGE_SIZE = 20

/** Timeout de cada llamada HTTP a SinergiaCRM. */
export const REQUEST_TIMEOUT_MS = 30_000

/** Longitud máxima de un valor de texto antes de truncarlo en la respuesta. */
export const MAX_FIELD_CHARS = 800

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function requireEnv(name: string): string {
  const value = readEnv(name)
  if (!value) {
    throw new ConfigError(`Falta la variable de entorno ${name}`)
  }
  return value
}

export function getSinergiaConfig(): SinergiaConfig {
  const baseUrl = requireEnv('SINERGIA_URL').replace(/\/+$/, '')

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError('SINERGIA_URL debe empezar por http:// o https://')
  }
  if (/\/Api(\/|$)/i.test(baseUrl)) {
    throw new ConfigError(
      'SINERGIA_URL debe ser solo la URL base de la instancia, sin /Api (las rutas /Api/V8/... se añaden solas)',
    )
  }
  if (/\/legacy(\/|$)/i.test(baseUrl)) {
    throw new ConfigError(
      'SINERGIA_URL no debe incluir /legacy: SinergiaCRM va sobre SuiteCRM 7.x y la API está en /Api/V8/...',
    )
  }

  const username = readEnv('SINERGIA_USERNAME')
  const password = readEnv('SINERGIA_PASSWORD')

  if ((username && !password) || (!username && password)) {
    throw new ConfigError(
      'SINERGIA_USERNAME y SINERGIA_PASSWORD deben definirse los dos juntos (o ninguno, para usar client_credentials)',
    )
  }

  return {
    baseUrl,
    clientId: requireEnv('SINERGIA_CLIENT_ID'),
    clientSecret: requireEnv('SINERGIA_CLIENT_SECRET'),
    username,
    password,
    grantType: username && password ? 'password' : 'client_credentials',
  }
}

/** Secreto esperado en el header Authorization de las peticiones MCP entrantes. */
export function getMcpAuthSecret(): string | undefined {
  return readEnv('MCP_AUTH_SECRET')
}

/**
 * Flag de escritura. Por defecto false: las tools de escritura ni siquiera se
 * registran en el servidor MCP.
 */
export function writesAllowed(): boolean {
  const raw = readEnv('ALLOW_WRITES')?.toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}
