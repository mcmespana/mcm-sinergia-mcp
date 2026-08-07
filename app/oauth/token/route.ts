/**
 * Endpoint de token (RFC 6749): authorization_code + refresh_token.
 *
 * Claude manda siempre `application/x-www-form-urlencoded`, tanto en el canje
 * inicial como en los refrescos. Los refresh tokens se rotan en cada uso, como
 * pide la especificación de autorización de MCP para clientes públicos.
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  MCP_SCOPE,
  OAuthNotConfiguredError,
  clientFingerprint,
  issueAccessToken,
  issueRefreshToken,
  readAuthorizationCode,
  readClientId,
  readRefreshToken,
  verifyPkce,
} from '@/lib/oauth/tokens'
import { corsPreflightResponse, jsonResponse } from '@/lib/oauth/urls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status)
}

function tokenResponse(fingerprint: string, scope: string): Response {
  return jsonResponse({
    access_token: issueAccessToken(fingerprint, scope),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: issueRefreshToken(fingerprint, scope),
    scope,
  })
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) params.append(key, String(value))
    }
    return params
  }

  return new URLSearchParams(await request.text())
}

function handleAuthorizationCode(params: URLSearchParams): Response {
  const clientId = params.get('client_id') ?? ''
  const client = readClientId(clientId)
  if (!client) {
    return oauthError('invalid_client', 'client_id no válido.', 401)
  }

  const code = readAuthorizationCode(params.get('code') ?? undefined)
  if (!code) {
    return oauthError('invalid_grant', 'El código de autorización no es válido o ha caducado.')
  }

  if (code.cid !== clientFingerprint(clientId)) {
    return oauthError('invalid_grant', 'El código se emitió para otro cliente.')
  }

  const redirectUri = params.get('redirect_uri')
  if (redirectUri && redirectUri !== code.ru) {
    return oauthError('invalid_grant', 'redirect_uri no coincide con la de la autorización.')
  }

  if (!verifyPkce(params.get('code_verifier') ?? undefined, code.cc)) {
    return oauthError('invalid_grant', 'La verificación PKCE ha fallado.')
  }

  return tokenResponse(code.cid, code.sc || MCP_SCOPE)
}

function handleRefreshToken(params: URLSearchParams): Response {
  const refresh = readRefreshToken(params.get('refresh_token') ?? undefined)
  if (!refresh) {
    return oauthError('invalid_grant', 'El refresh token no es válido o ha caducado.')
  }

  const clientId = params.get('client_id')
  if (clientId && refresh.cid !== clientFingerprint(clientId)) {
    return oauthError('invalid_grant', 'El refresh token pertenece a otro cliente.')
  }

  return tokenResponse(refresh.cid, refresh.sc || MCP_SCOPE)
}

export async function POST(request: Request): Promise<Response> {
  let params: URLSearchParams

  try {
    params = await readForm(request)
  } catch {
    return oauthError('invalid_request', 'No se pudo leer el cuerpo de la petición.')
  }

  try {
    switch (params.get('grant_type')) {
      case 'authorization_code':
        return handleAuthorizationCode(params)
      case 'refresh_token':
        return handleRefreshToken(params)
      default:
        return oauthError(
          'unsupported_grant_type',
          'Solo se admiten authorization_code y refresh_token.',
        )
    }
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) {
      return oauthError('server_error', error.message, 503)
    }
    throw error
  }
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse()
}
