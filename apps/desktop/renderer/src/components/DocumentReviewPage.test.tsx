import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockReviewDTO, DocumentReviewDTO, MentionReviewDTO } from '@aliasai/application'
import { renderInEnglish } from '../test-utils'
import { DocumentReviewPage } from './DocumentReviewPage'

function mention(overrides: Partial<MentionReviewDTO> = {}): MentionReviewDTO {
  return {
    mentionId: 'mention-1',
    matterId: 'matter-1',
    documentId: 'document-1',
    type: 'ID_CARD',
    strength: 'EXPLICIT',
    text: '110101199003077774',
    startOffset: 0,
    endOffset: 18,
    blockId: 'block-1',
    pageNo: 1,
    confidence: 0.97,
    detector: 'REGEX',
    reviewStatus: 'UNREVIEWED',
    decisionStatus: 'AUTO_LINKED',
    assignedEntity: {
      id: 'entity-1',
      publicToken: '@N-SYNTHETIC0001',
      type: 'PERSON',
      status: 'ACTIVE',
      primaryAlias: 'Party A',
      createdAt: 1
    },
    candidates: [],
    margin: null,
    ...overrides
  }
}

function blockWith(mentions: readonly MentionReviewDTO[]): BlockReviewDTO {
  return { blockId: 'block-1', pageNo: 1, readingOrder: 0, text: 'synthetic block text', mentions }
}

