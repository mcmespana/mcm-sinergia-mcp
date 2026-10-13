/**
 * Utilidades sobre wikitexto de MediaWiki:
 *
 * - Sacar el índice (secciones y páginas enlazadas) de las páginas
 *   "Manual de SinergiaCRM" / "Manual de SinergiaDA".
 * - Convertir el wikitexto de una página a un markdown legible para el modelo.
 * - Partir ese markdown por secciones.
 *
 * No pretende ser un parser completo de MediaWiki: cubre lo que usa el manual
 * de SinergiaTIC (enlaces, imágenes, listas, tablas, código, plantillas
 * sencillas y las marcas de la extensión Translate).
 */

const MY_LANGUAGE_PREFIX = /^(?:Especial|Special):(?:MiIdioma|MyLanguage)\//i
const IGNORED_NAMESPACES =
  /^(?:File|Archivo|Imagen|Image|Media|Category|Categoría|Categoria|Plantilla|Template)\s*:/i
const NON_ARTICLE_NAMESPACE = /^[A-Za-zÀ-ÿ]+\s*:/

export interface IndexEntry {
  /** Título de la página tal cual se enlaza desde el manual (sin /es). */
  title: string
  /** Texto del enlace en el índice. */
  label: string
  /** Sección del índice en la que aparece. */
  section: string
}

export interface MarkdownSection {
  heading: string
  level: number
  content: string
}

/** Normaliza un título de página: guiones bajos → espacios, sin anclas ni prefijo MyLanguage. */
export function normalizeTitle(raw: string): string {
  return raw
    .replace(MY_LANGUAGE_PREFIX, '')
    .replace(/#.*$/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Busca bloques equilibrados open…close (p.ej. [[…]] o {{…}}) y los sustituye.
 * Respeta el anidamiento, que en MediaWiki es habitual: [[File:x|texto con [[enlace]]]].
 */
function replaceBalanced(
  text: string,
  open: string,
  close: string,
  fn: (inner: string) => string,
): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf(open, i)
    if (start === -1) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, start)

    let depth = 0
    let j = start
    let end = -1
    while (j < text.length) {
      if (text.startsWith(open, j)) {
        depth++
        j += open.length
      } else if (text.startsWith(close, j)) {
        depth--
        j += close.length
        if (depth === 0) {
          end = j
          break
        }
      } else {
        j++
      }
    }

    if (end === -1) {
      // Sin cierre: se deja la apertura como texto y se sigue buscando detrás.
      out += open
      i = start + open.length
      continue
    }

    out += fn(text.slice(start + open.length, end - close.length))
    i = end
  }
  return out
}

/** Quita comentarios y las marcas de la extensión Translate. */
function stripTranslateMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<languages\s*\/?>/gi, '')
    .replace(/<\/?translate[^>]*>/gi, '')
    .replace(/<tvar[^>]*>|<\/tvar>/gi, '')
    .replace(/__[A-Z]+__/g, '')
}

