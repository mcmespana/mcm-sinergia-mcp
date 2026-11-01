/**
 * Comprueba que la guía de campos se lee y se trocea bien, sin tocar el CRM.
 *
 *   npm run test:guide                              # la de CRM_FIELDS_GUIDE_URL o guia/CAMPOS-RESUMEN.md
 *   npm run test:guide -- Contacts stic_Events      # y enseña esas secciones
 *
 * Falla si no hay sección «Reglas» o si un módulo sale en dos secciones.
 */

import process from 'node:process'
import { guideModules, loadGuide, parseGuide, selectGuide } from '../lib/fields-guide'

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file)
  } catch {
    // Sin fichero: seguimos con el entorno.
  }
}

async function main(): Promise<void> {
  const loaded = await loadGuide()
  const guide = parseGuide(loaded.text)
  const problems: string[] = []

  if (!guide.sections.some((s) => /^reglas\b/i.test(s.title))) problems.push('Falta la sección "## Reglas".')
  // Una sección sin módulo es válida (notas generales), pero solo sale con la guía entera.
  const loose = guide.sections.filter((s) => !/^reglas\b/i.test(s.title) && s.modules.length === 0)
  const seen = new Map<string, number>()
  for (const name of guideModules(guide)) seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1)
  for (const [name, count] of seen) if (count > 1) problems.push(`El módulo ${name} sale en ${count} secciones.`)

  console.log(`Fuente ....: ${loaded.source}`)
  console.log(`Tamaño ....: ${loaded.text.length} caracteres, ${guide.sections.length} secciones`)
  console.log(`Módulos ...: ${guideModules(guide).join(', ')}`)
  if (loose.length > 0) console.log(`Sin módulo : ${loose.map((s) => s.title).join(' · ')} (solo salen con la guía entera)`)

  const wanted = process.argv.slice(2)
  if (wanted.length > 0) {
    const { text, missing } = selectGuide(guide, wanted)
    console.log(`\n--- ${wanted.join(', ')} (${text.length} caracteres) ---\n${text}`)
    if (missing.length > 0) problems.push(`Sin sección para: ${missing.join(', ')}`)
  }

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.join('\n✗ ')}`)
    process.exitCode = 1
  } else {
    console.log('\n✓ La guía tiene buena forma.')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
