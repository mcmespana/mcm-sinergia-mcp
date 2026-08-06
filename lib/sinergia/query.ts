/**
 * Construcción y validación de query strings para la API V8.
 *
 * Los filtros son SIEMPRE estructurados: nunca se acepta SQL crudo. Los
 * nombres de módulo y de campo se validan contra una whitelist de caracteres
 * y los valores viajan como parámetros separados (SuiteCRM los escapa con
 * DBManager::quoted antes de construir el WHERE).
 */

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config'
import { SinergiaInputError } from './errors'
import type { QueryParams } from './client'

/** Operadores de comparación soportados por Api\V8\JsonApi\Repository\Filter. */
export const FILTER_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like'] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export const LOGICAL_OPERATORS = ['and', 'or'] as const
export type LogicalOperator = (typeof LOGICAL_OPERATORS)[number]

export interface FilterCondition {
  field: string
  operator: FilterOperator
  value: string | number | boolean
}

export interface StructuredFilter {
  operator?: LogicalOperator
  conditions: FilterCondition[]
}

export interface ListQueryOptions {
  module: string
  filter?: StructuredFilter
  sort?: string
  page?: number
  pageSize?: number
  fields?: string[]
}

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const UUID_LIKE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Valida un nombre de módulo (incluye los custom tipo stic_Subvenciones). */
export function assertModuleName(module: string): string {
  if (!IDENTIFIER_RE.test(module)) {
    throw new SinergiaInputError(
      `Nombre de módulo inválido: "${module}". Usa el nombre técnico del módulo (get_available_modules).`,
    )
  }
  return module
}

export function assertFieldName(field: string): string {
  if (!IDENTIFIER_RE.test(field)) {
    throw new SinergiaInputError(
      `Nombre de campo inválido: "${field}". Solo letras, números y guion bajo (get_module_fields).`,
    )
  }
  return field
}

export function assertRecordId(id: string): string {
  if (!UUID_LIKE_RE.test(id)) {
    throw new SinergiaInputError(`Id de registro inválido: "${id}".`)
  }
  return id
}

export function clampPageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(pageSize), 1), MAX_PAGE_SIZE)
}

function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page)) return 1
  return Math.max(Math.trunc(page), 1)
}

function serializeValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}

/** filter[campo][op]=valor  (+ filter[operator]=and|or si hay varias condiciones) */
export function buildFilterParams(filter: StructuredFilter): QueryParams {
  const params: QueryParams = []

  if (filter.conditions.length === 0) {
    throw new SinergiaInputError('El filtro debe incluir al menos una condición.')
  }

  if (filter.conditions.length > 1) {
    params.push(['filter[operator]', filter.operator ?? 'and'])
  }

  for (const condition of filter.conditions) {
    const field = assertFieldName(condition.field)
    if (!FILTER_OPERATORS.includes(condition.operator)) {
      throw new SinergiaInputError(
        `Operador de filtro inválido: "${condition.operator}". Válidos: ${FILTER_OPERATORS.join(', ')}.`,
      )
    }
    params.push([`filter[${field}][${condition.operator}]`, serializeValue(condition.value)])
  }

  return params
}

/** fields[Modulo]=campo1,campo2 (sparse fieldsets de JSON:API) */
export function buildFieldsParams(module: string, fields?: string[]): QueryParams {
  if (!fields || fields.length === 0) return []
  const clean = fields.map(assertFieldName)
  return [[`fields[${module}]`, clean.join(',')]]
}

/** sort=campo | sort=-campo (el guion es descendente) */
export function buildSortParams(sort?: string): QueryParams {
  if (!sort) return []
  const descending = sort.startsWith('-')
  const field = assertFieldName(descending ? sort.slice(1) : sort)
  return [['sort', descending ? `-${field}` : field]]
}

export function buildPageParams(page?: number, pageSize?: number): QueryParams {
  return [
    ['page[number]', String(normalizePage(page))],
    ['page[size]', String(clampPageSize(pageSize))],
  ]
}

export function buildListQuery(options: ListQueryOptions): QueryParams {
  const module = assertModuleName(options.module)

  return [
    ...buildFieldsParams(module, options.fields),
    ...(options.filter ? buildFilterParams(options.filter) : []),
    ...buildSortParams(options.sort),
    ...buildPageParams(options.page, options.pageSize),
  ]
}
