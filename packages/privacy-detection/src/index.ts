import type { MentionType, NormalizedBBox } from '@aliasai/domain'

export interface DetectableBlock {
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly blockId: string
  /** Decrypted transient text. Never persist or log this value from this package. */
  readonly text: string
  readonly bbox?: NormalizedBBox
}

export interface MentionProposal {
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly blockId: string
  readonly type: MentionType
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly detector: 'REGEX'
  readonly confidence: number
  readonly bbox?: NormalizedBBox
}

const patterns: ReadonlyArray<{ readonly type: MentionType; readonly expression: RegExp }> = [
  { type: 'EMAIL', expression: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'ID_CARD', expression: /\b\d{17}[\dXx]\b/g },
  { type: 'PHONE', expression: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g }
]

/** Deterministic V1 proposal generator. It detects occurrences; it never creates Entities. */
export function detectPrivacyMentions(block: DetectableBlock): MentionProposal[] {
  const proposals: MentionProposal[] = []
  for (const pattern of patterns) {
    for (const match of block.text.matchAll(pattern.expression)) {
      const text = match[0]
      const startOffset = match.index
      if (startOffset === undefined) continue
      proposals.push({
        matterId: block.matterId,
        documentId: block.documentId,
        pageId: block.pageId,
        blockId: block.blockId,
        type: pattern.type,
        text,
        startOffset,
        endOffset: startOffset + text.length,
        detector: 'REGEX',
        confidence: 0.99,
        ...(block.bbox === undefined ? {} : { bbox: block.bbox })
      })
    }
  }
  return proposals.sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)
}
