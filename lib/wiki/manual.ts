/**
 * Manuales de SinergiaCRM y SinergiaDA publicados en la wiki de SinergiaTIC.
 *
 * - El índice sale en vivo de las páginas "Manual de SinergiaCRM" y
 *   "Manual de SinergiaDA" (lo que se ve en Especial:MiIdioma/Manual_de_…).
 * - De cada página se prefiere la traducción /es; si no existe, la original.
 * - La búsqueda de texto de la propia wiki no devuelve resultados, así que la
 *   búsqueda se hace aquí: se descargan todas las páginas de los manuales
 *   (unas pocas peticiones por lotes) y se cachean en memoria unas horas.
 */

import { WikiError, getWikiBaseUrl, pageUrl, wikiApi } from './client'
import {
  type IndexEntry,
  type MarkdownSection,
  normalizeTitle,
  parseManualIndex,
  splitSections,
  wikitextToMarkdown,
} from './wikitext'

export const MANUALS = {
  crm: { name: 'Manual de SinergiaCRM', page: 'Manual de SinergiaCRM' },
  da: { name: 'Manual de SinergiaDA (Data Analytics)', page: 'Manual de SinergiaDA' },
} as const

export type ManualId = keyof typeof MANUALS
export const MANUAL_IDS = Object.keys(MANUALS) as ManualId[]

/** Cuánto vive en memoria el índice y el texto de los manuales. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Títulos por petición a la API (cada título de página va con su variante /es). */
const TITLES_PER_BATCH = 12
const PARALLEL_BATCHES = 4
const BATCH_TIMEOUT_MS = 25_000

/** Tope de caracteres que devuelve docs_read de una vez. */
export const MAX_READ_CHARS = 24_000

interface FetchedPage {
  /** Título real de la página leída (p.ej. "Eliminación de datos/es"). */
  title: string
  wikitext: string
}

interface ApiPage {
  title: string
  missing?: boolean
  invalid?: boolean
  revisions?: Array<{ slots?: { main?: { content?: string } } }>
}

interface RevisionsResponse {
  continue?: Record<string, string>
  query?: {
    normalized?: Array<{ from: string; to: string }>
    redirects?: Array<{ from: string; to: string }>
    pages?: ApiPage[]
  }
}

const LANGUAGE_SUBPAGE = /\/(?:es|ca|en|fr|it|pt|de|eu|gl)$/

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (batch: T[]) => Promise<R>,
): Promise<R[]> {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))

  const results: R[] = []
  for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
    results.push(...(await Promise.all(batches.slice(i, i + PARALLEL_BATCHES).map(fn))))
  }
  return results
}

export interface FetchResult {
  /** Título pedido → página leída (las que no existen no salen). */
  pages: Map<string, FetchedPage>
  /** Títulos que no se pudieron descargar (solo con tolerant). */
  failed: string[]
}

/**
 * Descarga el wikitexto de varias páginas, prefiriendo la traducción /es.
 * Cada lote se reintenta una vez; con tolerant, los lotes que siguen fallando
 * se apuntan en "failed" en vez de tumbar toda la descarga.
 */
export async function fetchPages(
  titles: string[],
  { tolerant = false } = {},
): Promise<FetchResult> {
  const wanted = [...new Set(titles.map(normalizeTitle).filter(Boolean))]
  const candidatesOf = (title: string) =>
    LANGUAGE_SUBPAGE.test(title) ? [title] : [`${title}/es`, title]
  const allCandidates = wanted.flatMap(candidatesOf)

  const aliases = new Map<string, string>()
  const contents = new Map<string, string>()
  const failedCandidates = new Set<string>()
  let firstError: unknown

  const loadBatch = async (batch: string[]) => {
    let cont: Record<string, string> | undefined = {}
    while (cont) {
      const data: RevisionsResponse = await wikiApi<RevisionsResponse>(
        {
          action: 'query',
          prop: 'revisions',
          rvprop: 'content',
          rvslots: 'main',
          redirects: '1',
          titles: batch.join('|'),
          ...cont,
        },
        { timeoutMs: BATCH_TIMEOUT_MS },
      )
      for (const { from, to } of [
        ...(data.query?.normalized ?? []),
        ...(data.query?.redirects ?? []),
      ]) {
        aliases.set(from, to)
      }
      for (const page of data.query?.pages ?? []) {
        const content = page.revisions?.[0]?.slots?.main?.content
        if (!page.missing && !page.invalid && typeof content === 'string') {
          contents.set(page.title, content)
        }
      }
      cont = data.continue
    }
  }

  await inBatches(allCandidates, TITLES_PER_BATCH, async (batch) => {
    try {
      await loadBatch(batch)
    } catch {
      try {
        await loadBatch(batch)
      } catch (error) {
        if (!tolerant) throw error
        firstError ??= error
        batch.forEach((title) => failedCandidates.add(title))
      }
    }
  })

  const resolve = (title: string) => {
    let current = title
    for (let hops = 0; hops < 5 && aliases.has(current); hops++) current = aliases.get(current)!
    return current
  }

  const pages = new Map<string, FetchedPage>()
  const failed: string[] = []
  for (const title of wanted) {
    for (const candidate of candidatesOf(title)) {
      const resolved = resolve(candidate)
      const wikitext = contents.get(resolved)
      // Una traducción /es vacía o sin texto real no sirve: se pasa a la original.
      if (wikitext !== undefined && wikitext.replace(/<[^>]+>|\{\{[^}]*\}\}|\s/g, '').length > 0) {
        pages.set(title, { title: resolved, wikitext })
        break
      }
    }
    if (!pages.has(title) && candidatesOf(title).some((c) => failedCandidates.has(c)))
      failed.push(title)
  }

  // Si no ha llegado nada, no es un fallo parcial: es que la wiki no responde.
  if (pages.size === 0 && failed.length > 0) throw firstError
  return { pages, failed }
}

