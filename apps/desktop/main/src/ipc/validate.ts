export class IpcValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'

  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

/**
 * Validates untrusted renderer payloads. Every check names the field only; the
 * rejected value itself never appears in an error message.
 */
export function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64 || hasControlCharacter(value)) {
    throw new IpcValidationError(field, `${field} must be a non-empty identifier`)
  }
  return value
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new IpcValidationError(field, `${field} is not supported`)
  }
  return value as T
}

export function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new IpcValidationError(field, `${field} must be a non-empty text of at most ${maxLength} characters`)
  }
  return value
}

/** Reads an optional boolean, defaulting to false; anything else is rejected. */
export function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new IpcValidationError(field, `${field} must be a boolean`)
  return value
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}
