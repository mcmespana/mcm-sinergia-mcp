/**
 * Lectura de un campo largo (p.ej. el cuerpo HTML de un email) entero, sin el
 * recorte de MAX_FIELD_CHARS que se aplica en los listados, troceado para que
 * cada respuesta quepa en el contexto del modelo.
 */

import { z } from 'zod'

/** Caracteres por trozo por defecto y tope duro (~10k tokens). */
export const DEFAULT_CHUNK_CHARS = 20_000
export const MAX_CHUNK_CHARS = 40_000

export const FIELD_FORMATS = ['raw', 'text'] as const
export type FieldFormat = (typeof FIELD_FORMATS)[number]

/** Parámetros comunes de las tools que leen un campo completo. */
export const chunkInputShape = {
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Carácter desde el que leer (0 por defecto). Para seguir leyendo pasa el "siguiente_offset" de la respuesta anterior.'),
  max_chars: z
    .number()
    .int()
    .min(1)
    .max(MAX_CHUNK_CHARS)
    .optional()
    .describe(`Caracteres por trozo (${DEFAULT_CHUNK_CHARS} por defecto, tope ${MAX_CHUNK_CHARS}).`),
  format: z
    .enum(FIELD_FORMATS)
    .optional()
    .describe('"raw" (por defecto) devuelve el valor tal cual. "text" convierte HTML a texto plano (quita estilos, scripts y etiquetas), que suele ocupar muchísimo menos en emails.'),
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  iexcl: '¡',
  iquest: '¿',
  euro: '€',
  laquo: '«',
  raquo: '»',
  ordf: 'ª',
  ordm: 'º',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  ccedil: 'ç',
  Ccedil: 'Ç',
}

/** HTML → texto plano legible: saltos en bloques, enlaces como "texto (url)". */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return !text || text === href ? href : `${text} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table|blockquote)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name] ?? match)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface FieldChunk {
  campo: string
  formato: FieldFormat
  total_caracteres: number
  desde: number
  hasta: number
  completo: boolean
  siguiente_offset?: number
  aviso?: string
  valor: string | null
}

/** Devuelve el trozo [offset, offset + maxChars) del valor del campo. */
export function chunkField(
  field: string,
  value: unknown,
  options: { offset?: number; maxChars?: number; format?: FieldFormat },
): FieldChunk {
  const format = options.format ?? 'raw'
  if (value === null || value === undefined) {
    return { campo: field, formato: format, total_caracteres: 0, desde: 0, hasta: 0, completo: true, valor: null }
  }

  const raw =
    typeof value === 'string'
      ? value
      : Buffer.isBuffer(value)
        ? value.toString('utf8')
        : JSON.stringify(value)
  const text = format === 'text' ? htmlToText(raw) : raw

  const size = Math.min(options.maxChars ?? DEFAULT_CHUNK_CHARS, MAX_CHUNK_CHARS)
  const from = Math.min(options.offset ?? 0, text.length)
  const to = Math.min(from + size, text.length)
  const complete = from === 0 && to === text.length
  const more = to < text.length

  return {
    campo: field,
    formato: format,
    total_caracteres: text.length,
    desde: from,
    hasta: to,
    completo: complete,
    ...(more
      ? {
          siguiente_offset: to,
          aviso: `Quedan ${text.length - to} caracteres: vuelve a llamar con offset=${to} para el siguiente trozo (${Math.ceil((text.length - to) / size)} más).`,
        }
      : {}),
    valor: text.slice(from, to),
  }
}
