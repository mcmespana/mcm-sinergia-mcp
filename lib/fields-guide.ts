/**
 * Guía de campos de la instancia (CAMPOS-RESUMEN.md): la chuleta que dice qué
 * campos y qué claves de desplegable existen, para que el agente no tenga que
 * explorar el CRM con get_module_fields cada vez.
 *
 * La guía es de cada organización, no de este repo, así que se lee de fuera:
 *
 *  - CRM_FIELDS_GUIDE_URL: URL http(s) del markdown (p.ej. el raw de GitHub del
 *    repo donde lo mantenéis). Lo más cómodo: se actualiza sin redesplegar.
 *  - Si no, `guia/CAMPOS-RESUMEN.md` dentro de este repo (copiadlo ahí si
 *    preferís tenerlo junto al servidor).
 *
 * Formato (lo genera `npm run guide:generate` y lo explica guia/README.md):
 * una sección `## ` por módulo, con el nombre técnico entre comillas invertidas
 * en el título, y una sección `## Reglas` que acompaña siempre a cualquier
 * módulo que se pida.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** Lo que tarda en volver a leerse la guía (se cambia poco). */
const CACHE_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
/** Tope para no meter en el contexto algo que no es una guía. */
const MAX_GUIDE_CHARS = 200_000

export const LOCAL_GUIDE_PATH = path.join('guia', 'CAMPOS-RESUMEN.md')

export interface GuideSection {
  title: string
  /** Nombres técnicos de módulo que aparecen entre comillas invertidas en el título. */
  modules: string[]
  body: string
}

export interface ParsedGuide {
  /** Título y nota inicial (antes de la primera sección). */
  intro: string
  sections: GuideSection[]
}

interface LoadedGuide {
  source: string
  text: string
  loadedAt: number
}

let cache: LoadedGuide | undefined

export class GuideNotConfiguredError extends Error {
  constructor() {
    super(
      'Esta instancia no tiene guía de campos. Usa get_module_fields (con name_contains) para ver los campos. ' +
        'Para crear una: `npm run guide:generate` en el repo del MCP, revisarla a mano, publicarla y poner su URL en CRM_FIELDS_GUIDE_URL (ver guia/README.md).',
    )
    this.name = 'GuideNotConfiguredError'
  }
}

function guideUrl(): string | undefined {
  const raw = process.env.CRM_FIELDS_GUIDE_URL?.trim()
  if (!raw) return undefined
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error('CRM_FIELDS_GUIDE_URL debe empezar por http:// o https://')
  }
  return raw
}

async function fetchGuide(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`No se ha podido leer la guía de campos (${url}): HTTP ${response.status}`)
  }
  return response.text()
}

async function readSource(): Promise<{ source: string; text: string }> {
  const url = guideUrl()
  if (url) return { source: url, text: await fetchGuide(url) }

  try {
    const file = path.join(process.cwd(), LOCAL_GUIDE_PATH)
    return { source: LOCAL_GUIDE_PATH, text: await readFile(file, 'utf8') }
  } catch {
    throw new GuideNotConfiguredError()
  }
}

/**
 * Lee la guía (con caché). Si la fuente falla y hay una copia en memoria, se
 * devuelve esa avisando, en vez de dejar al agente sin nada.
 */
export async function loadGuide(): Promise<LoadedGuide & { stale?: string }> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache
  try {
    const { source, text } = await readSource()
    if (!text.trim() || !/^## /m.test(text) || text.length > MAX_GUIDE_CHARS) {
      throw new Error(
        `Lo leído de ${source} no parece una guía de campos (vacío, sin secciones "## " o demasiado grande).`,
      )
    }
    cache = { source, text, loadedAt: Date.now() }
    return cache
  } catch (error) {
    if (cache && !(error instanceof GuideNotConfiguredError)) {
      return { ...cache, stale: error instanceof Error ? error.message : String(error) }
    }
    throw error
  }
}

export function parseGuide(text: string): ParsedGuide {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: GuideSection[] = []
  const intro: string[] = []
  let current: { title: string; lines: string[] } | undefined
  let inFence = false

  const flush = () => {
    if (!current) return
    sections.push({
      title: current.title,
      modules: [...current.title.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()),
      body: [`## ${current.title}`, ...current.lines].join('\n').trim(),
    })
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const heading = !inFence ? /^## (.+)$/.exec(line) : null
    if (heading) {
      flush()
      current = { title: heading[1].trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      intro.push(line)
    }
  }
  flush()

  return { intro: intro.join('\n').trim(), sections }
}

const normalize = (value: string) => value.trim().toLowerCase()

function isRules(section: GuideSection): boolean {
  return /^reglas\b/i.test(section.title)
}

/** Módulos que tiene la guía, en el orden en que aparecen. */
export function guideModules(guide: ParsedGuide): string[] {
  return guide.sections.flatMap((section) => section.modules)
}

/**
 * La guía entera, o solo las reglas más las secciones de los módulos pedidos.
 * Se busca el nombre técnico exacto (sin distinguir mayúsculas) y, si no,
 * secciones cuyo título lo contenga (p.ej. "eventos").
 */
export function selectGuide(
  guide: ParsedGuide,
  modules?: string[],
): { text: string; found: string[]; missing: string[] } {
  const wanted = (modules ?? []).map(normalize).filter(Boolean)
  if (wanted.length === 0) {
    return {
      text: [guide.intro, ...guide.sections.map((s) => s.body)].filter(Boolean).join('\n\n'),
      found: [],
      missing: [],
    }
  }

  const picked = new Set<GuideSection>()
  const found: string[] = []
  const missing: string[] = []

  for (const name of wanted) {
    const exact = guide.sections.filter((s) => s.modules.some((m) => normalize(m) === name))
    const matches =
      exact.length > 0 ? exact : guide.sections.filter((s) => !isRules(s) && normalize(s.title).includes(name))
    if (matches.length === 0) {
      missing.push(name)
    } else {
      found.push(name)
      for (const section of matches) picked.add(section)
    }
  }

  const rules = guide.sections.filter(isRules)
  const chosen = guide.sections.filter((s) => picked.has(s) && !isRules(s))
  return {
    text: [...rules, ...chosen].map((s) => s.body).join('\n\n'),
    found,
    missing,
  }
}

/** Solo para tests y scripts: vacía la caché. */
export function resetGuideCache(): void {
  cache = undefined
}
