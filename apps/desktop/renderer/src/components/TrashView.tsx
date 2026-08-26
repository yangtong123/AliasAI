import { invoke } from '../api/client'
import { useMutation, useTrash } from '../api/hooks'
import { useI18n } from '../i18n'

/**
 * Dedicated trash read view: deleted Matters and individually trashed
 * Documents grouped under their non-deleted Matter. Documents inside a deleted
 * Matter are not listed separately — restoring the Matter restores the tree.
 */
export function TrashView(props: { readonly refreshKey: number; readonly onChanged: () => void }) {
  const { t, formatError, locale } = useI18n()
  const { trash, loaded, error } = useTrash(props.refreshKey)
  const restoreMatter = useMutation((matterId: string) => invoke('matter:restore', { matterId }))
  const restoreDocument = useMutation((documentId: string) => invoke('document:restore', { documentId }))

  const onRestoreMatter = (matterId: string) => {
    void restoreMatter.run(matterId).then((result) => {
      if (result !== null) props.onChanged()
    })
  }

  const onRestoreDocument = (documentId: string) => {
    void restoreDocument.run(documentId).then((result) => {
      if (result !== null) props.onChanged()
    })
  }

  const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString(locale)

  const isEmpty = loaded && trash !== null && trash.matters.length === 0 && trash.documents.length === 0
  const busy = restoreMatter.pending || restoreDocument.pending

  return (
    <section className="trash-view">
      <h2>{t('trash.title')}</h2>
      {error !== null && <p className="error">{formatError(error)}</p>}
      {restoreMatter.error !== null && <p className="error">{formatError(restoreMatter.error)}</p>}
      {restoreDocument.error !== null && <p className="error">{formatError(restoreDocument.error)}</p>}
      {isEmpty && <p className="empty">{t('trash.empty')}</p>}
      {trash !== null && trash.matters.length > 0 && (
        <>
          <h3>{t('trash.matters')}</h3>
          <ul>
            {trash.matters.map((matter) => (
              <li key={matter.id}>
                <div className="item-row">
                  <span>
                    {matter.name}{' '}
                    <span className="trash-meta">{t('trash.deletedAt', { time: formatTime(matter.deletedAt) })}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRestoreMatter(matter.id)}
                    disabled={busy}
                    aria-label={`${t('trash.restoreMatter')}: ${matter.name}`}
                  >
                    {restoreMatter.pending ? t('trash.restoring') : t('trash.restoreMatter')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {trash !== null && trash.documents.length > 0 && (
        <>
          <h3>{t('trash.documents')}</h3>
          <ul>
            {trash.documents.map((document) => (
              <li key={document.id}>
                <div className="item-row">
                  <span>
                    {document.originalName}
                    {' · '}
                    {document.matterName}{' '}
                    <span className="trash-meta">{t('trash.deletedAt', { time: formatTime(document.deletedAt) })}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRestoreDocument(document.id)}
                    disabled={busy}
                    aria-label={`${t('trash.restoreDocument')}: ${document.originalName}`}
                  >
                    {restoreDocument.pending ? t('trash.restoring') : t('trash.restoreDocument')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
