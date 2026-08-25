import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentReviewDTO, DocumentSummaryDTO, MatterSummaryDTO } from '@aliasai/application'
import { App } from './App'
import { renderInEnglish } from './test-utils'

const matterOne: MatterSummaryDTO = {
  id: 'matter-1',
  name: 'Matter One',
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1
}
const matterTwo: MatterSummaryDTO = { ...matterOne, id: 'matter-2', name: 'Matter Two' }
const documentOne: DocumentSummaryDTO = {
  id: 'document-1',
  matterId: 'matter-1',
  originalName: 'synthetic.pdf',
  mimeType: 'application/pdf',
  parseStatus: 'IMPORTED',
  pageCount: 0,
  createdAt: 2,
  updatedAt: 2
}

describe('App workspace recovery', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    localStorage.clear()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('restores the last valid Matter and Document after a renderer restart', async () => {
    localStorage.setItem('aliasai.lastMatterId', 'matter-1')
    localStorage.setItem('aliasai.lastDocumentId', 'document-1')
    installWorkspaceMock(invoke, [matterOne], { 'matter-1': [documentOne] })

    renderInEnglish(<App />)

    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()
    expect(invoke).toHaveBeenCalledWith('document:list', { matterId: 'matter-1' })
    expect(invoke).toHaveBeenCalledWith('document:get', { documentId: 'document-1' })
  })

  it('clears the previous Document immediately when the Matter changes', async () => {
    let resolveMatterTwoDocuments: ((value: unknown) => void) | undefined
    installWorkspaceMock(invoke, [matterOne, matterTwo], { 'matter-1': [documentOne] }, (channel, payload) => {
      if (channel === 'document:list' && payload.matterId === 'matter-2') {
        return new Promise((resolve) => {
          resolveMatterTwoDocuments = resolve
        })
      }
      return undefined
    })
    const user = userEvent.setup()

    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Matter Two' }))

    expect(await screen.findByText('Select a matter and document')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'synthetic.pdf' })).toBeNull()
    expect(resolveMatterTwoDocuments).toBeDefined()
  })

  it('refreshes the Matter list after creating a Matter', async () => {
    const created: MatterSummaryDTO = { ...matterOne, id: 'matter-new', name: 'New Matter' }
    let listCalls = 0
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') {
        listCalls += 1
        return Promise.resolve({ ok: true, data: listCalls === 1 ? [] : [created] })
      }
      if (channel === 'matter:create') return Promise.resolve({ ok: true, data: created })
      return Promise.resolve({ ok: true, data: [] })
    })
    const user = userEvent.setup()

    renderInEnglish(<App />)
    await user.type(screen.getByLabelText('New matter name'), 'New Matter')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('button', { name: 'New Matter' })).toBeDefined()
    expect(listCalls).toBe(2)
  })
})

describe('App settings navigation lock', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    localStorage.clear()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('keeps the settings page mounted while a provider save is in flight', async () => {
    let resolveSave!: (envelope: unknown) => void
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [] })
      if (channel === 'aiProvider:getStatus') {
        return Promise.resolve({
          ok: true,
          data: { provider: 'openai-compatible', openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: true }, configErrorCode: null }
        })
      }
      if (channel === 'aiProvider:save') {
        return new Promise((resolve) => {
          resolveSave = resolve
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    await user.click(await screen.findByRole('radio', { name: 'OpenAI-compatible (network)' }))
    await user.type(screen.getByLabelText('Model name'), 'gpt-other')
    await user.click(screen.getByRole('button', { name: 'Save provider settings' }))

    // Both ways out of the settings page are blocked while the save is in
    // flight; otherwise remounting the page would reset its operation mutex.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveProperty('disabled', true)
    })
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toHaveProperty('disabled', true)

    resolveSave({ ok: true, data: { provider: 'openai-compatible', openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-other', apiKeyConfigured: true }, configErrorCode: null } })
    await screen.findByText('Provider settings saved.')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toHaveProperty('disabled', false)
  })
})

function installWorkspaceMock(
  invoke: ReturnType<typeof vi.fn>,
  matters: readonly MatterSummaryDTO[],
  documents: Readonly<Record<string, readonly DocumentSummaryDTO[]>>,
  override?: (channel: string, payload: Record<string, string>) => Promise<unknown> | undefined
): void {
  invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
    const overridden = override?.(channel, payload)
    if (overridden !== undefined) return overridden
    if (channel === 'matter:list') return Promise.resolve({ ok: true, data: matters })
    if (channel === 'document:list') return Promise.resolve({ ok: true, data: documents[payload.matterId ?? ''] ?? [] })
    if (channel === 'document:get') return Promise.resolve({ ok: true, data: { document: documentOne, jobs: [] } })
    if (channel === 'review:getDocument') {
      const review: DocumentReviewDTO = {
        document: documentOne,
        blocks: [],
        entities: [],
        constraints: [],
        counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0 },
        jobs: []
      }
      return Promise.resolve({ ok: true, data: review })
    }
    if (channel === 'preview:get') {
      return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'IMPORTED' } })
    }
    return Promise.resolve({ ok: true, data: null })
  })
}
