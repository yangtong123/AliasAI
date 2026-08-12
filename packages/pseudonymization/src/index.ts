export interface Replacement {
  readonly startOffset: number
  readonly endOffset: number
  readonly alias: string
  readonly publicToken: string
}

export class PseudonymizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PseudonymizationError'
  }
}

const PUBLIC_TOKEN_PATTERN = /^@[A-Z]-[A-Z0-9]+(?:-[A-Z0-9]+)*$/

/** Formats V1 sanitized output using a mutable alias plus immutable public token. */
export function formatPseudonym(alias: string, publicToken: string): string {
  if (alias.trim().length === 0) {
    throw new PseudonymizationError('alias must not be empty')
  }
  if (/[〔〕\r\n]/u.test(alias)) {
    throw new PseudonymizationError('alias contains reserved pseudonym delimiters')
  }
  if (!PUBLIC_TOKEN_PATTERN.test(publicToken)) {
    throw new PseudonymizationError('public token has an invalid format')
  }
  return `${alias}〔${publicToken}〕`
}

/**
 * Replaces resolved mention ranges from right to left. This never performs raw
 * global string replacement, so repeated or overlapping surface text is safe.
 */
export function pseudonymizeText(text: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].sort((left, right) => right.startOffset - left.startOffset)
  let endOfPrevious = text.length
  let sanitized = text
  for (const replacement of sorted) {
    if (
      !Number.isSafeInteger(replacement.startOffset) ||
      !Number.isSafeInteger(replacement.endOffset) ||
      replacement.startOffset < 0 ||
      replacement.endOffset <= replacement.startOffset ||
      replacement.endOffset > text.length
    ) {
      throw new PseudonymizationError('replacement offsets are outside the source text')
    }
    if (replacement.endOffset > endOfPrevious) {
      throw new PseudonymizationError('replacement ranges must not overlap')
    }
    sanitized = `${sanitized.slice(0, replacement.startOffset)}${formatPseudonym(replacement.alias, replacement.publicToken)}${sanitized.slice(replacement.endOffset)}`
    endOfPrevious = replacement.startOffset
  }
  return sanitized
}
