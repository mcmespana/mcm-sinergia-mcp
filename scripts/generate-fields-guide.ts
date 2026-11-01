/**
 * Genera el BORRADOR de la guía de campos (CAMPOS-RESUMEN.md) de tu instancia,
 * leyendo las definiciones de campos de la API V8. Es el punto de partida para
 * otra organización: luego se completa a mano (qué es cada campo, claves de los
 * desplegables, trampas), que es lo que de verdad ahorra llamadas.
 *
 *   npm run guide:generate                          # módulos con campos propios
 *   npm run guide:generate -- Contacts stic_Events  # solo esos
 *   npm run guide:generate -- --stdout              # a la pantalla
 *   npm run guide:generate -- --force               # pisa guia/CAMPOS-RESUMEN.md
 *
 * Solo lee. Por cada módulo saca los campos obligatorios, los personalizados
 * (`_c`) y los campos planos de enlace (`_ida`), que son los que se suelen
 * necesitar y no se adivinan.
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { LOCAL_GUIDE_PATH } from '../lib/fields-guide'
import { describeError } from '../lib/sinergia/errors'
import type { FlatField } from '../lib/sinergia/flatten'
import { getAvailableModules, getModuleFields } from '../lib/sinergia/operations'

/** Campos de auditoría de SuiteCRM: están en todos los módulos y no aportan. */
const BORING = new Set([
  'id', 'date_entered', 'date_modified', 'modified_user_id', 'modified_by_name', 'created_by', 'created_by_name',
  'deleted', 'assigned_user_name', 'name', 'description', 'id_c',
])

/** Tipos de la API → tipos cortos del formato de la guía. */
const SHORT_TYPES: Record<string, string> = {
  varchar: 'text', name: 'text', text: 'text', phone: 'text', email: 'text', textarea: 'text',
  enum: 'enum', dynamicenum: 'enum', radioenum: 'enum', multienum: 'multi',
  bool: 'bool', date: 'date', datetime: 'date', datetimecombo: 'date',
  int: 'int', decimal: 'dec', currency: 'dec', float: 'dec',
  url: 'url', relate: 'rel', link: 'link', id: 'id', wysiwyg: 'wysiwyg', image: 'image',
}

function loadDotEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file)
    } catch {
      // Sin fichero: seguimos con el entorno.
    }
  }
}

function interesting(field: FlatField): boolean {
  if (BORING.has(field.name)) return false
  return Boolean(field.required || field.custom || field.name.endsWith('_ida') || field.name === 'assigned_user_id')
}

function row(field: FlatField): string {
  const type = SHORT_TYPES[field.type ?? ''] ?? field.type ?? '?'
  const extras = [
    field.required ? 'oblig.' : '',
    field.len && ['text', 'enum', 'multi'].includes(type) ? `(${String(field.len)})` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const what = [
    field.label && !/^LBL_/.test(field.label) ? field.label : '',
    field.relationship ? `enlace \`${field.relationship}\`` : '',
    type === 'enum' || type === 'multi' ? 'claves: ❓ (míralas en Studio)' : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return `| \`${field.name}\` | ${[type, extras].filter(Boolean).join(' ')} | ${what || 'TODO'} |`
}

async function main(): Promise<void> {
  loadDotEnv()
  const args = process.argv.slice(2)
  const toStdout = args.includes('--stdout')
  const force = args.includes('--force')
  let modules = args.filter((arg) => !arg.startsWith('--'))
  const labels = new Map<string, string>()

  const auto = modules.length === 0
  const available = await getAvailableModules()
  for (const m of available.modules) if (m.label) labels.set(m.module, m.label)
  if (auto) modules = available.modules.map((m) => m.module)

  const sections: string[] = []
  for (const module of modules) {
    try {
      const { fields } = await getModuleFields(module)
      const picked = fields.filter(interesting)
      // En automático, un módulo sin nada propio (ni campos _c ni enlaces) no merece sección.
      if (auto && !picked.some((f) => f.custom || f.name.endsWith('_ida'))) continue
      sections.push(
        [
          `## \`${module}\` — ${labels.get(module) ?? 'TODO etiqueta'}`,
          '',
          `SQL: \`${module.toLowerCase()}\`${picked.some((f) => f.custom) ? ` + \`${module.toLowerCase()}_cstm\`` : ''}. TODO: para qué sirve en tu organización.`,
          '',
          '| Campo | Tipo | Qué es · claves |',
          '|---|---|---|',
          ...picked.map(row),
        ].join('\n'),
      )
      console.error(`✓ ${module}: ${picked.length} campos`)
    } catch (error) {
      console.error(`✗ ${module}: ${describeError(error)}`)
    }
  }

  const today = new Date().toLocaleDateString('es-ES')
  const guide = [
    '# Campos del CRM — resumen para agentes · TODO nombre de la organización',
    '',
    `<!-- formato: campos-resumen/1 · instancia: TODO · revisado: ${today} -->`,
    '',
    '> BORRADOR generado con `npm run guide:generate` desde la API V8. Revisa cada TODO, borra los campos que no',
    '> uséis y añade las claves de los desplegables (la API no las da). Formato explicado en `guia/README.md`.',
    '',
    '## Reglas',
    '',
    '- **No inventes campos.** Pedir uno que no existe hace fallar la consulta entera. Si no está aquí: `get_module_fields`.',
    '- **No inventes claves de desplegable.** La API no valida los `enum`: una clave inventada se guarda sin error.',
    '- **Pide siempre `fields`.** Sin él llegan todos los campos del módulo.',
    '- **SQL**: módulo `Foo_Bar` → tabla `foo_bar`; campos `…_c` en `foo_bar_cstm` (`id_c` = `id`); cada enlace es una tabla `<enlace>_c` con `…_ida` / `…_idb`. Siempre `deleted = 0`.',
    '- TODO: reglas propias (a quién se asigna lo que se crea, formatos de fecha, datos sensibles…).',
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n')

  if (toStdout) {
    process.stdout.write(guide)
    return
  }

  const target = path.join(process.cwd(), LOCAL_GUIDE_PATH)
  if (!force) {
    const exists = await access(target).then(
      () => true,
      () => false,
    )
    if (exists) {
      console.error(`\n${LOCAL_GUIDE_PATH} ya existe: no lo piso. Usa --force o --stdout.`)
      process.exitCode = 1
      return
    }
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, guide, 'utf8')
  console.error(`\nBorrador escrito en ${LOCAL_GUIDE_PATH} (${sections.length} módulos). Ahora toca completarlo a mano.`)
}

main().catch((error) => {
  console.error(describeError(error))
  process.exit(1)
})
