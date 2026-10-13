/**
 * Tools MCP de documentación: manual de SinergiaCRM y de SinergiaDA en la wiki
 * de SinergiaTIC. Solo lectura y no necesitan credenciales del CRM.
 */

import { z } from 'zod'
import {
  MANUAL_IDS,
  type ManualId,
  getCorpus,
  getIndex,
  readPage,
  searchCorpus,
} from '../wiki/manual'
import { guarded, type ToolServer } from './tools'

const STALE_NOTE =
  'La wiki no responde ahora mismo: estos datos son de la última copia en memoria y pueden estar algo desactualizados.'

const manualField = z
  .enum(['crm', 'da', 'todos'])
  .optional()
  .describe(
    'Qué manual: "crm" (Manual de SinergiaCRM, el principal), "da" (Manual de SinergiaDA, la herramienta de informes/Data Analytics) o "todos" (por defecto).',
  )

const indexInput = z.object({ manual: manualField })

const searchInput = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      'Qué buscar, en castellano y con palabras clave, p.ej. "recuperar registro borrado" o "remesas SEPA".',
    ),
  manual: manualField,
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Número máximo de resultados (8 por defecto).'),
})

const readInput = z.object({
  page: z
    .string()
    .describe(
      'Título de la página tal cual sale en docs_index o docs_search (p.ej. "Eliminación de datos"). También vale la URL de la wiki.',
    ),
  section: z
    .string()
    .optional()
    .describe(
      'Opcional: título (o parte) de una sección, o su número en "secciones", para leer solo esa parte. Recomendable en páginas largas.',
    ),
})

function selected(manual?: string): ManualId[] {
  return !manual || manual === 'todos' ? MANUAL_IDS : [manual as ManualId]
}

export function registerDocsTools(server: ToolServer): void {
  server.registerTool(
    'docs_index',
    {
      title: 'Índice del manual',
      description:
        'Índice del manual oficial de SinergiaCRM (y del de SinergiaDA) de la wiki de SinergiaTIC: páginas agrupadas por bloque (Funcionamiento general, Módulos funcionales, Administración, Desarrolladores…). Úsalo para orientarte y luego docs_read para leer una página.',
      inputSchema: indexInput,
    },
    guarded(async ({ manual }: z.infer<typeof indexInput>) => {
      const { value: indexes, stale } = await getIndex()
      const manuals = indexes
        .filter((index) => selected(manual).includes(index.manual))
        .map((index) => {
          const sections: Record<string, string[]> = {}
          for (const entry of index.entries) {
            ;(sections[entry.section] ??= []).push(entry.title)
          }
          return { manual: index.manual, nombre: index.name, url: index.url, secciones: sections }
        })
      return stale ? { aviso: STALE_NOTE, manuales: manuals } : { manuales: manuals }
    }),
  )

  server.registerTool(
    'docs_search',
    {
      title: 'Buscar en el manual',
      description:
        'Busca en el texto completo del manual oficial de SinergiaCRM y de SinergiaDA (cómo se hace algo, qué significa un campo, cómo funciona un módulo, configuración, API…). Devuelve las secciones más relevantes con un fragmento y su URL. Después usa docs_read con la página y la sección para leer el detalle. Consúltalo antes de explicar cómo funciona SinergiaCRM en vez de suponerlo.',
      inputSchema: searchInput,
    },
    guarded(async ({ query, manual, limit }: z.infer<typeof searchInput>) => {
      const { value: corpus, stale } = await getCorpus()
      const scope = selected(manual)
      const results = searchCorpus(
        corpus.docs.filter((doc) => scope.includes(doc.manual)),
        query,
        limit ?? 8,
      )
      return {
        ...(stale ? { aviso: STALE_NOTE } : {}),
        ...(corpus.failed.length > 0
          ? {
              aviso_paginas_no_disponibles: `La wiki no ha devuelto estas páginas y no se han buscado: ${corpus.failed.join(', ')}. Si parecen las relevantes, prueba docs_read con ellas.`,
            }
          : {}),
        consulta: query,
        resultados: results,
        ...(results.length === 0
          ? {
              sugerencia:
                'Sin resultados: prueba con otras palabras (sinónimos, nombre del módulo) o mira docs_index.',
            }
          : {}),
      }
    }),
  )

  server.registerTool(
    'docs_read',
    {
      title: 'Leer página del manual',
      description:
        'Lee una página del manual de SinergiaCRM/SinergiaDA (versión en castellano) convertida a markdown. Devuelve también la lista de secciones y las páginas enlazadas. Cita la URL cuando uses la información.',
      inputSchema: readInput,
    },
    guarded(async ({ page, section }: z.infer<typeof readInput>) => readPage(page, section)),
  )
}
