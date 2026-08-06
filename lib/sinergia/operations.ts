/**
 * Operaciones de alto nivel sobre la API V8: llaman al cliente HTTP y
 * devuelven ya la versión aplanada y compacta de la respuesta.
 *
 * Aquí NO hay borrado. Ni lo habrá.
 */

import { apiRequest, type QueryParams } from './client'
import {
  flattenCollection,
  flattenFields,
  flattenModules,
  flattenResource,
  type FlatCollection,
  type FlatRecord,
} from './flatten'
import {
  assertFieldName,
  assertModuleName,
  assertRecordId,
  buildFieldsParams,
  buildFilterParams,
  buildListQuery,
  buildPageParams,
  buildSortParams,
  clampPageSize,
  type StructuredFilter,
} from './query'
import { SinergiaInputError } from './errors'
import type { JsonApiDocument } from './types'

export async function getAvailableModules() {
  const document = await apiRequest<JsonApiDocument>('GET', '/meta/modules')
  return flattenModules(document)
}

export async function getModuleFields(module: string, nameContains?: string) {
  const moduleName = assertModuleName(module)
  const document = await apiRequest<JsonApiDocument>('GET', `/meta/fields/${moduleName}`)
  return flattenFields(document, { module: moduleName, nameContains })
}

export async function getEntry(
  module: string,
  id: string,
  fields?: string[],
): Promise<FlatRecord> {
  const moduleName = assertModuleName(module)
  const recordId = assertRecordId(id)
  const query = buildFieldsParams(moduleName, fields)

  const document = await apiRequest<JsonApiDocument>(
    'GET',
    `/module/${moduleName}/${recordId}`,
    { query },
  )

  const data = Array.isArray(document.data) ? document.data[0] : document.data
  if (!data) {
    throw new SinergiaInputError(`No se encontró el registro ${recordId} en ${moduleName}.`)
  }

  return flattenResource(data, { includeRelationshipNames: true })
}

export interface EntryListOptions {
  module: string
  filter?: StructuredFilter
  sort?: string
  page?: number
  pageSize?: number
  fields?: string[]
}

export async function getEntryList(options: EntryListOptions): Promise<FlatCollection> {
  const moduleName = assertModuleName(options.module)
  const page = options.page && options.page > 0 ? Math.trunc(options.page) : 1
  const pageSize = clampPageSize(options.pageSize)

  const query = buildListQuery({ ...options, module: moduleName, page, pageSize })
  const document = await apiRequest<JsonApiDocument>('GET', `/module/${moduleName}`, { query })

  return flattenCollection(document, { module: moduleName, page, pageSize })
}

export interface RelationshipListOptions {
  module: string
  id: string
  relationship: string
  page?: number
  pageSize?: number
  sort?: string
}

export async function getRelationships(options: RelationshipListOptions) {
  const moduleName = assertModuleName(options.module)
  const recordId = assertRecordId(options.id)
  const linkField = assertFieldName(options.relationship)
  const page = options.page && options.page > 0 ? Math.trunc(options.page) : 1
  const pageSize = clampPageSize(options.pageSize)

  const query: QueryParams = [
    ...buildSortParams(options.sort),
    ...buildPageParams(page, pageSize),
  ]

  const document = await apiRequest<JsonApiDocument>(
    'GET',
    `/module/${moduleName}/${recordId}/relationships/${linkField}`,
    { query },
  )

  const collection = flattenCollection(document, { module: moduleName, page, pageSize })

  return {
    module: moduleName,
    id: recordId,
    relationship: linkField,
    page: collection.page,
    page_size: collection.page_size,
    count: collection.count,
    related: collection.records,
    ...(collection.nota ? { nota: collection.nota } : {}),
  }
}

// ---------------------------------------------------------------------------
// Escritura (solo se expone como tool MCP si ALLOW_WRITES=true)
// ---------------------------------------------------------------------------

function assertAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(attributes ?? {})
  if (entries.length === 0) {
    throw new SinergiaInputError('Debes indicar al menos un atributo.')
  }
  for (const [field] of entries) {
    assertFieldName(field)
  }
  return attributes
}

export async function createEntry(
  module: string,
  attributes: Record<string, unknown>,
): Promise<FlatRecord> {
  const moduleName = assertModuleName(module)
  assertAttributes(attributes)

  const document = await apiRequest<JsonApiDocument>('POST', '/module', {
    body: { data: { type: moduleName, attributes } },
  })

  const data = Array.isArray(document.data) ? document.data[0] : document.data
  return data ? flattenResource(data) : { module: moduleName }
}

export async function updateEntry(
  module: string,
  id: string,
  attributes: Record<string, unknown>,
): Promise<FlatRecord> {
  const moduleName = assertModuleName(module)
  const recordId = assertRecordId(id)
  assertAttributes(attributes)

  const document = await apiRequest<JsonApiDocument>('PATCH', '/module', {
    body: { data: { type: moduleName, id: recordId, attributes } },
  })

  const data = Array.isArray(document.data) ? document.data[0] : document.data
  return data ? flattenResource(data) : { module: moduleName, id: recordId }
}

export interface SetRelationshipOptions {
  module: string
  id: string
  relationship: string
  relatedModule: string
  relatedId: string
}

export async function setRelationship(options: SetRelationshipOptions) {
  const moduleName = assertModuleName(options.module)
  const recordId = assertRecordId(options.id)
  const linkField = assertFieldName(options.relationship)
  const relatedModule = assertModuleName(options.relatedModule)
  const relatedId = assertRecordId(options.relatedId)

  const document = await apiRequest<JsonApiDocument>(
    'POST',
    `/module/${moduleName}/${recordId}/relationships/${linkField}`,
    { body: { data: { type: relatedModule, id: relatedId } } },
  )

  const data = Array.isArray(document.data) ? document.data[0] : document.data

  return {
    ok: true,
    module: moduleName,
    id: recordId,
    relationship: linkField,
    related_module: relatedModule,
    related_id: relatedId,
    ...(data ? { resultado: flattenResource(data) } : {}),
  }
}