/** Extrae el índice de una página tipo "Manual de …": enlaces internos agrupados por sección. */
export function parseManualIndex(wikitext: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  const seen = new Set<string>()
  let section = 'General'

  for (const line of stripTranslateMarkup(wikitext).split('\n')) {
    const heading = line.match(/^(={1,6})\s*(.+?)\s*\1\s*$/)
    if (heading) {
      section = heading[2].replace(/'{2,}/g, '').trim()
      continue
    }

    for (const match of line.matchAll(/\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]/g)) {
      const rawTarget = match[1].trim()
      if (rawTarget.startsWith('#') || IGNORED_NAMESPACES.test(rawTarget)) continue
      const hasMyLanguage = MY_LANGUAGE_PREFIX.test(rawTarget)
      if (!hasMyLanguage && NON_ARTICLE_NAMESPACE.test(rawTarget)) continue

      const title = normalizeTitle(rawTarget)
      if (!title || seen.has(title)) continue
      seen.add(title)

      const label = (match[2] ?? '').replace(/'{2,}/g, '').trim() || title
      entries.push({ title, label, section })
    }
  }

  return entries
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
}

function convertInlineFormatting(line: string): string {
  return line
    .replace(/'''''(.+?)'''''/g, '***$1***')
    .replace(/'''(.+?)'''/g, '**$1**')
    .replace(/''(.+?)''/g, '*$1*')
}

/** Convierte una tabla wiki ({| … |}) en una tabla markdown sencilla. */
function convertTable(lines: string[]): string[] {
  const rows: string[][] = []
  let current: string[] | null = null
  let caption = ''

  const cleanCell = (cell: string) => {
    // "style="…" | contenido" → "contenido"
    const attr = cell.match(/^\s*[a-z-]+\s*=\s*"[^"]*"(?:\s+[a-z-]+\s*=\s*"[^"]*")*\s*\|(.*)$/i)
    return (attr ? attr[1] : cell).trim().replace(/\|/g, '\\|')
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('{|') || line.startsWith('|}')) continue
    if (line.startsWith('|+')) {
      caption = line.slice(2).trim()
      continue
    }
    if (line.startsWith('|-')) {
      current = null
      continue
    }
    if (line.startsWith('|') || line.startsWith('!')) {
      if (!current) {
        current = []
        rows.push(current)
      }
      const separator = line.startsWith('!') ? /!!|\|\|/ : /\|\|/
      current.push(...line.slice(1).split(separator).map(cleanCell))
      continue
    }
    // Continuación multilínea de la última celda.
    if (current && current.length > 0 && line) {
      current[current.length - 1] += ` ${line}`
    }
  }

  const out: string[] = []
  if (caption) out.push(`**${caption}**`, '')
  rows.forEach((row, index) => {
    out.push(`| ${row.join(' | ')} |`)
    if (index === 0) out.push(`|${row.map(() => ' --- ').join('|')}|`)
  })
  return out
}

export interface ConvertedPage {
  markdown: string
  /** Páginas de la wiki enlazadas desde esta (sin repetir). */
  links: string[]
}

