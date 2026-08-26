import { describe, expect, it } from 'vitest'
import { extractLabeledContextLinks } from '../src/index'

function mention(text: string, value: string, id: string, type: 'PERSON' | 'ORGANIZATION' | 'PHONE' | 'ID_CARD') {
  const startOffset = text.indexOf(value)
  return { id, type, startOffset, endOffset: startOffset + value.length }
}

describe('labeled contract context evidence', () => {
  it('links labeled identifiers to the nearest explicitly labeled person', () => {
    const text =
      '出租方：湖北众创科技孵化园有限公司 授权代表：喻越 身份证号：421022199406233911 手机：18923414607'
    const mentions = [
      mention(text, '湖北众创科技孵化园有限公司', 'org', 'ORGANIZATION'),
      mention(text, '喻越', 'person', 'PERSON'),
      mention(text, '421022199406233911', 'id-card', 'ID_CARD'),
      mention(text, '18923414607', 'phone', 'PHONE')
    ]

    expect(extractLabeledContextLinks(text, mentions)).toEqual([
      { mentionId: 'id-card', subjectMentionId: 'person', evidenceType: 'SAME_LABELED_FIELD_GROUP', score: 100 },
      { mentionId: 'phone', subjectMentionId: 'person', evidenceType: 'SAME_LABELED_FIELD_GROUP', score: 100 }
    ])
  })

  it('does not infer ownership from proximity without explicit labels', () => {
    const text = '喻越 421022199406233911 18923414607'
    const mentions = [
      mention(text, '喻越', 'person', 'PERSON'),
      mention(text, '421022199406233911', 'id-card', 'ID_CARD'),
      mention(text, '18923414607', 'phone', 'PHONE')
    ]

    expect(extractLabeledContextLinks(text, mentions)).toEqual([])
  })

  it('stops a subject scope at the next subject and at sentence boundaries', () => {
    const text = '联系人：张三 电话：13800138000；联系人：李四 电话：13900139000。电话：13700137000'
    const mentions = [
      mention(text, '张三', 'person-a', 'PERSON'),
      mention(text, '13800138000', 'phone-a', 'PHONE'),
      mention(text, '李四', 'person-b', 'PERSON'),
      mention(text, '13900139000', 'phone-b', 'PHONE'),
      mention(text, '13700137000', 'phone-outside', 'PHONE')
    ]

    expect(extractLabeledContextLinks(text, mentions)).toEqual([
      { mentionId: 'phone-a', subjectMentionId: 'person-a', evidenceType: 'SAME_LABELED_FIELD_GROUP', score: 100 },
      { mentionId: 'phone-b', subjectMentionId: 'person-b', evidenceType: 'SAME_LABELED_FIELD_GROUP', score: 100 }
    ])
  })
})
