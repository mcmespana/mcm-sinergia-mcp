/**
 * Smoke test: login OAuth2 contra SinergiaCRM y listado de módulos.
 *
 *   npm run test:auth
 *
 * Solo valida credenciales y conectividad — no escribe nada. Úsalo antes de
 * desplegar en Vercel para descartar problemas de URL, cliente OAuth2,
 * usuario API o permisos del rol.
 */

import process from 'node:process'
import { getSinergiaConfig } from '../lib/config'
import { getAccessToken } from '../lib/sinergia/auth'
import { describeError } from '../lib/sinergia/errors'
import { getAvailableModules } from '../lib/sinergia/operations'

function loadDotEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file)
    } catch {
      // El fichero no existe: seguimos con las variables ya presentes en el entorno.
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv()

  const config = getSinergiaConfig()

  console.log('=== Smoke test SinergiaCRM API V8 ===')
  console.log(`URL base .......: ${config.baseUrl}`)
  console.log(`Token endpoint .: ${config.baseUrl}/Api/access_token`)
  console.log(`Grant type .....: ${config.grantType}`)
  if (config.username) console.log(`Usuario API ....: ${config.username}`)
  console.log('')

  console.log('1) Pidiendo access token…')
  const started = Date.now()
  const token = await getAccessToken()
  console.log(`   OK — token de ${token.length} caracteres en ${Date.now() - started} ms`)
  console.log('')

  console.log('2) GET /Api/V8/meta/modules …')
  const { count, modules } = await getAvailableModules()
  console.log(`   OK — ${count} módulos accesibles para este usuario`)
  console.log('')

  const preview = modules.slice(0, 20)
  for (const entry of preview) {
    console.log(`   - ${entry.module}${entry.label ? ` (${entry.label})` : ''}`)
  }
  if (modules.length > preview.length) {
    console.log(`   … y ${modules.length - preview.length} más`)
  }

  console.log('')
  console.log('Todo correcto: las credenciales sirven para desplegar.')
}

main().catch((error) => {
  console.error('')
  console.error('FALLO:', describeError(error))
  console.error('')
  console.error('Comprobaciones habituales:')
  console.error('  - SINERGIA_URL es la URL base, sin /Api y sin /legacy')
  console.error('  - El cliente OAuth2 existe y el grant configurado coincide')
  console.error('  - El usuario API está activo y su rol permite los módulos')
  console.error('  - Las claves RSA de Api/V8/OAuth2/ están bien en el servidor')
  process.exit(1)
})
