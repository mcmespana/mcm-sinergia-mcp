/**
 * RFC 8414 — Authorization Server Metadata.
 *
 * El propio despliegue hace de servidor de autorización: emite client_ids por
 * DCR (RFC 7591), pide la clave compartida en una pantalla de consentimiento y
 * entrega access/refresh tokens firmados. Claude exige PKCE S256.
 */

import { MCP_SCOPE } from '@/lib/oauth/tokens'
import { corsPreflightResponse, getPublicOrigin, jsonResponse } from '@/lib/oauth/urls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const origin = getPublicOrigin(request)

  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [MCP_SCOPE, 'offline_access'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  })
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse()
}
