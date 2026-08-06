/**
 * Emisión y verificación de los artefactos OAuth (client_id, códigos de
 * autorización, access tokens y refresh tokens).
 *
 * Todo es **sin estado**: cada artefacto es un JSON firmado con HMAC-SHA256
 * usando una clave derivada de MCP_AUTH_SECRET. Así el servidor funciona en
 * Vercel sin base de datos ni almacén de sesiones.
 *
 * Consecuencia a tener en cuenta: no se pueden revocar tokens de uno en uno.
 * Para invalidarlos todos, cambia MCP_AUTH_SECRET y vuelve a desplegar.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getMcpAuthSecret } from '../config'

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 // 1 h
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 días
export const AUTH_CODE_TTL_SECONDS = 120 // 2 min
export const MCP_SCOPE = 'mcp'

type TokenType = 'client' | 'code' | 'access' | 'refresh'

interface BasePayload {
  t: TokenType
  iat: number
  exp?: number
}

export interface ClientPayload extends BasePayload {
  t: 'client'
  /** redirect_uris registrados */
  ru: string[]
  /** client_name declarado en el registro */
  nm?: string
}

export interface CodePayload extends BasePayload {
  t: 'code'
  /** huella del client_id */
  cid: string
  /** redirect_uri usado en /authorize */
  ru: string
  /** code_challenge (PKCE, S256) */
  cc: string
  sc: string
}

export interface AccessPayload extends BasePayload {
  t: 'access'
  cid: string
  sc: string
}

export interface RefreshPayload extends BasePayload {
  t: 'refresh'
  cid: string
  sc: string
  /** identificador único, para que la rotación genere tokens distintos */
  ji: string
}

export class OAuthNotConfiguredError extends Error {
  constructor() {
    super('MCP_AUTH_SECRET no está configurado: el servidor OAuth está deshabilitado.')
    this.name = 'OAuthNotConfiguredError'
  }
}

function signingKey(): Buffer {
  const secret = getMcpAuthSecret()
  if (!secret) throw new OAuthNotConfiguredError()
  // Clave separada del secreto en claro, para no reutilizar el mismo material.
  return createHmac('sha256', secret).update('mcp-sinergia:oauth:v1').digest()
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function sign(payload: BasePayload): string {
  const body = toBase64Url(JSON.stringify(payload))
  const signature = toBase64Url(createHmac('sha256', signingKey()).update(body).digest())
  return `${body}.${signature}`
}

function verify<T extends BasePayload>(token: string | undefined, type: TokenType): T | null {
  if (!token) return null

  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null

  const body = token.slice(0, separator)
  const signature = token.slice(separator + 1)

  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }

  const expected = createHmac('sha256', signingKey()).update(body).digest()
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  let payload: BasePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as BasePayload
  } catch {
    return null
  }

  if (payload.t !== type) return null
  if (payload.exp !== undefined && nowSeconds() >= payload.exp) return null

  return payload as T
}

/** Huella corta de un client_id, para no arrastrar el valor entero en cada token. */
export function clientFingerprint(clientId: string): string {
  return createHash('sha256').update(clientId).digest('base64url').slice(0, 22)
}

// ---------------------------------------------------------------------------
// Clientes (Dynamic Client Registration)
// ---------------------------------------------------------------------------

export function issueClientId(redirectUris: string[], clientName?: string): string {
  return sign({
    t: 'client',
    iat: nowSeconds(),
    ru: redirectUris,
    ...(clientName ? { nm: clientName } : {}),
  } as ClientPayload)
}

export function readClientId(clientId: string | undefined): ClientPayload | null {
  return verify<ClientPayload>(clientId, 'client')
}

/**
 * Solo se aceptan destinos HTTPS o loopback. En loopback se ignora el puerto,
 * como exige RFC 8252 §7.3 (Claude Code usa un puerto efímero distinto en cada
 * sesión).
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }

  if (parsed.username || parsed.password || parsed.hash) return false
  if (parsed.protocol === 'https:') return true

  return (
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
  )
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
}

export function redirectUriIsRegistered(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true

  let candidateUrl: URL
  try {
    candidateUrl = new URL(candidate)
  } catch {
    return false
  }

  if (!isLoopback(candidateUrl)) return false

  return registered.some((entry) => {
    try {
      const url = new URL(entry)
      return (
        isLoopback(url) &&
        url.protocol === candidateUrl.protocol &&
        url.pathname === candidateUrl.pathname
      )
    } catch {
      return false
    }
  })
}

// ---------------------------------------------------------------------------
// Códigos de autorización
// ---------------------------------------------------------------------------

export function issueAuthorizationCode(input: {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope: string
}): string {
  return sign({
    t: 'code',
    iat: nowSeconds(),
    exp: nowSeconds() + AUTH_CODE_TTL_SECONDS,
    cid: clientFingerprint(input.clientId),
    ru: input.redirectUri,
    cc: input.codeChallenge,
    sc: input.scope,
  } as CodePayload)
}

export function readAuthorizationCode(code: string | undefined): CodePayload | null {
  return verify<CodePayload>(code, 'code')
}

/** Comprobación PKCE S256: BASE64URL(SHA256(code_verifier)) === code_challenge */
export function verifyPkce(codeVerifier: string | undefined, codeChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) return false

  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)

  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Access y refresh tokens
// ---------------------------------------------------------------------------

export function issueAccessToken(clientFingerprintValue: string, scope: string): string {
  return sign({
    t: 'access',
    iat: nowSeconds(),
    exp: nowSeconds() + ACCESS_TOKEN_TTL_SECONDS,
    cid: clientFingerprintValue,
    sc: scope,
  } as AccessPayload)
}

export function readAccessToken(token: string | undefined): AccessPayload | null {
  return verify<AccessPayload>(token, 'access')
}

export function issueRefreshToken(clientFingerprintValue: string, scope: string): string {
  return sign({
    t: 'refresh',
    iat: nowSeconds(),
    exp: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS,
    cid: clientFingerprintValue,
    sc: scope,
    ji: randomBytes(9).toString('base64url'),
  } as RefreshPayload)
}

export function readRefreshToken(token: string | undefined): RefreshPayload | null {
  return verify<RefreshPayload>(token, 'refresh')
}
