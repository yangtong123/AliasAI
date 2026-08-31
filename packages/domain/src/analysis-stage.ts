/**
 * Pure stage-selection rule for the automatic analysis pipeline
 * (parse -> privacy detection -> entity resolution). Lives in the domain
 * package so the main-process orchestrator and the renderer copy both derive
 * their view of "what happens next" from the same rule; neither side may
 * re-implement it differently.
 */
import type { DocumentParseStatus, ProcessingJobStatus, ProcessingJobType } from './types'

/** The three application stages composed into one automatic user operation. */
export type AnalysisStage = 'PARSE' | 'DETECT' | 'RESOLVE'

/** Persisted evidence one selection decision may look at. */
export interface AnalysisStateSnapshot {
  readonly parseStatus: DocumentParseStatus
  /** Latest job per type, as exposed by the review read model. */
  readonly jobs: readonly {
    readonly type: ProcessingJobType
    readonly status: ProcessingJobStatus
    readonly createdAt: number
  }[]
}

/**
 * What should happen next for a Document:
 *
 * - `RUN_*`: run this stage now (next unfinished stage, or a retry of the
 *   stage the persisted failure belongs to).
 * - `ALREADY_ANALYZED`: READY/SANITIZED — a successful no-op.
 * - `WAITING_FOR_LIVE_STAGE`: a pipeline stage is in flight; never start a
 *   second run.
 * - `SANITIZE_RETRY_OWNED`: the failure belongs to sanitization (or
 *   verification), which the sanitized-preview workflow owns; analysis must
 *   not route into it.
 */
export type AnalysisAction =
  | 'RUN_PARSE'
  | 'RUN_DETECT'
  | 'RUN_RESOLVE'
  | 'ALREADY_ANALYZED'
  | 'WAITING_FOR_LIVE_STAGE'
  | 'SANITIZE_RETRY_OWNED'

const ACTIVE_STATUSES: ReadonlySet<DocumentParseStatus> = new Set([
  'PARSING',
  'DETECTING',
  'RESOLVING',
  'SANITIZING'
])

/**
 * Selects the next analysis action from persisted status plus the latest job
 * per type. Job-based selection matters only for FAILED Documents: parsing
 * creates no ProcessingJob, so with no failed downstream job the failure
 * belongs to parsing. OCR is a parse variant. SANITIZE/VERIFY failures stay
 * outside analysis on purpose.
 */
export function selectAnalysisAction(snapshot: AnalysisStateSnapshot): AnalysisAction {
  switch (snapshot.parseStatus) {
    case 'READY':
    case 'SANITIZED':
      return 'ALREADY_ANALYZED'
    case 'IMPORTED':
      return 'RUN_PARSE'
    case 'PARSED':
      return 'RUN_DETECT'
    case 'DETECTED':
      return 'RUN_RESOLVE'
    default:
      break
  }
  if (ACTIVE_STATUSES.has(snapshot.parseStatus)) return 'WAITING_FOR_LIVE_STAGE'

  // parseStatus === 'FAILED': attribute the failure to its latest failed or
  // cancelled downstream job.
  const failedJob = [...snapshot.jobs]
    .filter((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  if (failedJob === undefined || failedJob.type === 'PARSE' || failedJob.type === 'OCR') return 'RUN_PARSE'
  if (failedJob.type === 'DETECT') return 'RUN_DETECT'
  if (failedJob.type === 'RESOLVE') return 'RUN_RESOLVE'
  return 'SANITIZE_RETRY_OWNED'
}
