import type { ProtectedValueType } from '@aliasai/domain'
import {
  MIN_DIGIT_EQUIVALENCE_LENGTH,
  NUMBER_GROUP_SEPARATOR_CHARS,
  dropMainlandCountryPrefix,
  foldDecimalDigits,
  normalizeProtectedValue
} from '@aliasai/entity-resolution'
import { MOCK_PROVIDER_ID } from './openai-compatible'

/** The only value allowed to cross an AiProvider boundary in V1. */
export interface AiProviderRequest {
  readonly content: string
  /**
   * Cooperative cancellation owned by the application service; a provider that
   * supports it aborts its transport immediately. Purely a control signal —
   * no data crosses it.
   */
  readonly signal?: AbortSignal
}

/** Provider output remains pseudonymized until the application rehydrates it locally. */
export interface AiProviderResponse {
  readonly content: string
}

export interface AiProvider {
  /** Stable, non-secret provider identifier persisted with the execution. */
  readonly id: string
  execute(request: AiProviderRequest): Promise<AiProviderResponse>
}

export type MockAiResponder = (content: string) => string | Promise<string>

/**
 * Deterministic local provider used by V1 tests and the desktop demo. It has the
 * same narrow contract as a future network provider but performs no I/O.
 */
export class MockAiProvider implements AiProvider {
  readonly id = MOCK_PROVIDER_ID

  constructor(private readonly respond: MockAiResponder = (content) => `Mock analysis:\n${content}`) {}

  async execute(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.content.length === 0) throw new Error('AI provider content must not be empty')
    if (request.signal?.aborted === true) throw new Error('AI provider request was cancelled')
    const content = await this.respond(request.content)
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('AI provider returned an invalid response')
    }
    return { content }
  }
}

export type OutboundLeakCode =
  | 'EMPTY_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE'
  | 'PROTECTED_VALUE_LEAK'
  | 'INTERNAL_IDENTIFIER_LEAK'
  | 'MALFORMED_TOKEN'
  | 'UNKNOWN_TOKEN'
  | 'MISSING_TOKEN'

/**
 * Hard ceiling on the outbound provider request. The leak scan is a bounded,
 * streaming pass, but it still runs synchronously on the Electron main
 * process, so an unbounded artifact must never reach it (or the provider).
 */
export const MAX_OUTBOUND_PAYLOAD_BYTES = 5 * 1024 * 1024

export interface OutboundLeakFinding {
  readonly code: OutboundLeakCode
  /** Non-sensitive ordinal only; never include the leaked value in diagnostics. */
  readonly index: number
}

/**
 * A ProtectedValue the payload must not contain. The denylist covers the whole
 * Matter, not only the current artifact's mappings: a detection miss in this
 * document must not leak a value already known from another document.
 */
export interface DeniedProtectedValue {
  readonly type: ProtectedValueType
  readonly value: string
}

export interface OutboundLeakScanInput {
  readonly content: string
  readonly allowedTokens: ReadonlySet<string>
  readonly deniedValues: readonly DeniedProtectedValue[]
  readonly forbiddenIdentifiers: readonly string[]
}

const STRICT_RESTORATION_TOKEN = /^@[A-Z]-[A-Z0-9]+$/u
const TOKEN_LIKE_REFERENCE = /@[^\s〔〕]+/gu
const UUID_LIKE_IDENTIFIER = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu

/** Our own bracketed token spans; their digits must never feed digit candidates. */
const BRACKETED_TOKEN_SPAN = /〔@[^\s〔〕]+〕/gu

/**
 * BMP code-unit lookup table derived from the shared separator grammar so the
 * streaming hot loop never materializes per-character strings. Every member
 * of the shared set is a BMP character; astral code points are always hard
 * boundaries, so the table plus a range guard is an exact translation.
 */
const SEPARATOR_CODE_TABLE = new Uint8Array(0x10000)
for (const separator of NUMBER_GROUP_SEPARATOR_CHARS) {
  const code = separator.charCodeAt(0)
  if (code < 0x10000) SEPARATOR_CODE_TABLE[code] = 1
}

/**
 * The separator grammar between digit groups is owned by
 * `NUMBER_GROUP_SEPARATOR_CHARS` in @aliasai/entity-resolution and shared with
 * domain normalization, so a rendering normalization would accept (commas,
 * colons, semicolons included) can never be a hard boundary for the scanner.
 * Everything else — prose, CJK punctuation, letters, tabs and newlines — stays
 * a hard candidate boundary, so numbers in different Blocks (joined with \n\n)
 * or in different list items can never merge into one candidate.
 */