function renderReview(blocks: readonly BlockReviewDTO[], overrides: Partial<DocumentReviewDTO> = {}) {
  const onSelectMention = vi.fn()
  const onChanged = vi.fn()
  const view = renderInEnglish(
    <DocumentReviewPage
      review={{
        document: {
          id: 'document-1',
          matterId: 'matter-1',
          originalName: 'synthetic.pdf',
          mimeType: 'application/pdf',
          parseStatus: 'READY',
          pageCount: 1,
          createdAt: 1,
          updatedAt: 1
        },
        blocks,
        entities: [],
        constraints: [],
        counts: { mentions: blocks.length, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
        jobs: [],
        ...overrides
      }}
      selectedMentionId={blocks.flatMap((b) => b.mentions)[0]?.mentionId ?? null}
      onSelectMention={onSelectMention}
      onChanged={onChanged}
    />
  )
  return { onSelectMention, onChanged, view }
}

describe('DocumentReviewPage result-first shell', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    invoke.mockResolvedValue({ ok: true, data: null })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('summarizes mutually exclusive buckets from decision statuses', () => {
    const blocks = [
      blockWith([
        mention({ mentionId: 'm-auto', decisionStatus: 'AUTO_LINKED' }),
        mention({ mentionId: 'm-user', decisionStatus: 'USER_ASSIGNED', text: 'second' }),
        mention({ mentionId: 'm-review', decisionStatus: 'NEEDS_REVIEW', text: 'third', assignedEntity: null })
      ]),
      { ...blockWith([mention({ mentionId: 'm-rej', decisionStatus: 'REJECTED', text: 'fourth' })]), blockId: 'block-2' }
    ]
    renderReview(blocks)

    // found=4 = handled=2 + notSensitive=1 + attention=1, and rejected gets its own clause.
    expect(screen.getByText('Found 4 sensitive items: 2 handled, 1 need confirmation.')).toBeDefined()
    expect(screen.getByText('1 more item(s) are marked not sensitive.')).toBeDefined()
  })

  it('shows plain-language state and ownership without internal jargon by default', () => {
    renderReview([blockWith([mention()])])

    expect(screen.getByText('Handled automatically')).toBeDefined()
    expect(screen.getByText((_, element) => element?.textContent === 'Belongs to: Party A')).toBeDefined()

    // Hidden-by-default concepts never appear before their disclosure opens.
    // Word boundaries keep everyday words like "identity" out of the match.
    expect(screen.queryByText(/\bentities\b|\bentity\b/i)).toBeNull()
    expect(screen.queryByText(/\bscore\b/i)).toBeNull()
    expect(screen.queryByText(/\bmargin\b/i)).toBeNull()
    expect(screen.queryByText(/Must-Link|Cannot-Link/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create entity & assign' })).toBeNull()
  })

  it('keeps detector diagnostics behind the technical-details disclosure', async () => {
    const user = userEvent.setup()
    renderReview([blockWith([mention({ margin: 0.42 })])])

    await user.click(screen.getByText('Technical details'))
    const techPanel = screen.getByText('Technical details').closest('details')!
    expect(techPanel.textContent).toContain('confidence 0.97')
    expect(techPanel.textContent).toContain('margin 0.42')
    expect(techPanel.textContent).toContain('review Unreviewed')
  })

  it('opens existing correction operations through Edit result and advanced identity management', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'review:createEntityAndAssign') {
        return Promise.resolve({
          ok: true,
          data: { mention: mention(), entity: { id: 'entity-9', publicToken: '@N-X', type: 'PERSON', status: 'ACTIVE', primaryAlias: '新化名', createdAt: 1 } }
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderReview([
      blockWith([
        mention({
          decisionStatus: 'NEEDS_REVIEW',
          assignedEntity: null,
          candidates: [
            {
              candidateId: 'candidate-1',
              entity: { id: 'entity-1', publicToken: '@N-TOKEN', type: 'PERSON', status: 'ACTIVE', primaryAlias: 'Candidate Person', createdAt: 1 },
              score: 0.8,
              state: 'PENDING',
              algorithmVersion: 'v1',
              evidence: [{ evidenceType: 'EXACT_NAME', weight: 3, score: 0.8 }]
            }
          ]
        })
      ])
    ])

    // Attention items lead with Confirm owner as the primary action.
    await user.click(screen.getByRole('button', { name: 'Confirm owner' }))
    const detailPanel = document.querySelector('.mention-detail')!
    expect(within(detailPanel as HTMLElement).getByRole('button', { name: 'Accept' })).toBeDefined()
    expect(
      within(detailPanel as HTMLElement).queryByPlaceholderText('New entity pseudonym (e.g. Party A)')
    ).toBeNull()

    // Two disclosures share this label (per-item editor + matter-level); the
    // correction form lives in the per-item one.
    await user.click(within(detailPanel as HTMLElement).getByText('Advanced identity management'))
    const aliasInput = within(detailPanel as HTMLElement).getByPlaceholderText('New entity pseudonym (e.g. Party A)')
    await user.type(aliasInput, 'New Party')
    await user.click(screen.getByRole('button', { name: 'Create entity & assign' }))
    expect(invoke).toHaveBeenCalledWith(
      'review:createEntityAndAssign',
      { mentionId: 'mention-1', primaryAlias: 'New Party', entityType: 'PERSON' }
    )
  })

  it.each([
    ['NEEDS_REVIEW', true],
    ['UNRESOLVED', true],
    ['AUTO_LINKED', false],
    ['USER_ASSIGNED', false],
    ['REJECTED', false]
  ] as const)('gives %s the prominent confirm action: %s', async (decisionStatus, hasConfirm) => {
    renderReview([
      blockWith([
        mention({
          decisionStatus,
          ...(decisionStatus === 'REJECTED' ? { assignedEntity: null } : {})
        })
      ])
    ])
    if (decisionStatus === 'NEEDS_REVIEW' || decisionStatus === 'UNRESOLVED') {
      expect(await screen.findByRole('button', { name: 'Confirm owner' })).toBeDefined()
    } else if (hasConfirm) {
      expect(await screen.findByRole('button', { name: 'Confirm owner' })).toBeDefined()
    } else {
      expect(screen.queryByRole('button', { name: 'Confirm owner' })).toBeNull()
    }
  })

  it('requires confirmation before rejecting an item as not sensitive', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    renderReview([blockWith([mention({ decisionStatus: 'UNRESOLVED', assignedEntity: null })])])

    await user.click(await screen.findByRole('button', { name: 'Not sensitive' }))

    expect(confirmSpy).toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => channel === 'review:rejectMention')).toBe(false)
    confirmSpy.mockRestore()
  })

  it('marks rejected items as not sensitive instead of asking for confirmation', () => {
    renderReview([blockWith([mention({ decisionStatus: 'REJECTED', assignedEntity: null })])])
    expect(screen.getByText('Not sensitive')).toBeDefined()
    expect(screen.getByText(/This text is marked not sensitive, so sanitized documents keep it unchanged/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Edit result' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Not sensitive' })).toBeNull()
  })

  it('collapses the missed-detection entry point until expanded', async () => {
    const user = userEvent.setup()
    renderReview([blockWith([])])

    expect(screen.queryByLabelText('Source block')).toBeNull()
    expect(screen.getByText('Missing a piece of sensitive information?')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Add a marker' }))
    expect(screen.getByLabelText('Source block')).toBeDefined()
    expect(screen.getByLabelText('Exact text from the block')).toBeDefined()
    expect(screen.getByLabelText('Sensitive text type')).toBeDefined()
  })
})
