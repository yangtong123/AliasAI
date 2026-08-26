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
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
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
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveProperty('disabled', false)
      expect(screen.getByRole('button', { name: 'Back to workspace' })).toHaveProperty('disabled', false)
    })
  })
})

describe('App trash flows', () => {
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

  function installTrashableWorkspace(): void {
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [documentOne] })
      if (channel === 'document:get') return Promise.resolve({ ok: true, data: { document: documentOne, jobs: [] } })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'matter:trash') return Promise.resolve({ ok: true, data: { changed: true } })
      if (channel === 'document:trash') return Promise.resolve({ ok: true, data: { changed: true } })
      void payload
      return Promise.resolve({ ok: true, data: null })
    })
  }

  it('confirms before trashing and cancels without a request', async () => {
    installTrashableWorkspace()
    const user = userEvent.setup()
    renderInEnglish(<App />)

    await user.click(await screen.findByRole('button', { name: 'Move matter to trash: Matter One' }))
    expect(screen.getByText(/All contents of this matter will disappear/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(invoke.mock.calls.filter(([channel]) => channel === 'matter:trash')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Move matter to trash: Matter One' })).toBeDefined()
  })

  it('trashes a selected Matter, clears selection and local storage, and refreshes', async () => {
    installTrashableWorkspace()
    localStorage.setItem('aliasai.lastMatterId', 'matter-1')
    localStorage.setItem('aliasai.lastDocumentId', 'document-1')
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Move matter to trash: Matter One' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === 'matter:trash')).toHaveLength(1)
    })
    expect(await screen.findByText('Select a matter and document')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'synthetic.pdf' })).toBeNull()
    expect(localStorage.getItem('aliasai.lastMatterId')).toBeNull()
    expect(localStorage.getItem('aliasai.lastDocumentId')).toBeNull()
    // Normal lists refreshed after the mutation.
    expect(invoke.mock.calls.filter(([channel]) => channel === 'matter:list').length).toBeGreaterThan(1)
  })

  it('trashes a selected Document and clears only the document selection', async () => {
    installTrashableWorkspace()
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Move document to trash: synthetic.pdf' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === 'document:trash')).toHaveLength(1)
    })
    expect(await screen.findByText('Select a matter and document')).toBeDefined()
    expect(localStorage.getItem('aliasai.lastDocumentId')).toBeNull()
  })

  it('shows an actionable error when the trash mutation fails', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'matter:trash') {
        return Promise.resolve({ ok: false, error: { code: 'DOCUMENT_BUSY', message: 'Document has running work' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)

    await user.click(await screen.findByRole('button', { name: 'Move matter to trash: Matter One' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))

    expect(await screen.findByText('Document has running work')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Matter One' })).toBeDefined()
  })

  it('replaces a document after confirmation and clears the old selection', async () => {
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [documentOne] })
      if (channel === 'document:get') return Promise.resolve({ ok: true, data: { document: documentOne, jobs: [] } })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:pickAndReplace') {
        return Promise.resolve({
          ok: true,
          data: { ...documentOne, id: 'document-replacement', supersedesDocumentId: 'document-1' }
        })
      }
      void payload
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Replace with new PDF…: synthetic.pdf' }))
    expect(screen.getByText(/Pick a new PDF to take the place of this document/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'document:pickAndReplace')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Replace with new PDF…: synthetic.pdf' }))
    await user.click(screen.getByRole('button', { name: 'Choose new PDF…' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:pickAndReplace', { documentId: 'document-1' })
    })
    // The replaced (now trashed) Document no longer holds the selection.
    expect(await screen.findByText('Select a matter and document')).toBeDefined()
    expect(localStorage.getItem('aliasai.lastDocumentId')).toBeNull()
  })

  it('marks a replacement document with its lineage', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') {
        return Promise.resolve({
          ok: true,
          data: [{ ...documentOne, supersedesDocumentId: 'document-old' }]
        })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)

    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    expect(await screen.findByText('Replaces an older document')).toBeDefined()
  })

  it('opens the trash view from the header and restores an item', async () => {
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [] })
      if (channel === 'trash:list') {
        return Promise.resolve({
          ok: true,
          data: {
            matters: [{ id: 'matter-1', name: 'Deleted Matter', deletedAt: 1_725_000_000_000, createdAt: 1 }],
            documents: []
          }
        })
      }
      if (channel === 'matter:restore') return Promise.resolve({ ok: true, data: { changed: true } })
      void payload
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)

    await user.click(await screen.findByRole('button', { name: 'Trash' }))
    expect(await screen.findByRole('heading', { name: 'Trash' })).toBeDefined()
    expect(await screen.findByText('Deleted Matter')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Restore matter: Deleted Matter' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('matter:restore', { matterId: 'matter-1' })
    })
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
        counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
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
