/** Tipos mínimos de JSON:API tal y como los devuelve SuiteCRM 7.x V8. */

export interface JsonApiResource {
  type?: string
  id?: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, unknown>
  links?: Record<string, unknown>
}

export interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[]
  meta?: Record<string, unknown>
  links?: Record<string, unknown>
  errors?: unknown
}

/** Definición de un campo devuelta por GET /Api/V8/meta/fields/{module}. */
export interface VardefLike {
  type?: string
  dbType?: string
  required?: boolean | string | number
  vname?: string
  len?: number | string
  default?: unknown
  source?: string
  relationship?: string
  comment?: string
  precision?: number | string
}
