import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AliasAiDatabase } from './client'
import { documents, matters, processingJobs } from './schema'
import type { DocumentParseStatus } from '@aliasai/domain'

/**
 * Strict stable-source pairing for pre-start failure compensation:
 *
 * - PARSE compensation applies ONLY to an untouched IMPORTED document.
 * - DETECT compensation applies ONLY to a settled PARSED document.
 * - RESOLVE compensation applies ONLY to a settled DETECTED document.
 *
 * Running states (PARSING/DETECTING/RESOLVING) are NEVER finalized here: they
 * belong to whoever owns the RUNNING ProcessingJob (the stage services'
 * guarded regions, startup recovery after a crash). This repository only ever
 * compensates failures that escaped BEFORE a stage took ownership, so a
 * concurrent diagnostic-channel success can never be re-marked FAILED.
 */
const STAGE_SOURCE_STATUS: Readonly<Record<'PARSE' | 'DETECT' | 'RESOLVE', DocumentParseStatus>> = {
  PARSE: 'IMPORTED',
  DETECT: 'PARSED',
  RESOLVE: 'DETECTED'
}

const STAGE_RUNNING_STATUS: Readonly<Record<'PARSE' | 'DETECT' | 'RESOLVE', DocumentParseStatus>> = {
  PARSE: 'PARSING',
  DETECT: 'DETECTING',
  RESOLVE: 'RESOLVING'
}

export type FailureStage = 'PARSE' | 'OCR' | 'DETECT' | 'RESOLVE'

export interface RecordAnalysisFailureInput {
  readonly documentId: string
  readonly job: {
    readonly id: string
    /** PARSE/OCR failures use the PARSE job type so retries route back to parsing. */
    readonly type?: FailureStage
    /** Started/finished timestamps for the synthesized FAILED lifecycle row. */
    readonly occurredAt: number
    /** Encrypted code-only payload; plaintext never reaches persistence. */
    readonly errorCipher: Buffer
    /** Persisted revision observed immediately before the stage was invoked. */
    readonly expected?: {
      readonly parseStatus: DocumentParseStatus
      readonly updatedAt: number
      readonly failedJobId?: string
    }
    /**
     * Present only when a stage acquired ownership but its own failure-finalizing
     * transaction failed. The fallback may then close exactly that owner.
     */
    readonly owner?: { readonly jobId?: string }
  }
}

