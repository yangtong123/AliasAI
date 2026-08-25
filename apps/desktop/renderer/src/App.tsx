import { useEffect, useRef, useState } from 'react'
import { useDocumentReview, useDocuments, useDocumentStatus, useMatters, useSanitizedPreview } from './api/hooks'
import { DocumentList } from './components/DocumentList'
import { DocumentReviewPage } from './components/DocumentReviewPage'
import { MatterList } from './components/MatterList'
import { PipelineControls } from './components/PipelineControls'
import { ProviderSettingsPage } from './components/ProviderSettingsPage'
import { SanitizedPreviewView } from './components/SanitizedPreview'
import { useI18n } from './i18n'

type View = 'review' | 'preview' | 'settings'
const LAST_MATTER_KEY = 'aliasai.lastMatterId'
const LAST_DOCUMENT_KEY = 'aliasai.lastDocumentId'

export function App() {
  const { locale, setLocale, t, formatError } = useI18n()
  const [refreshKey, setRefreshKey] = useState(0)
  const { matters, loaded: mattersLoaded, error: matterError } = useMatters(refreshKey)
  const [matterId, setMatterId] = useState<string | null>(() => localStorage.getItem(LAST_MATTER_KEY))
  const [documentId, setDocumentId] = useState<string | null>(null)
  const restoredDocumentIdRef = useRef<string | null>(localStorage.getItem(LAST_DOCUMENT_KEY))
  const [view, setView] = useState<View>('review')
  const [selectedMentionId, setSelectedMentionId] = useState<string | null>(null)
  // Set by the provider settings page: while a save/test/clear is in flight the
  // settings entry point is locked, because leaving would unmount the page and
  // reset its operation mutex.
  const [settingsBusy, setSettingsBusy] = useState(false)
  const { documents, loaded: documentsLoaded, error: documentListError } = useDocuments(matterId, refreshKey)
  const status = useDocumentStatus(documentId, refreshKey)
  const review = useDocumentReview(documentId, refreshKey)
  const preview = useSanitizedPreview(documentId, refreshKey)

  const refresh = () => {
    setRefreshKey((value) => value + 1)
  }

  const onSelectMatter = (id: string) => {
    setMatterId(id)
    localStorage.setItem(LAST_MATTER_KEY, id)
    restoredDocumentIdRef.current = null
    setDocumentId(null)
    localStorage.removeItem(LAST_DOCUMENT_KEY)
  }

  const onSelectDocument = (id: string) => {
    setDocumentId(id)
    restoredDocumentIdRef.current = null
    localStorage.setItem(LAST_DOCUMENT_KEY, id)
    setRefreshKey((value) => value + 1)
  }

  useEffect(() => {
    if (mattersLoaded && matterId !== null && !matters.some((matter) => matter.id === matterId)) {
      setMatterId(null)
      setDocumentId(null)
      restoredDocumentIdRef.current = null
      localStorage.removeItem(LAST_MATTER_KEY)
      localStorage.removeItem(LAST_DOCUMENT_KEY)
    }
  }, [matters, mattersLoaded, matterId])

  useEffect(() => {
    if (!documentsLoaded) return
    if (documentId === null && restoredDocumentIdRef.current !== null) {
      const restoredDocumentId = restoredDocumentIdRef.current
      restoredDocumentIdRef.current = null
      if (documents.some((document) => document.id === restoredDocumentId)) {
        setDocumentId(restoredDocumentId)
      } else {
        localStorage.removeItem(LAST_DOCUMENT_KEY)
      }
      return
    }
    if (documentId !== null && !documents.some((document) => document.id === documentId)) {
      setDocumentId(null)
      localStorage.removeItem(LAST_DOCUMENT_KEY)
    }
  }, [documents, documentsLoaded, documentId])

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">{t('app.tagline')}</p>
          <h1>AliasAI</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={view === 'settings' ? 'selected' : undefined}
            aria-pressed={view === 'settings'}
            disabled={settingsBusy}
            onClick={() => setView(view === 'settings' ? 'review' : 'settings')}
          >
            {t('nav.settings')}
          </button>
          <label className="locale-switcher">
            {t('language.label')}
            <select value={locale} aria-label={t('language.label')} onChange={(event) => setLocale(event.target.value as typeof locale)}>
              <option value="zh-CN">{t('language.chinese')}</option>
              <option value="en">{t('language.english')}</option>
            </select>
          </label>
        </div>
      </header>
      <div className="layout">
        <aside>
          <MatterList
            matters={matters}
            selectedMatterId={matterId}
            onSelect={onSelectMatter}
            onCreated={refresh}
          />
          <DocumentList
            matterId={matterId}
            documents={documents}
            selectedDocumentId={documentId}
            onSelect={onSelectDocument}
            onChanged={refresh}
          />
        </aside>
        <section className="content">
          {view === 'settings' ? (
            <ProviderSettingsPage onClose={() => setView('review')} onBusyChange={setSettingsBusy} />
          ) : (
            <>
              {(matterError ?? documentListError) !== null && (
                <p className="error">{formatError((matterError ?? documentListError)!)}</p>
              )}
              {status.document !== null ? (
                <>
                  <header>
                    <h2>{status.document.originalName}</h2>
                    <nav>
                      <button type="button" className={view === 'review' ? 'selected' : undefined} onClick={() => setView('review')}>
                        {t('nav.review')}
                      </button>
                      <button type="button" className={view === 'preview' ? 'selected' : undefined} onClick={() => setView('preview')}>
                        {t('nav.preview')}
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
                      <p className="empty">{t('workspace.noReview')}</p>
                    )
                  ) : (
                    <SanitizedPreviewView
                      key={status.document.id}
                      documentId={status.document.id}
                      preview={preview.preview}
                      onGenerated={refresh}
                      onReviewMention={(mentionId) => {
                        setSelectedMentionId(mentionId)
                        setView('review')
                      }}
                    />
                  )}
                  {(review.error ?? preview.error) !== null && (
                    <p className="error">{formatError((review.error ?? preview.error)!)}</p>
                  )}
                </>
              ) : (
                <p className="empty">{t('workspace.select')}</p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  )
}