// ---------------------------------------------------------------------------
// Caché en memoria (vive mientras Vercel reutilice la instancia)
// ---------------------------------------------------------------------------

/** Con la wiki caída y una copia antigua en memoria, cada cuánto se vuelve a intentar. */
const STALE_RETRY_MS = 5 * 60 * 1000

interface Cached<T> {
  value?: T
  loadedAt: number
  inflight?: Promise<T>
}

/**
 * Devuelve el valor cacheado si está fresco; si no, lo recarga. Si la recarga
 * falla y hay una copia antigua, se sirve la antigua marcada como tal.
 */
async function cached<T>(
  slot: Cached<T>,
  load: () => Promise<T>,
): Promise<{ value: T; stale: boolean }> {
  if (slot.value !== undefined && Date.now() - slot.loadedAt < CACHE_TTL_MS) {
    return { value: slot.value, stale: false }
  }
  slot.inflight ??= load().finally(() => {
    slot.inflight = undefined
  })
  try {
    const value = await slot.inflight
    slot.value = value
    slot.loadedAt = Date.now()
    return { value, stale: false }
  } catch (error) {
    if (slot.value === undefined) throw error
    // No se reintenta en cada llamada (cada intento fallido tarda lo que el timeout).
    slot.loadedAt = Date.now() - CACHE_TTL_MS + STALE_RETRY_MS
    return { value: slot.value, stale: true }
  }
}

export interface ManualIndex {
  manual: ManualId
  name: string
  url: string
  entries: IndexEntry[]
}

const indexCache: Cached<ManualIndex[]> = { loadedAt: 0 }

async function loadIndex(): Promise<ManualIndex[]> {
  const { pages } = await fetchPages(MANUAL_IDS.map((id) => MANUALS[id].page))
  return MANUAL_IDS.map((id) => {
    const page = pages.get(MANUALS[id].page)
    if (!page) {
      throw new WikiError(`No se encuentra la página "${MANUALS[id].page}" en la wiki`)
    }
    return {
      manual: id,
      name: MANUALS[id].name,
      url: pageUrl(`Especial:MiIdioma/${MANUALS[id].page}`),
      entries: parseManualIndex(page.wikitext),
    }
  })
}

export async function getIndex(): Promise<{ value: ManualIndex[]; stale: boolean }> {
  return cached(indexCache, loadIndex)
}

export interface DocPage {
  manual: ManualId
  title: string
  label: string
  indexSection: string
  url: string
  sections: MarkdownSection[]
}

export interface Corpus {
  docs: DocPage[]
  /** Páginas del índice que no se pudieron descargar en la última carga. */
  failed: string[]
}

const corpusCache: Cached<Corpus> = { loadedAt: 0 }

/** Si la carga ha sido parcial, se reintenta antes (10 min) en vez de esperar al TTL completo. */
const PARTIAL_RETRY_MS = 10 * 60 * 1000

async function loadCorpus(): Promise<Corpus> {
  const { value: indexes } = await getIndex()
  const entries = indexes.flatMap((index) =>
    index.entries.map((entry) => ({ ...entry, manual: index.manual })),
  )
  const { pages, failed } = await fetchPages(
    entries.map((entry) => entry.title),
    { tolerant: true },
  )

  const docs: DocPage[] = []
  for (const entry of entries) {
    const page = pages.get(entry.title)
    if (!page) continue
    docs.push({
      manual: entry.manual,
      title: entry.title,
      label: entry.label,
      indexSection: entry.section,
      url: pageUrl(page.title),
      sections: splitSections(wikitextToMarkdown(page.wikitext).markdown),
    })
  }
  return { docs, failed }
}

