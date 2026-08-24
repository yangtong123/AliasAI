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
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: '当事人:Holder One〔@I-933F7561C93A4DB8〕。' }]
    }
    invoke
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: { text: '当事人:110101199003077774。', unresolvedTokens: [] } })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)

    expect(screen.getByText(/当事人:Holder One〔@I-933F7561C93A4DB8〕。/)).toBeDefined()
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
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: '参见〔@I-0000000000000000〕' }]
    }
    invoke
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: true, data: { text: '参见〔@I-0000000000000000〕', unresolvedTokens: ['@I-0000000000000000'] } })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)

    await user.type(screen.getByLabelText('Simulated AI reply'), '参见〔@I-0000000000000000〕')
    await user.click(screen.getByRole('button', { name: 'Rehydrate locally' }))

    expect(await screen.findByText(/Unresolved tokens.*@I-0000000000000000/)).toBeDefined()
  })

  it('runs Mock AI and displays sanitized and locally rehydrated responses', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-ABC123〕' }]
    }
    invoke
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          id: 'ai-1',
          sanitizedDocumentId: 'sanitized-1',
          providerId: 'mock-v1',
          status: 'COMPLETED',
          sanitizedResponse: 'Analysis: Holder One〔@N-ABC123〕',
          rehydratedResponse: 'Analysis: Synthetic Person',
          unresolvedTokens: [],
          createdAt: 1,
          finishedAt: 2
        }
      })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))

    expect(invoke).toHaveBeenCalledWith('ai:execute', {
      sanitizedDocumentId: 'sanitized-1',
      includeRestoreOnRequest: false
    })
    expect(await screen.findByText('Analysis: Holder One〔@N-ABC123〕')).toBeDefined()
    expect(screen.getByText('Analysis: Synthetic Person')).toBeDefined()
  })

  it('drops a stale Mock AI result after the sanitized document switches', async () => {
    const previewA: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    const previewB: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-2',
      createdAt: 1,
      blocks: [{ blockId: 'block-2', pageNo: 0, readingOrder: 0, text: 'Holder Two〔@N-BBB222〕' }]
    }
    let resolveExecute: ((envelope: unknown) => void) | undefined
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:execute') {
        return new Promise((resolve) => {
          resolveExecute = resolve
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    const view = render(<SanitizedPreviewView documentId="document-1" preview={previewA} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    view.rerender(<SanitizedPreviewView documentId="document-2" preview={previewB} onGenerated={() => {}} />)

    // The remounted panel must not inherit document A's in-flight request.
    expect((screen.getByRole('button', { name: 'Send sanitized document' }) as HTMLButtonElement).disabled).toBe(false)

    resolveExecute?.({
      ok: true,
      data: {
        id: 'ai-1',
        sanitizedDocumentId: 'sanitized-1',
        providerId: 'mock-v1',
        status: 'COMPLETED',
        sanitizedResponse: 'Analysis of Holder One〔@N-AAA111〕',
        rehydratedResponse: '张伟 Analysis of Holder One',
        unresolvedTokens: [],
        createdAt: 1,
        finishedAt: 2
      }
    })
    // Flush the entire resolved promise chain (microtasks) via a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('张伟 Analysis of Holder One')).toBeNull()
    expect(screen.queryByText('Analysis of Holder One〔@N-AAA111〕')).toBeNull()
    expect(screen.getByText('Holder Two〔@N-BBB222〕')).toBeDefined()
    expect(invoke).toHaveBeenCalledWith('ai:latest', {
      sanitizedDocumentId: 'sanitized-2',
      includeRestoreOnRequest: false
    })
  })

  it('hides the previous restore policy result the moment the policy changes', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    let resolveLatest: ((envelope: unknown) => void) | undefined
    invoke.mockImplementation((channel: string, payload: { includeRestoreOnRequest?: boolean }) => {
      if (channel === 'ai:latest' && payload.includeRestoreOnRequest === true) {
        return new Promise((resolve) => {
          resolveLatest = resolve
        })
      }
      return Promise.resolve({
        ok: true,
        data: {
          id: 'ai-1',
          sanitizedDocumentId: 'sanitized-1',
          providerId: 'mock-v1',
          status: 'COMPLETED',
          sanitizedResponse: 'Analysis of Holder One〔@N-AAA111〕',
          rehydratedResponse: 'Withheld-by-policy view',
          unresolvedTokens: ['@N-AAA111'],
          createdAt: 1,
          finishedAt: 2
        }
      })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    expect(await screen.findByText('Withheld-by-policy view')).toBeDefined()

    await user.click(screen.getByLabelText('Restore RESTORE_ON_REQUEST values locally'))

    // Old-policy output must vanish before the new-policy fetch settles.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolveLatest).toBeDefined()
    expect(screen.queryByText('Withheld-by-policy view')).toBeNull()

    resolveLatest?.({
      ok: true,
      data: {
        id: 'ai-1',
        sanitizedDocumentId: 'sanitized-1',
        providerId: 'mock-v1',
        status: 'COMPLETED',
        sanitizedResponse: 'Analysis of Holder One〔@N-AAA111〕',
        rehydratedResponse: '张伟 Analysis of Holder One',
        unresolvedTokens: [],
        createdAt: 1,
        finishedAt: 2
      }
    })
    expect(await screen.findByText('张伟 Analysis of Holder One')).toBeDefined()
  })

  it('never lets a slow ai:latest overwrite a fresher ai:execute result', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    let resolveFirstLatest: (() => void) | undefined
    let firstLatestPending = true
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:latest' && firstLatestPending) {
        return new Promise((resolve) => {
          resolveFirstLatest = () => {
            firstLatestPending = false
            resolve({ ok: true, data: null })
          }
        })
      }
      if (channel === 'ai:execute') {
        return Promise.resolve({
          ok: true,
          data: {
            id: 'ai-2',
            sanitizedDocumentId: 'sanitized-1',
            providerId: 'mock-v1',
            status: 'COMPLETED',
            sanitizedResponse: 'Fresh execution',
            rehydratedResponse: 'Fresh restored',
            unresolvedTokens: [],
            createdAt: 2,
            finishedAt: 3
          }
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    expect(await screen.findByText('Fresh restored')).toBeDefined()

    resolveFirstLatest?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('Fresh restored')).toBeDefined()
    expect(screen.getByText('Fresh execution')).toBeDefined()
  })

  it('isolates mutation pending and error state from the previous restore policy', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    let rejectExecute: ((envelope: unknown) => void) | undefined
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:execute') {
        return new Promise((_resolve, reject) => {
          rejectExecute = reject
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    await user.click(screen.getByLabelText('Restore RESTORE_ON_REQUEST values locally'))

    // The new policy must not inherit the old policy's hanging request.
    expect((screen.getByRole('button', { name: 'Send sanitized document' }) as HTMLButtonElement).disabled).toBe(false)

    rejectExecute?.({ ok: false, error: { code: 'AI_PROVIDER_FAILURE', message: 'AI provider request failed' } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('AI provider request failed')).toBeNull()
  })

  it('still surfaces a provider failure under the policy it was issued with', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:execute') {
        return Promise.resolve({ ok: false, error: { code: 'AI_PROVIDER_FAILURE', message: 'AI provider request failed' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))

    expect(await screen.findByText('AI provider request failed')).toBeDefined()
  })

  it('keeps interleaved executions of two policies isolated when the older one fails', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    const executions: Array<{ resolve: (envelope: unknown) => void; reject: (envelope: unknown) => void }> = []
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:execute') {
        return new Promise((resolve, reject) => {
          executions.push({ resolve, reject })
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    // Policy A (includeRestoreOnRequest=false) starts, then the user switches
    // to policy B and starts a second execution while A is still in flight.
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    await user.click(screen.getByLabelText('Restore RESTORE_ON_REQUEST values locally'))
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    expect(executions).toHaveLength(2)

    // A fails while B is still pending: A's error must not surface under B,
    // and A settling must not clear B's pending state. (Failures cross the IPC
    // facade as resolved { ok: false } envelopes, so resolve instead of reject.)
    executions[0]!.resolve({ ok: false, error: { code: 'AI_PROVIDER_FAILURE', message: 'AI provider request failed' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('AI provider request failed')).toBeNull()
    expect((screen.getByRole('button', { name: 'Running…' }) as HTMLButtonElement).disabled).toBe(true)

    executions[1]!.resolve({
      ok: true,
      data: {
        id: 'ai-2',
        sanitizedDocumentId: 'sanitized-1',
        providerId: 'mock-v1',
        status: 'COMPLETED',
        sanitizedResponse: 'Analysis of Holder One〔@N-AAA111〕',
        rehydratedResponse: 'Policy B restored view',
        unresolvedTokens: [],
        createdAt: 2,
        finishedAt: 3
      }
    })
    expect(await screen.findByText('Policy B restored view')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Send sanitized document' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps interleaved executions of two policies isolated when the older one succeeds', async () => {
    const preview: SanitizedPreview = {
      status: 'AVAILABLE',
      sanitizedDocumentId: 'sanitized-1',
      createdAt: 1,
      blocks: [{ blockId: 'block-1', pageNo: 0, readingOrder: 0, text: 'Holder One〔@N-AAA111〕' }]
    }
    const executions: Array<{ resolve: (envelope: unknown) => void; reject: (envelope: unknown) => void }> = []
    invoke.mockImplementation((channel: string) => {
      if (channel === 'ai:execute') {
        return new Promise((resolve, reject) => {
          executions.push({ resolve, reject })
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    render(<SanitizedPreviewView documentId="document-1" preview={preview} onGenerated={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))
    await user.click(screen.getByLabelText('Restore RESTORE_ON_REQUEST values locally'))
    await user.click(screen.getByRole('button', { name: 'Send sanitized document' }))

    // B fails while A is still pending: B's error owns the state and A's late
    // success must neither clear it nor re-enable the button on its own.
    executions[1]!.resolve({ ok: false, error: { code: 'AI_PROVIDER_FAILURE', message: 'AI provider request failed' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await screen.findByText('AI provider request failed')).toBeDefined()

    executions[0]!.resolve({
      ok: true,
      data: {
        id: 'ai-1',
        sanitizedDocumentId: 'sanitized-1',
        providerId: 'mock-v1',
        status: 'COMPLETED',
        sanitizedResponse: 'Stale policy A analysis〔@N-AAA111〕',
        rehydratedResponse: 'Stale policy A restored',
        unresolvedTokens: [],
        createdAt: 1,
        finishedAt: 2
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('AI provider request failed')).toBeDefined()
    expect(screen.queryByText('Stale policy A restored')).toBeNull()
  })
})
