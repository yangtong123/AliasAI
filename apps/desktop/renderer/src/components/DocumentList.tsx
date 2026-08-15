import type { DocumentSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { StatusBadge } from './StatusBadge'

export function DocumentList(props: {
  readonly matterId: string | null
  readonly documents: readonly DocumentSummaryDTO[]
  readonly selectedDocumentId: string | null
  readonly onSelect: (documentId: string) => void
  readonly onChanged: () => void
}) {
  const pick = useMutation(() => invoke('dialog:pickPdf', {}))
  const importDocument = useMutation((filePath: string) =>
    invoke('document:import', { matterId: props.matterId ?? '', filePath })
  )

  const onImportClick = () => {
    if (props.matterId === null) return
    void pick
      .run()
      .then((picked) => (picked !== null && picked.filePath !== null ? importDocument.run(picked.filePath) : null))
      .then((imported) => {
        if (imported !== null) props.onChanged()
      })
  }

  return (
    <section className="document-list">
      <h2>Documents</h2>
      {props.matterId === null ? (
        <p className="empty">Select a matter first</p>
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
            {props.documents.length === 0 && <li className="empty">No documents yet</li>}
          </ul>
          <button type="button" onClick={onImportClick} disabled={pick.pending || importDocument.pending}>
            Import PDF…
          </button>
          {(pick.error ?? importDocument.error) !== null && (
            <p className="error">{(pick.error ?? importDocument.error)!.message}</p>
          )}
        </>
      )}
    </section>
  )
}
