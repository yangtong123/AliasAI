import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlockReviewDTO } from '@aliasai/application'
import { BlockText } from './BlockText'

const block = (text: string, mentions: BlockReviewDTO['mentions']): BlockReviewDTO => ({
  blockId: 'block-1',
  pageNo: 0,
  readingOrder: 0,
  text,
  mentions
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BlockText', () => {
  it('renders mention spans between plain text slices', () => {
    render(
      <BlockText
        block={block('Reach Holder via phone.', [
          {
            mentionId: 'mention-1',
            matterId: 'matter-1',
            documentId: 'document-1',
            type: 'PERSON',
            strength: 'EXPLICIT',
            text: 'Holder',
            startOffset: 6,
            endOffset: 12,
            blockId: 'block-1',
            pageNo: 0,
            confidence: 0.9,
            detector: 'NER',
            reviewStatus: 'UNREVIEWED',
            decisionStatus: 'NEEDS_REVIEW',
            assignedEntity: null,
            candidates: [],
            margin: null
          }
        ])}
        selectedMentionId={null}
        onSelectMention={() => {}}
      />
    )

    const mentionButton = screen.getByRole('button', { name: 'Holder' })
    expect(mentionButton.className).toContain('decision-needs_review')
    expect(screen.getByText('Reach')).toBeDefined()
    expect(screen.getByText('via phone.', { exact: false })).toBeDefined()
  })

  it('selects a mention on click', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <BlockText
        block={block('Holder', [
          {
            mentionId: 'mention-1',
            matterId: 'matter-1',
            documentId: 'document-1',
            type: 'PERSON',
            strength: 'EXPLICIT',
            text: 'Holder',
            startOffset: 0,
            endOffset: 6,
            blockId: 'block-1',
            pageNo: 0,
            confidence: 0.9,
            detector: 'NER',
            reviewStatus: 'UNREVIEWED',
            decisionStatus: 'AUTO_LINKED',
            assignedEntity: null,
            candidates: [],
            margin: null
          }
        ])}
        selectedMentionId={null}
        onSelectMention={onSelect}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Holder' }))
    expect(onSelect).toHaveBeenCalledWith('mention-1')
  })
})
