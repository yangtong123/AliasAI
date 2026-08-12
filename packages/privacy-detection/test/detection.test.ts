import { describe, expect, it } from 'vitest'
import { detectPrivacyMentions } from '../src/index'

describe('privacy detection proposals', () => {
  it('detects synthetic strong identifiers without creating identity records', () => {
    const mentions = detectPrivacyMentions({
      matterId: 'matter-1',
      documentId: 'document-1',
      pageId: 'page-1',
      blockId: 'block-1',
      text: 'Email synthetic@example.test; phone 13800138000; id 11010519491231002X.'
    })

    expect(mentions.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: 'EMAIL', text: 'synthetic@example.test' },
      { type: 'PHONE', text: '13800138000' },
      { type: 'ID_CARD', text: '11010519491231002X' }
    ])
    expect(mentions.every((mention) => !('entityId' in mention))).toBe(true)
  })
})
