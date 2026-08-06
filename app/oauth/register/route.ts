/**
 * RFC 7591 — Dynamic Client Registration.
 *
 * No hay base de datos: el client_id **es** el registro, firmado con HMAC. Al
 * volver en /authorize se verifica la firma y se comprueba que el redirect_uri
 * sea uno de los que se registraron aquí.
 */

import {
  OAuthNotConfiguredError,
  isAllowedRedirectUri,
  issueClientId,
} from '@/lib/oauth/tokens'
import { corsPreflightResponse, jsonResponse } from '@/lib/oauth/urls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REDIRECT_URIS = 10

interface RegistrationRequest {
  redirect_uris?: unknown
  client_name?: unknown
  token_endpoint_auth_method?: unknown
}

export async function POST(request: Request): Promise<Response> {
  let payload: RegistrationRequest

  try {
    payload = (await request.json()) as RegistrationRequest
  } catch {
    return jsonResponse(
      { error: 'invalid_client_metadata', error_description: 'El cuerpo debe ser JSON.' },
      400,
    )
  }

  const redirectUris = payload.redirect_uris

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return jsonResponse(
      { error: 'invalid_redirect_uri', error_description: 'Falta redirect_uris.' },
      400,
    )
  }

  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return jsonResponse(
      { error: 'invalid_redirect_uri', error_description: 'Demasiados redirect_uris.' },
      400,
    )
  }

  const uris = redirectUris.map(String)
  const invalid = uris.find((uri) => !isAllowedRedirectUri(uri))

  if (invalid) {
    return jsonResponse(
      {
        error: 'invalid_redirect_uri',
        error_description: `redirect_uri no permitido: ${invalid}. Solo se aceptan HTTPS o loopback.`,
      },
      400,
    )
  }

  const clientName = typeof payload.client_name === 'string' ? payload.client_name : undefined

  let clientId: string
  try {
    clientId = issueClientId(uris, clientName)
  } catch (error) {
    if (error instanceof OAuthNotConfiguredError) {
      return jsonResponse({ error: 'server_error', error_description: error.message }, 503)
    }
    throw error
  }

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(clientName ? { client_name: clientName } : {}),
    },
    201,
  )
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse()
}