export async function getCorpus(): Promise<{ value: Corpus; stale: boolean }> {
  const result = await cached(corpusCache, loadCorpus)
  if (!result.stale && result.value.failed.length > 0) {
    corpusCache.loadedAt = Math.min(
      corpusCache.loadedAt,
      Date.now() - CACHE_TTL_MS + PARTIAL_RETRY_MS,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a al algo como con cual cuando de del desde donde el en entre es esta este esto hay la las le les lo los mas me mi o para pero por que se si sin sobre su sus un una uno unos unas y ya hacer puedo puede quiero como cuales'.split(
    ' ',
  ),
)

/** Minúsculas y sin tildes, conservando la longitud del texto (para poder recortar fragmentos). */
export function fold(text: string): string {
  return text
    .replace(/[^\u0000-\u007f]/g, (c) => {
      const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '')
      return base.length === 1 ? base : c
    })
    .toLowerCase()
}

/** Raíz muy simple en castellano: lo justo para que "eliminar" encuentre "eliminación". */
function stem(word: string): string {
  // Ordenados de más largo a más corto; solo se quita uno.
  const suffixes = (
    'aciones iciones ciones amos emos imos acion icion cion mente ados adas idos idas ando iendo ' +
    'aron ieron aba ado ada ido ida ar er ir as es os an en o a e s'
  ).split(' ')
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4)
      return word.slice(0, -suffix.length)
  }
  return word
}

export function queryTerms(query: string): string[] {
  const words = fold(query)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 1)
  const useful = words.filter((w) => !STOPWORDS.has(w))
  return [...new Set((useful.length > 0 ? useful : words).map(stem))]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countMatches(haystack: string, term: RegExp): number {
  term.lastIndex = 0
  let count = 0
  while (term.exec(haystack) && count < 20) count++
  return count
}

function snippet(original: string, folded: string, terms: RegExp[], size = 360): string {
  let position = -1
  for (const term of terms) {
    term.lastIndex = 0
    const match = term.exec(folded)
    if (match && (position === -1 || match.index < position)) position = match.index
  }
  const start = Math.max(0, position - Math.floor(size / 3))
  let text = original.slice(start, start + size)
  if (start > 0) text = `…${text.replace(/^\S*\s/, '')}`
  if (start + size < original.length) text = `${text.replace(/\s\S*$/, '')}…`
  return text.replace(/\s+/g, ' ').trim()
}

export interface SearchHit {
  manual: ManualId
  pagina: string
  seccion: string
  url: string
  puntuacion: number
  fragmento: string
}

export function searchCorpus(docs: DocPage[], query: string, limit: number): SearchHit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const patterns = terms.map((term) => new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}`, 'g'))

  const hits: Array<SearchHit & { pageKey: string }> = []
  for (const doc of docs) {
    const foldedTitle = fold(`${doc.title} ${doc.label}`)
    for (const section of doc.sections) {
      const foldedHeading = fold(section.heading)
      const foldedBody = fold(section.content)

      let score = 0
      let matched = 0
      for (const pattern of patterns) {
        const inBody = countMatches(foldedBody, pattern)
        const inHeading = countMatches(foldedHeading, pattern) > 0
        const inTitle = countMatches(foldedTitle, pattern) > 0
        if (inBody || inHeading || inTitle) matched++
        score += (inBody ? 1 + Math.log2(1 + inBody) : 0) + (inHeading ? 3 : 0) + (inTitle ? 4 : 0)
      }
      if (matched === 0) continue

      const coverage = matched / patterns.length
      hits.push({
        pageKey: doc.title,
        manual: doc.manual,
        pagina: doc.title,
        seccion: section.heading,
        url:
          section.heading === 'Introducción'
            ? doc.url
            : `${doc.url}#${section.heading.replace(/ /g, '_')}`,
        puntuacion: Math.round(score * coverage * coverage * 10) / 10,
        fragmento: snippet(section.content, foldedBody, patterns),
      })
    }
  }

  hits.sort((a, b) => b.puntuacion - a.puntuacion)

  // Como mucho 3 secciones por página, para que una página larga no lo acapare todo.
  const perPage = new Map<string, number>()
  const result: SearchHit[] = []
  for (const { pageKey, ...hit } of hits) {
    const seen = perPage.get(pageKey) ?? 0
    if (seen >= 3) continue
    perPage.set(pageKey, seen + 1)
    result.push(hit)
    if (result.length >= limit) break
  }
  return result
}

// ---------------------------------------------------------------------------
// Lectura de una página
// ---------------------------------------------------------------------------

