import { useState } from 'react'
import type { DocumentSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'
import { StatusBadge } from './StatusBadge'

export function DocumentList(props: {
  readonly matterId: string | null
  readonly documents: readonly DocumentSummaryDTO[]
  readonly selectedDocumentId: string | null
  readonly onSelect: (documentId: string) => void
  readonly onChanged: () => void
  /** Called after a Document really moved to trash; selection cleanup is the parent's job. */
  readonly onTrashed?: (documentId: string) => void
}) {
  const { t, formatError } = useI18n()
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const importDocument = useMutation(() =>
    invoke('document:pickAndImport', { matterId: props.matterId ?? '' })
  )
  const trash = useMutation((documentId: string) => invoke('document:trash', { documentId }))

  const onImportClick = () => {
    if (props.matterId === null) return
    void importDocument.run().then((imported) => {
      if (imported !== null) props.onChanged()
    })
  }

  const onTrashConfirmed = (documentId: string) => {
    void trash.run(documentId).then((result) => {
      if (result !== null) {
        setConfirmingId(null)
        props.onTrashed?.(documentId)
      }
    })
  }

  return (
    <section className="document-list">
      <h2>{t('documents.title')}</h2>
      {props.matterId === null ? (
        <p className="empty">{t('documents.selectMatter')}</p>
      ) : (
        <>
          <ul>
            {props.documents.map((document) => (
              <li key={document.id} className={confirmingId === document.id ? 'confirming' : undefined}>
                <div className="item-row">
                  <button
                    type="button"
                    className={document.id === props.selectedDocumentId ? 'selected' : undefined}
                    onClick={() => props.onSelect(document.id)}
                  >
                    {document.originalName} <StatusBadge status={document.parseStatus} />
                  </button>
                  {confirmingId !== document.id && (
                    <button
                      type="button"
                      className="trash-button"
                      aria-label={`${t('document.trashAction')}: ${document.originalName}`}
                      disabled={trash.pending}
                      onClick={() => setConfirmingId(document.id)}
                    >
                      {t('document.trashAction')}
                    </button>
                  )}
                </div>
                {confirmingId === document.id && (
                  <div className="trash-confirm">
                    <p className="warning">{t('trash.documentConfirm')}</p>
                    <div className="trash-confirm-actions">
                      <button type="button" onClick={() => onTrashConfirmed(document.id)} disabled={trash.pending}>
                        {t('trash.confirm')}
                      </button>
                      <button type="button" onClick={() => setConfirmingId(null)} disabled={trash.pending}>
                        {t('trash.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
            {props.documents.length === 0 && <li className="empty">{t('documents.empty')}</li>}
          </ul>
          <button type="button" onClick={onImportClick} disabled={importDocument.pending}>
            {t('documents.import')}
          </button>
          {importDocument.error !== null && <p className="error">{formatError(importDocument.error)}</p>}
          {trash.error !== null && <p className="error">{formatError(trash.error)}</p>}
        </>
      )}
    </section>
  )
}
