import { describe, expect, it } from 'vitest'
import { RuleBasedPrivacyDetector, detectPrivacyMentions } from '../src/index'

const boundary = {
  matterId: 'matter-1',
  documentId: 'document-1',
  pageId: 'page-1',
  blockId: 'block-1'
}

describe('privacy detection proposals', () => {
  it('detects synthetic strong identifiers without returning plaintext or identity records', () => {
    const text = 'Email synthetic@example.test; phone 13800138000; id 11010519491231002X.'
    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(proposals.map(({ type, startOffset, endOffset }) => ({
      type,
      value: text.slice(startOffset, endOffset)
    }))).toEqual([
      { type: 'EMAIL', value: 'synthetic@example.test' },
      { type: 'PHONE', value: '13800138000' },
      { type: 'ID_CARD', value: '11010519491231002X' }
    ])
    expect(proposals.every((proposal) => !('text' in proposal) && !('entityId' in proposal))).toBe(true)
  })

  it('makes custom rules pluggable and resolves overlaps deterministically', () => {
    const detector = new RuleBasedPrivacyDetector([
      { type: 'PHONE', expression: /13800138000/g, confidence: 0.98 },
      { type: 'EMAIL', expression: /13800138000@example\.test/g, confidence: 1 }
    ])

    const proposals = detector.detect({ ...boundary, text: '13800138000@example.test' })

    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ type: 'EMAIL', startOffset: 0, endOffset: 24, confidence: 1 })
  })

  it('does not leak state between calls when a supplied expression is global', () => {
    const detector = new RuleBasedPrivacyDetector([{ type: 'EMAIL', expression: /a@example\.test/g }])
    const input = { ...boundary, text: 'a@example.test' }
    expect(detector.detect(input)).toHaveLength(1)
    expect(detector.detect(input)).toHaveLength(1)
  })

  it('rejects rules that can produce zero-length proposals', () => {
    expect(() => new RuleBasedPrivacyDetector([{ type: 'PERSON', expression: /a*/g }])).toThrow(
      'Privacy detection rules must not match empty text'
    )
  })

  it('rejects unsupported custom rule classifiers at runtime', () => {
    expect(() =>
      new RuleBasedPrivacyDetector([{ type: 'SECRET' as 'PERSON', expression: /secret/g }])
    ).toThrow('Privacy detection rule type is not supported')
  })
})
