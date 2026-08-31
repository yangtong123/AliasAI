import { encrypt, generateUuidV7 } from '@aliasai/crypto'
import { selectAnalysisAction, type AnalysisAction, type AnalysisStage, type DocumentParseStatus } from '@aliasai/domain'
import type { JobSummaryDTO } from './review-read'
import type { ApplicationKeys } from './index'

/**
 * The sequential analysis pipeline composes existing stage services through
 * these structural slices: unit tests substitute synthetic runners, while the
 * concrete application services satisfy the shapes without any adapter.
 */
export interface AnalysisDocumentReader {
  getDocumentStatus(documentId: string): {
    readonly document: { readonly parseStatus: DocumentParseStatus; readonly updatedAt: number }
    readonly jobs: readonly JobSummaryDTO[]
  }
}

export interface AnalysisParseStage {
  process(documentId: string): Promise<unknown>
}

export interface AnalysisDetectStage {
  detect(documentId: string): Promise<unknown>
}

export interface AnalysisResolveStage {
  resolve(documentId: string): Promise<unknown>
}

/**
 * Finalizes failures that escape a stage BEFORE its own FAILED bookkeeping
 * ran (source validation, availability guards, transaction rejections). Any
 * background failure must leave a persisted, stage-attributed final state so
 * the UI can stop showing progress and offer the retry action.
 */
export interface AnalysisFailureSink {
  recordAnalysisFailure(input: {
    readonly documentId: string
    /** Omitted only when the status read itself failed; persistence infers it. */
    readonly stage?: AnalysisStage
    readonly expected?: {
      readonly parseStatus: DocumentParseStatus
      readonly updatedAt: number
      readonly failedJobId?: string
    }
    readonly owner?: { readonly jobId?: string }
    /** Static error code only — never messages, values, or paths. */
    readonly errorCode: string
    readonly occurredAt: number
  }): 'RECORDED' | 'IGNORED'
}

/**
 * Default sink implementation over the database repository: encrypts the
 * code-only payload and writes the synthesized FAILED job lifecycle row.
 */
export class EncryptedAnalysisFailureSink implements AnalysisFailureSink {
  constructor(
    private readonly repository: {
      recordAnalysisFailure(input: {
        readonly documentId: string
        readonly job: {
          readonly id: string
          readonly type?: 'PARSE' | 'OCR' | 'DETECT' | 'RESOLVE'
          readonly occurredAt: number
          readonly errorCipher: Buffer
          readonly expected?: {
            readonly parseStatus: DocumentParseStatus
            readonly updatedAt: number
            readonly failedJobId?: string
          }
          readonly owner?: { readonly jobId?: string }
        }
      }): 'RECORDED' | 'IGNORED'
    },
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: (timestamp: number) => string = generateUuidV7
  ) {}

  recordAnalysisFailure(input: {
    readonly documentId: string
    readonly stage?: AnalysisStage
    readonly expected?: {
      readonly parseStatus: DocumentParseStatus
      readonly updatedAt: number
      readonly failedJobId?: string
    }
    readonly owner?: { readonly jobId?: string }
    readonly errorCode: string
    readonly occurredAt: number
  }): 'RECORDED' | 'IGNORED' {
    const jobType = input.stage === 'PARSE' ? ('PARSE' as const) : input.stage
    // A stage-owned fallback updates the existing RUNNING job, so its encrypted
    // error must be bound to that immutable job ID. Pre-start failures create a
    // new synthetic job and therefore generate a fresh ID here.
    const jobId = input.owner?.jobId ?? this.generateId(this.now())
    const payloadBytes = Buffer.from(JSON.stringify({ code: input.errorCode }), 'utf8')
    let errorCipher: Buffer
    try {
      errorCipher = encrypt(payloadBytes, this.keys.persistenceKey, analysisErrorContext(jobId))
    } finally {
      payloadBytes.fill(0)
    }
    try {
      return this.repository.recordAnalysisFailure({
        documentId: input.documentId,
        job: {
          id: jobId,
          ...(jobType === undefined ? {} : { type: jobType }),
          occurredAt: input.occurredAt,
          errorCipher,
          ...(input.expected === undefined ? {} : { expected: input.expected }),
          ...(input.owner === undefined ? {} : { owner: input.owner })
        }
      })
    } finally {
      errorCipher.fill(0)
    }
  }
}

/** Shared context shape with the stage services' job-error ciphers. */
function analysisErrorContext(jobId: string): Buffer {
  return Buffer.from(`${jobId}:processingJob.error`)
}

