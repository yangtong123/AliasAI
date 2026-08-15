import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SanitizedPreview } from '@aliasai/application'
import { SanitizedPreviewView } from './SanitizedPreview'

describe('SanitizedPreviewView', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('explains blockers when the document is not fully resolved', () => {
    const preview: SanitizedPreview = {
      status: 'READY',
      blockers: [{ mentionId: 'mention-1', reason: 'UNRESOLVED' }]
    }

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)

    expect(screen.getByText(/Preview blocked/)).toBeDefined()
    expect(screen.getByText(/mention-1: UNRESOLVED/)).toBeDefined()
  })

  it('renders sanitized spans, restore policies, and the local rehydration demo', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: '当事人:Holder One〔@I-933F7561C93A4DB8〕。' }],
      mappings: [
        { mentionId: 'mention-1', alias: 'Holder One', publicToken: '@I-933F7561C93A4DB8', restorePolicy: 'RESTORE_ON_REQUEST' }
      ]
    }
    invoke.mockResolvedValueOnce({ ok: true, data: { text: '当事人:110101199003077774。', unresolvedTokens: [] } })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)

    expect(screen.getByText(/当事人:Holder One〔@I-933F7561C93A4DB8〕。/)).toBeDefined()
    expect(screen.getByText('RESTORE_ON_REQUEST')).toBeDefined()

    await user.type(screen.getByLabelText('Simulated AI reply'), '当事人:Holder One〔@I-933F7561C93A4DB8〕。')
    await user.click(screen.getByRole('button', { name: 'Rehydrate locally' }))

    expect(invoke).toHaveBeenCalledWith('preview:rehydrate', {
      sanitizedDocumentId: 'sanitized-1',
      text: '当事人:Holder One〔@I-933F7561C93A4DB8〕。',
      includeRestoreOnRequest: true
    })
    expect(await screen.findByText('当事人:110101199003077774。')).toBeDefined()
  })

  it('reports unresolved tokens from the demo as a manual-review warning', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: '参见〔@I-0000000000000000〕' }],
      mappings: []
    }
    invoke.mockResolvedValueOnce({ ok: true, data: { text: '参见〔@I-0000000000000000〕', unresolvedTokens: ['@I-0000000000000000'] } })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)

    await user.type(screen.getByLabelText('Simulated AI reply'), '参见〔@I-0000000000000000〕')
    await user.click(screen.getByRole('button', { name: 'Rehydrate locally' }))

    expect(await screen.findByText(/Unresolved tokens.*@I-0000000000000000/)).toBeDefined()
  })
})
