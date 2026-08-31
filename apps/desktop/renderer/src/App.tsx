import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentSummaryDTO } from '@aliasai/application'
import { selectAnalysisAction } from '@aliasai/domain'
import { useAnalysisScheduler, useDocumentReview, useDocuments, useDocumentStatus, useMatters, useSanitizedPreview } from './api/hooks'
import { AnalysisStatus } from './components/AnalysisStatus'
import { DocumentList } from './components/DocumentList'
import { DocumentReviewPage } from './components/DocumentReviewPage'
import { MatterList } from './components/MatterList'
import { ProviderSettingsPage } from './components/ProviderSettingsPage'
import { SanitizedPreviewView } from './components/SanitizedPreview'
import { TrashView } from './components/TrashView'
import { useI18n } from './i18n'

type View = 'review' | 'preview' | 'settings' | 'trash'
const LAST_MATTER_KEY = 'aliasai.lastMatterId'
const LAST_DOCUMENT_KEY = 'aliasai.lastDocumentId'
/** Persisted states an interrupted automatic run can resume from. */
const RESUMABLE_ANALYSIS_STATUSES: ReadonlySet<string> = new Set(['IMPORTED', 'PARSED', 'DETECTED'])
/** Arrival at any of these ends a background run and requires a data refresh. */
const TERMINAL_ANALYSIS_STATUSES: ReadonlySet<string> = new Set(['READY', 'SANITIZED', 'FAILED'])
const UNRECORDED_ANALYSIS_FAILURE = 'ANALYSIS_FAILURE_UNRECORDED'

/**
 * Stable identity of one persisted document row revision: two IPC reads of
 * the same database state share this key (structured clone gives them
 * different object identities), and any real state transition — including a
 * genuinely NEW failure attempt — changes it via updatedAt and job identity.
 */
