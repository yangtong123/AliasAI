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
 * Validates a normalized value before fingerprinting; invalid values must never
 * produce a fingerprint or hard rule. PHONE accepts a mainland mobile
 * (`1[3-9]` plus 9 digits) or any digit string of at least 5 digits so
 * non-mobile lines stay resolvable; anything shorter is rejected.
 */
export function isValidNormalizedValue(type: MentionType, normalized: string): boolean {
  if (normalized.length === 0) return false
  switch (type) {
    case 'ID_CARD':
      return isValidIdCard(normalized)
    case 'PHONE':
      return /^1[3-9]\d{9}$/.test(normalized) || /^\d{5,}$/.test(normalized)
    case 'EMAIL': {
      const parts = normalized.split('@')
      return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
    }
    case 'BANK_ACCOUNT':
      return /^\d{8,30}$/.test(normalized)
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
 */
export function normalizeMentionValue(type: MentionType, text: string): string {
  const generic = text.normalize('NFKC').trim().replace(/\s+/g, ' ')
  switch (type) {
    case 'EMAIL':
      return generic.toLowerCase()
    case 'PHONE':
      return normalizePhone(generic)
    case 'ID_CARD':
      return generic.replace(/\s+/g, '').toUpperCase()
    case 'BANK_ACCOUNT':
      return generic.replace(/\D/g, '')
    default:
      return generic
  }
}

/** Keeps digits only, dropping a redundant '+86'/'86' prefix for mainland mobile numbers. */
function normalizePhone(text: string): string {
  const digits = text.replace(/\D/g, '')
  if (digits.startsWith('86')) {
    const remainder = digits.slice(2)
    if (remainder.length === 11 && remainder.startsWith('1')) return remainder
  }
  return digits
}
