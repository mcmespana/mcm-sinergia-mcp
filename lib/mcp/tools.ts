/**
 * Registro de las tools MCP sobre SinergiaCRM.
 *
 * - Lectura: siempre disponible.
 * - Escritura: solo si ALLOW_WRITES=true (si no, las tools ni se registran,
 *   así que el modelo no las ve en tools/list).
 * - Borrado: NO existe. No se implementa ninguna tool de borrado.
 */

import { z } from 'zod'
import { MAX_PAGE_SIZE, writesAllowed } from '../config'
import { describeError } from '../sinergia/errors'
import { FILTER_OPERATORS, LOGICAL_OPERATORS } from '../sinergia/query'
import {
  createEntry,
  getAvailableModules,
  getEntry,
  getEntryList,
  getModuleFields,
  getRelationships,
  setRelationship,
  updateEntry,
} from '../sinergia/operations'

/** Interfaz mínima del servidor MCP que necesitamos (evita acoplarnos al tipo exacto del SDK). */
export interface ToolServer {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: unknown },
    handler: (args: never) => Promise<ToolResult>,
  ): unknown
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${describeError(error)}` }], isError: true }
}

/** Envuelve el handler para que ningún fallo tumbe la petición MCP. */
function guarded<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await handler(args))
    } catch (error) {
      return fail(error)
    }
  }
}

const moduleField = z
  .string()
  .describe(
    'Nombre técnico del módulo, p.ej. "Contacts", "Accounts" o un módulo custom de SinergiaCRM como "stic_Subvenciones". Úsalo tal cual lo devuelve get_available_modules.',
  )

const idField = z.string().describe('Id (UUID) del registro.')

const fieldsField = z
  .array(z.string())
  .optional()
  .describe(
    'Lista de campos a devolver (sparse fieldset). Muy recomendable: sin él la API devuelve todos los campos del módulo y la respuesta se dispara.',
  )

const filterSchema = z
  .object({
    operator: z
      .enum(LOGICAL_OPERATORS)
      .optional()
      .describe('Cómo se combinan las condiciones. Por defecto "and".'),
    conditions: z
      .array(
        z.object({
          field: z.string().describe('Nombre técnico del campo (ver get_module_fields).'),
          operator: z
            .enum(FILTER_OPERATORS)
            .describe(
              'Operador de comparación. Con "like" tienes que poner tú los comodines %, p.ej. "%Garcia%".',
            ),
          value: z.union([z.string(), z.number(), z.boolean()]).describe('Valor a comparar.'),
        }),
      )
      .min(1)
      .describe('Condiciones del filtro.'),
  })
  .describe(
    'Filtro estructurado (nunca SQL). Se traduce a filter[campo][operador]=valor en la API V8.',
  )

export function registerSinergiaTools(server: ToolServer): void {
  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_available_modules',
    {
      title: 'Listar módulos',
      description:
        'Lista los módulos disponibles en SinergiaCRM (estándar y custom: Subvenciones, Proyectos, Atenciones, Valoraciones…) con su etiqueta y los permisos ACL del usuario API. Empieza siempre por aquí si no sabes el nombre técnico de un módulo.',
      inputSchema: z.object({}),
    },
    guarded(async () => getAvailableModules()),
  )

  server.registerTool(
    'get_module_fields',
    {
      title: 'Campos de un módulo',
      description:
        'Devuelve la definición de campos de un módulo (nombre técnico, tipo, obligatoriedad, etiqueta y si es campo custom). Usa name_contains para no traerte los cientos de campos de los módulos grandes.',
      inputSchema: z.object({
        module: moduleField,
        name_contains: z
          .string()
          .optional()
          .describe('Filtra los campos cuyo nombre o etiqueta contenga este texto.'),
      }),
      },
    guarded(async ({ module, name_contains }: { module: string; name_contains?: string }) =>
      getModuleFields(module, name_contains),
    ),
  )

  server.registerTool(
    'get_entry',
    {
      title: 'Obtener un registro',
      description:
        'Recupera un registro concreto de un módulo por su id. Incluye la lista de relaciones disponibles del registro, que puedes usar en get_relationships.',
      inputSchema: z.object({
        module: moduleField,
        id: idField,
        fields: fieldsField,
      }),
    },
    guarded(async ({ module, id, fields }: { module: string; id: string; fields?: string[] }) =>
      getEntry(module, id, fields),
    ),
  )

  server.registerTool(
    'get_entry_list',
    {
      title: 'Listar registros',
      description:
        `Lista registros de un módulo con filtros estructurados, orden y paginación. El tamaño de página se limita a ${MAX_PAGE_SIZE}. Los registros borrados se excluyen automáticamente.`,
      inputSchema: z.object({
        module: moduleField,
        filter: filterSchema.optional(),
        sort: z
          .string()
          .optional()
          .describe('Campo de orden. Prefija con "-" para descendente, p.ej. "-date_entered".'),
        page: z.number().int().min(1).optional().describe('Número de página (empieza en 1).'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Registros por página (máximo ${MAX_PAGE_SIZE}).`),
        fields: fieldsField,
      }),
    },
    guarded(
      async (args: {
        module: string
        filter?: { operator?: 'and' | 'or'; conditions: Array<{ field: string; operator: (typeof FILTER_OPERATORS)[number]; value: string | number | boolean }> }
        sort?: string
        page?: number
        page_size?: number
        fields?: string[]
      }) =>
        getEntryList({
          module: args.module,
          filter: args.filter,
          sort: args.sort,
          page: args.page,
          pageSize: args.page_size,
          fields: args.fields,
        }),
    ),
  )

  server.registerTool(
    'get_relationships',
    {
      title: 'Registros relacionados',
      description:
        'Devuelve los registros relacionados con uno dado a través de un link field (p.ej. "contacts", "stic_contacts_relationships"). Los nombres válidos salen en el campo relationships_disponibles de get_entry.',
      inputSchema: z.object({
        module: moduleField,
        id: idField,
        relationship: z
          .string()
          .describe('Nombre del link field / relación tal y como aparece en el módulo.'),
        page: z.number().int().min(1).optional().describe('Número de página (empieza en 1).'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Registros por página (máximo ${MAX_PAGE_SIZE}).`),
        sort: z.string().optional().describe('Campo de orden, "-campo" para descendente.'),
      }),
    },
    guarded(
      async (args: {
        module: string
        id: string
        relationship: string
        page?: number
        page_size?: number
        sort?: string
      }) =>
        getRelationships({
          module: args.module,
          id: args.id,
          relationship: args.relationship,
          page: args.page,
          pageSize: args.page_size,
          sort: args.sort,
        }),
    ),
  )

  // -------------------------------------------------------------------------
  // Escritura — solo con ALLOW_WRITES=true
  // -------------------------------------------------------------------------

  if (!writesAllowed()) {
    return
  }

  server.registerTool(
    'create_entry',
    {
      title: 'Crear registro',
      description:
        'Crea un registro nuevo en un módulo. Comprueba antes con get_module_fields qué campos existen y cuáles son obligatorios. Escribe en el CRM real: confirma con la persona usuaria antes de usarla.',
      inputSchema: z.object({
        module: moduleField,
        attributes: z
          .record(z.string(), z.unknown())
          .describe('Pares campo→valor con los datos del nuevo registro.'),
      }),
    },
    guarded(async ({ module, attributes }: { module: string; attributes: Record<string, unknown> }) =>
      createEntry(module, attributes),
    ),
  )

  server.registerTool(
    'update_entry',
    {
      title: 'Actualizar registro',
      description:
        'Actualiza los campos indicados de un registro existente. Solo se modifican los campos que envíes. Escribe en el CRM real: confirma con la persona usuaria antes de usarla.',
      inputSchema: z.object({
        module: moduleField,
        id: idField,
        attributes: z
          .record(z.string(), z.unknown())
          .describe('Pares campo→valor a modificar.'),
      }),
    },
    guarded(
      async ({
        module,
        id,
        attributes,
      }: {
        module: string
        id: string
        attributes: Record<string, unknown>
      }) => updateEntry(module, id, attributes),
    ),
  )

  server.registerTool(
    'set_relationship',
    {
      title: 'Crear relación',
      description:
        'Relaciona dos registros a través de un link field. Escribe en el CRM real: confirma con la persona usuaria antes de usarla.',
      inputSchema: z.object({
        module: moduleField,
        id: idField,
        relationship: z.string().describe('Link field del módulo origen.'),
        related_module: z.string().describe('Módulo del registro relacionado.'),
        related_id: z.string().describe('Id del registro relacionado.'),
      }),
    },
    guarded(
      async (args: {
        module: string
        id: string
        relationship: string
        related_module: string
        related_id: string
      }) =>
        setRelationship({
          module: args.module,
          id: args.id,
          relationship: args.relationship,
          relatedModule: args.related_module,
          relatedId: args.related_id,
        }),
    ),
  )
}
