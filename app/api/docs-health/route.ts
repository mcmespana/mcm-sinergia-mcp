/**
 * Estado de la conexión con la wiki de SinergiaTIC (documentación).
 *
 * Público a propósito: no expone nada del CRM, solo si este despliegue llega
 * a la wiki y cuántas páginas tiene cada índice. Responde 200 si todo va bien
 * y 503 si no, para que lo pueda vigilar cualquier monitor (ver
 * .github/workflows/docs-health.yml).
 */

import { checkDocsHealth } from '@/lib/wiki/manual'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(): Promise<Response> {
  const health = await checkDocsHealth()
  if (!health.ok) {
    console.error('[docs-health] La wiki de SinergiaTIC no es accesible:', health.error)
  }
  return Response.json(health, {
    status: health.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
