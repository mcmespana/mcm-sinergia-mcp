/**
 * Endpoint MCP (Streamable HTTP) del servidor de SinergiaCRM.
 *
 * Los clientes se conectan a  https://<deploy>/api/mcp  enviando
 *   Authorization: Bearer <MCP_AUTH_SECRET>
 * Sin ese header (o con uno que no cuadre) se responde 401 antes de tocar
 * nada del CRM.
 */

import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { isAuthorizedBearer } from '@/lib/mcp/auth'
import { registerSinergiaTools, type ToolServer } from '@/lib/mcp/tools'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const handler = createMcpHandler(
  (server) => {
    registerSinergiaTools(server as unknown as ToolServer)
  },
  {
    serverInfo: {
      name: 'sinergiacrm',
      version: '0.1.0',
    },
  },
)

const verifyToken = async (
  _request: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!isAuthorizedBearer(bearerToken)) {
    return undefined
  }

  return {
    token: bearerToken as string,
    clientId: 'sinergia-mcp',
    scopes: [],
  }
}

const authHandler = withMcpAuth(handler, verifyToken, { required: true })

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