/** Acepta un título, un título con guiones bajos o una URL de la wiki. */
export function titleFromInput(input: string): string {
  let text = input.trim()
  const base = getWikiBaseUrl()
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      text = url.searchParams.get('title') ?? url.pathname.replace(/^.*?\/index\.php\//, '')
      text = decodeURIComponent(text)
    } catch {
      text = text.replace(base, '')
    }
  }
  return normalizeTitle(text)
}

export interface ReadResult {
  pagina: string
  url: string
  manual?: ManualId
  secciones: string[]
  seccion?: string
  contenido: string
  truncado?: string
  enlaces: string[]
}

export async function readPage(input: string, sectionWanted?: string): Promise<ReadResult> {
  const requested = titleFromInput(input)
  if (!requested) throw new WikiError('Indica el título de la página')

  // Si el título se parece a una entrada del índice, se usa la entrada exacta.
  let title = requested
  let manual: ManualId | undefined
  try {
    const { value: indexes } = await getIndex()
    const wanted = fold(requested)
    const all = indexes.flatMap((index) =>
      index.entries.map((entry) => ({ ...entry, manual: index.manual })),
    )
    const match =
      all.find((e) => fold(e.title) === wanted || fold(e.label) === wanted) ??
      all.find((e) => fold(e.title).includes(wanted) || fold(e.label).includes(wanted))
    if (match) {
      title = match.title
      manual = match.manual
    }
  } catch {
    // Sin índice se intenta leer el título tal cual.
  }

  const page = (await fetchPages([title])).pages.get(title)
  if (!page) {
    throw new WikiError(
      `No existe la página "${requested}" en la wiki. Usa docs_index para ver los títulos exactos o docs_search para buscar por contenido.`,
    )
  }

  const { markdown, links } = wikitextToMarkdown(page.wikitext)
  const sections = splitSections(markdown)
  const url = pageUrl(page.title)

  let content = markdown
  let chosen: string | undefined
  if (sectionWanted?.trim()) {
    const wanted = fold(sectionWanted.trim())
    const asNumber = /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1
    let start = asNumber >= 0 && asNumber < sections.length ? asNumber : -1
    if (start === -1) start = sections.findIndex((s) => fold(s.heading) === wanted)
    if (start === -1) start = sections.findIndex((s) => fold(s.heading).includes(wanted))
    if (start === -1) {
      throw new WikiError(
        `La página "${page.title}" no tiene ninguna sección "${sectionWanted}". Secciones: ${sections.map((s) => s.heading).join(' · ')}`,
      )
    }
    // La sección pedida y sus subsecciones.
    const picked = [sections[start]]
    for (let i = start + 1; i < sections.length && sections[i].level > sections[start].level; i++) {
      picked.push(sections[i])
    }
    chosen = sections[start].heading
    content = picked.map((s) => `${'#'.repeat(s.level)} ${s.heading}\n\n${s.content}`).join('\n\n')
  }

  const result: ReadResult = {
    pagina: page.title,
    url,
    manual,
    secciones: sections.map((s) => `${'  '.repeat(Math.max(0, s.level - 2))}${s.heading}`),
    seccion: chosen,
    contenido: content,
    enlaces: links,
  }

  if (content.length > MAX_READ_CHARS) {
    result.contenido = `${content.slice(0, MAX_READ_CHARS)}\n\n[…]`
    result.truncado = `La página es larga (${content.length} caracteres) y se ha cortado. Pide una sección concreta con el parámetro "section" (ver "secciones").`
  }

  return result
}

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

export interface DocsHealth {
  ok: boolean
  wiki: string
  latencia_ms: number
  manuales?: Array<{ manual: ManualId; nombre: string; paginas_en_indice: number }>
  error?: string
  comprobado: string
}

/** Comprueba en vivo (sin caché) que la wiki responde y que los índices se pueden leer. */
export async function checkDocsHealth(): Promise<DocsHealth> {
  const started = Date.now()
  try {
    const indexes = await loadIndex()
    indexCache.value = indexes
    indexCache.loadedAt = Date.now()
    const manuales = indexes.map((index) => ({
      manual: index.manual,
      nombre: index.name,
      paginas_en_indice: index.entries.length,
    }))
    const empty = manuales.find((m) => m.paginas_en_indice === 0)
    return {
      ok: !empty,
      wiki: getWikiBaseUrl(),
      latencia_ms: Date.now() - started,
      manuales,
      error: empty
        ? `El índice de "${empty.nombre}" sale vacío: puede que haya cambiado el formato de la página`
        : undefined,
      comprobado: new Date().toISOString(),
    }
  } catch (error) {
    return {
      ok: false,
      wiki: getWikiBaseUrl(),
      latencia_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      comprobado: new Date().toISOString(),
    }
  }
}
