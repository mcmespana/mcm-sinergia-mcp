/**
 * OAuth2 contra SinergiaCRM (SuiteCRM 7.x).
 *
 *   POST {SINERGIA_URL}/Api/access_token      <-- SIN /legacy/
 *   Content-Type: application/vnd.api+json
 *
 * El token se cachea a nivel de módulo: en Vercel (Fluid compute) las
 * instancias se reutilizan entre invocaciones, así que la mayoría de
 * peticiones no vuelven a hacer login. Cuando está a punto de expirar se
 * refresca con grant_type=refresh_token y, si el refresh falla, se hace
 * login completo.
 */

import { REQUEST_TIMEOUT_MS, getSinergiaConfig, type SinergiaConfig } from '../config'
import { SinergiaAuthError } from './errors'

interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms en el que el token deja de ser válido. */
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
  message?: string
}

/** Margen antes de la expiración real para no usar un token recién caducado. */
const EXPIRY_SKEW_MS = 60_000

/** Cache a nivel de módulo, reutilizada mientras viva la instancia. */
let cachedToken: TokenSet | null = null

/** Petición en vuelo, para que N llamadas concurrentes no hagan N logins. */
let pendingToken: Promise<TokenSet> | null = null

export const JSON_API_HEADERS = {
  'Content-Type': 'application/vnd.api+json',
  Accept: 'application/vnd.api+json',
} as const

function isUsable(token: TokenSet | null): token is TokenSet {
  return token !== null && Date.now() < token.expiresAt - EXPIRY_SKEW_MS
}

async function requestToken(
  config: SinergiaConfig,
  body: Record<string, string>,
  what: string,
): Promise<TokenSet> {
  const url = `${config.baseUrl}/Api/access_token`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: JSON_API_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (error) {
    // Nunca incluimos el body: lleva client_secret y password.
    throw new SinergiaAuthError(`No se pudo contactar con ${url} (${what})`, {
      details: error instanceof Error ? error.message : String(error),
    })
  }

  const raw = await response.text()
  let payload: TokenResponse = {}
  try {
    payload = raw ? (JSON.parse(raw) as TokenResponse) : {}
  } catch {
    // Un HTML de error (404 de Apache, login page, etc.) cae aquí.
    throw new SinergiaAuthError(
      `Respuesta no-JSON de ${url} (${what}). ¿Es correcta SINERGIA_URL y está habilitada la API V8?`,
      { status: response.status, details: raw.slice(0, 300) },
    )
  }

  if (!response.ok || !payload.access_token) {
    const detail =
      payload.error_description ?? payload.message ?? payload.error ?? raw.slice(0, 300)
    throw new SinergiaAuthError(`Fallo de autenticación OAuth2 (${what})`, {
      status: response.status,
      details: detail,
    })
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

function login(config: SinergiaConfig): Promise<TokenSet> {
  if (config.grantType === 'password') {
    return requestToken(
      config,
      {
        grant_type: 'password',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        username: config.username as string,
        password: config.password as string,
        scope: '',
      },
      'password grant',
    )
  }

  return requestToken(
    config,
    {
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: '',
    },
    'client_credentials grant',
  )
}

function refresh(config: SinergiaConfig, refreshToken: string): Promise<TokenSet> {
  return requestToken(
    config,
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      scope: '',
    },
    'refresh_token grant',
  )
}

async function refreshOrLogin(config: SinergiaConfig): Promise<TokenSet> {
  const previousRefreshToken = cachedToken?.refreshToken

  if (previousRefreshToken) {
    try {
      const refreshed = await refresh(config, previousRefreshToken)
      // Algunas configuraciones no devuelven refresh_token nuevo: conservamos el viejo.
      return { ...refreshed, refreshToken: refreshed.refreshToken ?? previousRefreshToken }
    } catch (error) {
      console.warn(
        '[sinergia] refresh_token falló, se hace login completo:',
        error instanceof Error ? error.message : error,
      )
    }
  }

  return login(config)
}

/** Devuelve un access token válido, refrescando o relogueando si hace falta. */
export async function getAccessToken(): Promise<string> {
  if (isUsable(cachedToken)) {
    return cachedToken.accessToken
  }

  if (!pendingToken) {
    const config = getSinergiaConfig()
    pendingToken = refreshOrLogin(config)
      .then((token) => {
        cachedToken = token
        return token
      })
      .catch((error) => {
        cachedToken = null
        throw error
      })
      .finally(() => {
        pendingToken = null
      })
  }

  const token = await pendingToken
  return token.accessToken
}

/**
 * Invalida el access token cacheado (conservando el refresh token) para que la
 * siguiente llamada renueve. Se usa al recibir un 401 de la API V8.
 */
export function invalidateAccessToken(): void {
  if (cachedToken) {
    cachedToken = { ...cachedToken, expiresAt: 0 }
  }
}

/** Olvida el token por completo. Solo para tests/smoke test. */
export function resetTokenCache(): void {
  cachedToken = null
  pendingToken = null
}
