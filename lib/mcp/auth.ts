/** Comprobación del bearer de entrada del servidor MCP. */

import { createHash, timingSafeEqual } from 'node:crypto'
import { getMcpAuthSecret } from '../config'

/** Compara dos secretos en tiempo constante y sin filtrar la longitud. */
function secretsMatch(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * Valida el token recibido en "Authorization: Bearer <token>" contra
 * MCP_AUTH_SECRET. Si el secreto no está configurado se rechaza todo:
 * preferimos caernos cerrados antes que exponer el CRM.
 */
export function isAuthorizedBearer(bearerToken?: string): boolean {
  const secret = getMcpAuthSecret()

  if (!secret) {
    console.error(
      '[mcp] MCP_AUTH_SECRET no está configurado: se rechazan todas las peticiones entrantes.',
    )
    return false
  }

  if (!bearerToken) return false

  return secretsMatch(bearerToken, secret)
}
