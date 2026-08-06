/**
 * Endpoint de autorización (OAuth 2.1, authorization_code + PKCE S256).
 *
 * La "identidad" aquí es la clave compartida MCP_AUTH_SECRET: quien la conoce
 * puede autorizar al cliente. No hay usuarios ni sesiones; es una puerta con
 * una sola llave, igual que el bearer estático.
 */

import { isAuthorizedBearer } from '@/lib/mcp/auth'
import {
  MCP_SCOPE,
  OAuthNotConfiguredError,
  issueAuthorizationCode,
  readClientId,
  redirectUriIsRegistered,
} from '@/lib/oauth/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  codeChallengeMethod: string
  responseType: string
  scope: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#f6f6f7; color:#18181b; padding:1.5rem; }
  .card { background:#fff; border:1px solid #e4e4e7; border-radius:14px; padding:2rem;
          max-width:26rem; width:100%; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  h1 { font-size:1.15rem; margin:0 0 .25rem; }
  p { color:#52525b; font-size:.9rem; line-height:1.5; margin:.5rem 0; }
  code { background:#f4f4f5; padding:.1rem .3rem; border-radius:4px; font-size:.85em; }
  label { display:block; font-size:.85rem; font-weight:600; margin:1.25rem 0 .4rem; }
  input[type=password] { width:100%; box-sizing:border-box; padding:.6rem .7rem; font-size:1rem;
          border:1px solid #d4d4d8; border-radius:8px; background:#fff; color:inherit; }
  button { width:100%; margin-top:1.25rem; padding:.7rem; font-size:1rem; font-weight:600;
           border:0; border-radius:8px; background:#18181b; color:#fff; cursor:pointer; }
  .error { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; padding:.6rem .75rem;
           border-radius:8px; font-size:.85rem; margin-top:1rem; }
  @media (prefers-color-scheme: dark) {
    body { background:#09090b; color:#fafafa; }
    .card { background:#18181b; border-color:#27272a; }
    p { color:#a1a1aa; } code { background:#27272a; }
    input[type=password] { background:#09090b; border-color:#3f3f46; }
    button { background:#fafafa; color:#18181b; }
    .error { background:#450a0a; border-color:#7f1d1d; color:#fca5a5; }
  }
</style>
</head>
<body><div class="card">${inner}</div></body>
</html>`
}

function errorPage(title: string, detail: string, status: number): Response {
  return htmlResponse(
    page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`),
    status,
  )
}

function consentPage(params: AuthorizeRequest, clientName: string | undefined, error?: string) {
  const hidden = [
    ['client_id', params.clientId],
    ['redirect_uri', params.redirectUri],
    ['state', params.state],
    ['code_challenge', params.codeChallenge],
    ['code_challenge_method', params.codeChallengeMethod],
    ['response_type', params.responseType],
    ['scope', params.scope],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n')

  const who = clientName ? escapeHtml(clientName) : 'Una aplicación'

  return htmlResponse(
    page(
      'Conectar con SinergiaCRM',
      `<h1>Conectar con SinergiaCRM</h1>
       <p>${who} quiere acceder a tu SinergiaCRM a través de este servidor MCP.</p>
       <p>Introduce la clave de acceso del servidor &mdash; el valor de
          <code>MCP_AUTH_SECRET</code> &mdash; para autorizarlo.</p>
       ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
       <form method="post">
         ${hidden}
         <label for="secret">Clave de acceso</label>
         <input id="secret" name="secret" type="password" autocomplete="off" autofocus required>
         <button type="submit">Autorizar</button>
       </form>`,
    ),
    error ? 401 : 200,
  )
}

function readParams(source: URLSearchParams): AuthorizeRequest {
  return {
    clientId: source.get('client_id') ?? '',
    redirectUri: source.get('redirect_uri') ?? '',
    state: source.get('state') ?? '',
    codeChallenge: source.get('code_challenge') ?? '',
    codeChallengeMethod: source.get('code_challenge_method') ?? '',
    responseType: source.get('response_type') ?? '',
    scope: source.get('scope') ?? MCP_SCOPE,
  }
}

function redirectWithError(params: AuthorizeRequest, error: string, description: string) {
  const target = new URL(params.redirectUri)
  target.searchParams.set('error', error)
  target.searchParams.set('error_description', description)
  if (params.state) target.searchParams.set('state', params.state)
  return Response.redirect(target.toString(), 302)
}

/**
 * Valida la petición. Devuelve o bien los datos del cliente, o bien la
 * respuesta de error que hay que servir.
 */
function validate(
  params: AuthorizeRequest,
): { ok: true; clientName?: string } | { ok: false; response: Response } {
  const client = readClientId(params.clientId)

  // Sin cliente válido o sin redirect_uri registrado no se puede redirigir a
  // ningún sitio: se responde con una página de error (evita open redirect).
  if (!client) {
    return {
      ok: false,
      response: errorPage(
        'Cliente no válido',
        'El client_id no es válido o fue emitido con otra clave del servidor. Vuelve a añadir el conector.',
        400,
      ),
    }
  }

  if (!params.redirectUri || !redirectUriIsRegistered(client.ru, params.redirectUri)) {
    return {
      ok: false,
      response: errorPage(
        'redirect_uri no válida',
        'La dirección de retorno no coincide con ninguna de las registradas por este cliente.',
        400,
      ),
    }
  }

  if (params.responseType !== 'code') {
    return {
      ok: false,
      response: redirectWithError(
        params,
        'unsupported_response_type',
        'Solo se admite response_type=code.',
      ),
    }
  }

  if (!params.codeChallenge || params.codeChallengeMethod !== 'S256') {
    return {
      ok: false,
      response: redirectWithError(
        params,
        'invalid_request',
        'Se exige PKCE con code_challenge_method=S256.',
      ),
    }
  }

  return { ok: true, clientName: client.nm }
}

export async function GET(request: Request): Promise<Response> {
  const params = readParams(new URL(request.url).searchParams)

  try {
    const result = validate(params)
    if (!result.ok) return result.response
    return consentPage(params, result.clientName)
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) {
      return errorPage('Servidor sin configurar', error.message, 503)
    }
    throw error
  }
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData()
  const source = new URLSearchParams()
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') source.append(key, value)
  }

  const params = readParams(source)
  const secret = source.get('secret') ?? undefined

  try {
    const result = validate(params)
    if (!result.ok) return result.response

    if (!isAuthorizedBearer(secret)) {
      return consentPage(params, result.clientName, 'Clave incorrecta. Inténtalo de nuevo.')
    }

    const code = issueAuthorizationCode({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope: params.scope || MCP_SCOPE,
    })

    const target = new URL(params.redirectUri)
    target.searchParams.set('code', code)
    if (params.state) target.searchParams.set('state', params.state)

    return Response.redirect(target.toString(), 302)
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) {
      return errorPage('Servidor sin configurar', error.message, 503)
    }
    throw error
  }
}
