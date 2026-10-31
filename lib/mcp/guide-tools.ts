/**
 * Tool de la guía de campos de la instancia (CAMPOS-RESUMEN.md). Es lo primero
 * que debería mirar un agente antes de pedir campos: le ahorra varias llamadas
 * a get_module_fields y le da las claves de los desplegables, que la API no
 * devuelve.
 */

import { z } from 'zod'
import { GuideNotConfiguredError, guideModules, loadGuide, parseGuide, selectGuide } from '../fields-guide'
import type { ToolServer, ToolResult } from './tools'

const guideInput = z.object({
  modules: z
    .array(z.string())
    .optional()
    .describe(
      'Módulos que te interesan, por nombre técnico (p.ej. ["Contacts", "stic_Events"]). Sin esto, la guía entera. Siempre vienen también las reglas generales.',
    ),
})

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) }
}

export function registerGuideTools(server: ToolServer): void {
  server.registerTool(
    'crm_fields_guide',
    {
      title: 'Guía de campos del CRM',
      description:
        'EMPIEZA POR AQUÍ antes de pedir campos o de escribir. Chuleta de ESTA instancia: qué campos usar en cada módulo (nombres técnicos exactos), las claves de los desplegables (que la API no devuelve y no valida), cómo se enlazan los módulos, las tablas SQL y las trampas conocidas. Pide solo los módulos que necesites. Si un campo no está aquí, entonces get_module_fields.',
      inputSchema: guideInput,
    },
    async ({ modules }: z.infer<typeof guideInput>): Promise<ToolResult> => {
      try {
        const loaded = await loadGuide()
        const guide = parseGuide(loaded.text)
        const { text: body, missing } = selectGuide(guide, modules)

        const notes: string[] = [`<!-- fuente: ${loaded.source} -->`]
        if (loaded.stale) {
          notes.push(`> ⚠️ No se ha podido releer la guía (${loaded.stale}); esta es la última copia en memoria.`)
        }
        if (missing.length > 0) {
          notes.push(
            `> Sin sección en la guía para: ${missing.join(', ')}. Mira get_module_fields. Módulos con sección: ${guideModules(guide).join(', ')}.`,
          )
        }
        return text([...notes, '', body].join('\n'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return text(message, !(error instanceof GuideNotConfiguredError))
      }
    },
  )
}
