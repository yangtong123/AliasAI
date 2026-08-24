import type { MentionType, ProtectedValueType } from '@aliasai/domain'

/**
 * Maps a Mention type to its ProtectedValue type; metadata-only types have none.
 */
export function mentionTypeToProtectedValueType(type: MentionType): ProtectedValueType | undefined {
  switch (type) {
    case 'PERSON':
      return 'PERSON_NAME'
    case 'ORGANIZATION':
      return 'ORG_NAME'
    case 'PHONE':
      return 'PHONE'
    case 'EMAIL':
      return 'EMAIL'
    case 'ID_CARD':
      return 'ID_CARD'
    case 'BANK_ACCOUNT':
      return 'BANK_ACCOUNT'
    case 'ADDRESS':
      return 'ADDRESS'
    case 'CASE_NUMBER':
    case 'CONTRACT_NUMBER':
    case 'COURT':
    case 'LAWYER':
    case 'JUDGE':
      return undefined
  }
}

/**
 * Digit values shorter than this never participate in digit equivalence: a
 * 4-digit fragment would match unrelated numbers everywhere. Shared by
 * validation and the AI outbound leak scanner so neither side can drift.
 */
export const MIN_DIGIT_EQUIVALENCE_LENGTH = 5

/** Longest PHONE admitted to a fingerprint: E.164 subscriber numbers max out at 15–20 digits. */
export const PHONE_MAX_DIGITS = 20

export const BANK_ACCOUNT_MIN_DIGITS = 8
export const BANK_ACCOUNT_MAX_DIGITS = 30

const PHONE_DIGITS = new RegExp(`^\\d{${MIN_DIGIT_EQUIVALENCE_LENGTH},${PHONE_MAX_DIGITS}}$`)
const BANK_ACCOUNT_DIGITS = new RegExp(`^\\d{${BANK_ACCOUNT_MIN_DIGITS},${BANK_ACCOUNT_MAX_DIGITS}}$`)

/**
 * Validates a normalized value before fingerprinting; invalid values must never
 * produce a fingerprint or hard rule. PHONE accepts any 5–20 digit line so
 * non-mobile numbers stay resolvable; anything shorter or longer is rejected.
 */