function persistedRevision(
  document: DocumentSummaryDTO,
  jobs: readonly { readonly id?: string; readonly type: string; readonly status: string; readonly createdAt: number }[]
): string {
  const failedJob = jobs.find((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
  return [
    document.updatedAt,
    document.parseStatus,
    failedJob === undefined ? '-' : `${failedJob.type}:${failedJob.status}:${failedJob.id ?? failedJob.createdAt}`
  ].join('|')
}

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
  const { documents, loaded: documentsLoaded, error: documentListError, loadEpoch } = useDocuments(matterId, refreshKey)

  const refresh = () => {
    setRefreshKey((value) => value + 1)
  }
  // The scheduler callback stays identity-stable so scheduling survives renders.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const autoResumeScheduledRef = useRef(new Set<string>())
  /**
   * A selection requires judging staleness against list snapshots completed
   * AFTER it; an older snapshot predates the selection and must not veto it
   * (import/replacement rows appear exactly in such later snapshots).
   */
  const minValidListEpochRef = useRef(0)

  /**
   * Analysis activity window per Document: from the moment a schedule (auto
   * or retry) is issued until a fetch observes READY/SANITIZED (or an
   * explicitly-retried failure proves stable). Stage-to-stage gaps expose
   * resumable statuses (IMPORTED/PARSED/DETECTED) for a moment — the
   * scheduling REQUEST alone resolves long before that — so polling and the
   * progress shell must key off this window, not off the request flight.
   */
  const [analysisActiveIds, setAnalysisActiveIds] = useState<ReadonlySet<string>>(new Set())
  const releaseActiveId = useCallback((releasedId: string) => {
    setAnalysisActiveIds((previous) => {
      if (!previous.has(releasedId)) return previous
      const next = new Set(previous)
      next.delete(releasedId)
      return next
    })
  }, [])
  const analysisScheduler = useAnalysisScheduler({
    onScheduled: () => refreshRef.current(),
    // A failed schedule must leave its document usable: drop the activity
    // window AND the once-per-session resume marker so the retry button is
    // enabled and re-selecting can try again.
    onFailure: (failedId) => {
      releaseActiveId(failedId)
      autoResumeScheduledRef.current.delete(failedId)
    }
  })
  /** Drops every renderer trace of one document's analysis lifecycle. */
  const forgetAnalysisState = useCallback(
    (forgottenId: string) => {
      analysisScheduler.forget(forgottenId)
      releaseActiveId(forgottenId)
      processedSnapshotRef.current.delete(forgottenId)
      refreshedTerminalRef.current.delete(forgottenId)
      ignoredFailedRevisionRef.current.delete(forgottenId)
      autoResumeScheduledRef.current.delete(forgottenId)
      scheduledDocumentMatterRef.current.delete(forgottenId)
    },
    [analysisScheduler, releaseActiveId]
  )
  const scheduleAnalysis = useCallback(
    (targetId: string) => {
      setAnalysisActiveIds((previous) => {
        if (previous.has(targetId)) return previous
        const next = new Set(previous)
        next.add(targetId)
        return next
      })
      // The retry attempt is fresh: observations of the PRE-EXISTING failure
      // revision (the deferral means the very next poll can still read it)
      // are stale hand-off reads to ignore — but any DIFFERENT FAILED
      // revision belongs to this attempt and ends the window at once. A
      // first analysis has no prior failure revision, so its first FAILED
      // observation closes the window immediately.
      const snapshot = latestStatusRef.current.document
      const snapshotJobs = latestStatusRef.current.jobs
      if (snapshot !== null && snapshot.id === targetId && snapshot.parseStatus === 'FAILED') {
        ignoredFailedRevisionRef.current.set(targetId, persistedRevision(snapshot, snapshotJobs))
      } else {
        ignoredFailedRevisionRef.current.delete(targetId)
      }
      processedSnapshotRef.current.delete(targetId)
      const ownerMatterId = snapshot !== null && snapshot.id === targetId ? snapshot.matterId : matterId
      if (ownerMatterId !== null) scheduledDocumentMatterRef.current.set(targetId, ownerMatterId)
      analysisScheduler.schedule(targetId)
    },
    [analysisScheduler, matterId]
  )
  const scheduleAnalysisRef = useRef(scheduleAnalysis)
  scheduleAnalysisRef.current = scheduleAnalysis

  const status = useDocumentStatus(
    documentId,
    refreshKey,
    documentId !== null && analysisActiveIds.has(documentId)
  )
  // Render-time mirror so schedule-time capture reads the snapshot the user
  // is looking at, regardless of hook declaration order.
  const latestStatusRef = useRef(status)
  latestStatusRef.current = status
  const review = useDocumentReview(documentId, refreshKey)
  const preview = useSanitizedPreview(documentId, refreshKey)
  const unrecordedAnalysisFailure = status.error?.code === UNRECORDED_ANALYSIS_FAILURE
  // A main-process import can fail before this renderer completes its FIRST
  // status read. The list summary is still a safe persisted projection and
  // keeps the selected document's retry surface visible in that cold race.
  const selectedStatusDocument =
    status.document ??
    (unrecordedAnalysisFailure && documentId !== null
      ? (documents.find((document) => document.id === documentId) ?? null)
      : null)
  const documentReady =
    selectedStatusDocument !== null &&
    (selectedStatusDocument.parseStatus === 'READY' || selectedStatusDocument.parseStatus === 'SANITIZED')

  const onSelectMatter = (id: string) => {
    setMatterId(id)
    localStorage.setItem(LAST_MATTER_KEY, id)
    restoredDocumentIdRef.current = null
    setDocumentId(null)
    setSelectedMentionId(null)
    localStorage.removeItem(LAST_DOCUMENT_KEY)
  }

  const selectDocument = (id: string) => {
    setDocumentId(id)
    setSelectedMentionId(null)
    restoredDocumentIdRef.current = null
    localStorage.setItem(LAST_DOCUMENT_KEY, id)
    minValidListEpochRef.current = loadEpoch + 1
    setRefreshKey((value) => value + 1)
  }

  const onSelectDocument = selectDocument

  /**
   * A newly imported or replacement Document is selected immediately AND the
   * workspace returns to the review view, so its automatic analysis progress
   * and final result are visible no matter which page launched the action.
   */
  const onDocumentImported = (imported: DocumentSummaryDTO) => {
    if (imported.supersedesDocumentId !== undefined) forgetAnalysisState(imported.supersedesDocumentId)
    setView('review')
    selectDocument(imported.id)
  }

  // Selection cleanup happens synchronously on trash success so no stale
  // Document content renders for even one frame before the lists refresh.
  const onMatterTrashed = (trashedMatterId: string) => {
    // A trashed Matter takes its whole (possibly mid-analysis) document set
    // with it. The schedule-time registry covers documents of matters that are
    // NOT currently selected (whose rows the live list never shows), so a
    // later restore resumes cleanly instead of inheriting stale markers.
    for (const [documentId, ownerMatterId] of scheduledDocumentMatterRef.current) {
      if (ownerMatterId === trashedMatterId) forgetAnalysisState(documentId)
    }
    if (trashedMatterId === matterId) {
      setMatterId(null)
      setDocumentId(null)
      restoredDocumentIdRef.current = null
      setSelectedMentionId(null)
      localStorage.removeItem(LAST_MATTER_KEY)
      localStorage.removeItem(LAST_DOCUMENT_KEY)
    }
    refresh()
  }

  const onDocumentTrashed = (trashedDocumentId: string) => {
    forgetAnalysisState(trashedDocumentId)
    if (trashedDocumentId === documentId) {
      setDocumentId(null)
      restoredDocumentIdRef.current = null
      setSelectedMentionId(null)
      localStorage.removeItem(LAST_DOCUMENT_KEY)
    }
    refresh()
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
    // Judge a missing id only against snapshots completed after the selection;
    // the stale-while-revalidate list may legitimately still lack a row that
    // is about to arrive.
    if (
      documentId !== null &&
      loadEpoch >= minValidListEpochRef.current &&
      !documents.some((document) => document.id === documentId)
    ) {
      setDocumentId(null)
      localStorage.removeItem(LAST_DOCUMENT_KEY)
    }
  }, [documents, documentsLoaded, documentId, loadEpoch])

  /**
   * Selecting a Document in a resumable non-failed state resumes its automatic
   * analysis once per app session; the main-process runner deduplicates this
   * with any import-triggered start, and a persisted FAILED state keeps
   * waiting for the explicit retry action instead of looping.
   */
  /**
   * When backgrounded analysis moves the persisted status onto a terminal
   * state, one refresh pulls fresh review/preview/list data: unlike the old
   * manual stage buttons there is no user click after completion.
   */
  /**
   * The last PERSISTED REVISION processed per document, built from
   * updatedAt + parseStatus + failed-job identity. Observation logic runs
   * only when this stable key changes: Electron IPC structured-clones every
   * response into a fresh object, so object identity cannot deduplicate two
   * reads of the same database row — and a window-membership change (retry
   * clicked, another document scheduled) re-running the effect against the
   * same stale snapshot must not count it twice either.
   */
  const processedSnapshotRef = useRef(new Map<string, string>())
  /** Terminal revisions already refreshed per document (same stable key). */
  const refreshedTerminalRef = useRef(new Map<string, string>())
  /** Failure revision observed BEFORE a schedule: stale hand-off reads to ignore. */
  const ignoredFailedRevisionRef = useRef(new Map<string, string>())
  /**
   * Matter ownership recorded AT SCHEDULE TIME for every document this session
   * ever gave analysis state: `documents` only covers the CURRENT matter, so
   * trashing a non-selected matter would otherwise leave its scheduled
   * documents' windows/markers behind.
   */
  const scheduledDocumentMatterRef = useRef(new Map<string, string>())
  useEffect(() => {
    const snapshot = status.document
    if (snapshot === null) return
    const observedId = snapshot.id
    const revision = persistedRevision(snapshot, status.jobs)
    if (processedSnapshotRef.current.get(observedId) === revision) return
    processedSnapshotRef.current.set(observedId, revision)
    const currentStatus = snapshot.parseStatus

    // Terminal arrival pulls fresh review/preview/list data once per persisted
    // revision — unlike the old manual stage buttons, background completion
    // has no user click. Keyed by revision (not previousStatus) so a window
    // that was opened after the last observation still refreshes at READY.
    if (TERMINAL_ANALYSIS_STATUSES.has(currentStatus) && refreshedTerminalRef.current.get(observedId) !== revision) {
      refreshedTerminalRef.current.set(observedId, revision)
      refreshRef.current()
    }

    // Window lifecycle: READY/SANITIZED always close. A FAILED observation is
    // either the stale PRE-SCHEDULE revision (a hand-off read to ignore) or a
    // genuinely NEW failure of this attempt — new failures end the window
    // immediately; every accepted attempt leaves its own persisted revision
    // (same-stage re-compensation), so identity is one-revision-per-attempt.
    if (currentStatus === 'READY' || currentStatus === 'SANITIZED') {
      releaseActiveId(observedId)
      scheduledDocumentMatterRef.current.delete(observedId)
    } else if (currentStatus === 'FAILED') {
      if (
        analysisActiveIds.has(observedId) &&
        ignoredFailedRevisionRef.current.get(observedId) !== revision
      ) {
        ignoredFailedRevisionRef.current.delete(observedId)
        releaseActiveId(observedId)
      }
    }
  }, [status.document, analysisActiveIds, releaseActiveId])

  // Persistence can fail while recording a stage failure. The runner exposes
  // that attempt-specific terminal signal through document:get; releasing the
  // window here prevents infinite progress and leaves the explicit retry usable.
  useEffect(() => {
    if (documentId !== null && status.error?.code === UNRECORDED_ANALYSIS_FAILURE) {
      releaseActiveId(documentId)
    }
  }, [documentId, status.error, releaseActiveId])

  useEffect(() => {
    const selected = status.document
    if (selected === null || !RESUMABLE_ANALYSIS_STATUSES.has(selected.parseStatus)) return
    if (autoResumeScheduledRef.current.has(selected.id)) return
    // An explicit retry (or import) already owns this document's activity
    // window: scheduling again would reset its observation state and skip the
    // terminal refresh when READY finally lands. Membership is read from the
    // render that produced this snapshot; the effect deliberately depends on
    // snapshots only — re-running on window changes would reschedule after a
    // failed schedule released its own window and loop.
    if (analysisActiveIds.has(selected.id)) return
    autoResumeScheduledRef.current.add(selected.id)
    scheduleAnalysisRef.current(selected.id)
  }, [status.document])

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
            className={view === 'trash' ? 'selected' : undefined}
            aria-pressed={view === 'trash'}
            onClick={() => setView(view === 'trash' ? 'review' : 'trash')}
          >
            {t('trash.nav')}
          </button>
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
            onTrashed={onMatterTrashed}
          />
          <DocumentList
            matterId={matterId}
            documents={documents}
            selectedDocumentId={documentId}
            onSelect={onSelectDocument}
            onChanged={refresh}
            onTrashed={onDocumentTrashed}
            onReplaced={onDocumentImported}
            onImported={onDocumentImported}
          />
        </aside>
        <section className="content">
          {view === 'settings' ? (
            <ProviderSettingsPage onClose={() => setView('review')} onBusyChange={setSettingsBusy} />
          ) : view === 'trash' ? (
            <TrashView refreshKey={refreshKey} onChanged={refresh} />
          ) : (
            <>
              {(matterError ?? documentListError) !== null && (
                <p className="error">{formatError((matterError ?? documentListError)!)}</p>
              )}
              {selectedStatusDocument !== null ? (
                (() => {
                  const documentStatus = selectedStatusDocument
                  // A sanitization-owned failure keeps its recovery surface:
                  // the preview tab stays reachable with a regenerate action.
                  const sanitizeOwnedFailure =
                    documentStatus.parseStatus === 'FAILED' &&
                    selectAnalysisAction({ parseStatus: 'FAILED', jobs: status.jobs }) === 'SANITIZE_RETRY_OWNED'
                  const workShellReady = documentReady || sanitizeOwnedFailure
                  const activeView: View = sanitizeOwnedFailure && view === 'review' ? 'preview' : view
                  return (
                    <>
                      <header>
                        <h2>{documentStatus.originalName}</h2>
                        {workShellReady && (
                          <nav>
                            {!sanitizeOwnedFailure && (
                              <button type="button" className={activeView === 'review' ? 'selected' : undefined} onClick={() => setView('review')}>
                                {t('nav.review')}
                              </button>
                            )}
                            <button type="button" className={activeView === 'preview' ? 'selected' : undefined} onClick={() => setView('preview')}>
                              {t('nav.preview')}
                            </button>
                          </nav>
                        )}
                      </header>
                      {!workShellReady ? (
                        <>
                          {/* Product-level progress replaces stage controls; no empty
                              review panel is rendered before a result exists. */}
                          <AnalysisStatus
                            parseStatus={documentStatus.parseStatus}
                            jobs={status.jobs}
                            analysisPending={analysisActiveIds.has(documentStatus.id)}
                            requestInFlight={analysisScheduler.pendingDocumentIds.has(documentStatus.id)}
                            // Scheduling failures carry no safe detail for the
                            // renderer surface; a stable localized sentence keeps
                            // the recovery path understandable.
                            scheduleError={
                              unrecordedAnalysisFailure
                                ? t('analysis.runError')
                                : analysisScheduler.failureFor(documentStatus.id) !== null
                                  ? t('analysis.scheduleError')
                                  : null
                            }
                            onRetry={() => {
                              if (documentId !== null) scheduleAnalysisRef.current(documentId)
                            }}
                          />
                          <p className="empty">{t('analysis.explainer')}</p>
                          {(review.error ?? preview.error ?? (unrecordedAnalysisFailure ? null : status.error)) !== null && (
                            <p className="error">
                              {formatError((review.error ?? preview.error ?? status.error)!)}
                            </p>
                          )}
                        </>
                      ) : activeView === 'review' ? (
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
                          key={documentStatus.id}
                          documentId={documentStatus.id}
                          preview={preview.preview}
                          onGenerated={refresh}
                          onReviewMention={(mentionId) => {
                            setSelectedMentionId(mentionId)
                            setView('review')
                          }}
                        />
                      )}
                      {workShellReady && (review.error ?? preview.error) !== null && (
                        <p className="error">{formatError((review.error ?? preview.error)!)}</p>
                      )}
                    </>
                  )
                })()
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
