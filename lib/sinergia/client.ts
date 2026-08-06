/**
 * Cliente HTTP de la API V8 de SinergiaCRM.
 *
 * Todas las rutas cuelgan de {SINERGIA_URL}/Api/V8/... — SIN /legacy/, que es
 * lo que usa SuiteCRM 8.x y aquí devuelve 404.
 */

import { REQUEST_TIMEOUT_MS, getSinergiaConfig } from '../config'
import { JSON_API_HEADERS, getAccessToken, invalidateAccessToken } from './auth'
import { SinergiaApiError } from './errors'
import type { JsonApiDocument } from './types'

export type QueryParams = Array<[string, string]>

interface RequestOptions {
  query?: QueryParams
  body?: unknown
}

/** Extrae un mensaje legible de un documento de errores JSON:API. */
function extractErrorDetail(raw: string): string {
  if (!raw) return ''

  try {
    const parsed = JSON.parse(raw) as {
      errors?: unknown
      message?: string
      error?: string
    }

    const errors = parsed.errors
    const list = Array.isArray(errors) ? errors : errors ? [errors] : []

    const messages = list
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object') {
          const e = entry as { title?: string; detail?: string; code?: unknown }
          return [e.title, e.detail].filter(Boolean).join(': ')
        }
        return ''
      })
      .filter(Boolean)

    if (messages.length > 0) return messages.join(' | ')
    if (parsed.message) return parsed.message
    if (parsed.error) return parsed.error
  } catch {
    // No era JSON: devolvemos un recorte del cuerpo tal cual.
  }

  return raw.slice(0, 300)
}

function buildUrl(path: string, query?: QueryParams): string {
  const { baseUrl } = getSinergiaConfig()
  const url = new URL(`${baseUrl}/Api/V8${path}`)

  if (query) {
    for (const [key, value] of query) {
      url.searchParams.append(key, value)
    }
  }

  return url.toString()
}

async function send(
  method: string,
  url: string,
  body: unknown,
  token: string,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      ...JSON_API_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  })
}

/**
 * Lanza una petición contra la API V8. Si la respuesta es 401 se invalida el
 * token cacheado y se reintenta una única vez (el token pudo revocarse desde
 * el CRM mientras la instancia seguía viva).
 */
export async function apiRequest<T = JsonApiDocument>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = buildUrl(path, options.query)

  let token = await getAccessToken()
  let response: Response

  try {
    response = await send(method, url, options.body, token)

    if (response.status === 401) {
      invalidateAccessToken()
      token = await getAccessToken()
      response = await send(method, url, options.body, token)
    }
  } catch (error) {
    throw new SinergiaApiError(`Fallo de red llamando a ${method} ${path}`, {
      details: error instanceof Error ? error.message : String(error),
    })
  }

  const raw = await response.text()

  if (!response.ok) {
    throw new SinergiaApiError(`La API de SinergiaCRM devolvió un error en ${method} ${path}`, {
      status: response.status,
      details: extractErrorDetail(raw),
    })
  }

  if (!raw) {
    return {} as T
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    throw new SinergiaApiError(`Respuesta no-JSON en ${method} ${path}`, {
      status: response.status,
      details: raw.slice(0, 300),
    })
  }
}