export function isValidNormalizedValue(type: MentionType, normalized: string): boolean {
  if (normalized.length === 0) return false
  switch (type) {
    case 'ID_CARD':
      return isValidIdCard(normalized)
    case 'PHONE':
      return PHONE_DIGITS.test(normalized)
    case 'EMAIL': {
      // Defensive: the canonical form must be whitespace-free. If normalization
      // ever regresses, validity must fail closed instead of fingerprinting a
      // value whose spaced and unspaced forms would diverge.
      if (/\s/.test(normalized)) return false
      const parts = normalized.split('@')
      return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
    }
    case 'BANK_ACCOUNT':
      return BANK_ACCOUNT_DIGITS.test(normalized)
    case 'PERSON':
    case 'ORGANIZATION':
    case 'ADDRESS':
      return true
    case 'CASE_NUMBER':
    case 'CONTRACT_NUMBER':
    case 'COURT':
    case 'LAWYER':
    case 'JUDGE':
      return false
  }
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const ID_CARD_CHECK_CHARS = '10X98765432'

/**
 * Full GB 11643-1999 validation: 18-character shape, a valid calendar birth
 * date that does not lie in the future, and the ISO 7064 MOD 11-2 check digit.
 * Only a validated ID number may produce a fingerprint or a hard identity rule
 * downstream. V1 does not validate the region or sequence codes.
 */
function isValidIdCard(value: string): boolean {
  if (!/^\d{17}[\dX]$/.test(value)) return false
  const year = Number(value.slice(6, 10))
  const month = Number(value.slice(10, 12))
  const day = Number(value.slice(12, 14))
  if (year < 1900 || month < 1 || month > 12) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return false
  // The birth date must not lie in the future (full UTC date comparison).
  if (Date.UTC(year, month - 1, day) > Date.now()) return false
  let sum = 0
  for (const [index, weight] of ID_CARD_WEIGHTS.entries()) sum += Number(value[index]) * weight
  return ID_CARD_CHECK_CHARS[sum % 11] === value[17]
}

/**
 * Deterministic normalization for matching/fingerprinting. Never mutates the source text.
 * Metadata-only Mention types fall back to the generic form.
 */
export function normalizeMentionValue(type: MentionType, text: string): string {
  const protectedType = mentionTypeToProtectedValueType(type)
  if (protectedType === undefined) return genericForm(text)
  return normalizeProtectedValue(protectedType, text)
}

/**
 * Formatting separators that may appear INSIDE a rendered number: horizontal
 * spaces, hyphens and dashes (ASCII plus Unicode variants), dots, middle dots,
 * slashes, parentheses, commas/colons/semicolons (ASCII; full-width forms fold
 * to ASCII under NFKC), the ideographic comma, and zero-width format
 * characters. This grammar is the single source of truth shared by
 * normalization (drops them inside PHONE/BANK_ACCOUNT/ID_CARD values) and the
 * AI outbound leak scanner (treats them as transparent between digit groups).
 * Everything else — prose, letters, tabs, newlines — is a hard boundary on
 * both sides, so no variant can be normalized one way here and another way
 * there.
 */
export const NUMBER_GROUP_SEPARATOR_CHARS = new Set(
  (
    ' \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u205F\u3000' +
    '-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2043' +
    '.\u00B7\u2027/' +
    '()' +
    ',;:' +
    '\u3001' +
    '\u200B\u200C\u200D\u2060\uFEFF\u00AD'
  ).split('')
)

/**
 * Non-ASCII Unicode decimal digits (property Nd), derived from the engine's
 * own Unicode data at first use instead of a hand-written table: every Nd
 * block is exactly ten consecutive code points ascending 0–9, so a block's
 * first code point maps to '0'. Deriving the mapping from `\p{Nd}` itself
 * means coverage can never drift when the runtime's Unicode version changes.
 */
interface DigitFolds {
  readonly digitByCodePoint: ReadonlyMap<number, string>
  readonly pattern: RegExp
}

let digitFolds: DigitFolds | undefined

function loadDigitFolds(): DigitFolds {
  if (digitFolds !== undefined) return digitFolds
  // Scan the full code point space once in chunks to find every Nd block.
  const chunks: string[] = []
  const CHUNK_SIZE = 0x1000
  for (let base = 0; base <= 0x10ffff; base += CHUNK_SIZE) {
    const points: number[] = []
    for (let codePoint = base; codePoint < base + CHUNK_SIZE && codePoint <= 0x10ffff; codePoint += 1) {
      points.push(codePoint)
    }
    chunks.push(String.fromCodePoint(...points))
  }
  const digitByCodePoint = new Map<number, string>()
  const blockStarts: number[] = []
  let previous = -2
  let blockStart = -1
  for (const match of chunks.join('').matchAll(/\p{Nd}/gu)) {
    const codePoint = match[0].codePointAt(0)!
    if (codePoint >= 0x80) {
      if (codePoint !== previous + 1 || codePoint - blockStart > 9) {
        blockStart = codePoint
        blockStarts.push(codePoint)
      }
      digitByCodePoint.set(codePoint, String.fromCharCode(0x30 + codePoint - blockStart))
    }
    previous = codePoint
  }
  digitFolds = {
    digitByCodePoint,
    pattern: new RegExp(
      `[${blockStarts.map((start) => `\\u{${start.toString(16)}}-\\u{${(start + 9).toString(16)}}`).join('')}]`,
      'gu'
    )
  }
  return digitFolds
}

/** Folds non-ASCII Unicode decimal digits to their ASCII digits; all other characters pass through. */
export function foldDecimalDigits(text: string): string {
  const folds = loadDigitFolds()
  return text.replace(folds.pattern, (digit) => folds.digitByCodePoint.get(digit.codePointAt(0)!)!)
}

/**
 * Normalization by ProtectedValueType. This is the single source of truth for
 * value equivalence: Mention matching, fingerprinting, and the AI outbound leak
 * scan must all derive equivalence from these rules so no variant class can be
 * normalized one way here and another way there.
 */
export function normalizeProtectedValue(type: ProtectedValueType, text: string): string {
  switch (type) {
    case 'EMAIL':
      // Canonical email form has no whitespace: local-part and domain never
      // legally contain spaces, so stripping them keeps vault value and leaked
      // variant in one equivalence class (e.g. "a @ b.test" === "a@b.test").
      return genericForm(text).replace(/\s+/g, '').toLowerCase()
    case 'PHONE':
      return dropMainlandCountryPrefix(renderNumberDigits(digitForm(text)))
    case 'ID_CARD':
      return renderNumberDigits(digitForm(text)).toUpperCase()
    case 'BANK_ACCOUNT':
      return renderNumberDigits(digitForm(text))
    case 'PERSON_NAME':
    case 'ORG_NAME':
    case 'ADDRESS':
      return genericForm(text)
  }
}

function genericForm(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

/**
 * Digit types never collapse internal whitespace: a tab, newline, or other
 * hard-boundary whitespace inside a value is a candidate boundary for the AI
 * outbound scanner, so it is preserved here to make validation reject exactly
 * the renderings the scanner would refuse to join.
 */
function digitForm(text: string): string {
  return text.normalize('NFKC').trim()
}

/**
 * Extracts the digit sequence of a rendered number: Unicode decimal digits are
 * folded to ASCII, one leading "+" is dropped, and the shared separator
 * grammar is removed. Any other character is deliberately preserved (not
 * silently deleted) so isValidNormalizedValue rejects prose-wrapped junk —
 * digit extraction must stay in lockstep with the scanner's boundary grammar,
 * never more permissive than it.
 */
function renderNumberDigits(text: string): string {
  let digits = foldDecimalDigits(text)
  if (digits.startsWith('+')) digits = digits.slice(1)
  let rendered = ''
  for (const char of digits) {
    if ((char >= '0' && char <= '9') || !NUMBER_GROUP_SEPARATOR_CHARS.has(char)) rendered += char
  }
  return rendered
}

/**
 * Drops a redundant "86" mainland country prefix from a pure-digit rendered
 * mobile number. Shared by normalization and the AI outbound scanner so both
 * sides derive phone equivalence from a single rule.
 */
export function dropMainlandCountryPrefix(digits: string): string {
  if (digits.length === 13 && digits.startsWith('86') && digits.charCodeAt(2) === 0x31) return digits.slice(2)
  return digits
}
