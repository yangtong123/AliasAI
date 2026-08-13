import type { MentionDetector, MentionStrength, MentionType } from '@aliasai/domain'

export interface DetectableBlock {
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly blockId: string
  /** Decrypted transient text. Detectors must never persist or log this value. */
  readonly text: string
}

/** A location-only proposal. The application owns plaintext slicing and encryption. */
export interface MentionProposal {
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly blockId: string
  readonly type: MentionType
  readonly strength: MentionStrength
  readonly startOffset: number
  readonly endOffset: number
  readonly detector: MentionDetector
  readonly confidence: number
}

export interface PrivacyDetector {
  detect(block: DetectableBlock): readonly MentionProposal[] | Promise<readonly MentionProposal[]>
}

export interface PrivacyDetectionRule {
  readonly type: MentionType
  readonly expression: RegExp
  readonly strength?: MentionStrength
  readonly confidence?: number
}

const defaultRules: readonly PrivacyDetectionRule[] = [
  { type: 'EMAIL', expression: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'ID_CARD', expression: /\b\d{17}[\dXx]\b/g },
  { type: 'PHONE', expression: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g }
]

interface RankedProposal {
  readonly proposal: MentionProposal
  readonly ruleIndex: number
}

/**
 * Deterministic V1 detector for high-precision structured identifiers. It emits
 * proposals only and never creates Entities or retains the matched plaintext.
 */
export class RuleBasedPrivacyDetector implements PrivacyDetector {
  readonly #rules: readonly PrivacyDetectionRule[]

  constructor(rules: readonly PrivacyDetectionRule[] = defaultRules) {
    this.#rules = rules.map((rule) => {
      if (rule.expression.source.length === 0) throw new Error('Privacy detection rules must not match empty text')
      const probeFlags = rule.expression.flags.replaceAll('g', '').replaceAll('y', '')
      if (new RegExp(rule.expression.source, probeFlags).test('')) {
        throw new Error('Privacy detection rules must not match empty text')
      }
      if (rule.confidence !== undefined && (!Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1)) {
        throw new Error('Privacy detection rule confidence must be between 0 and 1')
      }
      if (!MENTION_TYPES.has(rule.type)) throw new Error('Privacy detection rule type is not supported')
      if (rule.strength !== undefined && !MENTION_STRENGTHS.has(rule.strength)) {
        throw new Error('Privacy detection rule strength is not supported')
      }
      return rule
    })
  }

  detect(block: DetectableBlock): readonly MentionProposal[] {
    assertBlockBoundary(block)
    const ranked: RankedProposal[] = []
    for (const [ruleIndex, rule] of this.#rules.entries()) {
      const flags = rule.expression.flags.includes('g') ? rule.expression.flags : `${rule.expression.flags}g`
      const expression = new RegExp(rule.expression.source, flags)
      for (const match of block.text.matchAll(expression)) {
        const startOffset = match.index
        const matchedLength = match[0].length
        if (startOffset === undefined || matchedLength === 0) continue
        ranked.push({
          ruleIndex,
          proposal: {
            matterId: block.matterId,
            documentId: block.documentId,
            pageId: block.pageId,
            blockId: block.blockId,
            type: rule.type,
            strength: rule.strength ?? 'EXPLICIT',
            startOffset,
            endOffset: startOffset + matchedLength,
            detector: 'REGEX',
            confidence: rule.confidence ?? 0.99
          }
        })
      }
    }

    ranked.sort(
      (left, right) =>
        left.proposal.startOffset - right.proposal.startOffset ||
        right.proposal.endOffset - left.proposal.endOffset ||
        left.ruleIndex - right.ruleIndex
    )
    const accepted: MentionProposal[] = []
    for (const candidate of ranked) {
      const previous = accepted.at(-1)
      if (previous !== undefined && candidate.proposal.startOffset < previous.endOffset) continue
      accepted.push(candidate.proposal)
    }
    return accepted
  }
}

const MENTION_TYPES = new Set<MentionType>([
  'PERSON',
  'ORGANIZATION',
  'PHONE',
  'EMAIL',
  'ID_CARD',
  'BANK_ACCOUNT',
  'ADDRESS',
  'CASE_NUMBER',
  'CONTRACT_NUMBER',
  'COURT',
  'LAWYER',
  'JUDGE'
])
const MENTION_STRENGTHS = new Set<MentionStrength>(['EXPLICIT', 'PARTIAL', 'REFERENCE'])

const defaultDetector = new RuleBasedPrivacyDetector()

/** Backwards-compatible convenience entry point for the default V1 rules. */
export function detectPrivacyMentions(block: DetectableBlock): readonly MentionProposal[] {
  return defaultDetector.detect(block)
}

function assertBlockBoundary(block: DetectableBlock): void {
  for (const [field, value] of [
    ['matterId', block.matterId],
    ['documentId', block.documentId],
    ['pageId', block.pageId],
    ['blockId', block.blockId]
  ] as const) {
    if (value.trim().length === 0) throw new Error(`${field} must not be empty`)
  }
}
