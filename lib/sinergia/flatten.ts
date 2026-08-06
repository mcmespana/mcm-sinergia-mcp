/**
 * Aplanado de JSON:API a estructuras compactas.
 *
 * SuiteCRM devuelve documentos muy verbosos (data.attributes con 150+ campos,
 * relationships con links por cada link field, etc.). Volcarlos crudos al
 * modelo gasta contexto a lo tonto, así que aquí se reducen a lo útil.
 */

import { MAX_FIELD_CHARS } from '../config'
import type { JsonApiDocument, JsonApiResource, VardefLike } from './types'

export interface FlatRecord {
  id?: string
  module?: string
  [key: string]: unknown
}

interface FlattenOptions {
  /** Añade la lista de nombres de relaciones disponibles del registro. */
  includeRelationshipNames?: boolean
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as object).length === 0
  }
  return false
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) {
    return `${value.slice(0, MAX_FIELD_CHARS)}… [truncado, ${value.length} caracteres]`
  }
  return value
}

function cleanAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (isEmptyValue(value)) continue
    // deleted=0 aparece en todos los registros y no aporta nada: la API ya
    // excluye los borrados por defecto.
    if (key === 'deleted' && (value === 0 || value === '0' || value === false)) continue
    result[key] = truncate(value)
  }
  return result
}

export function flattenResource(
  resource: JsonApiResource,
  options: FlattenOptions = {},
): FlatRecord {
  const record: FlatRecord = {}

  if (resource.id) record.id = resource.id
  if (resource.type) record.module = resource.type

  Object.assign(record, cleanAttributes(resource.attributes ?? {}))

  if (options.includeRelationshipNames && resource.relationships) {
    const names = Object.keys(resource.relationships)
    if (names.length > 0) record.relationships_disponibles = names
  }

  return record
}

function asResourceArray(data: JsonApiDocument['data']): JsonApiResource[] {
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

export interface FlatCollection {
  module: string
  page: number
  page_size: number
  count: number
  total_pages?: number
  records: FlatRecord[]
  nota?: string
}

export function flattenCollection(
  document: JsonApiDocument,
  context: { module: string; page: number; pageSize: number },
): FlatCollection {
  const records = asResourceArray(document.data).map((resource) => flattenResource(resource))
  const meta = document.meta ?? {}
  const totalPages = Number(meta['total-pages'] ?? meta.total_pages)

  const collection: FlatCollection = {
    module: context.module,
    page: context.page,
    page_size: context.pageSize,
    count: records.length,
    records,
  }

  // SuiteCRM lo manda como entero, pero algunas versiones lo serializan como texto.
  if (Number.isFinite(totalPages)) {
    collection.total_pages = totalPages
  }

  if (typeof meta.message === 'string' && records.length === 0) {
    collection.nota = meta.message
  }

  return collection
}

/** GET /Api/V8/meta/modules → data.attributes = { Modulo: { label, acls… } } */
export interface FlatModule {
  module: string
  label?: string
  acl?: Record<string, unknown>
}

export function flattenModules(document: JsonApiDocument): {
  count: number
  modules: FlatModule[]
} {
  const attributes = (asResourceArray(document.data)[0]?.attributes ?? {}) as Record<
    string,
    unknown
  >

  const modules: FlatModule[] = Object.entries(attributes)
    .map(([module, value]) => {
      if (!value || typeof value !== 'object') {
        return { module, label: typeof value === 'string' ? value : undefined }
      }
      const info = value as Record<string, unknown>
      const acl = info.acls ?? info.acl
      return {
        module,
        label: typeof info.label === 'string' ? info.label : undefined,
        acl: acl && typeof acl === 'object' ? (acl as Record<string, unknown>) : undefined,
      }
    })
    .sort((a, b) => a.module.localeCompare(b.module))

  return { count: modules.length, modules }
}

/** GET /Api/V8/meta/fields/{module} → data.attributes = { campo: vardef } */
export interface FlatField {
  name: string
  type?: string
  required?: boolean
  label?: string
  len?: number | string
  default?: unknown
  relationship?: string
  /** Solo para campos con source=custom_fields (los "_c" de SinergiaCRM). */
  custom?: true
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function flattenFields(
  document: JsonApiDocument,
  filters: { module: string; nameContains?: string },
): { module: string; count: number; total_fields: number; fields: FlatField[]; nota?: string } {
  const attributes = (asResourceArray(document.data)[0]?.attributes ?? {}) as Record<
    string,
    VardefLike
  >

  const needle = filters.nameContains?.trim().toLowerCase()

  const all = Object.entries(attributes)
  const fields: FlatField[] = all
    .filter(([name, def]) => {
      if (!needle) return true
      const label = typeof def?.vname === 'string' ? def.vname.toLowerCase() : ''
      return name.toLowerCase().includes(needle) || label.includes(needle)
    })
    .map(([name, def]) => {
      const field: FlatField = { name }
      if (def?.type) field.type = String(def.type)
      if (toBoolean(def?.required)) field.required = true
      if (def?.vname) field.label = String(def.vname)
      if (def?.len !== undefined && def.len !== '') field.len = def.len
      if (def?.default !== undefined && def.default !== '' && def.default !== null) {
        field.default = def.default
      }
      if (def?.relationship) field.relationship = String(def.relationship)
      if (def?.source === 'custom_fields') field.custom = true
      return field
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const result = {
    module: filters.module,
    count: fields.length,
    total_fields: all.length,
    fields,
  }

  if (needle && fields.length === 0) {
    return { ...result, nota: `Ningún campo coincide con "${filters.nameContains}".` }
  }

  return result
}
