import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentParseStatus } from '@aliasai/domain'
import type { WorkspaceTrashDTO } from '@aliasai/application'
import { renderInEnglish } from '../test-utils'
import { TrashView } from './TrashView'

const trashedMatter = {
  id: 'matter-1',
  name: 'Deleted Matter',
  deletedAt: 1_725_000_000_000,
  createdAt: 1
}

const trashedDocument = {
  id: 'document-1',
  matterId: 'matter-2',
  matterName: 'Active Matter',
  originalName: 'synthetic.pdf',
  mimeType: 'application/pdf',
  parseStatus: 'SANITIZED' as DocumentParseStatus,
  deletedAt: 1_725_000_000_001,
  createdAt: 1
}

describe('TrashView', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function installTrash(trash: WorkspaceTrashDTO): void {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'trash:list') return Promise.resolve({ ok: true, data: trash })
      if (channel === 'matter:restore') return Promise.resolve({ ok: true, data: { changed: true } })
      if (channel === 'document:restore') return Promise.resolve({ ok: true, data: { changed: true } })
      return Promise.resolve({ ok: true, data: null })
    })
  }

  it('shows the empty state when nothing is trashed', async () => {
    installTrash({ matters: [], documents: [] })
    renderInEnglish(<TrashView refreshKey={0} onChanged={() => {}} />)

    expect(await screen.findByText('Trash is empty.')).toBeDefined()
  })

  it('lists deleted matters and documents with a restore action each', async () => {
    installTrash({ matters: [trashedMatter], documents: [trashedDocument] })
    renderInEnglish(<TrashView refreshKey={0} onChanged={() => {}} />)

    expect(await screen.findByText('Deleted matters')).toBeDefined()
    expect(screen.getByText('Deleted documents')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Restore matter: Deleted Matter' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Restore document: synthetic.pdf' })).toBeDefined()
  })

  it('restores through the lifecycle channels and refreshes on success', async () => {
    installTrash({ matters: [trashedMatter], documents: [trashedDocument] })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    renderInEnglish(<TrashView refreshKey={0} onChanged={onChanged} />)

    await user.click(await screen.findByRole('button', { name: 'Restore matter: Deleted Matter' }))
    await user.click(screen.getByRole('button', { name: 'Restore document: synthetic.pdf' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('matter:restore', { matterId: 'matter-1' })
      expect(invoke).toHaveBeenCalledWith('document:restore', { documentId: 'document-1' })
    })
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
  })

  it('blocks conflicting restore actions while one is pending', async () => {
    let resolveRestore!: (envelope: unknown) => void
    invoke.mockImplementation((channel: string) => {
      if (channel === 'trash:list') {
        return Promise.resolve({ ok: true, data: { matters: [trashedMatter], documents: [] } })
      }
      if (channel === 'matter:restore') {
        return new Promise((resolve) => {
          resolveRestore = resolve
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<TrashView refreshKey={0} onChanged={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Restore matter: Deleted Matter' }))
    expect(await screen.findByText('Restoring…')).toBeDefined()
    const restoreButton = screen.getByRole('button', { name: 'Restore matter: Deleted Matter' })
    expect(restoreButton).toHaveProperty('disabled', true)

    // Rapid repeated clicks issue no duplicate requests while pending.
    restoreButton.click()
    restoreButton.click()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'matter:restore')).toHaveLength(1)

    resolveRestore({ ok: true, data: { changed: true } })
  })

  it('surfaces an actionable restore conflict message', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'trash:list') {
        return Promise.resolve({ ok: true, data: { matters: [], documents: [trashedDocument] } })
      }
      if (channel === 'document:restore') {
        return Promise.resolve({
          ok: false,
          error: { code: 'RESTORE_CONFLICT', message: 'An active Document with the same file hash already exists' }
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()
    renderInEnglish(<TrashView refreshKey={0} onChanged={() => {}} />)

    await user.click(await screen.findByRole('button', { name: 'Restore document: synthetic.pdf' }))

    expect(
      await screen.findByText('An active Document with the same file hash already exists')
    ).toBeDefined()
  })
})