export interface DocumentAnalysisResult {
  readonly documentId: string
  /**
   * COMPLETE ran at least one stage; ALREADY_COMPLETE performed none (the
   * Document was already READY/SANITIZED, another run owns the live stage, or
   * the failure is owned by the sanitized-preview workflow).
   */
  readonly status: 'COMPLETE' | 'ALREADY_COMPLETE'
}

export class DocumentAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentAnalysisError'
  }
}

type RunAction = Extract<AnalysisAction, `RUN_${string}`>

function isRunAction(action: AnalysisAction): action is RunAction {
  return action.startsWith('RUN_')
}

function stageOf(action: RunAction): AnalysisStage {
  return action === 'RUN_PARSE' ? 'PARSE' : action === 'RUN_DETECT' ? 'DETECT' : 'RESOLVE'
}

/** Coded service errors surface their code; anything else stays generic so
 * raw messages (which may contain paths or values) never persist or leak. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const candidate = (error as { code?: unknown }).code
    if (typeof candidate === 'string') return candidate
  }
  return 'ANALYSIS_STAGE_FAILURE'
}

/**
 * Composes the existing stage services into one user operation:
 * parse -> detect -> resolve. It owns no transactions of its own — every
 * persistence boundary stays inside the composed services — and re-reads the
 * persisted status after every awaited stage instead of assuming progress.
 * A stage failure propagates unchanged and ends the run; nothing here resets a
 * failed state or continues past a failure.
 */
export class DocumentAnalysisService {
  readonly #pendingTerminalFailures = new Map<
    string,
    Omit<Parameters<AnalysisFailureSink['recordAnalysisFailure']>[0], 'occurredAt'>
  >()

  constructor(
    private readonly documents: AnalysisDocumentReader,
    private readonly processing: AnalysisParseStage,
    private readonly detection: AnalysisDetectStage,
    private readonly resolution: AnalysisResolveStage,
    private readonly onFailure?: AnalysisFailureSink,
    /** Injected so tests can drive monotonic time and the sink validates it. */
    private readonly now: () => number = Date.now,
    /** Yield between observations while a compatibility channel owns a stage. */
    private readonly waitForExternalStage: () => Promise<void> = () =>
      new Promise<void>((resolve) => setTimeout(resolve, LIVE_STAGE_POLL_INTERVAL_MS))
  ) {}

