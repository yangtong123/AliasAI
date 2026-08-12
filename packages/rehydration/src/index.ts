const PUBLIC_TOKEN = '(?<![A-Za-z0-9-])@[A-Z]-[A-Z0-9-]+(?![A-Za-z0-9-])'
const PUBLIC_TOKEN_REFERENCE = new RegExp(`〔(${PUBLIC_TOKEN})〕|(${PUBLIC_TOKEN})`, 'g')

export interface RehydrationTarget {
  /** Decrypted local value to restore. It must never be sent to an AI provider. */
  readonly value: string
  /** Current and historic aliases that may immediately precede the token. */
  readonly aliases: readonly string[]
}

/**
 * Restores an exact pseudonym span selected by its Public Token. The alias list
 * only identifies the beginning of that span; it is never used as the lookup
 * key. Unknown tokens or unexpectedly edited aliases remain verbatim for local
 * review instead of risking corruption of surrounding AI text.
 */
export function rehydrateText(
  sanitizedText: string,
  tokenToTarget: ReadonlyMap<string, RehydrationTarget>
): string {
  let restored = ''
  let cursor = 0

  for (const match of sanitizedText.matchAll(PUBLIC_TOKEN_REFERENCE)) {
    const referenceStart = match.index
    const markerToken = match[1]
    const token = markerToken ?? match[2]
    if (token === undefined) continue

    const target = tokenToTarget.get(token)
    if (target === undefined || target.value.length === 0) continue

    if (markerToken === undefined) {
      restored += sanitizedText.slice(cursor, referenceStart)
      restored += target.value
      cursor = referenceStart + match[0].length
      continue
    }

    const alias = [...target.aliases]
      .filter((candidate) => candidate.length > 0)
      .sort((left, right) => right.length - left.length)
      .find(
        (candidate) =>
          sanitizedText.slice(referenceStart - candidate.length, referenceStart) === candidate &&
          hasUnambiguousAsciiBoundary(sanitizedText, referenceStart - candidate.length, candidate)
      )
    if (alias === undefined) continue

    const aliasStart = referenceStart - alias.length
    if (aliasStart < cursor) continue

    restored += sanitizedText.slice(cursor, aliasStart)
    restored += target.value
    cursor = referenceStart + match[0].length
  }

  return `${restored}${sanitizedText.slice(cursor)}`
}

function hasUnambiguousAsciiBoundary(text: string, aliasStart: number, alias: string): boolean {
  if (aliasStart <= 0 || !/[A-Za-z0-9]/u.test(alias[0] ?? '')) return true
  return !/[A-Za-z0-9]/u.test(text[aliasStart - 1] ?? '')
}