export class AnalysisFailureRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  recordAnalysisFailure(input: RecordAnalysisFailureInput): 'RECORDED' | 'IGNORED' {
    return this.db.transaction((transaction) => {
      const row = transaction
        .select({
          parseStatus: documents.parseStatus,
          deletedAt: documents.deletedAt,
          updatedAt: documents.updatedAt,
          matterStatus: matters.status
        })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, input.documentId))
        .get()
      // Availability guards come first: a trashed Document OR a Matter already
      // moved to trash must never gain FAILED review state — restore brings
      // the row back exactly as it was, not as a manufactured failure.
      if (row === undefined) return 'IGNORED'
      if (row.deletedAt !== null || row.matterStatus === 'DELETED') return 'IGNORED'
      // STRICT stage↔status pairing: settled successes, the sanitize domain,
      // another stage's territory, and running states owned elsewhere all
      // stay untouched.
      const latestFailed = transaction
        .select({ id: processingJobs.id, jobType: processingJobs.jobType })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.documentId, input.documentId),
            inArray(processingJobs.status, ['FAILED', 'CANCELLED'])
          )
        )
        .orderBy(desc(processingJobs.createdAt), desc(processingJobs.id))
        .limit(1)
        .get()
      const latestAnalysisType =
        latestFailed === undefined
          ? 'PARSE'
          : latestFailed.jobType === 'PARSE' ||
              latestFailed.jobType === 'OCR' ||
              latestFailed.jobType === 'DETECT' ||
              latestFailed.jobType === 'RESOLVE'
            ? latestFailed.jobType
            : undefined
      const inferredType =
        input.job.type ??
        (row.parseStatus === 'IMPORTED'
          ? 'PARSE'
          : row.parseStatus === 'PARSED'
            ? 'DETECT'
            : row.parseStatus === 'DETECTED'
              ? 'RESOLVE'
              : row.parseStatus === 'FAILED'
                ? latestAnalysisType
                : undefined)
      if (inferredType === undefined) return 'IGNORED'
      const stage = inferredType === 'OCR' ? 'PARSE' : inferredType
      const requiredStatus = STAGE_SOURCE_STATUS[stage]
      if (requiredStatus === undefined) return 'IGNORED'

      // A stage-owned finalization fallback is allowed only for the exact live
      // state and (for job-backed stages) the exact RUNNING owner. It updates
      // that job rather than manufacturing a second attempt.
      if (input.job.owner !== undefined) {
        const runningStatus = STAGE_RUNNING_STATUS[stage]
        if (row.parseStatus !== runningStatus || input.job.occurredAt < row.updatedAt) return 'IGNORED'
        const occurredAt = Math.max(input.job.occurredAt, row.updatedAt)
        if (input.job.owner.jobId !== undefined) {
          const owner = transaction
            .select({ type: processingJobs.jobType, status: processingJobs.status, documentId: processingJobs.documentId })
            .from(processingJobs)
            .where(eq(processingJobs.id, input.job.owner.jobId))
            .get()
          const ownerStage = owner?.type === 'OCR' ? 'PARSE' : owner?.type
          if (
            owner === undefined ||
            owner.documentId !== input.documentId ||
            owner.status !== 'RUNNING' ||
            ownerStage !== stage
          ) {
            return 'IGNORED'
          }
          const jobResult = transaction
            .update(processingJobs)
            .set({ status: 'FAILED', errorCipher: input.job.errorCipher, finishedAt: occurredAt })
            .where(and(eq(processingJobs.id, input.job.owner.jobId), eq(processingJobs.status, 'RUNNING')))
            .run()
          if (jobResult.changes !== 1) return 'IGNORED'
        }
        const documentResult = transaction
          .update(documents)
          .set({ parseStatus: 'FAILED', ...(stage === 'PARSE' ? { pageCount: null } : {}), updatedAt: occurredAt })
          .where(
            and(
              eq(documents.id, input.documentId),
              eq(documents.parseStatus, runningStatus),
              eq(documents.updatedAt, row.updatedAt)
            )
          )
          .run()
        if (documentResult.changes !== 1) throw new Error('Analysis failure owner changed before finalization')
        if (input.job.owner.jobId === undefined) {
          transaction
            .insert(processingJobs)
            .values({
              id: input.job.id,
              documentId: input.documentId,
              jobType: inferredType,
              status: 'FAILED',
              progress: 0,
              checkpoint: null,
              errorCipher: input.job.errorCipher,
              createdAt: occurredAt,
              startedAt: occurredAt,
              finishedAt: occurredAt
            })
            .run()
        }
        return 'RECORDED'
      }

      // The caller's pre-stage revision is the ownership boundary. If it no
      // longer matches, the stage changed state (including finalizing its own
      // failure), so this outer fallback must be a no-op.
      if (input.job.expected !== undefined) {
        if (
          row.parseStatus !== input.job.expected.parseStatus ||
          row.updatedAt !== input.job.expected.updatedAt ||
          latestFailed?.id !== input.job.expected.failedJobId
        ) {
          return 'IGNORED'
        }
      }
      if (row.parseStatus !== requiredStatus) {
        // A retry of an already-FAILED document can fail again BEFORE its
        // stage transaction starts (source still missing, for example). The
        // retry was accepted, so it must leave a distinguishable revision —
        // otherwise the renderer keeps treating every read as the pre-schedule
        // stale one and disables retry forever. Allowed only when the
        // persisted failure belongs to the SAME stage family; sanitize-owned
        // failures (no analysis job) stay untouched.
        if (row.parseStatus !== 'FAILED') return 'IGNORED'
        if (latestFailed === undefined) return 'IGNORED'
        const latestStage = latestFailed.jobType === 'OCR' ? 'PARSE' : latestFailed.jobType
        if (latestStage !== stage) return 'IGNORED'
      }
      // Monotonic time, same rule as every stage repository: a compensation
      // timestamp older than the row's last write would rewind updatedAt.
      if (input.job.occurredAt < row.updatedAt) return 'IGNORED'
      // A new attempt must remain observable even when two failures land in the
      // same millisecond. Random UUID ordering is not an attempt sequence.
      const occurredAt = Math.max(input.job.occurredAt, row.updatedAt + 1)

      // Only parsing failures invalidate the parsed Document Model; later
      // stages must PRESERVE pageCount or their retries would dead-end on
      // 'Document Model is incomplete'.
      const pageCount =
        stage === 'PARSE'
          ? null
          : (
              transaction
                .select({ value: documents.pageCount })
                .from(documents)
                .where(eq(documents.id, input.documentId))
                .get() ?? { value: null }
            ).value

      const updated = transaction
        .update(documents)
        .set({ parseStatus: 'FAILED', pageCount, updatedAt: occurredAt })
        .where(
          and(
            eq(documents.id, input.documentId),
            inArray(documents.parseStatus, [requiredStatus, 'FAILED']),
            eq(documents.updatedAt, row.updatedAt)
          )
        )
        .run()
      if (updated.changes !== 1) return 'IGNORED'

      transaction
        .insert(processingJobs)
        .values({
          id: input.job.id,
          documentId: input.documentId,
          jobType: inferredType,
          status: 'FAILED',
          progress: 0,
          checkpoint: null,
          errorCipher: input.job.errorCipher,
          createdAt: occurredAt,
          startedAt: occurredAt,
          finishedAt: occurredAt
        })
        .run()
      return 'RECORDED'
    })
  }
}