/**
 * Longest normalized denied digit value that participates in window matching.
 * Anything longer can never be proven absent by a bounded window and is
 * flagged instead (fail closed); the domain contract keeps real values far
 * below this (PHONE <= 20, BANK_ACCOUNT <= 30, ID_CARD = 18 digits).
 */
const MAX_DIGIT_EQUIVALENCE_DIGITS = 34

interface DigitDenyIndex {
  /** Denied values per digit type, normalized exactly like the content side. */
  readonly phone: ReadonlySet<string> | undefined
  readonly bank: ReadonlySet<string> | undefined
  readonly idCard: ReadonlySet<string> | undefined
  /** Raw window lengths that can match some denied value (phone includes a glued '86'). */
  readonly windowLengths: readonly number[]
  /** Longest raw digit window worth reading; 0 means no digit scanning at all. */
  readonly enumerateTo: number
  /** Denylist indexes no bounded window can ever prove absent; they fail closed. */
  readonly unmatchableIndexes: ReadonlySet<number>
  /** Normalized denylist value per denylist index, digit types only. */
  readonly normalizedByIndex: readonly (string | undefined)[]
}

/**
 * Whether the streaming matcher can index a normalized digit value for exact
 * equality: PHONE/BANK_ACCOUNT must be pure digits and ID_CARD must be 17
 * digits plus the optional X check character, at or above the equivalence
 * floor and within the window cap.
 */
function isNormalizedDigitValueIndexable(type: ProtectedValueType, normalized: string): boolean {
  if (normalized.length < MIN_DIGIT_EQUIVALENCE_LENGTH || normalized.length > MAX_DIGIT_EQUIVALENCE_DIGITS) {
    return false
  }
  return type === 'ID_CARD' ? /^\d{17}[\dX]$/.test(normalized) : /^\d+$/.test(normalized)
}

/**
 * Whether a denied value can be safely indexed by the outbound digit matcher.
 * Values that cannot — legacy rows normalized under the old
 * whitespace-collapsing rules, digit values below the equivalence floor (no
 * valid Vault row can be that short) or beyond any bounded window — can never
 * be proven absent from a payload, so callers must fail closed on them
 * instead of dispatching the provider.
 */
export function isDeniedValueIndexable(type: ProtectedValueType, value: string): boolean {
  if (type !== 'PHONE' && type !== 'BANK_ACCOUNT' && type !== 'ID_CARD') return true
  return isNormalizedDigitValueIndexable(type, normalizeProtectedValue(type, value))
}

function buildDigitDenyIndex(deniedValues: readonly DeniedProtectedValue[]): DigitDenyIndex {
  const phone = new Set<string>()
  const bank = new Set<string>()
  const idCard = new Set<string>()
  const unmatchableIndexes = new Set<number>()
  const normalizedByIndex: (string | undefined)[] = new Array<string | undefined>(deniedValues.length).fill(undefined)
  const windowLengths = new Set<number>()
  deniedValues.forEach((entry, index) => {
    if (entry.type !== 'PHONE' && entry.type !== 'BANK_ACCOUNT' && entry.type !== 'ID_CARD') return
    const normalized = normalizeProtectedValue(entry.type, entry.value)
    normalizedByIndex[index] = normalized
    if (!isNormalizedDigitValueIndexable(entry.type, normalized)) {
      unmatchableIndexes.add(index)
      return
    }
    const bucket = entry.type === 'PHONE' ? phone : entry.type === 'BANK_ACCOUNT' ? bank : idCard
    bucket.add(normalized)
    if (entry.type === 'PHONE') {
      // The window matches directly, or with a redundant '86' prefix glued on.
      windowLengths.add(normalized.length)
      windowLengths.add(normalized.length + 2)
    } else {
      windowLengths.add(normalized.length)
    }
  })
  const lengths = [...windowLengths].sort((left, right) => left - right)
  return {
    phone: phone.size === 0 ? undefined : phone,
    bank: bank.size === 0 ? undefined : bank,
    idCard: idCard.size === 0 ? undefined : idCard,
    windowLengths: lengths,
    enumerateTo: lengths.length === 0 ? 0 : lengths[lengths.length - 1]!,
    unmatchableIndexes,
    normalizedByIndex
  }
}

interface DigitLeakSets {
  readonly phone: ReadonlySet<string>
  readonly bank: ReadonlySet<string>
  readonly idCard: ReadonlySet<string>
}

/**
 * Streams the content once, character by character, and matches digit windows
 * directly against the pre-indexed denylist. Nothing proportional to the
 * content is retained: the only state is the group being read plus a bounded
 * suffix of the current run (never longer than the longest denied value plus
 * slack), so digit-dense payloads can neither amplify memory nor blow up the
 * synchronous scan budget. Instead of enumerating every window, the matcher
 * looks up only the window lengths the denylist can actually match, at group
 * boundaries, and compares by typed equality with the shared '86' prefix rule.
 */
