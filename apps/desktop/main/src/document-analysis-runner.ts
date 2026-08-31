import type { DocumentAnalysisResult } from '@aliasai/application'

interface AnalysisServiceLike {
  analyze(documentId: string): Promise<DocumentAnalysisResult>
  clearPendingFailure?(documentId: string): void
}

/**
 * Process-local scheduler for automatic document analysis. The import and
 * replace IPC handlers must return immediately, so the sequential pipeline
 * runs in the background; this class guards one active run per Document and
 * guarantees every rejection is observed.
 *
 * The map is NOT durable workflow state — SQLite Document/ProcessingJob rows
 * stay authoritative across restarts (startup recovery converts leftover live
 * states to retryable failures). It only deduplicates duplicate starts inside
 * one app process, and its entries are removed in `finally` so an explicit
 * retry can start again later.
 */
export class DocumentAnalysisRunner {
  readonly #runs = new Map<string, Promise<void>>()
  readonly #unrecordedFailures = new Map<string, { readonly code: 'ANALYSIS_FAILURE_UNRECORDED'; readonly revision: number }>()
  #failureRevision = 0
  #closed = false

  constructor(
    private readonly analysis: AnalysisServiceLike,
    /**
     * Observes background rejections so they never become unhandled. The
     * persisted FAILED Document/job state is the user-visible representation
     * of the failure; the callback may log codes but never values or paths.
     */
    private readonly onError?: (documentId: string, error: unknown) => void
  ) {}

  /**
   * Registers one background run for `documentId` and returns true; a second
   * start while that run is active (or after close) is ignored with false —
   * not an error.
   */
  start(documentId: string): boolean {
    if (this.#closed || this.#runs.has(documentId)) return false
    this.#unrecordedFailures.delete(documentId)
    const run = this.analysis.analyze(documentId).then(
      () => undefined,
      (error: unknown) => {
        if (hasErrorCode(error, 'ANALYSIS_FAILURE_UNRECORDED')) {
          this.#unrecordedFailures.set(documentId, {
            code: 'ANALYSIS_FAILURE_UNRECORDED',
            revision: ++this.#failureRevision
          })
        }
        try {
          this.onError?.(documentId, error)
        } catch {
          // An observer failure must never escape into the run chain.
        }
      }
    )
    // Attach cleanup so a finished or rejected run frees the slot even if no
    // caller ever awaits it; the guard keeps a same-tick restart from racing.
    void run.finally(() => {
      if (this.#runs.get(documentId) === run) this.#runs.delete(documentId)
    })
    this.#runs.set(documentId, run)
    return true
  }

  /** Number of runs currently registered. */
  get activeCount(): number {
    return this.#runs.size
  }

  /** True when the given Document has a run registered right now. */
  isActive(documentId: string): boolean {
    return this.#runs.has(documentId)
  }

  /**
   * Process-local terminal signal used only when the durable failure sink was
   * unavailable. Persisted Document/Job state remains authoritative otherwise.
   */
  failureFor(documentId: string): { readonly code: 'ANALYSIS_FAILURE_UNRECORDED'; readonly revision: number } | undefined {
    return this.#unrecordedFailures.get(documentId)
  }

  /** Lifecycle removal/replacement invalidates any process-local observation. */
  clearFailure(documentId: string): void {
    this.#unrecordedFailures.delete(documentId)
    this.analysis.clearPendingFailure?.(documentId)
  }

  /**
   * Resolves once every registered run settles. Graceful shutdown and tests
   * drain before closing resources so no stage writes against closed handles;
   * an abrupt exit is still safe because SQLite rolls back uncommitted stage
   * transactions and startup recovery finalizes leftover RUNNING states.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.#runs.values()])
  }

  /**
   * Stops accepting new starts (returns false immediately) without touching
   * already-registered runs; pair with `drain` on shutdown paths. Idempotent.
   */
  close(): void {
    this.#closed = true
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}
