import { useEffect, useRef, useState } from 'react'
import type { DocumentSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'
import { StatusBadge } from './StatusBadge'

/** The pending inline confirmation on one document item, if any. */
type PendingConfirmation = { readonly documentId: string; readonly action: 'trash' | 'replace' } | null

export function DocumentList(props: {
  readonly matterId: string | null
  readonly documents: readonly DocumentSummaryDTO[]
  readonly selectedDocumentId: string | null
  readonly onSelect: (documentId: string) => void
  readonly onChanged: () => void
  /** Called after a Document really moved to trash; selection cleanup is the parent's job. */
  readonly onTrashed?: (documentId: string) => void
  /**
   * Called with the persisted replacement right after a one-step replacement;
   * the parent selects it so the user watches its automatic analysis.
   */
  readonly onReplaced?: (replacement: DocumentSummaryDTO) => void
  /** Called with the newly imported Document; the parent selects it. */
  readonly onImported?: (imported: DocumentSummaryDTO) => void
}) {
  const { t, formatError } = useI18n()
  const [confirming, setConfirming] = useState<PendingConfirmation>(null)
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null)
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const importDocument = useMutation(() =>
    invoke('document:pickAndImport', { matterId: props.matterId ?? '' })
  )
  const trash = useMutation((documentId: string) => invoke('document:trash', { documentId }))
  const replace = useMutation((documentId: string) =>
    invoke('document:pickAndReplace', { documentId })
  )

  const onImportClick = () => {
    if (props.matterId === null) return
    void importDocument.run().then((imported) => {
      if (imported !== null) {
        props.onChanged()
        props.onImported?.(imported)
      }
    })
  }

  const onTrashConfirmed = (documentId: string) => {
    void trash.run(documentId).then((result) => {
      if (result !== null) {
        setConfirming(null)
        props.onTrashed?.(documentId)
      }
    })
  }

  const onReplaceConfirmed = (documentId: string) => {
    void replace.run(documentId).then((replacement) => {
      if (replacement === null) {
        // A cancelled file picker changes nothing; hand focus back so the
        // keyboard user is not dropped onto <body>.
        setConfirming(null)
        menuButtonRefs.current.get(documentId)?.focus()
        return
      }
      setConfirming(null)
      props.onChanged()
      props.onReplaced?.(replacement)
    })
  }

  /** Closes an open confirmation and hands focus back to the row's ⋯ button. */
  const cancelConfirmation = (documentId: string) => {
    setConfirming(null)
    menuButtonRefs.current.get(documentId)?.focus()
  }

  // Switching the selected document (or the whole matter) collapses any open
  // action menu AND any pending destructive confirmation, so nothing stale
  // reappears next to another row when the context comes back.
  useEffect(() => {
    setOpenMenuFor(null)
    setConfirming(null)
  }, [props.selectedDocumentId, props.matterId])

  const busy = trash.pending || replace.pending

  return (
    <section className="document-list">
      <h2>{t('documents.title')}</h2>
      {props.matterId === null ? (
        <p className="empty">{t('documents.selectMatter')}</p>
      ) : (
        <>
          <ul>
            {props.documents.map((document) => {
              const confirmingThis =
                confirming !== null && confirming.documentId === document.id ? confirming.action : null
              return (
                <li key={document.id} className={confirmingThis !== null ? 'confirming' : undefined}>
                  <div className="item-row">
                    <button
                      type="button"
                      className={`doc-select${document.id === props.selectedDocumentId ? ' selected' : ''}`}
                      title={document.originalName}
                      onClick={() => props.onSelect(document.id)}
                    >
                      <span className="document-name">{document.originalName}</span>
                      <StatusBadge status={document.parseStatus} />
                      {document.supersedesDocumentId !== undefined && (
                        <span className="badge lineage" title={t('document.replacedLineage')}>
                          {t('document.replacedLineage')}
                        </span>
                      )}
                    </button>
                    <DocumentActionMenu
                      document={document}
                      open={openMenuFor === document.id}
                      disabled={busy}
                      registerTrigger={(element) => {
                        if (element === null) menuButtonRefs.current.delete(document.id)
                        else menuButtonRefs.current.set(document.id, element)
                      }}
                      onOpenChange={(open) => setOpenMenuFor(open ? document.id : null)}
                    />
                  </div>
                  {openMenuFor === document.id && (
                    <DocumentActionGroup
                      document={document}
                      onClose={() => {
                        setOpenMenuFor(null)
                        menuButtonRefs.current.get(document.id)?.focus()
                      }}
                      onSelectReplace={() => {
                        setOpenMenuFor(null)
                        setConfirming({ documentId: document.id, action: 'replace' })
                      }}
                      onSelectTrash={() => {
                        setOpenMenuFor(null)
                        setConfirming({ documentId: document.id, action: 'trash' })
                      }}
                    />
                  )}
                  {confirmingThis === 'trash' && (
                    <div className="trash-confirm">
                      <p className="warning">{t('trash.documentConfirm')}</p>
                      <div className="trash-confirm-actions">
                        <button type="button" autoFocus onClick={() => onTrashConfirmed(document.id)} disabled={busy}>
                          {t('trash.confirm')}
                        </button>
                        <button type="button" onClick={() => cancelConfirmation(document.id)} disabled={busy}>
                          {t('trash.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  {confirmingThis === 'replace' && (
                    <div className="trash-confirm">
                      <p className="warning">{t('document.replaceConfirm')}</p>
                      <div className="trash-confirm-actions">
                        <button type="button" autoFocus onClick={() => onReplaceConfirmed(document.id)} disabled={busy}>
                          {t('document.replacePick')}
                        </button>
                        <button type="button" onClick={() => cancelConfirmation(document.id)} disabled={busy}>
                          {t('trash.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
            {props.documents.length === 0 && <li className="empty">{t('documents.empty')}</li>}
          </ul>
          <button type="button" onClick={onImportClick} disabled={importDocument.pending}>
            {t('documents.import')}
          </button>
          {importDocument.error !== null && <p className="error">{formatError(importDocument.error)}</p>}
          {trash.error !== null && <p className="error">{formatError(trash.error)}</p>}
          {replace.error !== null && <p className="error">{formatError(replace.error)}</p>}
        </>
      )}
    </section>
  )
}

/**
 * The compact ⋯ trigger for one row. The expanded actions render as a sibling
 * DocumentActionGroup BELOW the row (block-level, full row width), so this
 * stays the only in-row action surface and can never squeeze the filename.
 */
function DocumentActionMenu(props: {
  readonly document: DocumentSummaryDTO
  readonly open: boolean
  readonly disabled: boolean
  readonly registerTrigger: (element: HTMLButtonElement | null) => void
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  // The document name is interpolated into the label only — never logged.
  const menuLabel = t('document.moreActions', { name: props.document.originalName })
  return (
    <div className="doc-menu-anchor">
      <button
        type="button"
        className="overflow-button"
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-label={menuLabel}
        disabled={props.disabled}
        ref={props.registerTrigger}
        onClick={() => props.onOpenChange(!props.open)}
      >
        ⋯
      </button>
    </div>
  )
}

/**
 * The expanded action menu for one row, rendered as its SIBLING: it occupies
 * its own block-level layout height below the row instead of floating over or
 * beside anything. Real keyboard surface: opening focuses the first action,
 * ArrowUp/Down/Home/End rove across menuitems, Tab follows native order, and
 * Escape/outside-click closes with focus returned to the ⋯ trigger.
 */
function DocumentActionGroup(props: {
  readonly document: DocumentSummaryDTO
  /** Closes the group and restores focus to the ⋯ trigger. */
  readonly onClose: () => void
  readonly onSelectTrash: () => void
  readonly onSelectReplace: () => void
}) {
  const { t } = useI18n()
  const groupRef = useRef<HTMLDivElement | null>(null)

  // Focus lands on the first action when the group mounts so the surface is
  // immediately operable without hunting for extra Tab stops.
  useEffect(() => {
    groupRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
        return
      }
      const container = groupRef.current
      if (!container) return
      if (event.target instanceof Node && !container.contains(event.target)) return
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Home' ||
        event.key === 'End'
      ) {
        const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        if (items.length === 0) return
        event.preventDefault()
        const currentIndex = items.findIndex((item) => item === document.activeElement)
        let nextIndex: number
        if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = items.length - 1
        else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length
        else nextIndex = (currentIndex - 1 + items.length) % items.length
        items[nextIndex]?.focus()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const menu = groupRef.current
      if (menu !== null && event.target instanceof Node && !menu.contains(event.target)) {
        props.onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [props])

  const menuLabel = t('document.moreActions', { name: props.document.originalName })

  return (
    <div ref={groupRef} className="doc-menu" role="menu" aria-label={menuLabel}>
      <button type="button" role="menuitem" onClick={props.onSelectReplace}>
        {t('document.replaceAction')}
      </button>
      <button type="button" role="menuitem" className="danger" onClick={props.onSelectTrash}>
        {t('trash.confirm')}
      </button>
    </div>
  )
}
