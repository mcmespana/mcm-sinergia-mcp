/**
 * Smoke test: conexión de solo lectura a la base de datos de SinergiaCRM.
 *
 *   npm run test:db
 *   npm run test:db -- "SELECT COUNT(*) AS n FROM contacts WHERE deleted = 0"
 *
 * Necesita CRM_BBDD_IP, CRM_BBDD_PORT, CRM_BBDD_USER y CRM_BBDD_PASS (y CRM_BBDD_NAME si el
 * usuario ve más de una base de datos). Ojo: el servidor de BBDD puede
 * aceptar solo ciertas IPs.
 */

import process from 'node:process'
import { getDbConfig } from '../lib/config'
import { describeSchema, runReadQuery } from '../lib/db/client'
import { describeError } from '../lib/sinergia/errors'

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file)
  } catch {
    // El fichero no existe: seguimos con las variables ya presentes en el entorno.
  }
}

async function main(): Promise<void> {
  const config = getDbConfig()
  console.log('=== Smoke test BBDD SinergiaCRM ===')
  console.log(`Servidor .......: ${config.host}:${config.port}`)
  console.log(`Usuario ........: ${config.user}`)
  console.log(`Base de datos ..: ${config.database ?? '(autodetectar)'}`)
  console.log('')

  const sql = process.argv[2] ?? 'SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS usuario'
  console.log(`1) ${sql}`)
  console.log(JSON.stringify(await runReadQuery(sql, 20), null, 2))

  console.log('\n2) Tablas stic_*')
  const { total, tablas } = (await describeSchema({ nameContains: 'stic_' })) as {
    total: number
    tablas: unknown[]
  }
  console.log(`${total} tablas; primeras:`, tablas.slice(0, 10))
}

main().catch((error) => {
  console.error(`\n✗ ${describeError(error)}`)
  process.exit(1)
})
