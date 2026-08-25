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
}) {
  const { t, formatError } = useI18n()
  const importDocument = useMutation(() =>
    invoke('document:pickAndImport', { matterId: props.matterId ?? '' })
  )

  const onImportClick = () => {
    if (props.matterId === null) return
    void importDocument.run().then((imported) => {
      if (imported !== null) props.onChanged()
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
              <li key={document.id}>
                <button
                  type="button"
                  className={document.id === props.selectedDocumentId ? 'selected' : undefined}
                  onClick={() => props.onSelect(document.id)}
                >
                  {document.originalName} <StatusBadge status={document.parseStatus} />
                </button>
              </li>
            ))}
            {props.documents.length === 0 && <li className="empty">{t('documents.empty')}</li>}
          </ul>
          <button type="button" onClick={onImportClick} disabled={importDocument.pending}>
            {t('documents.import')}
          </button>
          {importDocument.error !== null && <p className="error">{formatError(importDocument.error)}</p>}
        </>
      )}
    </section>
  )
}