function scanDigitRuns(content: string, denyIndex: DigitDenyIndex): DigitLeakSets {
  const phone = new Set<string>()
  const bank = new Set<string>()
  const idCard = new Set<string>()
  if (denyIndex.enumerateTo === 0) return { phone, bank, idCard }
  const text = foldDecimalDigits(content.normalize('NFKC').replace(BRACKETED_TOKEN_SPAN, ' '))
  const enumerateTo = denyIndex.enumerateTo
  // Streaming window state for the current run of digit groups. Offsets are
  // absolute within the run's digit sequence; `runDigits` is a bounded suffix
  // buffer starting at absolute offset `base`, compacted lazily.
  let group = ''
  let groupOversized = false
  let runDigits = ''
  let base = 0
  let totalLength = 0
  let runStarts: number[] = []
  let inRun = false

  const matchWindow = (window: string): void => {
    if (denyIndex.phone !== undefined) {
      const equivalent = dropMainlandCountryPrefix(window)
      if (denyIndex.phone.has(equivalent)) phone.add(equivalent)
    }
    if (denyIndex.bank !== undefined && denyIndex.bank.has(window)) bank.add(window)
    if (denyIndex.idCard !== undefined && denyIndex.idCard.has(window)) idCard.add(window)
  }

  const resetRun = (): void => {
    group = ''
    groupOversized = false
    runDigits = ''
    base = 0
    totalLength = 0
    runStarts = []
    inRun = false
  }

  /** Finishes the group being read and matches every denylist window ending with it. */
  const closeGroup = (): void => {
    if (groupOversized) {
      // Every window through an oversized group is itself oversized, and
      // mid-group substrings are not candidates, so it severs the run.
      runDigits = ''
      base = totalLength
      runStarts = []
    } else if (group.length > 0) {
      runDigits += group
      runStarts.push(totalLength)
      totalLength += group.length
      while (runStarts.length > 0 && totalLength - runStarts[0]! > enumerateTo) runStarts.shift()
      for (const target of denyIndex.windowLengths) {
        const start = totalLength - target
        if (start < base) continue
        if (runStarts.includes(start)) matchWindow(runDigits.slice(start - base))
      }
      // Lazily compact the suffix buffer once the dead prefix grows past slack.
      const dead = runStarts.length > 0 ? runStarts[0]! - base : runDigits.length
      if (dead > 64) {
        runDigits = runDigits.slice(dead)
        base += dead
      }
    }
    group = ''
    groupOversized = false
  }

  /**
   * Matches the ID-card check character against the window of exactly 17
   * digits that ends the run (a group boundary). The X is checked whenever it
   * follows run digits regardless of the character after it — `777X已登记` is
   * the normal Chinese rendering — because the window must equal a denied
   * value exactly, so an unrelated `X轴` can never match.
   */
  const matchTrailingX = (): void => {
    if (denyIndex.idCard === undefined) return
    const start = runStarts.find((candidate) => totalLength - candidate === 17)
    if (start === undefined) return
    const withCheck = `${runDigits.slice(start - base)}X`
    if (denyIndex.idCard.has(withCheck)) idCard.add(withCheck)
  }

  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code >= 0x30 && code <= 0x39) {
      if (!groupOversized) {
        group += text[index]!
        if (group.length > enumerateTo) {
          group = ''
          groupOversized = true
        }
      }
      inRun = true
      index += 1
      continue
    }
    // Outside a run every non-digit is inert: only digits can start a run,
    // so prose pays one character comparison and nothing else.
    if (!inRun) {
      index += 1
      continue
    }
    if (code < 0x10000 && SEPARATOR_CODE_TABLE[code] === 1) {
      closeGroup()
      index += 1
      continue
    }
    if (code === 0x58 || code === 0x78) {
      if (group.length > 0 || runStarts.length > 0) {
        closeGroup()
        matchTrailingX()
        resetRun()
        index += 1
        continue
      }
    }
    closeGroup()
    resetRun()
    index += 1
  }
  closeGroup()
  resetRun()
  return { phone, bank, idCard }
}

/**
 * Lazy, single-pass projections of the outbound content. EMAIL equivalence is
 * case-insensitive and whitespace-free; text types match after NFKC
 * normalization and whitespace collapsing; digit types match typed streaming
 * windows against the denylist index (see scanDigitRuns).
 */
