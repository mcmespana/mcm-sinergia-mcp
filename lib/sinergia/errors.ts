/** Errores del cliente de SinergiaCRM, con mensajes aptos para devolver al modelo. */

export class SinergiaError extends Error {
  readonly status?: number
  readonly details?: string

  constructor(message: string, options: { status?: number; details?: string } = {}) {
    super(message)
    this.name = new.target.name
    this.status = options.status
    this.details = options.details
  }
}

/** Configuración incompleta o inválida (variables de entorno). */
export class ConfigError extends SinergiaError {}

/** Fallo obteniendo o refrescando el token OAuth2. */
export class SinergiaAuthError extends SinergiaError {}

/** Respuesta de error de la API V8. */
export class SinergiaApiError extends SinergiaError {}

/** Entrada inválida antes de llegar a la API (módulo/campo/operador mal formados). */
export class SinergiaInputError extends SinergiaError {}

export function describeError(error: unknown): string {
  if (error instanceof SinergiaError) {
    const parts = [error.message]
    if (error.status) parts.push(`(HTTP ${error.status})`)
    if (error.details) parts.push(`\n${error.details}`)
    return parts.join(' ')
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
