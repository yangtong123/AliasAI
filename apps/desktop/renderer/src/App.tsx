import { useState } from 'react'
import type { DocumentSummaryDTO } from '@aliasai/application'
import { invoke } from './api/client'
import { useDocumentReview, useDocumentStatus, useMatters, useMutation, useSanitizedPreview } from './api/hooks'
import { DocumentList } from './components/DocumentList'
import { DocumentReviewPage } from './components/DocumentReviewPage'
import { MatterList } from './components/MatterList'
import { PipelineControls } from './components/PipelineControls'
import { SanitizedPreviewView } from './components/SanitizedPreview'

type View = 'review' | 'preview'

export function App() {
  const { matters, error: matterError } = useMatters()
  const [matterId, setMatterId] = useState<string | null>(null)
  const [documentId, setDocumentId] = useState<string | null>(null)
  const [view, setView] = useState<View>('review')
  const [selectedMentionId, setSelectedMentionId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [documents, setDocuments] = useState<readonly DocumentSummaryDTO[]>([])

  const loadDocuments = useMutation((id: string) => invoke('document:list', { matterId: id }))
  const status = useDocumentStatus(documentId, refreshKey)
  const review = useDocumentReview(documentId, refreshKey)
  const preview = useSanitizedPreview(documentId, refreshKey)

  const refresh = () => {
    setRefreshKey((value) => value + 1)
    if (matterId !== null) {
      void loadDocuments.run(matterId).then((result) => {
        if (result !== null) setDocuments(result)
      })
    }
  }

  const onSelectMatter = (id: string) => {
    setMatterId(id)
    setDocumentId(null)
    void loadDocuments.run(id).then((result) => {
      if (result !== null) setDocuments(result)
    })
  }

  return (
    <main>
      <p className="eyebrow">Local-first privacy workspace</p>
      <h1>AliasAI</h1>
      <div className="layout">
        <aside>
          <MatterList
            matters={matters}
            selectedMatterId={matterId}
            onSelect={onSelectMatter}
            onCreated={() => setRefreshKey((value) => value + 1)}
          />
          <DocumentList
            matterId={matterId}
            documents={documents}
            selectedDocumentId={documentId}
            onSelect={(id) => {
              setDocumentId(id)
              setRefreshKey((value) => value + 1)
            }}
            onChanged={refresh}
          />
        </aside>
        <section className="content">
          {matterError !== null && <p className="error">{matterError.message}</p>}
          {status.document !== null ? (
            <>
              <header>
                <h2>{status.document.originalName}</h2>
                <nav>
                  <button type="button" className={view === 'review' ? 'selected' : undefined} onClick={() => setView('review')}>
                    Review
                  </button>
                  <button type="button" className={view === 'preview' ? 'selected' : undefined} onClick={() => setView('preview')}>
                    Sanitized preview
                  </button>
                </nav>
              </header>
              <PipelineControls
                documentId={status.document.id}
                parseStatus={status.document.parseStatus}
                jobs={status.jobs}
                onChanged={refresh}
              />
              {view === 'review' ? (
                review.review !== null ? (
                  <DocumentReviewPage
                    review={review.review}
                    selectedMentionId={selectedMentionId}
                    onSelectMention={setSelectedMentionId}
                    onChanged={refresh}
                  />
                ) : (
                  <p className="empty">No review data</p>
                )
              ) : (
                <SanitizedPreviewView documentId={status.document.id} preview={preview.preview} onGenerated={refresh} />
              )}
              {(review.error ?? preview.error) !== null && (
                <p className="error">{(review.error ?? preview.error)!.message}</p>
              )}
            </>
          ) : (
            <p className="empty">Select a matter and document</p>
          )}
        </section>
      </div>
    </main>
  )
}