function contentProjections(content: string, denyIndex: DigitDenyIndex) {
  let email: string | undefined
  let collapsed: string | undefined
  let digitLeaks: DigitLeakSets | undefined
  return {
    get email() {
      return (email ??= content.normalize('NFKC').toLowerCase().replace(/\s+/g, ''))
    },
    get collapsed() {
      return (collapsed ??= content.normalize('NFKC').replace(/\s+/g, ' '))
    },
    get digitLeaks() {
      return (digitLeaks ??= scanDigitRuns(content, denyIndex))
    }
  }
}

function deniedValueLeaked(
  projections: ReturnType<typeof contentProjections>,
  content: string,
  entry: DeniedProtectedValue,
  denyIndex: DigitDenyIndex,
  index: number
): boolean {
  if (entry.value.length > 0 && content.includes(entry.value)) return true
  switch (entry.type) {
    case 'PHONE':
    case 'BANK_ACCOUNT':
    case 'ID_CARD': {
      // Below-floor, over-cap, and grammar-invalid values all landed in
      // unmatchableIndexes during index construction and fail closed above.
      if (denyIndex.unmatchableIndexes.has(index)) return true
      const normalized = denyIndex.normalizedByIndex[index]
      if (normalized === undefined) return false
      const leaks = projections.digitLeaks
      return entry.type === 'PHONE'
        ? leaks.phone.has(normalized)
        : entry.type === 'BANK_ACCOUNT'
          ? leaks.bank.has(normalized)
          : leaks.idCard.has(normalized)
    }
    case 'EMAIL': {
      const normalized = normalizeProtectedValue('EMAIL', entry.value)
      return normalized.length > 0 && projections.email.includes(normalized)
    }
    case 'PERSON_NAME':
    case 'ORG_NAME':
    case 'ADDRESS': {
      const normalized = normalizeProtectedValue(entry.type, entry.value)
      return normalized.length > 0 && projections.collapsed.includes(normalized)
    }
  }
}

/**
 * Fail-closed outbound boundary. Findings deliberately omit the matched text so
 * logs and IPC errors cannot echo a protected value or internal identifier.
 */
export function scanOutboundPayload(input: OutboundLeakScanInput): readonly OutboundLeakFinding[] {
  const findings: OutboundLeakFinding[] = []
  if (input.content.length === 0) findings.push({ code: 'EMPTY_PAYLOAD', index: 0 })
  if (new TextEncoder().encode(input.content).length > MAX_OUTBOUND_PAYLOAD_BYTES) {
    // An oversized payload is rejected outright instead of scanned: bounding
    // the synchronous scan budget matters more than classifying its findings.
    findings.push({ code: 'PAYLOAD_TOO_LARGE', index: 0 })
    return findings
  }

  const denyIndex = buildDigitDenyIndex(input.deniedValues)
  const projections = contentProjections(input.content, denyIndex)
  input.deniedValues.forEach((entry, index) => {
    if (deniedValueLeaked(projections, input.content, entry, denyIndex, index)) {
      findings.push({ code: 'PROTECTED_VALUE_LEAK', index })
    }
  })
  input.forbiddenIdentifiers.forEach((identifier, index) => {
    if (identifier.length > 0 && input.content.includes(identifier)) {
      findings.push({ code: 'INTERNAL_IDENTIFIER_LEAK', index })
    }
  })
  for (const match of input.content.matchAll(UUID_LIKE_IDENTIFIER)) {
    findings.push({ code: 'INTERNAL_IDENTIFIER_LEAK', index: match.index })
  }

  const referencedTokens = new Set<string>()
  for (const match of input.content.matchAll(TOKEN_LIKE_REFERENCE)) {
    const token = match[0]
    if (!STRICT_RESTORATION_TOKEN.test(token)) {
      findings.push({ code: 'MALFORMED_TOKEN', index: match.index })
      continue
    }
    referencedTokens.add(token)
    if (!input.allowedTokens.has(token)) {
      findings.push({ code: 'UNKNOWN_TOKEN', index: match.index })
    }
  }
  let tokenIndex = 0
  for (const token of input.allowedTokens) {
    if (!referencedTokens.has(token)) findings.push({ code: 'MISSING_TOKEN', index: tokenIndex })
    tokenIndex += 1
  }
  return findings
}

export class AiLeakDetectedError extends Error {
  constructor(readonly findings: readonly OutboundLeakFinding[]) {
    super('AI outbound payload failed privacy verification')
    this.name = 'AiLeakDetectedError'
  }
}

export function assertSafeOutboundPayload(input: OutboundLeakScanInput): void {
  const findings = scanOutboundPayload(input)
  if (findings.length > 0) throw new AiLeakDetectedError(findings)
}

export * from './openai-compatible'
