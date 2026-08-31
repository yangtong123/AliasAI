import { cleanup, screen, waitFor, within } from '@testing-library/react'
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

  it('trashes a selected Document through the overflow menu and clears only the document selection', async () => {
    installTrashableWorkspace()
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    const menuPanel647444641 = await openOverflowMenu(user, 'synthetic.pdf')
    await user.click(within(menuPanel647444641).getByRole('menuitem', { name: 'Move to trash' }))
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

  it('replaces a document through the overflow menu, confirms, and selects the replacement', async () => {
    const replacement: DocumentSummaryDTO = { ...documentOne, id: 'document-replacement', supersedesDocumentId: 'document-1' }
    let replacedRecorded = false
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') {
        return replacedRecorded
          ? Promise.resolve({ ok: true, data: [replacement] })
          : Promise.resolve({ ok: true, data: [documentOne] })
      }
      if (channel === 'review:getDocument') return Promise.resolve({ ok: true, data: null })
      if (channel === 'document:get') {
        const requested = payload.documentId
        const current = requested === 'document-replacement' ? replacement : documentOne
        return Promise.resolve({ ok: true, data: { document: current, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:pickAndReplace') {
        replacedRecorded = true
        return Promise.resolve({ ok: true, data: replacement })
      }
      void payload
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()

    const menuPanel647444642 = await openOverflowMenu(user, 'synthetic.pdf')
    await user.click(within(menuPanel647444642).getByRole('menuitem', { name: 'Replace with new PDF…' }))
    expect(screen.getByText(/Pick a new PDF to take the place of this document/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'document:pickAndReplace')).toHaveLength(0)

    // Cancellation keeps the replacement pending state closed and focused.
    expect((document.activeElement as HTMLElement | null)?.className).toContain('overflow-button')

    const menuPanel647444643 = await openOverflowMenu(user, 'synthetic.pdf')
    await user.click(within(menuPanel647444643).getByRole('menuitem', { name: 'Replace with new PDF…' }))
    await user.click(screen.getByRole('button', { name: 'Choose new PDF…' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:pickAndReplace', { documentId: 'document-1' })
    })
    // The replacement takes over the selection instead of leaving an empty page.
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()
    expect(localStorage.getItem('aliasai.lastDocumentId')).toBe('document-replacement')
  })

  it('auto-analyzes an imported document and selects it immediately', async () => {
    const imported: DocumentSummaryDTO = { ...documentOne, id: 'document-imported-1' }
    let importRecorded = false
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      // Once the import persisted, the refreshed list carries the new Document;
      // otherwise the selection effect would immediately clear it again.
      if (channel === 'document:list') {
        return importRecorded
          ? Promise.resolve({ ok: true, data: [imported] })
          : Promise.resolve({ ok: true, data: [] })
      }
      if (channel === 'document:pickAndImport') {
        importRecorded = true
        return Promise.resolve({ ok: true, data: imported })
      }
      if (channel === 'document:get') {
        if (payload.documentId !== imported.id) {
          return Promise.resolve({ ok: false as const, error: { code: 'DOCUMENT_NOT_FOUND', message: 'not found' } })
        }
        return Promise.resolve({ ok: true as const, data: { document: imported, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      void payload
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))

    await user.click(screen.getByRole('button', { name: 'Import PDF…' }))

    // The returned Document is selected right away...
    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()
    expect(localStorage.getItem('aliasai.lastDocumentId')).toBe('document-imported-1')
    // ...and its automatic analysis starts without any stage-button click.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:analyze', { documentId: 'document-imported-1' })
    })
    expect(invoke.mock.calls.some(([channel]) => channel === 'document:process')).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'document:detect')).toBe(false)
    expect(invoke.mock.calls.some(([channel]) => channel === 'document:resolve')).toBe(false)
    expect(screen.getByText('Waiting to analyze…')).toBeDefined()
  })

  it('keeps the retry window through repeated reads of the same stale FAILED revision', async () => {
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED' }
    const jobsFor = () => [{ type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 2 }]
    // Snapshot script: pre-retry observation, TWO stale reads after the retry
    // click (same persisted revision — IPC clones each response into a fresh
    // object, which is exactly the race object-identity gating missed), then
    // (only after we unfreeze) PARSED -> READY.
    const scripted: readonly string[] = ['FAILED', 'FAILED', 'FAILED', 'PARSED', 'READY']
    let servedFetches = 0
    let unfrozen = false

    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') return Promise.resolve({ ok: true, data: { accepted: true } })
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      }
      if (channel === 'review:getDocument') {
        const review: DocumentReviewDTO = {
          document: { ...failedDocument, parseStatus: 'READY' },
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
        return Promise.resolve({ ok: true, data: review })
      }
      if (channel === 'document:get') {
        const index = servedFetches
        servedFetches += 1
        const respond = (): { ok: true; data: unknown } => ({
          ok: true,
          data: { document: { ...failedDocument, parseStatus: scripted[index] ?? 'READY' }, jobs: jobsFor() }
        })
        // The first three reads (pre-retry + BOTH stale reads) resolve
        // immediately; everything after is frozen until the mid-flight
        // assertion ran, so no PARSED/READY revival can rescue a prematurely
        // closed window.
        if (index < 3 || unfrozen) return Promise.resolve(respond())
        return new Promise((resolve) => {
          const timer = setInterval(() => {
            if (unfrozen) {
              clearInterval(timer)
              resolve(respond())
            }
          }, 10)
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Analyze again' }))

    // BOTH stale FAILED snapshots have been served and rendered; nothing
    // further resolves yet. They share one persisted revision, so they count
    // as a single observation and the retry button stays disabled — object
    // identity (or per-read counting) would have closed the window already.
    await waitFor(() => {
      expect(servedFetches).toBeGreaterThanOrEqual(3)
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const retryButton = screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(true)

    unfrozen = true
    expect(await screen.findByText('Analysis complete', {}, { timeout: 4000 })).toBeDefined()
  })

  it('keeps following a retried analysis through one stale FAILED read into READY', async () => {
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED' }
    let analyzeCount = 0
    const statusesAfterRetry = ['FAILED', 'PARSED', 'READY']
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCount += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'preview:get') return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      if (channel === 'document:get') {
        if (analyzeCount === 0) {
          return Promise.resolve({
            ok: true,
            data: { document: { ...failedDocument }, jobs: [{ type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 2 }] }
          })
        }
        // The deferral means the FIRST read after retrying can still see the
        // persisted FAILED state. The SECOND read lands on PARSED — a resumable
        // gap status that only keeps polling while the activity window is
        // alive — so reaching READY proves the window survived the stale
        // FAILED instead of being closed as a "stable second observation".
        const parseStatus = statusesAfterRetry.shift() ?? 'READY'
        return Promise.resolve({
          ok: true,
          data: {
            document: { ...failedDocument, parseStatus },
            jobs: []
          }
        })
      }
      if (channel === 'review:getDocument') {
        const current = statusesAfterRetry.includes('READY') ? null : undefined
        void current
        const parsedNow = analyzeCount > 0 && statusesAfterRetry.length <= 1
        if (!parsedNow) return Promise.resolve({ ok: false, error: { code: 'NOT_READY_YET', message: 'pending' } })
        const review: DocumentReviewDTO = {
          document: { ...failedDocument, parseStatus: 'READY' },
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 2, resolved: 2, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
        return Promise.resolve({ ok: true, data: review })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()
    await user.click(await screen.findByRole('button', { name: 'Analyze again' }))

    // The chain must END on the completion surface. A second analyze call is
    // EXPECTED here: observing PARSED (only possible because the window
    // survived the stale FAILED) triggers the resume-once-per-session rule.
    await waitFor(
      () => {
        expect(screen.getByText('Analysis complete')).toBeDefined()
      },
      { timeout: 4000 }
    )
    expect(invoke.mock.calls.filter(([channel]) => channel === 'document:analyze')).toHaveLength(2)
  })

  it('recovers the retry path when scheduling itself fails for an imported document', async () => {
    const failedScheduleDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'IMPORTED' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedScheduleDocument] })
      if (channel === 'document:get') {
        return Promise.resolve({ ok: true, data: { document: failedScheduleDocument, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        return Promise.resolve({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'main process refused' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    // The failure is attributed to this document and stops any busy state.
    expect(await screen.findByText(/automatic analysis could not start/i)).toBeDefined()
    const retry = await screen.findByRole('button', { name: 'Analyze again' })
    expect((retry as HTMLButtonElement).disabled).toBe(false)

    // Once the main process accepts again, pressing retry schedules normally.
    invoke.mockImplementation((channel: string) => {
      if (channel === 'document:analyze') return Promise.resolve({ ok: true, data: { accepted: true } })
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedScheduleDocument] })
      if (channel === 'document:get') {
        return Promise.resolve({ ok: true, data: { document: failedScheduleDocument, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      return Promise.resolve({ ok: true, data: null })
    })
    await user.click(retry)
    await waitFor(() => {
      expect(invoke.mock.calls.filter(([channel]) => channel === 'document:analyze')).toHaveLength(2)
    })
  })

  it('releases progress and exposes retry when the runner could not persist its terminal failure', async () => {
    const imported: DocumentSummaryDTO = { ...documentOne, parseStatus: 'IMPORTED' }
    let analyzeCalls = 0
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [imported] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCalls += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'document:get') {
        if (analyzeCalls === 0) {
          return Promise.resolve({ ok: true, data: { document: imported, jobs: [] } })
        }
        return Promise.resolve({
          ok: false,
          error: {
            code: 'ANALYSIS_FAILURE_UNRECORDED',
            message: 'Automatic analysis stopped before its failure could be saved'
          }
        })
      }
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'IMPORTED' } })
      }
      if (channel === 'review:getDocument') {
        return Promise.resolve({ ok: false, error: { code: 'DOCUMENT_NOT_READY', message: 'pending' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })

    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    expect(await screen.findByText(/stopped before its failure could be saved/i)).toBeDefined()
    const retry = screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement
    await waitFor(() => expect(retry.disabled).toBe(false))
    expect(analyzeCalls).toBe(1)
  })

  it('shows retry when an import fails before the renderer gets its first status snapshot', async () => {
    const imported: DocumentSummaryDTO = { ...documentOne, id: 'document-cold-failure', parseStatus: 'IMPORTED' }
    let importedRecorded = false
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') {
        return Promise.resolve({ ok: true, data: importedRecorded ? [imported] : [] })
      }
      if (channel === 'document:pickAndImport') {
        importedRecorded = true
        return Promise.resolve({ ok: true, data: imported })
      }
      if (channel === 'document:get') {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'ANALYSIS_FAILURE_UNRECORDED',
            message: 'Automatic analysis stopped before its failure could be saved'
          }
        })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'IMPORTED' } })
      }
      if (channel === 'review:getDocument') {
        return Promise.resolve({ ok: false, error: { code: 'DOCUMENT_NOT_READY', message: 'pending' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })

    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(screen.getByRole('button', { name: 'Import PDF…' }))

    expect(await screen.findByRole('heading', { name: 'synthetic.pdf' })).toBeDefined()
    expect(await screen.findByText(/stopped before its failure could be saved/i)).toBeDefined()
    expect((screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears scheduler state on trash so a restored document can be analyzed again', async () => {
    // The row stays listed across the trash round-trip (as if restored
    // immediately): what matters is that selection cleared and the scheduler
    // forgot the document, so re-selecting schedules exactly once more.
    const trashedAway: DocumentSummaryDTO = { ...documentOne, parseStatus: 'IMPORTED' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [trashedAway] })
      if (channel === 'document:get') {
        return Promise.resolve({ ok: true, data: { document: trashedAway, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:trash') return Promise.resolve({ ok: true, data: { changed: true } })
      if (channel === 'document:analyze') return Promise.resolve({ ok: true, data: { accepted: true } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    // Selection resumed analysis once (window + session marker recorded).
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:analyze', { documentId: 'document-1' })
    })
    expect(invoke.mock.calls.filter(([channel]) => channel === 'document:analyze')).toHaveLength(1)

    // Trash it; the selection clears even though the row remains listed.
    const panel = await openOverflowMenu(user, 'synthetic.pdf')
    await user.click(within(panel).getByRole('menuitem', { name: 'Move to trash' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:trash', { documentId: 'document-1' })
    })
    expect(await screen.findByText('Select a matter and document')).toBeDefined()

    // Re-select: a stale session marker would block re-analysis; the cleanup
    // must allow exactly one fresh schedule for the restored document.
    invoke.mock.calls.length = 0
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([channel]) => channel === 'document:analyze')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(['document:analyze', { documentId: 'document-1' }])
    })
  })

  it('shows one friendly retry action for a failed document and none for resumable jargon buttons', async () => {
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'document:get') return Promise.resolve({ ok: true, data: { document: failedDocument, jobs: [{ type: 'DETECT', status: 'FAILED', progress: 0.4, createdAt: 3 }] } })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()
    // The manual stage buttons are gone from the normal interface entirely.
    expect(screen.queryByRole('button', { name: /Run Parse|Run Detect|Run Resolve|Retry Detect/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Analyze again' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:analyze', { documentId: 'document-1' })
    })
  })

  it('releases the window on the FIRST failure of a fresh analysis', async () => {
    // IMPORTED -> auto-resume -> the pipeline fails once. A single new FAILED
    // revision must end the window (retry usable again); requiring a second
    // observation would disable retry forever.
    const imported: DocumentSummaryDTO = { ...documentOne, parseStatus: 'IMPORTED' }
    let analyzeCalls = 0
    let failedOnce = false
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [imported] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCalls += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'document:get') {
        if (!failedOnce && analyzeCalls > 0) failedOnce = true
        const parseStatus = analyzeCalls > 0 && failedOnce ? 'FAILED' : 'IMPORTED'
        return Promise.resolve({
          ok: true,
          data: {
            document: { ...imported, parseStatus, updatedAt: parseStatus === 'FAILED' ? 9 : 2 },
            jobs: parseStatus === 'FAILED' ? [{ type: 'PARSE', status: 'FAILED', progress: 0, createdAt: 9 }] : []
          }
        })
      }
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    // The single FAILED snapshot lands; the retry button must be ENABLED
    // (window released) without needing a second FAILED observation.
    const retry = (await screen.findByRole('button', { name: 'Analyze again' })) as HTMLButtonElement
    await waitFor(() => {
      expect((retry as HTMLButtonElement).disabled).toBe(false)
    })
    expect(analyzeCalls).toBe(1)
  })

  it('distinguishes same-timestamp failures by immutable job id', async () => {
    // Two FAILED attempts sharing EVERY timestamp field: only the immutable
    // job id separates their revisions. The retry's new failure must release
    // the window (retry usable) — a timestamp-only key would see "stale".
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED', updatedAt: 5 }
    const jobOne = { id: 'job-attempt-1', type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 5 }
    const jobTwo = { id: 'job-attempt-2', type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 5 }
    let analyzeCalls = 0
    let servedStale = false
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCalls += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'document:get') {
        if (analyzeCalls === 0) {
          return Promise.resolve({ ok: true, data: { document: { ...failedDocument }, jobs: [jobOne] } })
        }
        if (!servedStale) {
          servedStale = true
          return Promise.resolve({ ok: true, data: { document: { ...failedDocument }, jobs: [jobOne] } })
        }
        // Same timestamps, DIFFERENT job id: the new attempt's failure.
        return Promise.resolve({ ok: true, data: { document: { ...failedDocument }, jobs: [jobTwo] } })
      }
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Analyze again' }))
    const retry = screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement
    await waitFor(
      () => {
        expect(retry.disabled).toBe(false)
      },
      { timeout: 4000 }
    )
    expect(analyzeCalls).toBe(1)
  })

  it('clears analysis state when a NON-selected matter is trashed', async () => {
    const matterTwo: MatterSummaryDTO = { ...matterOne, id: 'matter-2', name: 'Matter Two' }
    const docA: DocumentSummaryDTO = { ...documentOne, id: 'document-a', matterId: 'matter-1' }
    const docB: DocumentSummaryDTO = { ...documentOne, id: 'document-b', matterId: 'matter-2' }
    invoke.mockImplementation((channel: string, payload: Record<string, string>) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne, matterTwo] })
      if (channel === 'document:list') {
        return Promise.resolve({ ok: true, data: payload.matterId === 'matter-1' ? [docA] : [docB] })
      }
      if (channel === 'document:get') {
        const current = payload.documentId === 'document-a' ? docA : docB
        return Promise.resolve({ ok: true, data: { document: current, jobs: [] } })
      }
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'matter:trash') return Promise.resolve({ ok: true, data: { changed: true } })
      if (channel === 'document:analyze') return Promise.resolve({ ok: true, data: { accepted: true } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)

    // Schedule analysis in matter 1, then switch to matter 2.
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('document:analyze', { documentId: 'document-a' })
    })
    await user.click(screen.getByRole('button', { name: 'Matter Two' }))
    expect(await screen.findByText('Select a matter and document')).toBeDefined()

    // Trash the NON-selected matter 1 from the sidebar while viewing matter 2.
    await user.click(screen.getByRole('button', { name: 'Move matter to trash: Matter One' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('matter:trash', { matterId: 'matter-1' })
    })

    // Switch back: the restored document must schedule afresh (exactly one
    // new analyze) — a stale session marker would have blocked it.
    invoke.mock.calls.length = 0
    await user.click(screen.getByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([channel]) => channel === 'document:analyze')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(['document:analyze', { documentId: 'document-a' }])
    })
  })

  it('releases the window when a retry produces a NEW failure revision', async () => {
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED', updatedAt: 2 }
    const preRetryJobs = [{ type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 2 }]
    const newFailureJobs = [{ type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 7 }]
    let analyzeCalls = 0
    let newFailureServed = false
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCalls += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'document:get') {
        // Retry clicked -> first reads are the stale OLD revision (ignored as
        // a hand-off read), then the attempt genuinely fails with a NEW
        // persisted revision (new job + newer updatedAt).
        const useNewFailure = analyzeCalls > 0 && newFailureServed === false && Math.random() >= 0
        void useNewFailure
        if (analyzeCalls === 0) {
          return Promise.resolve({ ok: true, data: { document: { ...failedDocument }, jobs: preRetryJobs } })
        }
        if (!newFailureServed) {
          newFailureServed = true
          return Promise.resolve({ ok: true, data: { document: { ...failedDocument }, jobs: preRetryJobs } })
        }
        return Promise.resolve({
          ok: true,
          data: { document: { ...failedDocument, updatedAt: 7 }, jobs: newFailureJobs }
        })
      }
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Analyze again' }))

    // One stale read is ignored; the NEW failure revision closes the window
    // and the retry button becomes usable again without another observation.
    const retry = screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement
    await waitFor(
      () => {
        expect(retry.disabled).toBe(false)
      },
      { timeout: 4000 }
    )
    expect(analyzeCalls).toBe(1)
  })

  it('never double-schedules inside an active window and refreshes review exactly at READY', async () => {
    const failedDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'FAILED' }
    const jobsFor = () => [{ type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 2 }]
    // Review data is unreadable until READY has actually been observed: the
    // repository only projects mentions after resolution. Early refreshes
    // must therefore NOT latch a stale empty review over the final result.
    let readyObserved = false
    // Before any retry, EVERY status read returns the same persisted FAILED
    // revision (terminal-arrival refreshes legitimately refetch status); only
    // after the retry does the pipeline advance PARSED -> READY.
    const postRetry: string[] = ['PARSED', 'READY']
    let analyzeCalls = 0

    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [failedDocument] })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      if (channel === 'document:analyze') {
        analyzeCalls += 1
        return Promise.resolve({ ok: true, data: { accepted: true } })
      }
      if (channel === 'preview:get') {
        return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'FAILED' } })
      }
      if (channel === 'document:get') {
        const parseStatus = analyzeCalls === 0 ? 'FAILED' : (postRetry.shift() ?? 'READY')
        if (parseStatus === 'READY') readyObserved = true
        return Promise.resolve({
          ok: true,
          data: { document: { ...failedDocument, parseStatus }, jobs: jobsFor() }
        })
      }
      if (channel === 'review:getDocument') {
        if (!readyObserved) {
          return Promise.resolve({ ok: false, error: { code: 'NOT_READY', message: 'analysis in flight' } })
        }
        const review: DocumentReviewDTO = {
          document: { ...failedDocument, parseStatus: 'READY' },
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 2, resolved: 2, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
        return Promise.resolve({ ok: true, data: review })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))
    expect(await screen.findByText('Analysis did not finish, please retry')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Analyze again' }))

    // The retry runs FAILED -> PARSED -> READY. The PARSED observation must
    // NOT trigger a second schedule (the window already owns the document),
    // and the READY observation must refresh review data that only now
    // becomes readable — the result summary renders without another click.
    expect(await screen.findByText('Analysis complete', {}, { timeout: 4000 })).toBeDefined()
    expect(analyzeCalls).toBe(1)
  })

  it('does not schedule analysis for an already analyzed document on selection', async () => {
    const readyDocument: DocumentSummaryDTO = { ...documentOne, parseStatus: 'READY' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'matter:list') return Promise.resolve({ ok: true, data: [matterOne] })
      if (channel === 'document:list') return Promise.resolve({ ok: true, data: [readyDocument] })
      if (channel === 'document:get') return Promise.resolve({ ok: true, data: { document: readyDocument, jobs: [] } })
      if (channel === 'review:getDocument') {
        const review: DocumentReviewDTO = {
          document: readyDocument,
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
        return Promise.resolve({ ok: true, data: review })
      }
      if (channel === 'preview:get') return Promise.resolve({ ok: true, data: { status: 'READY', blockers: [] } })
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: { matters: [], documents: [] } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<App />)
    await user.click(await screen.findByRole('button', { name: 'Matter One' }))
    await user.click(await screen.findByRole('button', { name: /^synthetic\.pdf/ }))

    expect(await screen.findByText('Analysis complete')).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(invoke.mock.calls.some(([channel]) => channel === 'document:analyze')).toBe(false)
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

/** Opens the compact ⋯ action menu of one document row and returns its panel. */
async function openOverflowMenu(
  user: ReturnType<typeof userEvent.setup>,
  documentName: string
): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `More actions for ${documentName}` }))
  return screen.getByRole('menu', { name: `More actions for ${documentName}` })
}
