/**
 * Endpoint MCP (Streamable HTTP) del servidor de SinergiaCRM.
 *
 * Se aceptan dos formas de autenticación, ambas contra la misma clave:
 *
 *  1. Bearer estático: `Authorization: Bearer <MCP_AUTH_SECRET>`. Es lo que
 *     usan Claude Code, mcp-remote, el Inspector o curl.
 *  2. Access token OAuth emitido por este mismo despliegue (ver /oauth/*).
 *     Es la vía que necesita Claude en la web, que no deja fijar cabeceras.
 *
 * Sin ninguna de las dos se responde 401 con la cabecera WWW-Authenticate que
 * apunta al documento de recurso protegido, antes de tocar nada del CRM.
 */

import type { AuthInfo } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { isAuthorizedBearer } from '@/lib/mcp/auth'
import { registerDocsTools } from '@/lib/mcp/docs-tools'
import { registerGuideTools } from '@/lib/mcp/guide-tools'
import { registerSqlTools } from '@/lib/mcp/sql-tools'
import { registerSinergiaTools, type ToolServer } from '@/lib/mcp/tools'
import { MCP_SCOPE, readAccessToken } from '@/lib/oauth/tokens'
import { PROTECTED_RESOURCE_METADATA_PATH } from '@/lib/oauth/urls'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const handler = createMcpHandler(
  (server) => {
    registerGuideTools(server as unknown as ToolServer)
    registerSinergiaTools(server as unknown as ToolServer)
    registerDocsTools(server as unknown as ToolServer)
    registerSqlTools(server as unknown as ToolServer)
  },
  {
    serverInfo: {
      name: 'sinergiacrm',
      version: '0.1.0',
    },
    // Lo lee el cliente al conectar: así el agente sabe que hay chuleta antes
    // de ponerse a explorar módulo a módulo.
    instructions:
      'Servidor de SinergiaCRM (SuiteCRM 7.x). Antes de pedir campos o escribir, llama a crm_fields_guide con los módulos que necesites: dice los nombres exactos de los campos de esta instancia y las claves de los desplegables (la API no las devuelve ni las valida). Pide siempre "fields" para no traer todos los campos. get_module_fields solo para lo que no esté en la guía.',
  },
)

const verifyToken = async (
  _request: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined

  if (isAuthorizedBearer(bearerToken)) {
    return { token: bearerToken, clientId: 'static-secret', scopes: [MCP_SCOPE] }
  }

  try {
    const payload = readAccessToken(bearerToken)
    if (payload) {
      return {
        token: bearerToken,
        clientId: payload.cid,
        scopes: payload.sc ? payload.sc.split(' ') : [MCP_SCOPE],
        expiresAt: payload.exp,
      }
    }
  } catch {
    // Sin MCP_AUTH_SECRET no hay forma de validar nada: se deniega.
  }

  return undefined
}

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: PROTECTED_RESOURCE_METADATA_PATH,
})

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