  async analyze(documentId: string): Promise<DocumentAnalysisResult> {
    // Defer into a fresh macrotask first: import/replace IPC responses must be
    // able to reach the renderer before potentially long synchronous work
    // (entity resolution over many mentions has no internal awaits) can
    // monopolize the main-process event loop behind the handler's stack.
    await new Promise<void>((resolve) => setImmediate(resolve))

    this.retryPendingTerminalFailure(documentId)

    let ranAnyStage = false
    let ranStages = 0
    let observedExternalStage = false
    while (ranStages < MAX_STAGES_PER_RUN) {
      let status: ReturnType<AnalysisDocumentReader['getDocumentStatus']>
      try {
        status = await this.readStatus(documentId)
      } catch (error) {
        // The schedule was already accepted. If the product read model itself
        // cannot be obtained, ask the raw persistence fallback to infer the
        // resting stage so the renderer still receives a terminal revision.
        const failureOutcome = this.recordFailure({ documentId, error, occurredAt: this.now() })
        if (failureOutcome === 'IGNORED') throw unrecordedFailure(error)
        throw error
      }
      const action = selectAnalysisAction({ parseStatus: status.document.parseStatus, jobs: status.jobs })
      if (action === 'WAITING_FOR_LIVE_STAGE') {
        // A diagnostic/compatibility channel owns this stage. Returning here
        // would release the main-process runner while the renderer keeps its
        // activity window, leaving nobody responsible for the next stage.
        // Keep the runner reservation, yield, and take over from the external
        // stage's next persisted resting state.
        observedExternalStage = true
        await this.waitForExternalStage()
        continue
      }
      if (!isRunAction(action)) {
        return { documentId, status: ranAnyStage ? 'COMPLETE' : 'ALREADY_COMPLETE' }
      }
      // An external owner that ended in FAILED already produced the terminal
      // result for this accepted attempt. Do not turn that observation into an
      // automatic retry; the user-facing retry remains explicit.
      if (observedExternalStage && status.document.parseStatus === 'FAILED') {
        return { documentId, status: ranAnyStage ? 'COMPLETE' : 'ALREADY_COMPLETE' }
      }
      observedExternalStage = false
      try {
        await this.runStage(action, documentId)
      } catch (error) {
        // The composed services persist their own FAILED states once their
        // guarded region was entered; failures thrown BEFORE that point would
        // otherwise leave the document mid-resumable forever.
        const failedJob = status.jobs.find((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
        const owner = analysisOwnerOf(error)
        const failureOutcome = this.recordFailure({
          documentId,
          stage: stageOf(action),
          expected: {
            parseStatus: status.document.parseStatus,
            updatedAt: status.document.updatedAt,
            ...(failedJob === undefined ? {} : { failedJobId: failedJob.id })
          },
          ...(owner === undefined ? {} : { owner }),
          error,
          occurredAt: this.now()
        })
        if (failureOutcome === 'IGNORED') {
          // The compensation repository rejected the stale pre-stage revision.
          // If persistence moved, another owner won the race: keep the runner
          // reservation and observe that owner's result. If NOTHING moved,
          // this accepted attempt has no durable terminal signal, so expose
          // the process-local fallback instead of looping forever.
          let latest: ReturnType<AnalysisDocumentReader['getDocumentStatus']>
          try {
            latest = await this.readStatus(documentId)
          } catch (cause) {
            throw unrecordedFailure(error, cause)
          }
          if (persistedRevision(latest) === persistedRevision(status)) {
            throw unrecordedFailure(error)
          }
          this.#pendingTerminalFailures.delete(documentId)
          // The invoked stage may have completed its OWN failure transaction
          // before throwing. That is a durable terminal failure, not an
          // external ownership transfer; preserve the original error contract.
          if (latest.document.parseStatus === 'FAILED') throw error
          observedExternalStage = true
          continue
        }
        throw error
      }
      ranAnyStage = true
      ranStages += 1
    }

    // The iteration cap is itself a failed accepted attempt. Re-read once so
    // a stage that completed on the final iteration can still win; otherwise
    // persist an exact terminal failure revision instead of leaving the
    // renderer's activity window open forever.
    const stalled = new DocumentAnalysisError('ANALYSIS_STALLED', 'Document analysis did not progress')
    let status: ReturnType<AnalysisDocumentReader['getDocumentStatus']>
    try {
      status = await this.readStatus(documentId)
    } catch (cause) {
      const unreadableStall = new DocumentAnalysisError('ANALYSIS_STALLED', 'Document analysis did not progress', {
        cause
      })
      const failureOutcome = this.recordFailure({ documentId, error: unreadableStall, occurredAt: this.now() })
      if (failureOutcome === 'IGNORED') throw unrecordedFailure(unreadableStall)
      throw unreadableStall
    }
    const action = selectAnalysisAction({ parseStatus: status.document.parseStatus, jobs: status.jobs })
    if (!isRunAction(action)) {
      return { documentId, status: ranAnyStage ? 'COMPLETE' : 'ALREADY_COMPLETE' }
    }
    const failedJob = status.jobs.find((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
    const failureOutcome = this.recordFailure({
      documentId,
      stage: stageOf(action),
      expected: {
        parseStatus: status.document.parseStatus,
        updatedAt: status.document.updatedAt,
        ...(failedJob === undefined ? {} : { failedJobId: failedJob.id })
      },
      error: stalled,
      occurredAt: this.now()
    })
    if (failureOutcome === 'IGNORED') throw unrecordedFailure(stalled)
    throw stalled
  }

  private async readStatus(documentId: string): Promise<ReturnType<AnalysisDocumentReader['getDocumentStatus']>> {
    let lastError: unknown
    for (let attempt = 0; attempt < STATUS_READ_ATTEMPTS; attempt += 1) {
      try {
        return this.documents.getDocumentStatus(documentId)
      } catch (error) {
        lastError = error
        if (attempt + 1 < STATUS_READ_ATTEMPTS) {
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    }
    throw lastError
  }

  private recordFailure(input: {
    readonly documentId: string
    readonly stage?: AnalysisStage
    readonly expected?: {
      readonly parseStatus: DocumentParseStatus
      readonly updatedAt: number
      readonly failedJobId?: string
    }
    readonly owner?: { readonly jobId?: string }
    readonly error: unknown
    readonly occurredAt: number
  }): 'RECORDED' | 'IGNORED' | undefined {
    if (this.onFailure === undefined) return undefined
    const sinkInput = {
      documentId: input.documentId,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.expected === undefined ? {} : { expected: input.expected }),
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      errorCode: errorCodeOf(input.error)
    }
    try {
      const outcome = this.onFailure.recordAnalysisFailure({ ...sinkInput, occurredAt: input.occurredAt })
      if (outcome === 'RECORDED') this.#pendingTerminalFailures.delete(input.documentId)
      else this.#pendingTerminalFailures.set(input.documentId, sinkInput)
      return outcome
    } catch (cause) {
      // The original stage error remains the cause, but a background caller
      // must be able to distinguish "persisted FAILED" from "terminalization
      // itself failed". The runner exposes this coded process-local failure to
      // document:get so the renderer can stop polling and offer retry.
      this.#pendingTerminalFailures.set(input.documentId, sinkInput)
      throw unrecordedFailure(input.error, cause)
    }
  }

  /** Lifecycle removal and a successful compatibility run invalidate fallback state. */
  clearPendingFailure(documentId: string): void {
    this.#pendingTerminalFailures.delete(documentId)
  }

  private retryPendingTerminalFailure(documentId: string): void {
    const pending = this.#pendingTerminalFailures.get(documentId)
    if (pending === undefined || this.onFailure === undefined) return
    try {
      const outcome = this.onFailure.recordAnalysisFailure({ ...pending, occurredAt: this.now() })
      if (outcome === 'RECORDED') {
        this.#pendingTerminalFailures.delete(documentId)
        return
      }
      const current = this.documents.getDocumentStatus(documentId)
      const action = selectAnalysisAction({ parseStatus: current.document.parseStatus, jobs: current.jobs })
      if (action !== 'WAITING_FOR_LIVE_STAGE' && persistedRevision(current) !== expectedRevision(pending)) {
        this.#pendingTerminalFailures.delete(documentId)
        return
      }
      throw unrecordedFailure(new Error(pending.errorCode))
    } catch (cause) {
      if (cause instanceof DocumentAnalysisError && cause.code === 'ANALYSIS_FAILURE_UNRECORDED') throw cause
      throw unrecordedFailure(new Error(pending.errorCode), cause)
    }
  }

  private async runStage(action: RunAction, documentId: string): Promise<void> {
    switch (action) {
      case 'RUN_PARSE':
        await this.processing.process(documentId)
        return
      case 'RUN_DETECT':
        await this.detection.detect(documentId)
        return
      case 'RUN_RESOLVE':
        await this.resolution.resolve(documentId)
        return
    }
  }
}

/**
 * A single automatic run crosses at most one retry origin per stage: a full
 * pass is PARSE+DETECT+RESOLVE and each FAILED origin replays at most its own
 * stage before continuing forward (worst case four stage executions). Eight
 * iterations leave generous headroom while still bounding a pathological loop.
 */
const MAX_STAGES_PER_RUN = 8
const STATUS_READ_ATTEMPTS = 3
const LIVE_STAGE_POLL_INTERVAL_MS = 100

function analysisOwnerOf(error: unknown): { readonly jobId?: string } | undefined {
  if (typeof error !== 'object' || error === null || !('analysisOwner' in error)) return undefined
  const owner = (error as { readonly analysisOwner?: unknown }).analysisOwner
  if (typeof owner !== 'object' || owner === null) return undefined
  const jobId = 'jobId' in owner ? (owner as { readonly jobId?: unknown }).jobId : undefined
  return typeof jobId === 'string' ? { jobId } : {}
}

function persistedRevision(status: ReturnType<AnalysisDocumentReader['getDocumentStatus']>): string {
  const failedJob = status.jobs.find((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
  return `${status.document.parseStatus}|${status.document.updatedAt}|${failedJob?.id ?? '-'}`
}

function expectedRevision(
  pending: Omit<Parameters<AnalysisFailureSink['recordAnalysisFailure']>[0], 'occurredAt'>
): string {
  const expected = pending.expected
  return expected === undefined
    ? '-'
    : `${expected.parseStatus}|${expected.updatedAt}|${expected.failedJobId ?? '-'}`
}

function unrecordedFailure(original: unknown, terminalization?: unknown): DocumentAnalysisError {
  return new DocumentAnalysisError(
    'ANALYSIS_FAILURE_UNRECORDED',
    'Automatic analysis failed before its terminal state could be saved',
    {
      cause:
        terminalization === undefined
          ? original
          : new AggregateError([original, terminalization])
    }
  )
}
