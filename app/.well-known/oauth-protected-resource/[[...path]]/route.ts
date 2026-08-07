/**
 * RFC 9728 — Protected Resource Metadata.
 *
 * Claude sondea primero
 *   /.well-known/oauth-protected-resource/api/mcp
 * y si no, /.well-known/oauth-protected-resource. El catch-all opcional cubre
 * las dos, y el campo `resource` siempre apunta al endpoint MCP, que es la URL
 * que la persona usuaria escribe en el conector.
 */

import { MCP_SCOPE } from '@/lib/oauth/tokens'
import {
  corsPreflightResponse,
  getMcpResourceUrl,
  getPublicOrigin,
  jsonResponse,
} from '@/lib/oauth/urls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return jsonResponse({
    resource: getMcpResourceUrl(request),
    authorization_servers: [getPublicOrigin(request)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  })
}

export async function OPTIONS(): Promise<Response> {
  return corsPreflightResponse()
}
