import type { JobSummaryDTO } from '@aliasai/application'
import { selectAnalysisAction, type DocumentParseStatus } from '@aliasai/domain'
import { useI18n, type TranslationKey } from '../i18n'

/** Friendly copy per persisted running/resumable status. */
const PROGRESS_HEADLINES: Readonly<
  Record<'IMPORTED' | 'PARSING' | 'PARSED' | 'DETECTING' | 'DETECTED' | 'RESOLVING', TranslationKey>
> = {
  IMPORTED: 'analysis.waiting',
  PARSING: 'analysis.reading',
  PARSED: 'analysis.detecting',
  DETECTING: 'analysis.detecting',
  DETECTED: 'analysis.relating',
  RESOLVING: 'analysis.relating'
}

/**
 * The one product-level analysis state. It never renders job types, enum
 * values, detector names, or error details — only the friendly progress /
 * completion / failure copy and a single retry action for a persisted
 * failure. Stage selection comes from the same pure rule the main-process
 * orchestrator uses (`selectAnalysisAction`), so the renderer can never
 * attribute a failure to a different stage than the retry would actually run.
 *
 * Scheduling belongs to the parent (`onRetry`), which owns dedupe and the
 * per-Document analysis activity window.
 */
export function AnalysisStatus(props: {
  readonly parseStatus: DocumentParseStatus
  readonly jobs: readonly JobSummaryDTO[]
  /** True while this Document's analysis is trusted to be underway. */
  readonly analysisPending?: boolean
  /** True while the schedule/retry IPC request itself is still in flight. */
  readonly requestInFlight?: boolean
  /** Friendly message when scheduling could not start. */
  readonly scheduleError?: string | null
  readonly onRetry: () => void
}) {
  const { t } = useI18n()
  const action = selectAnalysisAction({ parseStatus: props.parseStatus, jobs: props.jobs })
  const busy = props.analysisPending === true || props.requestInFlight === true
  const activeJob = props.jobs.find((job) => job.status === 'RUNNING' && job.progress > 0)

  if (action === 'ALREADY_ANALYZED') {
    return (
      <section className="analysis-status complete">
        <p className="analysis-headline">{t('analysis.complete')}</p>
      </section>
    )
  }

  if (action === 'SANITIZE_RETRY_OWNED') {
    return (
      <section className="analysis-status failed" aria-live="polite">
        <p className="analysis-headline warning">{t('analysis.sanitizeFailed')}</p>
      </section>
    )
  }

  if (props.parseStatus === 'FAILED') {
    // Failed with an analysis-owned origin: exactly one visible retry action.
    return (
      <section className="analysis-status failed" aria-live="polite">
        <p className="analysis-headline">{t('analysis.failed')}</p>
        {(props.scheduleError ?? null) !== null && <p className="error">{props.scheduleError}</p>}
        <button type="button" disabled={busy} onClick={props.onRetry}>
          {t('analysis.retry')}
        </button>
      </section>
    )
  }

  return (
    <section className="analysis-status running" aria-live="polite">
      <p className="analysis-headline">
        {t(PROGRESS_HEADLINES[props.parseStatus as keyof typeof PROGRESS_HEADLINES] ?? 'analysis.relating')}
      </p>
      {activeJob !== undefined && (
        <progress
          max={1}
          value={activeJob.progress}
          aria-label={t('analysis.progress', { percent: Math.round(activeJob.progress * 100) })}
        />
      )}
      {props.scheduleError !== null && props.scheduleError !== undefined ? (
        <>
          <p className="error">{props.scheduleError}</p>
          {/* Scheduling failed, so nothing is running: one retry stays usable. */}
          <button type="button" disabled={busy} onClick={props.onRetry}>
            {t('analysis.retry')}
          </button>
        </>
      ) : (
        !busy && <p className="hint">{t('analysis.explainer')}</p>
      )}
    </section>
  )
}
