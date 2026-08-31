import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { DocumentSummaryDTO } from '@aliasai/application'
import { renderInEnglish } from '../test-utils'
import { DocumentList } from './DocumentList'

const synthetic: DocumentSummaryDTO = {
  id: 'document-1',
  matterId: 'matter-1',
  originalName: '房屋租赁合同-very-long-file-name-example.pdf',
  mimeType: 'application/pdf',
  parseStatus: 'READY',
  pageCount: 3,
  createdAt: 1,
  updatedAt: 1
}
const second: DocumentSummaryDTO = { ...synthetic, id: 'document-2', originalName: 'other.pdf' }

describe('DocumentList compact actions', () => {
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

  function renderList(overrides: Partial<Parameters<typeof DocumentList>[0]> = {}) {
    return renderInEnglish(
      <DocumentList
        matterId="matter-1"
        documents={[synthetic]}
        selectedDocumentId={null}
        onSelect={() => {}}
        onChanged={() => {}}
        {...overrides}
      />
    )
  }

  it('keeps every action behind a closed ⋯ menu with an accessible name', () => {
    renderList()
    const trigger = screen.getByRole('button', {
      name: 'More actions for 房屋租赁合同-very-long-file-name-example.pdf'
    })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull()
  })

  it('opens the menu, closes it on Escape, and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    renderList()
    const trigger = screen.getByRole('button', { name: /More actions for/ })
    await user.click(trigger)

    const panel = screen.getByRole('menu', { name: /More actions for/ })
    // Opening focuses the first action so keyboard operation starts at once…
    expect(document.activeElement).not.toBe(trigger)
    expect(within(panel).getByRole('menuitem', { name: 'Replace with new PDF…' })).toBeDefined()
    expect(within(panel).getByRole('menuitem', { name: 'Move to trash' })).toBeDefined()

    // Arrow keys rove across items inside the group.
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(within(panel).getByRole('menuitem', { name: 'Move to trash' }))
    await user.keyboard('{Home}')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
    // Focus returns to the trigger after Escape or cancellation.
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the menu on an outside click without other effects', async () => {
    const user = userEvent.setup()
    renderList()
    await user.click(screen.getByRole('button', { name: /More actions for/ }))
    expect(screen.getByRole('menu', { name: /More actions for/ })).toBeDefined()

    await user.click(screen.getByRole('heading', { name: 'Documents' }))
    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
  })

  it('closes the menu when the current row filename is clicked outside the menu surface', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderList({ onSelect })
    await user.click(screen.getByRole('button', { name: /More actions for/ }))
    expect(screen.getByRole('menu', { name: /More actions for/ })).toBeDefined()

    await user.click(screen.getByRole('button', { name: /^房屋租赁合同-very-long-file-name-example\.pdf/ }))

    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
    expect(onSelect).toHaveBeenCalledWith('document-1')
  })

  it('routes the destructive action through a full-width confirmation below the row', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'document:trash') return Promise.resolve({ ok: true, data: { changed: true } })
      return Promise.resolve({ ok: true, data: null })
    })
    const onTrashed = vi.fn()
    const user = userEvent.setup()
    renderList({ onTrashed })

    const trigger = screen.getByRole('button', { name: /More actions for/ })
    await user.click(trigger)
    // Choosing the destructive action closes the group and opens the
    // full-width confirmation below the row, with focus moved onto its
    // primary button (the group buttons unmount under the keyboard user).
    await user.click(within(trigger.closest('li')!).getByRole('menuitem', { name: 'Move to trash' }))
    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
    expect(screen.getByText(/This document will disappear from the workspace/)).toBeDefined()
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe('Move to trash')
    expect(invoke.mock.calls.some(([channel]) => channel === 'document:trash')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    // Cancellation restores focus to the overflow trigger.
    expect((document.activeElement as HTMLElement | null)?.className).toContain('overflow-button')
    expect(screen.queryByText(/This document will disappear/)).toBeNull()

    const replaceTrigger = screen.getByRole('button', { name: /More actions for/ })
    await user.click(replaceTrigger)
    await user.click(within(replaceTrigger.closest('li')!).getByRole('menuitem', { name: 'Move to trash' }))
    await user.click(screen.getByRole('button', { name: 'Move to trash' }))

    expect(await screen.findByText('Documents').then(() => true)).toBeDefined()
    expect(invoke).toHaveBeenCalledWith('document:trash', { documentId: 'document-1' })
    expect(onTrashed).toHaveBeenCalledWith('document-1')
  })

  it('reports the replacement summary through onReplaced so the parent can select it', async () => {
    const replacement: DocumentSummaryDTO = { ...synthetic, id: 'document-replacement', supersedesDocumentId: 'document-1' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'document:pickAndReplace') return Promise.resolve({ ok: true, data: replacement })
      return Promise.resolve({ ok: true, data: null })
    })
    const onReplaced = vi.fn()
    const onTrashed = vi.fn()
    const user = userEvent.setup()
    renderList({ documents: [synthetic], onReplaced, onTrashed })

    const menuTrigger = screen.getByRole('button', { name: /More actions for/ })
    await user.click(menuTrigger)
    await user.click(within(menuTrigger.closest('li')!).getByRole('menuitem', { name: 'Replace with new PDF…' }))
    await user.click(screen.getByRole('button', { name: 'Choose new PDF…' }))

    expect(onReplaced).toHaveBeenCalledWith(replacement)
    expect(onTrashed).not.toHaveBeenCalled()
  })

  it('hands newly imported documents to onImported', async () => {
    const imported: DocumentSummaryDTO = { ...synthetic, id: 'document-new' }
    invoke.mockImplementation((channel: string) => {
      if (channel === 'document:pickAndImport') return Promise.resolve({ ok: true, data: imported })
      return Promise.resolve({ ok: true, data: null })
    })
    const onImported = vi.fn()
    const user = userEvent.setup()
    renderList({ onImported })

    await user.click(screen.getByRole('button', { name: 'Import PDF…' }))
    expect(onImported).toHaveBeenCalledWith(imported)
  })

  it('allows only one open group across rows, and selecting a document collapses them', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [selected, setSelected] = useState<string | null>(null)
      return (
        <DocumentList
          matterId="matter-1"
          documents={[synthetic, second]}
          selectedDocumentId={selected}
          onSelect={(id) => {
            setSelected(id)
            propsOnSelect(id)
          }}
          onChanged={() => {}}
        />
      )
    }
    const propsOnSelect = vi.fn()
    renderInEnglish(<Harness />)

    const triggers = screen.getAllByRole('button', { name: /More actions for/ })
    await user.click(triggers[0]!)
    expect(screen.getAllByRole('menu', { name: /More actions for/ })).toHaveLength(1)

    // Opening the second row's group replaces the first one.
    await user.click(triggers[1]!)
    expect(screen.getAllByRole('menu', { name: /More actions for/ })).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /other\.pdf/ })).toBeDefined()

    // Selecting any document collapses the group entirely.
    await user.click(screen.getAllByRole('button', { name: /^other\.pdf/ })[0]!)
    expect(screen.queryByRole('menu', { name: /More actions for/ })).toBeNull()
    expect(propsOnSelect).toHaveBeenCalledWith('document-2')
  })
})
