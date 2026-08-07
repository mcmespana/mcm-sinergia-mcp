/**
 * Resolución de la URL pública del despliegue.
 *
 * Los documentos de descubrimiento OAuth tienen que anunciar exactamente la
 * misma URL que la persona usuaria escribe en Claude, así que se deduce de las
 * cabeceras que pone el proxy de Vercel (x-forwarded-*) y se puede forzar con
 * PUBLIC_BASE_URL cuando hay dominio propio.
 */

/** Ruta del endpoint MCP dentro del despliegue. */
export const MCP_PATH = '/api/mcp'

/** Ruta del documento RFC 9728 que describe el recurso protegido. */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`

export function getPublicOrigin(request: Request): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost ?? request.headers.get('host')

  if (host) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
    return `${proto}://${host}`
  }

  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

export function getMcpResourceUrl(request: Request): string {
  return `${getPublicOrigin(request)}${MCP_PATH}`
}

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  // El descubrimiento puede hacerse desde herramientas en navegador (Inspector).
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
} as const

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS })
}

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: JSON_HEADERS })
}