/** Convierte wikitexto a markdown legible. */
export function wikitextToMarkdown(wikitext: string): ConvertedPage {
  const placeholders: string[] = []
  const hold = (value: string) => {
    placeholders.push(value)
    return `\u0000${placeholders.length - 1}\u0000`
  }

  let text = stripTranslateMarkup(wikitext.replace(/\r\n?/g, '\n'))

  // Bloques de código y nowiki: se aíslan para no tocarlos.
  text = text.replace(
    /<(syntaxhighlight|source)([^>]*)>([\s\S]*?)<\/\1>/gi,
    (_m, _tag, attrs: string, code: string) => {
      const lang = attrs.match(/lang\s*=\s*"?([\w+-]+)/i)?.[1] ?? ''
      return hold(`\n\`\`\`${lang}\n${code.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n`)
    },
  )
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) =>
    hold(
      `\n\`\`\`\n${decodeEntities(code.replace(/<\/?nowiki>/gi, '')).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n`,
    ),
  )
  text = text.replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, (_m, inner: string) => hold(inner))
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, (_m, inner: string) => hold(`\`${inner}\``))

  text = text.replace(/<youtube[^>]*>\s*([^<\s]+)\s*<\/youtube>/gi, (_m, video: string) => {
    if (/^[\w-]+$/.test(video)) return `[Vídeo](https://www.youtube.com/watch?v=${video})`
    return `[Vídeo](${/^https?:\/\//i.test(video) ? video : `https://${video}`})`
  })
  text = text.replace(/<ref[^>]*\/>/gi, '')
  text = text.replace(/<ref[^>]*>([\s\S]*?)<\/ref>/gi, ' ($1)')

  // Plantillas: las funciones de parser ({{#…}}) se quitan; del resto se
  // conserva el texto de los parámetros, que suele ser el contenido útil.
  text = replaceBalanced(text, '{{', '}}', (inner) => {
    if (inner.trim().startsWith('#') || inner.trim().startsWith('!')) return ''
    const params = inner
      .split('|')
      .slice(1)
      .map((p) => p.replace(/^\s*[\w ]+\s*=/, '').trim())
      .filter(Boolean)
    return params.join(' — ')
  })

  // Enlaces internos, imágenes y categorías.
  const links: string[] = []
  text = replaceBalanced(text, '[[', ']]', (inner) => {
    const body = inner.replace(/^:/, '')
    if (IGNORED_NAMESPACES.test(body)) return ''
    const pipe = body.indexOf('|')
    const target = (pipe === -1 ? body : body.slice(0, pipe)).trim()
    const label = pipe === -1 ? '' : body.slice(pipe + 1).trim()
    if (target.startsWith('#')) return label || target.slice(1).replace(/_/g, ' ')
    const title = normalizeTitle(target)
    if (title && (MY_LANGUAGE_PREFIX.test(target) || !NON_ARTICLE_NAMESPACE.test(target))) {
      if (!links.includes(title)) links.push(title)
    }
    return label || title
  })

  // Enlaces externos.
  text = text.replace(
    /\[((?:https?:)?\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g,
    (_m, url: string, label?: string) => (label ? `[${label.trim()}](${url})` : url),
  )

  // HTML suelto.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>|<\/?(?:ul|ol)[^>]*>/gi, '')
    .replace(/<\/?(?:b|strong)>/gi, '**')
    .replace(/<\/?(?:i|em)>/gi, '*')
    .replace(
      /<\/?(?:span|div|font|center|small|big|u|s|p|sup|sub|blockquote|gallery|table|tr|td|th|tbody)[^>]*>/gi,
      '',
    )

  // Procesado línea a línea: tablas, títulos y listas.
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trim().startsWith('{|')) {
      const table: string[] = []
      while (i < lines.length) {
        table.push(lines[i])
        if (lines[i].trim().startsWith('|}')) break
        i++
      }
      out.push('', ...convertTable(table).map(convertInlineFormatting), '')
      continue
    }

    const heading = line.match(/^(={1,6})\s*(.+?)\s*\1\s*$/)
    if (heading) {
      out.push('', `${'#'.repeat(heading[1].length)} ${heading[2].replace(/'{2,}/g, '')}`, '')
      continue
    }

    const list = line.match(/^([*#:;]+)\s*(.*)$/)
    if (list) {
      const marks = list[1]
      const indent = '  '.repeat(marks.length - 1)
      const last = marks[marks.length - 1]
      const content = convertInlineFormatting(list[2])
      if (last === '*') out.push(`${indent}- ${content}`)
      else if (last === '#') out.push(`${indent}1. ${content}`)
      else if (last === ';') {
        const definition = content.match(/^(.*?)\s+:\s*(.*)$/)
        out.push(
          definition
            ? `${indent}**${definition[1]}**: ${definition[2]}`
            : `${indent}**${content}**`,
        )
      } else out.push(`${indent}${content}`)
      continue
    }

    out.push(convertInlineFormatting(line))
  }

  let markdown = decodeEntities(out.join('\n'))
  // eslint-disable-next-line no-control-regex
  // Un bloque aislado puede contener otro (p.ej. <nowiki> dentro de <code>).
  for (let pass = 0; pass < 5 && markdown.includes('\u0000'); pass++) {
    markdown = markdown.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => placeholders[Number(n)])
  }
  markdown = markdown
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { markdown, links }
}

/** Parte un markdown por sus títulos (ignorando los # dentro de bloques de código). */
export function splitSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  let current: MarkdownSection = { heading: 'Introducción', level: 1, content: '' }
  let inFence = false

  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    const heading = !inFence && line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      if (current.content.trim()) sections.push({ ...current, content: current.content.trim() })
      current = { heading: heading[2].trim(), level: heading[1].length, content: '' }
      continue
    }
    current.content += `${line}\n`
  }
  if (current.content.trim()) sections.push({ ...current, content: current.content.trim() })

  return sections
}
