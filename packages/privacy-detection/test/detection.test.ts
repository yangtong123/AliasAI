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

  it('detects high-precision Chinese contract subjects and captures only the field value', () => {
    const text =
      '出租方：湖北众创科技孵化园有限公司 授权代表：喻越 身份证号：421022199406233911 手机：18923414607'

    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(
      proposals.map(({ type, startOffset, endOffset, detector }) => ({
        type,
        value: text.slice(startOffset, endOffset),
        detector
      }))
    ).toEqual([
      { type: 'ORGANIZATION', value: '湖北众创科技孵化园有限公司', detector: 'REGEX' },
      { type: 'PERSON', value: '喻越', detector: 'REGEX' },
      { type: 'ID_CARD', value: '421022199406233911', detector: 'REGEX' },
      { type: 'PHONE', value: '18923414607', detector: 'REGEX' }
    ])
  })

  it('detects a labeled bank account without including its label', () => {
    const text = '开户账号：6222 0202 1234 5678 901'

    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ type: 'BANK_ACCOUNT', detector: 'REGEX', confidence: 0.99 })
    expect(text.slice(proposals[0]!.startOffset, proposals[0]!.endOffset)).toBe('6222 0202 1234 5678 901')
  })

  it('captures a labeled Chinese address only to the next structured field', () => {
    const text = '联系地址：湖北省武汉市洪山区珞喻路1号 电话：18923414607'

    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(proposals.map((proposal) => ({
      type: proposal.type,
      value: text.slice(proposal.startOffset, proposal.endOffset)
    }))).toEqual([
      { type: 'ADDRESS', value: '湖北省武汉市洪山区珞喻路1号' },
      { type: 'PHONE', value: '18923414607' }
    ])
  })

  it('stops a labeled address at a comma-separated field so the next value stays its own mention', () => {
    const text = '地址：北京市海淀区中关村大街1号，电话：13800138000。'

    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(proposals.map((proposal) => ({
      type: proposal.type,
      value: text.slice(proposal.startOffset, proposal.endOffset)
    }))).toEqual([
      { type: 'ADDRESS', value: '北京市海淀区中关村大街1号' },
      { type: 'PHONE', value: '13800138000' }
    ])
  })

  it('stops a labeled address before an ASCII comma followed by a bank account label', () => {
    const text = '通讯地址:上海市浦东新区世纪大道100号, 银行账号：6222020212345678901'

    const proposals = detectPrivacyMentions({ ...boundary, text })

    expect(proposals.map((proposal) => ({
      type: proposal.type,
      value: text.slice(proposal.startOffset, proposal.endOffset)
    }))).toEqual([
      { type: 'ADDRESS', value: '上海市浦东新区世纪大道100号' },
      { type: 'BANK_ACCOUNT', value: '6222020212345678901' }
    ])
  })

  it('computes capture offsets from the exact group span, not from a first textual occurrence', () => {
    const detector = new RuleBasedPrivacyDetector([
      { type: 'ADDRESS', expression: /电话号码[：:](电话号码.{2,})/g, captureGroup: 1, confidence: 0.9 }
    ])
    const text = '电话号码：电话号码大厦'

    const proposals = detector.detect({ ...boundary, text })

    expect(proposals).toHaveLength(1)
    expect(text.slice(proposals[0]!.startOffset, proposals[0]!.endOffset)).toBe('电话号码大厦')
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

  it('validates custom capture groups', () => {
    expect(
      () => new RuleBasedPrivacyDetector([{ type: 'PERSON', expression: /(name)/g, captureGroup: 0 }])
    ).toThrow('captureGroup must be a positive integer')
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
