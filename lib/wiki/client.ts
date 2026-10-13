/**
 * Cliente mínimo de la API MediaWiki de la wiki de SinergiaTIC
 * (https://wiki.sinergiatic.org/api.php). Solo lectura y sin autenticación:
 * el manual es público.
 *
 * Si la wiki no responde (caída, bloqueo de IPs de Vercel, página de reto
 * anti-bots…) se lanza WikiUnavailableError con un mensaje que explica qué
 * pasa, para que el modelo se lo cuente a la persona en vez de inventar.
 */

const DEFAULT_WIKI_URL = 'https://wiki.sinergiatic.org'

/** Timeout de cada llamada a la wiki. */
export const WIKI_TIMEOUT_MS = 15_000

const USER_AGENT = 'mcm-sinergia-mcp/0.1 (+https://github.com/mcmespana/mcm-sinergia-mcp)'

export class WikiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** La wiki no es accesible desde este servidor. */
export class WikiUnavailableError extends WikiError {}

/** URL base de la wiki (se puede cambiar con WIKI_URL, p.ej. para pruebas). */
export function getWikiBaseUrl(): string {
  const raw = process.env.WIKI_URL?.trim()
  return (raw || DEFAULT_WIKI_URL).replace(/\/+$/, '')
}

/** URL pública de una página de la wiki. */
export function pageUrl(title: string): string {
  return `${getWikiBaseUrl()}/index.php/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`
}

function unavailable(cause: string): WikiUnavailableError {
  return new WikiUnavailableError(
    `No se puede acceder a la wiki de SinergiaTIC (${getWikiBaseUrl()}) desde el servidor MCP: ${cause}. ` +
      'Puede que la wiki esté caída o que bloquee las peticiones que salen de Vercel. ' +
      'Díselo a la persona usuaria tal cual; puede consultar el manual directamente en ' +
      `${pageUrl('Especial:MiIdioma/Manual_de_SinergiaCRM')} y revisar el estado en /api/docs-health.`,
  )
}

export type WikiParams = Record<string, string>

/** Llama a api.php con format=json&formatversion=2 y devuelve el JSON. */
export async function wikiApi<T = Record<string, unknown>>(
  params: WikiParams,
  { timeoutMs = WIKI_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(`${getWikiBaseUrl()}/api.php`)
  for (const [key, value] of Object.entries({ ...params, format: 'json', formatversion: '2' })) {
    url.searchParams.set(key, value)
  }

  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
  } catch (error) {
    const err = error as Error & { cause?: { code?: string; message?: string } }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw unavailable(`no ha respondido en ${timeoutMs / 1000} s`)
    }
    const detail = err.cause?.code || err.cause?.message || err.message
    throw unavailable(`fallo de conexión (${detail})`)
  }

  const text = await response.text()

  if (!response.ok) {
    throw unavailable(`ha respondido HTTP ${response.status}`)
  }

  let data: T & { error?: { code?: string; info?: string } }
  try {
    data = JSON.parse(text)
  } catch {
    // Típico de un reto anti-bots (Cloudflare & co.) o de una página de mantenimiento.
    throw unavailable(
      `ha devuelto algo que no es JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`,
    )
  }

  if (data.error) {
    throw new WikiError(
      `La API de la wiki devolvió un error: ${data.error.code}: ${data.error.info}`,
    )
  }

  return data
}
