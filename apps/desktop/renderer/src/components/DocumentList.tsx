import { useState } from 'react'
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
  /** Called after a one-step replacement with the superseded (now trashed) Document ID. */
  readonly onReplaced?: (supersededDocumentId: string) => void
}) {
  const { t, formatError } = useI18n()
  const [confirming, setConfirming] = useState<PendingConfirmation>(null)
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
      if (imported !== null) props.onChanged()
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
        // A cancelled file picker changes nothing; keep the list interactive.
        setConfirming(null)
        return
      }
      setConfirming(null)
      props.onReplaced?.(replacement.supersedesDocumentId ?? documentId)
    })
  }

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
                      className={document.id === props.selectedDocumentId ? 'selected' : undefined}
                      onClick={() => props.onSelect(document.id)}
                    >
                      {document.originalName} <StatusBadge status={document.parseStatus} />
                      {document.supersedesDocumentId !== undefined && (
                        <span className="badge lineage" title={t('document.replacedLineage')}>
                          {t('document.replacedLineage')}
                        </span>
                      )}
                    </button>
                    {confirmingThis === null && (
                      <span className="item-actions">
                        <button
                          type="button"
                          className="replace-button"
                          aria-label={`${t('document.replaceAction')}: ${document.originalName}`}
                          disabled={busy}
                          onClick={() => setConfirming({ documentId: document.id, action: 'replace' })}
                        >
                          {t('document.replaceAction')}
                        </button>
                        <button
                          type="button"
                          className="trash-button"
                          aria-label={`${t('document.trashAction')}: ${document.originalName}`}
                          disabled={busy}
                          onClick={() => setConfirming({ documentId: document.id, action: 'trash' })}
                        >
                          {t('document.trashAction')}
                        </button>
                      </span>
                    )}
                  </div>
                  {confirmingThis === 'trash' && (
                    <div className="trash-confirm">
                      <p className="warning">{t('trash.documentConfirm')}</p>
                      <div className="trash-confirm-actions">
                        <button type="button" onClick={() => onTrashConfirmed(document.id)} disabled={busy}>
                          {t('trash.confirm')}
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
                          {t('trash.cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                  {confirmingThis === 'replace' && (
                    <div className="trash-confirm">
                      <p className="warning">{t('document.replaceConfirm')}</p>
                      <div className="trash-confirm-actions">
                        <button type="button" onClick={() => onReplaceConfirmed(document.id)} disabled={busy}>
                          {t('document.replacePick')}
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} disabled={busy}>
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
