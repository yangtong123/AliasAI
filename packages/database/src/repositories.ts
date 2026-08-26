import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'
import type {
  AiExecution,
  Document,
  DocumentBlock,
  DocumentPage,
  Entity,
  EntityAlias,
  EntityConstraint,
  EntityStatus,
  EntityType,
  Matter,
  Mention,
  ProcessingJob,
  ProtectedValue,
  ProtectedValueType,
  ResolutionCandidate,
  ResolutionEvent,
  ResolutionEvidence,
  SanitizationMapping,
  SanitizedBlock,
  SanitizedDocument
} from '@aliasai/domain'
import {
  assertAiExecution,
  assertDocument,
  assertDocumentBlock,
  assertDocumentPage,
  assertEntity,
  assertEntityAlias,
  assertMention,
  assertProcessingJob,
  assertProtectedValue,
  assertSameMatter,
  assertSanitizationMapping,
  assertSanitizedBlock,
  assertSanitizedDocument,
  assignMentionToEntity,
  canonicalizeEntityConstraint,
  confirmMentionAssignment
} from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import {
  aiExecutions,
  documentBlocks,
  documentPages,
  documents,
  entities,
  entityAliases,
  entityConstraints,
  entityProtectedValues,
  matters,
  mentions,
  processingJobs,
  protectedValues,
  resolutionCandidates,
  resolutionEvents,
  resolutionEvidence,
  sanitizationMappings,
  sanitizedBlocks,
  sanitizedDocuments
} from './schema'

export interface CreateMatterInput {
  readonly id: string
  readonly nameCipher: Buffer
  readonly status: Matter['status']
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateDocumentInput {
  readonly id: string
  readonly matterId: string
  readonly originalNameCipher: Buffer
  readonly sourcePathCipher?: Buffer
  readonly fileHash: string
  readonly mimeType: string
  readonly parserType?: string
  readonly pageCount?: number
  readonly parseStatus: Document['parseStatus']
  readonly createdAt: number
  readonly updatedAt: number
}

/** One atomic import decision: matter availability, active dedup, creation. */
export type ImportDecision =
  | { readonly status: 'MATTER_UNAVAILABLE' }
  | { readonly status: 'REUSED'; readonly document: Document }
  | { readonly status: 'CREATED'; readonly document: Document }

export interface DocumentProcessingSource {
  readonly document: Document
  readonly sourcePathCipher?: Buffer
}

export interface CreateDocumentPageInput extends DocumentPage {
  readonly createdAt: number
}

export interface CreateDocumentBlockInput extends DocumentBlock {
  readonly textCipher: Buffer
  readonly createdAt: number
}

export interface CompleteDocumentProcessingInput {
  readonly documentId: string
  readonly parserType: string
  readonly pageCount: number
  readonly pages: readonly CreateDocumentPageInput[]
  readonly blocks: readonly CreateDocumentBlockInput[]
  readonly updatedAt: number
}

export type CreateEntityInput = Entity

export type CreateEntityAliasInput = EntityAlias

export interface CreateResolutionEventInput extends ResolutionEvent {
  readonly payloadCipher: Buffer
}

export interface CreateEntityWithPrimaryAliasAndEventInput {
  readonly entity: CreateEntityInput
  readonly primaryAlias: CreateEntityAliasInput
  readonly event: CreateResolutionEventInput
}

export interface CreatedEntityWithPrimaryAliasAndEvent {
  readonly entity: Entity
  readonly primaryAlias: EntityAlias
  readonly event: ResolutionEvent
}

export class MatterRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  create(input: CreateMatterInput): Matter {
    this.db.insert(matters).values(input).run()
    return { id: input.id, status: input.status, createdAt: input.createdAt, updatedAt: input.updatedAt }
  }

  findById(id: string): Matter | undefined {
    const row = this.db.select().from(matters).where(eq(matters.id, id)).get()
    return row === undefined
      ? undefined
      : { id: row.id, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }
  }
}

export class DocumentRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  create(input: CreateDocumentInput): Document {
    const document: Document = {
      id: input.id,
      matterId: input.matterId,
      fileHash: input.fileHash,
      mimeType: input.mimeType,
      ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
      ...(input.parserType === undefined ? {} : { parserType: input.parserType }),
      parseStatus: input.parseStatus,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    }
    assertDocument(document)
    this.db.insert(documents).values(input).run()
    return document
  }

  /**
   * Import decision in one transaction: the Matter must be available (checked
   * here, not before the async file inspection, so trashing the Matter during
   * inspection cannot leave a hidden Document behind), an active same-hash
   * Document is reused, otherwise the new Document is created. The caller's
   * candidate ID is ignored on reuse.
   */
  createInAvailableMatter(input: CreateDocumentInput): ImportDecision {
    return this.db.transaction((transaction) => {
      const matter = transaction
        .select({ status: matters.status })
        .from(matters)
        .where(eq(matters.id, input.matterId))
        .get()
      if (matter === undefined || matter.status === 'DELETED') {
        return { status: 'MATTER_UNAVAILABLE' } as const
      }
      const existing = transaction
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.matterId, input.matterId),
            eq(documents.fileHash, input.fileHash),
            isNull(documents.deletedAt)
          )
        )
        .get()
      if (existing !== undefined) {
        return { status: 'REUSED', document: toDocument(existing) } as const
      }
      const document: Document = {
        id: input.id,
        matterId: input.matterId,
        fileHash: input.fileHash,
        mimeType: input.mimeType,
        ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
        ...(input.parserType === undefined ? {} : { parserType: input.parserType }),
        parseStatus: input.parseStatus,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt
      }
      assertDocument(document)
      transaction.insert(documents).values(input).run()
      return { status: 'CREATED', document } as const
    })
  }

  /** Import deduplication: only an active Document with this hash is reused. */
  findByMatterAndFileHash(matterId: string, fileHash: string): Document | undefined {
    const row = this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.matterId, matterId), eq(documents.fileHash, fileHash), isNull(documents.deletedAt))
      )
      .get()
    return row === undefined ? undefined : toDocument(row)
  }

  findById(id: string): Document | undefined {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get()
    return row === undefined ? undefined : toDocument(row)
  }

  /**
   * User-facing read: the Document must be active and its Matter must not be
   * deleted. Historical (unfiltered) access stays on the explicitly named
   * findById so one method never sometimes filters and sometimes retains.
   */
  findAvailableById(id: string): Document | undefined {
    const row = this.db
      .select({ document: documents })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(and(eq(documents.id, id), isNull(documents.deletedAt), ne(matters.status, 'DELETED')))
      .get()
    return row === undefined ? undefined : toDocument(row.document)
  }

  findProcessingSource(id: string): DocumentProcessingSource | undefined {
    const row = this.db
      .select({ document: documents, matterStatus: matters.status })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(eq(documents.id, id))
      .get()
    if (row === undefined) return undefined
    if (row.document.deletedAt !== null || row.matterStatus === 'DELETED') return undefined
    return {
      document: toDocument(row.document),
      ...(row.document.sourcePathCipher === null ? {} : { sourcePathCipher: row.document.sourcePathCipher })
    }
  }

  markProcessing(documentId: string, parserType: string, updatedAt: number): Document {
    if (parserType.trim().length === 0) throw new Error('parserType must not be empty')
    return this.db.transaction((transaction) => {
      const row = transaction
        .select({ document: documents, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, documentId))
        .get()
      if (row === undefined) throw new Error('Document was not found')
      if (row.document.deletedAt !== null || row.matterStatus === 'DELETED') {
        throw new Error('Document is not available for processing')
      }
      const current = toDocument(row.document)
      if (updatedAt < current.updatedAt) throw new Error('Document processing timestamp must not move backwards')
      if (
        current.parseStatus === 'FAILED' &&
        transaction
          .select({ id: documentPages.id })
          .from(documentPages)
          .where(eq(documentPages.documentId, documentId))
          .limit(1)
          .get() !== undefined
      ) {
        throw new Error('A failed downstream stage cannot be retried as document parsing')
      }

      const result = transaction
        .update(documents)
        .set({ parseStatus: 'PARSING', parserType, pageCount: null, updatedAt })
        .where(
          and(
            eq(documents.id, documentId),
            isNull(documents.deletedAt),
            inArray(documents.parseStatus, ['IMPORTED', 'FAILED'])
          )
        )
        .run()
      if (result.changes !== 1) throw new Error('Document is not available for processing')
      const processing = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      if (processing === undefined) throw new Error('Document was not found')
      return toDocument(processing)
    })
  }

  markProcessingFailed(documentId: string, updatedAt: number): Document {
    const current = this.findById(documentId)
    if (current === undefined) throw new Error('Document was not found')
    if (updatedAt < current.updatedAt) throw new Error('Document processing timestamp must not move backwards')

    const result = this.db
      .update(documents)
      .set({ parseStatus: 'FAILED', pageCount: null, updatedAt })
      .where(and(eq(documents.id, documentId), eq(documents.parseStatus, 'PARSING')))
      .run()
    if (result.changes !== 1) throw new Error('Document is not currently processing')
    return this.requireById(documentId)
  }

  completeProcessing(input: CompleteDocumentProcessingInput): Document {
    if (input.parserType.trim().length === 0) throw new Error('parserType must not be empty')
    if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1) {
      throw new Error('pageCount must be a positive safe integer')
    }
    if (input.pages.length !== input.pageCount) throw new Error('pageCount must match the persisted pages')

    const pageIds = new Set<string>()
    const pageNumbers = new Set<number>()
    for (const page of input.pages) {
      assertDocumentPage(page)
      if (page.documentId !== input.documentId) throw new Error('Page must belong to the processed Document')
      if (pageIds.has(page.id) || pageNumbers.has(page.pageNo)) throw new Error('Document pages must be unique')
      pageIds.add(page.id)
      pageNumbers.add(page.pageNo)
    }
    for (let pageNo = 1; pageNo <= input.pageCount; pageNo += 1) {
      if (!pageNumbers.has(pageNo)) throw new Error('Document pages must form a complete sequence')
    }

    const blockIds = new Set<string>()
    for (const block of input.blocks) {
      assertDocumentBlock(block)
      if (block.documentId !== input.documentId || !pageIds.has(block.pageId)) {
        throw new Error('Block must belong to a persisted Document page')
      }
      if (blockIds.has(block.id)) throw new Error('Document blocks must have unique IDs')
      blockIds.add(block.id)
    }

    return this.db.transaction((transaction) => {
      const current = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (current === undefined) throw new Error('Document was not found')
      // The document may have been trashed (or its Matter deleted) while the
      // worker was running; never commit parsed content into the trash.
      if (current.deletedAt !== null || !matterIsAvailable(transaction, current.matterId)) {
        throw new Error('Document is not available for processing')
      }
      if (current.parseStatus !== 'PARSING') throw new Error('Document is not currently processing')
      if (input.updatedAt < current.updatedAt) throw new Error('Document processing timestamp must not move backwards')

      transaction
        .insert(documentPages)
        .values(
          input.pages.map((page) => ({
            id: page.id,
            documentId: page.documentId,
            pageNo: page.pageNo,
            originalWidth: page.originalWidth,
            originalHeight: page.originalHeight,
            rotation: page.rotation,
            sourceType: page.sourceType,
            createdAt: page.createdAt
          }))
        )
        .run()
      if (input.blocks.length > 0) {
        transaction
          .insert(documentBlocks)
          .values(
            input.blocks.map((block) => ({
              id: block.id,
              documentId: block.documentId,
              pageId: block.pageId,
              blockType: block.blockType,
              textCipher: block.textCipher,
              source: block.source,
              ...(block.confidence === undefined ? {} : { confidence: block.confidence }),
              x: block.bbox.x,
              y: block.bbox.y,
              width: block.bbox.width,
              height: block.bbox.height,
              readingOrder: block.readingOrder,
              createdAt: block.createdAt
            }))
          )
          .run()
      }
      const result = transaction
        .update(documents)
        .set({
          parserType: input.parserType,
          pageCount: input.pageCount,
          parseStatus: 'PARSED',
          updatedAt: input.updatedAt
        })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, 'PARSING')))
        .run()
      if (result.changes !== 1) throw new Error('Document processing state changed before completion')

      const completed = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (completed === undefined) throw new Error('Completed Document was not found')
      return toDocument(completed)
    })
  }

  private requireById(id: string): Document {
    const document = this.findById(id)
    if (document === undefined) throw new Error('Document was not found')
    return document
  }
}

export interface PrivacyDetectionBlockSource extends DocumentBlock {
  readonly matterId: string
  readonly textCipher: Buffer
}

export interface BeginPrivacyDetectionInput {
  readonly documentId: string
  readonly jobId: string
  readonly startedAt: number
}

export interface BegunPrivacyDetection {
  readonly document: Document
  readonly job: ProcessingJob
  readonly blocks: readonly PrivacyDetectionBlockSource[]
}

export interface CreateMentionInput extends Mention {
  readonly textCipher: Buffer
  readonly fingerprint?: Buffer
}

export interface CompletePrivacyDetectionInput {
  readonly documentId: string
  readonly jobId: string
  readonly mentions: readonly CreateMentionInput[]
  readonly finishedAt: number
}

export interface PrivacyDetectionResult {
  readonly document: Document
  readonly job: ProcessingJob
  readonly mentions: readonly Mention[]
}

/** Owns the DETECT job state machine and all Mention persistence transactions. */
export class PrivacyDetectionRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findCompleted(documentId: string): PrivacyDetectionResult | undefined {
    const documentRow = this.db
      .select({ document: documents })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(and(eq(documents.id, documentId), ne(matters.status, 'DELETED')))
      .get()
    if (
      documentRow === undefined ||
      documentRow.document.parseStatus !== 'DETECTED' ||
      documentRow.document.deletedAt !== null
    ) {
      return undefined
    }
    const jobRow = this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.documentId, documentId),
          eq(processingJobs.jobType, 'DETECT'),
          eq(processingJobs.status, 'COMPLETED')
        )
      )
      .orderBy(desc(processingJobs.finishedAt), desc(processingJobs.createdAt))
      .limit(1)
      .get()
    if (jobRow === undefined) throw new Error('Detected Document is missing its completed ProcessingJob')
    return {
      document: toDocument(documentRow.document),
      job: toProcessingJob(jobRow),
      mentions: this.findMentions(documentId)
    }
  }

  begin(input: BeginPrivacyDetectionInput): BegunPrivacyDetection {
    if (input.jobId.trim().length === 0) throw new Error('jobId must not be empty')
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (current === undefined) throw new Error('Document was not found')
      if (current.deletedAt !== null || !matterIsAvailable(transaction, current.matterId)) {
        throw new Error('Document is not available for privacy detection')
      }
      if (input.startedAt < current.updatedAt) throw new Error('Privacy detection timestamp must not move backwards')
      if (current.parseStatus !== 'PARSED' && current.parseStatus !== 'FAILED') {
        throw new Error('Document is not available for privacy detection')
      }
      if (current.pageCount === null) throw new Error('Document Model is incomplete')

      if (current.parseStatus === 'FAILED') {
        const latest = transaction
          .select()
          .from(processingJobs)
          .where(and(eq(processingJobs.documentId, input.documentId), eq(processingJobs.jobType, 'DETECT')))
          .orderBy(desc(processingJobs.createdAt))
          .limit(1)
          .get()
        if (latest?.status !== 'FAILED') throw new Error('Failed Document did not fail during privacy detection')
      }

      const pageCount = transaction
        .select({ id: documentPages.id })
        .from(documentPages)
        .where(eq(documentPages.documentId, input.documentId))
        .all().length
      if (pageCount !== current.pageCount) throw new Error('Document Model is incomplete')
      const existingMention = transaction
        .select({ id: mentions.id })
        .from(mentions)
        .where(eq(mentions.documentId, input.documentId))
        .limit(1)
        .get()
      if (existingMention !== undefined) throw new Error('Document already has a persisted Mention set')

      const job: ProcessingJob = {
        id: input.jobId,
        documentId: input.documentId,
        type: 'DETECT',
        status: 'RUNNING',
        progress: 0,
        createdAt: input.startedAt,
        startedAt: input.startedAt
      }
      assertProcessingJob(job)
      transaction
        .insert(processingJobs)
        .values({
          id: job.id,
          documentId: job.documentId,
          jobType: job.type,
          status: job.status,
          progress: job.progress,
          createdAt: job.createdAt,
          startedAt: job.startedAt
        })
        .run()
      const transition = transaction
        .update(documents)
        .set({ parseStatus: 'DETECTING', updatedAt: input.startedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, current.parseStatus)))
        .run()
      if (transition.changes !== 1) throw new Error('Document state changed before privacy detection began')

      const pageRows = transaction
        .select()
        .from(documentPages)
        .where(eq(documentPages.documentId, input.documentId))
        .orderBy(asc(documentPages.pageNo), asc(documentPages.id))
        .all()
      const blockRows = pageRows.flatMap((page) =>
        transaction
          .select()
          .from(documentBlocks)
          .where(and(eq(documentBlocks.documentId, input.documentId), eq(documentBlocks.pageId, page.id)))
          .orderBy(asc(documentBlocks.readingOrder), asc(documentBlocks.id))
          .all()
      )
      const document = toDocument({ ...current, parseStatus: 'DETECTING', updatedAt: input.startedAt })
      return {
        document,
        job,
        blocks: blockRows.map((row) => toDetectionBlock(row, current.matterId))
      }
    })
  }

  updateProgress(jobId: string, completedBlocks: number, totalBlocks: number): ProcessingJob {
    if (!Number.isSafeInteger(completedBlocks) || completedBlocks < 0) throw new Error('completedBlocks must be non-negative')
    if (!Number.isSafeInteger(totalBlocks) || totalBlocks < 1 || completedBlocks > totalBlocks) {
      throw new Error('totalBlocks must be positive and no smaller than completedBlocks')
    }
    const progress = completedBlocks / totalBlocks
    const result = this.db
      .update(processingJobs)
      .set({ progress, checkpoint: `${completedBlocks}/${totalBlocks}` })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'DETECT'), eq(processingJobs.status, 'RUNNING')))
      .run()
    if (result.changes !== 1) throw new Error('Privacy detection job is not running')
    return this.requireJob(jobId)
  }

  complete(input: CompletePrivacyDetectionInput): PrivacyDetectionResult {
    const ids = new Set<string>()
    for (const mention of input.mentions) {
      assertMention(mention)
      if (mention.documentId !== input.documentId) throw new Error('Mention must belong to the detected Document')
      if (mention.entityId !== undefined || mention.protectedValueId !== undefined) {
        throw new Error('Detection must not assign Mentions to identity records')
      }
      if (ids.has(mention.id)) throw new Error('Mention IDs must be unique')
      ids.add(mention.id)
    }

    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'DETECTING') {
        throw new Error('Document is not currently detecting privacy mentions')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== input.documentId ||
        jobRow.jobType !== 'DETECT' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Privacy detection job is not running')
      }
      if (input.finishedAt < documentRow.updatedAt || input.finishedAt < jobRow.startedAt) {
        throw new Error('Privacy detection timestamp must not move backwards')
      }
      for (const mention of input.mentions) {
        if (mention.matterId !== documentRow.matterId) throw new Error('Mention must remain inside the Document Matter')
      }

      if (input.mentions.length > 0) {
        transaction.insert(mentions).values(input.mentions.map(toMentionInsert)).run()
      }
      const jobResult = transaction
        .update(processingJobs)
        .set({ status: 'COMPLETED', progress: 1, checkpoint: null, finishedAt: input.finishedAt })
        .where(and(eq(processingJobs.id, input.jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      const documentResult = transaction
        .update(documents)
        .set({ parseStatus: 'DETECTED', updatedAt: input.finishedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, 'DETECTING')))
        .run()
      if (jobResult.changes !== 1 || documentResult.changes !== 1) {
        throw new Error('Privacy detection state changed before completion')
      }
      const completedDocument = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const completedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (completedDocument === undefined || completedJob === undefined) throw new Error('Completed detection state was not found')
      return {
        document: toDocument(completedDocument),
        job: toProcessingJob(completedJob),
        mentions: input.mentions.map(mentionInputToDomain)
      }
    })
  }

  fail(documentId: string, jobId: string, errorCipher: Buffer, finishedAt: number): PrivacyDetectionResult {
    if (errorCipher.length === 0) throw new Error('errorCipher must not be empty')
    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'DETECTING') {
        throw new Error('Document is not currently detecting privacy mentions')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== documentId ||
        jobRow.jobType !== 'DETECT' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Privacy detection job is not running')
      }
      if (finishedAt < documentRow.updatedAt || finishedAt < jobRow.startedAt) {
        throw new Error('Privacy detection timestamp must not move backwards')
      }
      transaction
        .update(processingJobs)
        .set({ status: 'FAILED', errorCipher, finishedAt })
        .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      transaction
        .update(documents)
        .set({ parseStatus: 'FAILED', updatedAt: finishedAt })
        .where(and(eq(documents.id, documentId), eq(documents.parseStatus, 'DETECTING')))
        .run()
      const failedDocument = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const failedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (failedDocument === undefined || failedJob === undefined) throw new Error('Failed detection state was not found')
      return {
        document: toDocument(failedDocument),
        job: toProcessingJob(failedJob),
        mentions: []
      }
    })
  }

  findMentions(documentId: string): readonly Mention[] {
    return this.db
      .select({ mention: mentions })
      .from(mentions)
      .innerJoin(documentPages, eq(documentPages.id, mentions.pageId))
      .innerJoin(documentBlocks, eq(documentBlocks.id, mentions.blockId))
      .where(eq(mentions.documentId, documentId))
      .orderBy(
        asc(documentPages.pageNo),
        asc(documentBlocks.readingOrder),
        asc(mentions.startOffset),
        asc(mentions.id)
      )
      .all()
      .map(({ mention }) => toMention(mention))
  }

  private requireJob(id: string): ProcessingJob {
    const row = this.db.select().from(processingJobs).where(eq(processingJobs.id, id)).get()
    if (row === undefined) throw new Error('ProcessingJob was not found')
    return toProcessingJob(row)
  }
}

type DocumentRow = typeof documents.$inferSelect
type DocumentBlockRow = typeof documentBlocks.$inferSelect
type MentionRow = typeof mentions.$inferSelect
type ProcessingJobRow = typeof processingJobs.$inferSelect
type EntityRow = typeof entities.$inferSelect
type EntityAliasRow = typeof entityAliases.$inferSelect
type EntityConstraintRow = typeof entityConstraints.$inferSelect
type ProtectedValueRow = typeof protectedValues.$inferSelect

/** The transaction handle type drizzle passes to `db.transaction` callbacks. */
type TransactionLike = Parameters<Parameters<AliasAiDatabase['transaction']>[0]>[0]

/** True when the Matter exists and is not in the trash. */
export function matterIsAvailable(db: AliasAiDatabase | TransactionLike, matterId: string): boolean {
  const row = db.select({ status: matters.status }).from(matters).where(eq(matters.id, matterId)).get()
  return row !== undefined && row.status !== 'DELETED'
}

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    matterId: row.matterId,
    fileHash: row.fileHash,
    mimeType: row.mimeType,
    ...(row.pageCount === null ? {} : { pageCount: row.pageCount }),
    ...(row.parserType === null ? {} : { parserType: row.parserType }),
    parseStatus: row.parseStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt }),
    ...(row.supersedesDocumentId === null ? {} : { supersedesDocumentId: row.supersedesDocumentId })
  }
}

function toDetectionBlock(row: DocumentBlockRow, matterId: string): PrivacyDetectionBlockSource {
  const block: PrivacyDetectionBlockSource = {
    id: row.id,
    matterId,
    documentId: row.documentId,
    pageId: row.pageId,
    blockType: row.blockType,
    textCipher: row.textCipher,
    source: row.source,
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    bbox: { x: row.x, y: row.y, width: row.width, height: row.height },
    readingOrder: row.readingOrder
  }
  assertDocumentBlock(block)
  return block
}

function toMentionInsert(input: CreateMentionInput): typeof mentions.$inferInsert {
  return {
    id: input.id,
    matterId: input.matterId,
    documentId: input.documentId,
    pageId: input.pageId,
    blockId: input.blockId,
    ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    ...(input.protectedValueId === undefined ? {} : { protectedValueId: input.protectedValueId }),
    mentionType: input.type,
    mentionStrength: input.strength,
    textCipher: input.textCipher,
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    ...(input.bbox === undefined
      ? {}
      : { x: input.bbox.x, y: input.bbox.y, width: input.bbox.width, height: input.bbox.height }),
    detector: input.detector,
    confidence: input.confidence,
    reviewStatus: input.reviewStatus,
    createdAt: input.createdAt
  }
}

/** Maps a mention row to its domain shape; shared with the review read model. */
export function toMention(row: MentionRow): Mention {
  const mention: Mention = {
    id: row.id,
    matterId: row.matterId,
    documentId: row.documentId,
    pageId: row.pageId,
    blockId: row.blockId,
    type: row.mentionType,
    strength: row.mentionStrength,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    ...(row.x === null || row.y === null || row.width === null || row.height === null
      ? {}
      : { bbox: { x: row.x, y: row.y, width: row.width, height: row.height } }),
    detector: row.detector,
    confidence: row.confidence,
    reviewStatus: row.reviewStatus,
    ...(row.entityId === null ? {} : { entityId: row.entityId }),
    ...(row.protectedValueId === null ? {} : { protectedValueId: row.protectedValueId }),
    createdAt: row.createdAt
  }
  assertMention(mention)
  return mention
}

/** Maps a processing job row to its domain shape; shared with the review read model. */
export function toProcessingJob(row: ProcessingJobRow): ProcessingJob {
  const job: ProcessingJob = {
    id: row.id,
    documentId: row.documentId,
    type: row.jobType,
    status: row.status,
    progress: row.progress,
    ...(row.checkpoint === null ? {} : { checkpoint: row.checkpoint }),
    createdAt: row.createdAt,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt })
  }
  assertProcessingJob(job)
  return job
}

function mentionInputToDomain(input: CreateMentionInput): Mention {
  return {
    id: input.id,
    matterId: input.matterId,
    documentId: input.documentId,
    pageId: input.pageId,
    blockId: input.blockId,
    type: input.type,
    strength: input.strength,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    ...(input.bbox === undefined ? {} : { bbox: input.bbox }),
    detector: input.detector,
    confidence: input.confidence,
    reviewStatus: input.reviewStatus,
    ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    ...(input.protectedValueId === undefined ? {} : { protectedValueId: input.protectedValueId }),
    createdAt: input.createdAt
  }
}

function toEntity(row: EntityRow): Entity {
  const entity: Entity = {
    id: row.id,
    matterId: row.matterId,
    type: row.entityType,
    publicToken: row.publicToken,
    status: row.status,
    ...(row.mergedIntoEntityId === null ? {} : { mergedIntoEntityId: row.mergedIntoEntityId }),
    ...(row.resolutionConfidence === null ? {} : { resolutionConfidence: row.resolutionConfidence }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
  assertEntity(entity)
  return entity
}

function toEntityAlias(row: EntityAliasRow): EntityAlias {
  const alias: EntityAlias = {
    id: row.id,
    matterId: row.matterId,
    entityId: row.entityId,
    alias: row.alias,
    aliasType: row.aliasType,
    ...(row.role === null ? {} : { role: row.role }),
    isPrimary: row.isPrimary,
    createdAt: row.createdAt
  }
  assertEntityAlias(alias)
  return alias
}

function toEntityConstraint(row: EntityConstraintRow): EntityConstraint {
  return {
    id: row.id,
    matterId: row.matterId,
    entityAId: row.entityAId,
    entityBId: row.entityBId,
    type: row.constraintType,
    reason: row.reason,
    source: row.source,
    createdAt: row.createdAt
  }
}

function toProtectedValueInsert(input: CreateProtectedValueInput): typeof protectedValues.$inferInsert {
  return {
    id: input.id,
    matterId: input.matterId,
    valueType: input.type,
    valueCipher: input.valueCipher,
    fingerprint: input.fingerprint,
    ...(input.publicToken === undefined ? {} : { publicToken: input.publicToken }),
    restorePolicy: input.restorePolicy,
    createdAt: input.createdAt
  }
}

function toProtectedValueWithCipher(row: ProtectedValueRow): ProtectedValueWithCipher {
  const value: ProtectedValueWithCipher = {
    id: row.id,
    matterId: row.matterId,
    type: row.valueType,
    valueCipher: row.valueCipher,
    ...(row.publicToken === null ? {} : { publicToken: row.publicToken }),
    restorePolicy: row.restorePolicy,
    createdAt: row.createdAt
  }
  assertProtectedValue(value)
  return value
}

function toResolutionEventInsert(event: CreateResolutionEventInput): typeof resolutionEvents.$inferInsert {
  return {
    id: event.id,
    matterId: event.matterId,
    eventType: event.type,
    ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
    ...(event.mentionId === undefined ? {} : { mentionId: event.mentionId }),
    actor: event.actor,
    payloadCipher: event.payloadCipher,
    createdAt: event.createdAt
  }
}

function toResolutionMentionSource(row: MentionRow): ResolutionMentionSource {
  return { ...toMention(row), textCipher: row.textCipher, fingerprint: row.fingerprint }
}

/**
 * Review mutations are only valid while the Document is reviewable. Once a
 * SANITIZE job starts, the sanitized artifact and its mappings are one-shot;
 * assignment or confirmation changes afterwards would desynchronize the review
 * state from the persisted artifact. Enforced inside the mutation transaction,
 * not just in the renderer.
 */
/**
 * Review writes require an active Document in an available Matter. Checking
 * only parseStatus would let a trashed Document (or one inside a deleted
 * Matter) still be mutated through stale renderer IDs.
 */
function assertDocumentReviewMutable(row: {
  readonly parseStatus: string
  readonly deletedAt: number | null
  readonly matterStatus: string
}): void {
  if (row.deletedAt !== null || row.matterStatus === 'DELETED') {
    throw new Error('Document is not available for review changes')
  }
  if (row.parseStatus === 'SANITIZING' || row.parseStatus === 'SANITIZED') {
    throw new Error('Document review is closed after sanitization')
  }
}

/** Entity-level review writes require a Matter that is not in the trash. */
function assertMatterReviewMutable(transaction: TransactionLike, matterId: string): void {
  const row = transaction.select({ status: matters.status }).from(matters).where(eq(matters.id, matterId)).get()
  if (row === undefined || row.status === 'DELETED') {
    throw new Error('Matter is not available for review changes')
  }
}

export class EntityRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  /** Persists the initial Entity identity aggregate and its audit record atomically. */
  createWithPrimaryAliasAndEvent(
    input: CreateEntityWithPrimaryAliasAndEventInput
  ): CreatedEntityWithPrimaryAliasAndEvent {
    const { entity, primaryAlias, event } = input
    assertEntity(entity)
    assertEntityAlias(primaryAlias)
    assertSameMatter(entity, primaryAlias, 'entity and primary alias')
    if (entity.status !== 'ACTIVE') throw new Error('a newly created Entity must be active')
    if (primaryAlias.entityId !== entity.id || primaryAlias.aliasType !== 'PRIMARY' || !primaryAlias.isPrimary) {
      throw new Error('primary alias must identify the newly created Entity')
    }
    if (event.type !== 'ENTITY_CREATED' || event.entityId !== entity.id || event.mentionId !== undefined) {
      throw new Error('creation event must identify only the newly created Entity')
    }
    if (event.matterId !== entity.matterId) {
      throw new Error('creation event must belong to the Entity Matter')
    }

    const entityRow = {
      id: entity.id,
      matterId: entity.matterId,
      entityType: entity.type,
      publicToken: entity.publicToken,
      status: entity.status,
      ...(entity.resolutionConfidence === undefined ? {} : { resolutionConfidence: entity.resolutionConfidence }),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }

    return this.db.transaction((transaction) => {
      transaction.insert(entities).values(entityRow).run()
      transaction.insert(entityAliases).values(primaryAlias).run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(event)).run()
      return {
        entity,
        primaryAlias,
        event: {
          id: event.id,
          matterId: event.matterId,
          type: event.type,
          entityId: entity.id,
          actor: event.actor,
          createdAt: event.createdAt
        }
      }
    })
  }

  create(entity: CreateEntityInput): Entity {
    assertEntity(entity)
    this.db.insert(entities).values({
      id: entity.id,
      matterId: entity.matterId,
      entityType: entity.type,
      publicToken: entity.publicToken,
      status: entity.status,
      ...(entity.mergedIntoEntityId === undefined ? {} : { mergedIntoEntityId: entity.mergedIntoEntityId }),
      ...(entity.resolutionConfidence === undefined ? {} : { resolutionConfidence: entity.resolutionConfidence }),
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    }).run()
    return entity
  }

  addAlias(alias: CreateEntityAliasInput): EntityAlias {
    assertEntityAlias(alias)
    this.db.insert(entityAliases).values(alias).run()
    return alias
  }

  appendResolutionEvent(event: CreateResolutionEventInput): ResolutionEvent {
    this.db.insert(resolutionEvents).values(toResolutionEventInsert(event)).run()
    return {
      id: event.id,
      matterId: event.matterId,
      type: event.type,
      ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
      ...(event.mentionId === undefined ? {} : { mentionId: event.mentionId }),
      actor: event.actor,
      createdAt: event.createdAt
    }
  }

  findById(id: string): Entity | undefined {
    const row = this.db.select().from(entities).where(eq(entities.id, id)).get()
    return row === undefined ? undefined : toEntity(row)
  }

  findByMatterAndType(matterId: string, type: EntityType): readonly Entity[] {
    return this.db
      .select()
      .from(entities)
      .where(and(eq(entities.matterId, matterId), eq(entities.entityType, type), eq(entities.status, 'ACTIVE')))
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all()
      .map(toEntity)
  }

  findAliases(matterId: string): readonly EntityAlias[] {
    return this.db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.matterId, matterId))
      .orderBy(asc(entityAliases.createdAt), asc(entityAliases.id))
      .all()
      .map(toEntityAlias)
  }

  findByPublicToken(matterId: string, publicToken: string): Entity | undefined {
    const row = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.matterId, matterId), eq(entities.publicToken, publicToken)))
      .get()
    return row === undefined ? undefined : toEntity(row)
  }
}

export interface ProtectedValueWithCipher extends ProtectedValue {
  readonly valueCipher: Buffer
}

export interface CreateProtectedValueInput extends ProtectedValueWithCipher {
  readonly fingerprint: Buffer
}

export interface LinkEntityProtectedValueInput {
  /** Caller-side correlation id; persistence identity is the (entityId, protectedValueId) pair. */
  readonly id: string
  readonly matterId: string
  readonly entityId: string
  readonly protectedValueId: string
  readonly relationshipType: string
  readonly confidence: number
  readonly isPrimary: boolean
  readonly createdAt: number
}

export interface EntityProtectedValueSummary {
  readonly protectedValueId: string
  readonly type: ProtectedValueType
  readonly fingerprint: Buffer
}

/** Owns ProtectedValue persistence and Entity <-> ProtectedValue links. */
export class ProtectedValueRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findByFingerprint(
    matterId: string,
    type: ProtectedValueType,
    fingerprint: Buffer
  ): ProtectedValueWithCipher | undefined {
    const row = this.db
      .select()
      .from(protectedValues)
      .where(
        and(
          eq(protectedValues.matterId, matterId),
          eq(protectedValues.valueType, type),
          eq(protectedValues.fingerprint, fingerprint)
        )
      )
      .get()
    return row === undefined ? undefined : toProtectedValueWithCipher(row)
  }

  create(input: CreateProtectedValueInput): ProtectedValue {
    assertProtectedValue(input)
    if (input.valueCipher.length === 0) throw new Error('valueCipher must not be empty')
    if (input.fingerprint.length === 0) throw new Error('fingerprint must not be empty')
    this.db.insert(protectedValues).values(toProtectedValueInsert(input)).run()
    return {
      id: input.id,
      matterId: input.matterId,
      type: input.type,
      ...(input.publicToken === undefined ? {} : { publicToken: input.publicToken }),
      restorePolicy: input.restorePolicy,
      createdAt: input.createdAt
    }
  }

  linkToEntity(input: LinkEntityProtectedValueInput): void {
    const entityRow = this.db
      .select({ matterId: entities.matterId })
      .from(entities)
      .where(eq(entities.id, input.entityId))
      .get()
    if (entityRow === undefined || entityRow.matterId !== input.matterId) {
      throw new Error('Entity was not found in the Matter')
    }
    const valueRow = this.db
      .select({ matterId: protectedValues.matterId })
      .from(protectedValues)
      .where(eq(protectedValues.id, input.protectedValueId))
      .get()
    if (valueRow === undefined || valueRow.matterId !== input.matterId) {
      throw new Error('ProtectedValue was not found in the Matter')
    }
    this.db
      .insert(entityProtectedValues)
      .values({
        entityId: input.entityId,
        protectedValueId: input.protectedValueId,
        relationshipType: input.relationshipType,
        confidence: input.confidence,
        isPrimary: input.isPrimary,
        createdAt: input.createdAt
      })
      .run()
  }

  findEntitiesByProtectedValue(matterId: string, protectedValueId: string): readonly Entity[] {
    return this.db
      .select({ entity: entities })
      .from(entityProtectedValues)
      .innerJoin(entities, eq(entities.id, entityProtectedValues.entityId))
      .where(
        and(
          eq(entities.matterId, matterId),
          eq(entityProtectedValues.protectedValueId, protectedValueId),
          eq(entities.status, 'ACTIVE')
        )
      )
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .all()
      .map(({ entity }) => toEntity(entity))
  }

  findEntityProtectedValues(matterId: string, entityId: string): readonly EntityProtectedValueSummary[] {
    return this.db
      .select({
        protectedValueId: entityProtectedValues.protectedValueId,
        type: protectedValues.valueType,
        fingerprint: protectedValues.fingerprint
      })
      .from(entityProtectedValues)
      .innerJoin(protectedValues, eq(protectedValues.id, entityProtectedValues.protectedValueId))
      .where(and(eq(protectedValues.matterId, matterId), eq(entityProtectedValues.entityId, entityId)))
      .orderBy(asc(protectedValues.createdAt), asc(protectedValues.id))
      .all()
  }
}

export interface ResolutionMentionSource extends Mention {
  readonly textCipher: Buffer
  readonly fingerprint: Buffer | null
}

export interface ResolutionBlockSource {
  readonly id: string
  readonly textCipher: Buffer
}

export interface BeginEntityResolutionInput {
  readonly documentId: string
  readonly jobId: string
  readonly startedAt: number
}

export interface BegunEntityResolution {
  readonly document: Document
  readonly job: ProcessingJob
  readonly blocks: readonly ResolutionBlockSource[]
  readonly mentions: readonly ResolutionMentionSource[]
}

export interface ResolutionMentionUpdate {
  readonly id: string
  readonly fingerprint: Buffer | null
  readonly protectedValueId: string | null
  readonly entityId: string | null
}

export type CreateResolutionEvidenceInput = Omit<ResolutionEvidence, 'candidateId'>

export interface CreateResolutionCandidateInput extends ResolutionCandidate {
  readonly evidence: readonly CreateResolutionEvidenceInput[]
}

export interface CompleteEntityResolutionInput {
  readonly documentId: string
  readonly jobId: string
  /** New Entities (with primary alias and ENTITY_CREATED event) inserted in the same transaction. */
  readonly entitiesToCreate?: readonly CreateEntityWithPrimaryAliasAndEventInput[]
  readonly protectedValues: readonly CreateProtectedValueInput[]
  /** Existing ProtectedValues whose missing restoration token is filled in atomically. */
  readonly protectedValueTokenBackfills?: readonly { readonly id: string; readonly publicToken: string }[]
  readonly entityProtectedValueLinks: readonly LinkEntityProtectedValueInput[]
  readonly mentionUpdates: readonly ResolutionMentionUpdate[]
  readonly candidates: readonly CreateResolutionCandidateInput[]
  readonly events: readonly CreateResolutionEventInput[]
  readonly finishedAt: number
}

export interface EntityResolutionResult {
  readonly document: Document
  readonly job: ProcessingJob
}

export interface AssignMentionInput {
  readonly mentionId: string
  readonly entityId: string
  /** Timestamp applied when open review candidates are closed by the assignment. */
  readonly resolvedAt: number
  readonly event: CreateResolutionEventInput
  readonly updatedAt?: never
}

export interface ConfirmMentionInput {
  readonly mentionId: string
  readonly event: CreateResolutionEventInput
}

/**
 * User-driven "new Entity for this Mention" use case persisted atomically:
 * the Entity identity aggregate, its creation event, and the Mention
 * assignment (with its own event) commit in one transaction, so a crash can
 * never leave an unassigned Entity behind.
 */
export interface CreateEntityWithAssignmentInput {
  readonly entity: CreateEntityInput
  readonly primaryAlias: CreateEntityAliasInput
  readonly creationEvent: CreateResolutionEventInput
  readonly mentionId: string
  /** Timestamp applied when open review candidates are closed by the assignment. */
  readonly resolvedAt: number
  readonly assignmentEvent: CreateResolutionEventInput
  /** Present only when the assignment is the result of an explicit split. */
  readonly splitEvent?: CreateResolutionEventInput
}

export interface CreatedEntityWithAssignment {
  readonly entity: Entity
  readonly primaryAlias: EntityAlias
  readonly mention: Mention
}

export interface AddEntityConstraintInput {
  readonly constraint: EntityConstraint
  readonly event: CreateResolutionEventInput
}

export interface RenameEntityInput {
  readonly entityId: string
  readonly alias: CreateEntityAliasInput
  readonly event: CreateResolutionEventInput
  readonly updatedAt: number
}

export interface RejectMentionInput {
  readonly mentionId: string
  readonly event: CreateResolutionEventInput
  readonly resolvedAt: number
}

export interface MergeEntitiesInput {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly event: CreateResolutionEventInput
  readonly updatedAt: number
}

export interface CreateManualMentionInput {
  readonly mention: Mention
  readonly textCipher: Buffer
  readonly fingerprint: Buffer
  readonly protectedValue?: CreateProtectedValueInput
  readonly protectedValueTokenBackfill?: { readonly id: string; readonly publicToken: string }
  readonly event: CreateResolutionEventInput
}

export interface ManualMentionBlockSource {
  readonly id: string
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly textCipher: Buffer
}

/** Owns the RESOLVE job state machine and all entity resolution persistence transactions. */
export class EntityResolutionRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findCompleted(documentId: string): EntityResolutionResult | undefined {
    const documentRow = this.db
      .select({ document: documents })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(and(eq(documents.id, documentId), ne(matters.status, 'DELETED')))
      .get()
    if (
      documentRow === undefined ||
      documentRow.document.parseStatus !== 'READY' ||
      documentRow.document.deletedAt !== null
    ) {
      return undefined
    }
    const jobRow = this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.documentId, documentId),
          eq(processingJobs.jobType, 'RESOLVE'),
          eq(processingJobs.status, 'COMPLETED')
        )
      )
      .orderBy(desc(processingJobs.finishedAt), desc(processingJobs.createdAt))
      .limit(1)
      .get()
    if (jobRow === undefined) throw new Error('Ready Document is missing its completed ProcessingJob')
    return { document: toDocument(documentRow.document), job: toProcessingJob(jobRow) }
  }

  begin(input: BeginEntityResolutionInput): BegunEntityResolution {
    if (input.jobId.trim().length === 0) throw new Error('jobId must not be empty')
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (current === undefined) throw new Error('Document was not found')
      if (current.deletedAt !== null || !matterIsAvailable(transaction, current.matterId)) {
        throw new Error('Document is not available for entity resolution')
      }
      if (input.startedAt < current.updatedAt) throw new Error('Entity resolution timestamp must not move backwards')
      if (current.parseStatus !== 'DETECTED' && current.parseStatus !== 'FAILED') {
        throw new Error('Document is not available for entity resolution')
      }
      if (current.pageCount === null) throw new Error('Document Model is incomplete')

      if (current.parseStatus === 'FAILED') {
        const latest = transaction
          .select()
          .from(processingJobs)
          .where(and(eq(processingJobs.documentId, input.documentId), eq(processingJobs.jobType, 'RESOLVE')))
          .orderBy(desc(processingJobs.createdAt))
          .limit(1)
          .get()
        if (latest?.status !== 'FAILED') throw new Error('Failed Document did not fail during entity resolution')
      }

      const pageCount = transaction
        .select({ id: documentPages.id })
        .from(documentPages)
        .where(eq(documentPages.documentId, input.documentId))
        .all().length
      if (pageCount !== current.pageCount) throw new Error('Document Model is incomplete')

      const job: ProcessingJob = {
        id: input.jobId,
        documentId: input.documentId,
        type: 'RESOLVE',
        status: 'RUNNING',
        progress: 0,
        createdAt: input.startedAt,
        startedAt: input.startedAt
      }
      assertProcessingJob(job)
      transaction
        .insert(processingJobs)
        .values({
          id: job.id,
          documentId: job.documentId,
          jobType: job.type,
          status: job.status,
          progress: job.progress,
          createdAt: job.createdAt,
          startedAt: job.startedAt
        })
        .run()
      const transition = transaction
        .update(documents)
        .set({ parseStatus: 'RESOLVING', updatedAt: input.startedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, current.parseStatus)))
        .run()
      if (transition.changes !== 1) throw new Error('Document state changed before entity resolution began')

      const mentionRows = transaction
        .select({ mention: mentions })
        .from(mentions)
        .innerJoin(documentPages, eq(documentPages.id, mentions.pageId))
        .innerJoin(documentBlocks, eq(documentBlocks.id, mentions.blockId))
        .where(eq(mentions.documentId, input.documentId))
        .orderBy(
          asc(documentPages.pageNo),
          asc(documentBlocks.readingOrder),
          asc(mentions.startOffset),
          asc(mentions.id)
        )
        .all()
      const blockRows = transaction
        .select({ id: documentBlocks.id, textCipher: documentBlocks.textCipher })
        .from(documentBlocks)
        .innerJoin(documentPages, eq(documentPages.id, documentBlocks.pageId))
        .where(eq(documentBlocks.documentId, input.documentId))
        .orderBy(asc(documentPages.pageNo), asc(documentBlocks.readingOrder), asc(documentBlocks.id))
        .all()
      const document = toDocument({ ...current, parseStatus: 'RESOLVING', updatedAt: input.startedAt })
      return {
        document,
        job,
        blocks: blockRows,
        mentions: mentionRows.map(({ mention }) => toResolutionMentionSource(mention))
      }
    })
  }

  updateProgress(jobId: string, completedMentions: number, totalMentions: number): ProcessingJob {
    if (!Number.isSafeInteger(completedMentions) || completedMentions < 0) {
      throw new Error('completedMentions must be non-negative')
    }
    if (!Number.isSafeInteger(totalMentions) || totalMentions < 1 || completedMentions > totalMentions) {
      throw new Error('totalMentions must be positive and no smaller than completedMentions')
    }
    const progress = completedMentions / totalMentions
    const result = this.db
      .update(processingJobs)
      .set({ progress, checkpoint: `${completedMentions}/${totalMentions}` })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'RESOLVE'), eq(processingJobs.status, 'RUNNING')))
      .run()
    if (result.changes !== 1) throw new Error('Entity resolution job is not running')
    return this.requireJob(jobId)
  }

  complete(input: CompleteEntityResolutionInput): EntityResolutionResult {
    for (const value of input.protectedValues) {
      assertProtectedValue(value)
      if (value.valueCipher.length === 0) throw new Error('valueCipher must not be empty')
      if (value.fingerprint.length === 0) throw new Error('fingerprint must not be empty')
    }
    const updateIds = new Set<string>()
    for (const update of input.mentionUpdates) {
      if (updateIds.has(update.id)) throw new Error('Mention update IDs must be unique')
      updateIds.add(update.id)
    }
    const candidateIds = new Set<string>()
    for (const candidate of input.candidates) {
      if (candidate.algorithmVersion.trim().length === 0) throw new Error('algorithmVersion must not be empty')
      if (candidateIds.has(candidate.id)) throw new Error('ResolutionCandidate IDs must be unique')
      candidateIds.add(candidate.id)
    }
    const entityIds = new Set<string>()
    for (const created of input.entitiesToCreate ?? []) {
      assertEntity(created.entity)
      assertEntityAlias(created.primaryAlias)
      assertSameMatter(created.entity, created.primaryAlias, 'entity and primary alias')
      if (created.entity.status !== 'ACTIVE') throw new Error('a newly created Entity must be active')
      if (
        created.primaryAlias.entityId !== created.entity.id ||
        created.primaryAlias.aliasType !== 'PRIMARY' ||
        !created.primaryAlias.isPrimary
      ) {
        throw new Error('primary alias must identify the newly created Entity')
      }
      if (
        created.event.type !== 'ENTITY_CREATED' ||
        created.event.entityId !== created.entity.id ||
        created.event.mentionId !== undefined
      ) {
        throw new Error('creation event must identify only the newly created Entity')
      }
      if (created.event.matterId !== created.entity.matterId) {
        throw new Error('creation event must belong to the Entity Matter')
      }
      if (entityIds.has(created.entity.id)) throw new Error('Entity IDs must be unique')
      entityIds.add(created.entity.id)
    }

    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'RESOLVING') {
        throw new Error('Document is not currently resolving entities')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== input.documentId ||
        jobRow.jobType !== 'RESOLVE' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Entity resolution job is not running')
      }
      if (input.finishedAt < documentRow.updatedAt || input.finishedAt < jobRow.startedAt) {
        throw new Error('Entity resolution timestamp must not move backwards')
      }

      // Verify Mention ownership before any write so a foreign reference aborts
      // cleanly, and derive the assignment transition from the stored state.
      const requiredEventByMentionId = new Map<string, { entityId: string; type: 'MENTION_ASSIGNED' | 'MENTION_REASSIGNED' }>()
      for (const update of input.mentionUpdates) {
        const mentionRow = transaction.select().from(mentions).where(eq(mentions.id, update.id)).get()
        if (mentionRow === undefined || mentionRow.documentId !== input.documentId) {
          throw new Error('Mention must belong to the resolved Document')
        }
        const previousEntityId = mentionRow.entityId
        if (update.entityId === null && previousEntityId !== null) {
          throw new Error('Resolution completion must not clear a Mention assignment')
        }
        if (update.entityId !== null && update.entityId !== previousEntityId) {
          requiredEventByMentionId.set(update.id, {
            entityId: update.entityId,
            type: previousEntityId === null ? 'MENTION_ASSIGNED' : 'MENTION_REASSIGNED'
          })
        }
      }

      // Verify candidate and event ownership before any write. New Entities are
      // inserted by this same transaction, so their ids are accepted by reference.
      const mentionRowsById = new Map<string, typeof mentions.$inferSelect>()
      const findMentionRow = (mentionId: string) => {
        const cached = mentionRowsById.get(mentionId)
        if (cached !== undefined) return cached
        const row = transaction.select().from(mentions).where(eq(mentions.id, mentionId)).get()
        if (row !== undefined) mentionRowsById.set(mentionId, row)
        return row
      }
      const createdEntityIds = new Set((input.entitiesToCreate ?? []).map((created) => created.entity.id))
      const assertEntityInDocumentMatter = (entityId: string, description: string) => {
        if (createdEntityIds.has(entityId)) return
        const entityRow = transaction
          .select({ matterId: entities.matterId })
          .from(entities)
          .where(eq(entities.id, entityId))
          .get()
        if (entityRow === undefined || entityRow.matterId !== documentRow.matterId) {
          throw new Error(`${description} must belong to the Document Matter`)
        }
      }
      for (const candidate of input.candidates) {
        const mentionRow = findMentionRow(candidate.mentionId)
        if (mentionRow === undefined || mentionRow.documentId !== input.documentId) {
          throw new Error('Candidate Mention must belong to the resolved Document')
        }
        assertEntityInDocumentMatter(candidate.candidateEntityId, 'Candidate Entity')
      }
      // Events must record the actual mutations: the transition derived from the
      // stored Mention state dictates the required event type, every assignment
      // event must match its Mention update, and every transitioning Mention must
      // have exactly one event. Completion events are always SYSTEM-recorded; user
      // transitions go through assignMention. No other event types may be smuggled in.
      const assignmentEventMentionIds = new Set<string>()
      for (const event of input.events) {
        if (event.matterId !== documentRow.matterId) {
          throw new Error('Resolution event must belong to the Document Matter')
        }
        if (event.type !== 'MENTION_ASSIGNED' && event.type !== 'MENTION_REASSIGNED') {
          throw new Error('Resolution completion only records Mention assignment events')
        }
        if (event.actor !== 'SYSTEM') {
          throw new Error('Resolution completion events must be recorded by the SYSTEM actor')
        }
        if (event.mentionId === undefined || event.entityId === undefined) {
          throw new Error('Assignment event must reference its Mention and Entity')
        }
        const mentionRow = findMentionRow(event.mentionId)
        if (mentionRow === undefined || mentionRow.documentId !== input.documentId) {
          throw new Error('Resolution event Mention must belong to the resolved Document')
        }
        assertEntityInDocumentMatter(event.entityId, 'Resolution event Entity')
        const required = requiredEventByMentionId.get(event.mentionId)
        if (required === undefined || required.entityId !== event.entityId || required.type !== event.type) {
          throw new Error('Assignment event must match the Mention update it records')
        }
        if (assignmentEventMentionIds.has(event.mentionId)) {
          throw new Error('A Mention assignment must have exactly one assignment event')
        }
        assignmentEventMentionIds.add(event.mentionId)
      }
      for (const mentionId of requiredEventByMentionId.keys()) {
        if (!assignmentEventMentionIds.has(mentionId)) {
          throw new Error('Every Mention assignment must be recorded by an assignment event')
        }
      }

      // Insert new Entities first so links and Mention updates can reference them.
      for (const created of input.entitiesToCreate ?? []) {
        if (created.entity.matterId !== documentRow.matterId) {
          throw new Error('Entity must remain inside the Document Matter')
        }
        transaction
          .insert(entities)
          .values({
            id: created.entity.id,
            matterId: created.entity.matterId,
            entityType: created.entity.type,
            publicToken: created.entity.publicToken,
            status: created.entity.status,
            ...(created.entity.resolutionConfidence === undefined
              ? {}
              : { resolutionConfidence: created.entity.resolutionConfidence }),
            createdAt: created.entity.createdAt,
            updatedAt: created.entity.updatedAt
          })
          .run()
        transaction.insert(entityAliases).values(created.primaryAlias).run()
        transaction.insert(resolutionEvents).values(toResolutionEventInsert(created.event)).run()
      }

      // Upsert ProtectedValues by (matterId, type, fingerprint) and map caller ids to persisted ids.
      const resolvedProtectedValueIds = new Map<string, string>()
      for (const value of input.protectedValues) {
        if (value.matterId !== documentRow.matterId) {
          throw new Error('ProtectedValue must remain inside the Document Matter')
        }
        const existing = transaction
          .select()
          .from(protectedValues)
          .where(
            and(
              eq(protectedValues.matterId, value.matterId),
              eq(protectedValues.valueType, value.type),
              eq(protectedValues.fingerprint, value.fingerprint)
            )
          )
          .get()
        if (existing === undefined) {
          transaction.insert(protectedValues).values(toProtectedValueInsert(value)).run()
          resolvedProtectedValueIds.set(value.id, value.id)
        } else {
          resolvedProtectedValueIds.set(value.id, existing.id)
        }
      }
      // Fill in a restoration token for values created before this feature. The
      // guarded update only fills rows that are still tokenless, so a concurrent
      // backfill never overwrites an existing token.
      for (const backfill of input.protectedValueTokenBackfills ?? []) {
        const result = transaction
          .update(protectedValues)
          .set({ publicToken: backfill.publicToken })
          .where(
            and(
              eq(protectedValues.id, backfill.id),
              eq(protectedValues.matterId, documentRow.matterId),
              isNull(protectedValues.publicToken)
            )
          )
          .run()
        if (result.changes !== 1) throw new Error('ProtectedValue restoration token backfill failed')
      }
      const resolveProtectedValueId = (id: string | null): string | null =>
        id === null ? null : (resolvedProtectedValueIds.get(id) ?? id)

      for (const link of input.entityProtectedValueLinks) {
        const protectedValueId = resolveProtectedValueId(link.protectedValueId)
        if (protectedValueId === null) throw new Error('Entity ProtectedValue link requires a ProtectedValue')
        const existingLink = transaction
          .select({ entityId: entityProtectedValues.entityId })
          .from(entityProtectedValues)
          .where(
            and(
              eq(entityProtectedValues.entityId, link.entityId),
              eq(entityProtectedValues.protectedValueId, protectedValueId)
            )
          )
          .get()
        if (existingLink !== undefined) continue
        const entityRow = transaction
          .select({ matterId: entities.matterId })
          .from(entities)
          .where(eq(entities.id, link.entityId))
          .get()
        if (entityRow === undefined || entityRow.matterId !== documentRow.matterId) {
          throw new Error('Entity was not found in the Document Matter')
        }
        const valueRow = transaction
          .select({ matterId: protectedValues.matterId })
          .from(protectedValues)
          .where(eq(protectedValues.id, protectedValueId))
          .get()
        if (valueRow === undefined || valueRow.matterId !== documentRow.matterId) {
          throw new Error('ProtectedValue was not found in the Document Matter')
        }
        transaction
          .insert(entityProtectedValues)
          .values({
            entityId: link.entityId,
            protectedValueId,
            relationshipType: link.relationshipType,
            confidence: link.confidence,
            isPrimary: link.isPrimary,
            createdAt: link.createdAt
          })
          .run()
      }

      for (const update of input.mentionUpdates) {
        const result = transaction
          .update(mentions)
          .set({
            fingerprint: update.fingerprint,
            protectedValueId: resolveProtectedValueId(update.protectedValueId),
            entityId: update.entityId
          })
          .where(eq(mentions.id, update.id))
          .run()
        if (result.changes !== 1) throw new Error('Mention state changed before entity resolution completed')
      }

      for (const candidate of input.candidates) {
        transaction
          .insert(resolutionCandidates)
          .values({
            id: candidate.id,
            mentionId: candidate.mentionId,
            candidateEntityId: candidate.candidateEntityId,
            score: candidate.score,
            state: candidate.state,
            algorithmVersion: candidate.algorithmVersion,
            createdAt: candidate.createdAt,
            ...(candidate.resolvedAt === undefined ? {} : { resolvedAt: candidate.resolvedAt })
          })
          .run()
        if (candidate.evidence.length > 0) {
          transaction
            .insert(resolutionEvidence)
            .values(candidate.evidence.map((evidence) => ({ ...evidence, candidateId: candidate.id })))
            .run()
        }
      }

      for (const event of input.events) {
        transaction.insert(resolutionEvents).values(toResolutionEventInsert(event)).run()
      }

      const jobResult = transaction
        .update(processingJobs)
        .set({ status: 'COMPLETED', progress: 1, checkpoint: null, finishedAt: input.finishedAt })
        .where(and(eq(processingJobs.id, input.jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      const documentResult = transaction
        .update(documents)
        .set({ parseStatus: 'READY', updatedAt: input.finishedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, 'RESOLVING')))
        .run()
      if (jobResult.changes !== 1 || documentResult.changes !== 1) {
        throw new Error('Entity resolution state changed before completion')
      }
      const completedDocument = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const completedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (completedDocument === undefined || completedJob === undefined) {
        throw new Error('Completed entity resolution state was not found')
      }
      return { document: toDocument(completedDocument), job: toProcessingJob(completedJob) }
    })
  }

  fail(documentId: string, jobId: string, errorCipher: Buffer, finishedAt: number): EntityResolutionResult {
    if (errorCipher.length === 0) throw new Error('errorCipher must not be empty')
    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'RESOLVING') {
        throw new Error('Document is not currently resolving entities')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== documentId ||
        jobRow.jobType !== 'RESOLVE' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Entity resolution job is not running')
      }
      if (finishedAt < documentRow.updatedAt || finishedAt < jobRow.startedAt) {
        throw new Error('Entity resolution timestamp must not move backwards')
      }
      transaction
        .update(processingJobs)
        .set({ status: 'FAILED', errorCipher, finishedAt })
        .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      transaction
        .update(documents)
        .set({ parseStatus: 'FAILED', updatedAt: finishedAt })
        .where(and(eq(documents.id, documentId), eq(documents.parseStatus, 'RESOLVING')))
        .run()
      const failedDocument = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const failedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (failedDocument === undefined || failedJob === undefined) {
        throw new Error('Failed entity resolution state was not found')
      }
      return { document: toDocument(failedDocument), job: toProcessingJob(failedJob) }
    })
  }

  assignMention(input: AssignMentionInput): Mention {
    return this.db.transaction((transaction) => {
      const mentionRow = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (mentionRow === undefined) throw new Error('Mention was not found')
      const entityRow = transaction.select().from(entities).where(eq(entities.id, input.entityId)).get()
      if (entityRow === undefined) throw new Error('Entity was not found')
      const documentRow = transaction
        .select({ parseStatus: documents.parseStatus, deletedAt: documents.deletedAt, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, mentionRow.documentId))
        .get()
      if (documentRow === undefined) throw new Error('Mention Document was not found')
      assertDocumentReviewMutable(documentRow)

      const mention = toMention(mentionRow)
      const assigned = assignMentionToEntity(mention, toEntity(entityRow))
      // A same-Entity assignment is a no-op, not a transition: recording a
      // MENTION_REASSIGNED event for it would fabricate audit history.
      if (mention.entityId === input.entityId) {
        throw new Error('Mention is already assigned to this Entity')
      }
      const expectedType = mention.entityId === undefined ? 'MENTION_ASSIGNED' : 'MENTION_REASSIGNED'
      if (input.event.type !== expectedType) {
        throw new Error('Resolution event type must match the Mention assignment transition')
      }
      // This entry point records user decisions only; SYSTEM assignments are
      // produced by resolution completion.
      if (input.event.actor !== 'USER') {
        throw new Error('Manual assignment events must be recorded by the USER actor')
      }
      // The audit event must bind to the actual mutation it records.
      if (input.event.mentionId !== input.mentionId) {
        throw new Error('Resolution event must reference the assigned Mention')
      }
      if (input.event.entityId !== input.entityId) {
        throw new Error('Resolution event must reference the assigned Entity')
      }
      if (input.event.matterId !== mentionRow.matterId) {
        throw new Error('Resolution event must belong to the Mention Matter')
      }

      // A new assignment restarts review: the confirmation state must always
      // bind to the current Entity, never to a superseded assignment.
      const result = transaction
        .update(mentions)
        .set({ entityId: assigned.entityId, reviewStatus: 'UNREVIEWED' })
        .where(eq(mentions.id, input.mentionId))
        .run()
      if (result.changes !== 1) throw new Error('Mention state changed before assignment')

      // Attach the Mention's ProtectedValue to the Entity so later fingerprint
      // lookups find the confirmed identity; the link is idempotent.
      if (mentionRow.protectedValueId !== null) {
        const existingLink = transaction
          .select({ entityId: entityProtectedValues.entityId })
          .from(entityProtectedValues)
          .where(
            and(
              eq(entityProtectedValues.entityId, input.entityId),
              eq(entityProtectedValues.protectedValueId, mentionRow.protectedValueId)
            )
          )
          .get()
        if (existingLink === undefined) {
          transaction
            .insert(entityProtectedValues)
            .values({
              entityId: input.entityId,
              protectedValueId: mentionRow.protectedValueId,
              relationshipType: 'OWNER',
              confidence: 1,
              isPrimary: true,
              createdAt: input.resolvedAt
            })
            .run()
        }
      }

      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()

      // A user decision closes every open review candidate for the Mention.
      transaction
        .update(resolutionCandidates)
        .set({ state: 'ACCEPTED', resolvedAt: input.resolvedAt })
        .where(
          and(
            eq(resolutionCandidates.mentionId, input.mentionId),
            eq(resolutionCandidates.candidateEntityId, input.entityId),
            eq(resolutionCandidates.state, 'PENDING')
          )
        )
        .run()
      transaction
        .update(resolutionCandidates)
        .set({ state: 'REJECTED', resolvedAt: input.resolvedAt })
        .where(
          and(
            eq(resolutionCandidates.mentionId, input.mentionId),
            ne(resolutionCandidates.candidateEntityId, input.entityId),
            eq(resolutionCandidates.state, 'PENDING')
          )
        )
        .run()

      const updated = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (updated === undefined) throw new Error('Assigned Mention was not found')
      return toMention(updated)
    })
  }

  /**
   * Records the USER confirmation of a Mention's current assignment. Confirming
   * the same assignment again is an idempotent no-op: the audit trail keeps
   * exactly one ENTITY_CONFIRMED event per confirmed assignment.
   */
  confirmMention(input: ConfirmMentionInput): Mention {
    if (input.event.type !== 'ENTITY_CONFIRMED') {
      throw new Error('Resolution event type must be ENTITY_CONFIRMED')
    }
    // This entry point records user decisions only; SYSTEM confirmations are
    // not part of the V1 workflow.
    if (input.event.actor !== 'USER') {
      throw new Error('Confirmation events must be recorded by the USER actor')
    }
    return this.db.transaction((transaction) => {
      const mentionRow = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (mentionRow === undefined) throw new Error('Mention was not found')
      const documentRow = transaction
        .select({ parseStatus: documents.parseStatus, deletedAt: documents.deletedAt, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, mentionRow.documentId))
        .get()
      if (documentRow === undefined) throw new Error('Mention Document was not found')
      assertDocumentReviewMutable(documentRow)

      const mention = toMention(mentionRow)
      const confirmed = confirmMentionAssignment(mention)
      // The audit event must bind to the actual assignment it confirms.
      if (input.event.mentionId !== input.mentionId) {
        throw new Error('Resolution event must reference the confirmed Mention')
      }
      if (input.event.entityId !== mention.entityId) {
        throw new Error('Resolution event must reference the confirmed Entity')
      }
      if (input.event.matterId !== mentionRow.matterId) {
        throw new Error('Resolution event must belong to the Mention Matter')
      }

      // Confirming an already-confirmed assignment is a no-op, not a
      // transition: recording another event would fabricate audit history.
      if (mention.reviewStatus === 'CONFIRMED') return mention

      const result = transaction
        .update(mentions)
        .set({ reviewStatus: confirmed.reviewStatus })
        .where(eq(mentions.id, input.mentionId))
        .run()
      if (result.changes !== 1) throw new Error('Mention state changed before confirmation')

      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()

      const updated = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (updated === undefined) throw new Error('Confirmed Mention was not found')
      return toMention(updated)
    })
  }

  /**
   * Persists a user-created Entity together with the Mention assignment that
   * motivated it, atomically. The mention-side mutation follows assignMention
   * exactly: ProtectedValue link, assignment event, candidate closure.
   */
  createEntityWithAssignment(input: CreateEntityWithAssignmentInput): CreatedEntityWithAssignment {
    const { entity, primaryAlias, creationEvent, assignmentEvent, splitEvent } = input
    assertEntity(entity)
    assertEntityAlias(primaryAlias)
    assertSameMatter(entity, primaryAlias, 'entity and primary alias')
    if (entity.status !== 'ACTIVE') throw new Error('a newly created Entity must be active')
    if (primaryAlias.entityId !== entity.id || primaryAlias.aliasType !== 'PRIMARY' || !primaryAlias.isPrimary) {
      throw new Error('primary alias must identify the newly created Entity')
    }
    if (creationEvent.type !== 'ENTITY_CREATED' || creationEvent.entityId !== entity.id) {
      throw new Error('creation event must identify the newly created Entity')
    }
    if (creationEvent.mentionId !== undefined) {
      throw new Error('creation event must not reference a Mention')
    }
    if (creationEvent.matterId !== entity.matterId) {
      throw new Error('creation event must belong to the Entity Matter')
    }
    // This entry point records user decisions only; SYSTEM entity creation is
    // produced by resolution completion.
    if (creationEvent.actor !== 'USER' || assignmentEvent.actor !== 'USER') {
      throw new Error('Manual creation and assignment events must be recorded by the USER actor')
    }
    if (assignmentEvent.entityId !== entity.id) {
      throw new Error('Resolution event must reference the assigned Entity')
    }
    if (assignmentEvent.mentionId !== input.mentionId) {
      throw new Error('Resolution event must reference the assigned Mention')
    }
    if (
      splitEvent !== undefined &&
      (splitEvent.type !== 'ENTITY_SPLIT' ||
        splitEvent.entityId !== entity.id ||
        splitEvent.mentionId !== input.mentionId ||
        splitEvent.matterId !== entity.matterId ||
        splitEvent.actor !== 'USER')
    ) {
      throw new Error('Split event must identify the new Entity and reassigned Mention')
    }

    return this.db.transaction((transaction) => {
      const mentionRow = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (mentionRow === undefined) throw new Error('Mention was not found')
      if (mentionRow.matterId !== entity.matterId) {
        throw new Error('Mention must belong to the Entity Matter')
      }
      if (assignmentEvent.matterId !== mentionRow.matterId) {
        throw new Error('Resolution event must belong to the Mention Matter')
      }
      const documentRow = transaction
        .select({ parseStatus: documents.parseStatus, deletedAt: documents.deletedAt, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, mentionRow.documentId))
        .get()
      if (documentRow === undefined) throw new Error('Mention Document was not found')
      assertDocumentReviewMutable(documentRow)
      const mention = toMention(mentionRow)
      const assigned = assignMentionToEntity(mention, entity)
      const expectedType = mention.entityId === undefined ? 'MENTION_ASSIGNED' : 'MENTION_REASSIGNED'
      if (assignmentEvent.type !== expectedType) {
        throw new Error('Resolution event type must match the Mention assignment transition')
      }

      transaction
        .insert(entities)
        .values({
          id: entity.id,
          matterId: entity.matterId,
          entityType: entity.type,
          publicToken: entity.publicToken,
          status: entity.status,
          ...(entity.resolutionConfidence === undefined
            ? {}
            : { resolutionConfidence: entity.resolutionConfidence }),
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt
        })
        .run()
      transaction.insert(entityAliases).values(primaryAlias).run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(creationEvent)).run()

      // A new assignment restarts review: the confirmation state must always
      // bind to the current Entity, never to a superseded assignment.
      const result = transaction
        .update(mentions)
        .set({ entityId: assigned.entityId, reviewStatus: 'UNREVIEWED' })
        .where(eq(mentions.id, input.mentionId))
        .run()
      if (result.changes !== 1) throw new Error('Mention state changed before assignment')

      // Attach the Mention's ProtectedValue to the Entity so later fingerprint
      // lookups find the confirmed identity; the link is idempotent.
      if (mentionRow.protectedValueId !== null) {
        const existingLink = transaction
          .select({ entityId: entityProtectedValues.entityId })
          .from(entityProtectedValues)
          .where(
            and(
              eq(entityProtectedValues.entityId, entity.id),
              eq(entityProtectedValues.protectedValueId, mentionRow.protectedValueId)
            )
          )
          .get()
        if (existingLink === undefined) {
          transaction
            .insert(entityProtectedValues)
            .values({
              entityId: entity.id,
              protectedValueId: mentionRow.protectedValueId,
              relationshipType: 'OWNER',
              confidence: 1,
              isPrimary: true,
              createdAt: input.resolvedAt
            })
            .run()
        }
      }

      transaction.insert(resolutionEvents).values(toResolutionEventInsert(assignmentEvent)).run()
      if (splitEvent !== undefined) {
        transaction.insert(resolutionEvents).values(toResolutionEventInsert(splitEvent)).run()
      }

      // A user decision closes every open review candidate for the Mention.
      transaction
        .update(resolutionCandidates)
        .set({ state: 'ACCEPTED', resolvedAt: input.resolvedAt })
        .where(
          and(
            eq(resolutionCandidates.mentionId, input.mentionId),
            eq(resolutionCandidates.candidateEntityId, entity.id),
            eq(resolutionCandidates.state, 'PENDING')
          )
        )
        .run()
      transaction
        .update(resolutionCandidates)
        .set({ state: 'REJECTED', resolvedAt: input.resolvedAt })
        .where(
          and(
            eq(resolutionCandidates.mentionId, input.mentionId),
            ne(resolutionCandidates.candidateEntityId, entity.id),
            eq(resolutionCandidates.state, 'PENDING')
          )
        )
        .run()

      const updated = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (updated === undefined) throw new Error('Assigned Mention was not found')
      return { entity, primaryAlias, mention: toMention(updated) }
    })
  }

  renameEntity(input: RenameEntityInput): EntityAlias {
    assertEntityAlias(input.alias)
    if (
      input.alias.entityId !== input.entityId ||
      input.alias.aliasType !== 'PRIMARY' ||
      !input.alias.isPrimary ||
      input.event.type !== 'ENTITY_RENAMED' ||
      input.event.entityId !== input.entityId ||
      input.event.mentionId !== undefined ||
      input.event.actor !== 'USER'
    ) {
      throw new Error('Rename input must identify the Entity and its new primary Alias')
    }
    return this.db.transaction((transaction) => {
      const entity = transaction.select().from(entities).where(eq(entities.id, input.entityId)).get()
      if (entity === undefined || entity.status !== 'ACTIVE' || entity.matterId !== input.alias.matterId) {
        throw new Error('Active Entity was not found in the Matter')
      }
      if (input.event.matterId !== entity.matterId) throw new Error('Rename event must belong to the Entity Matter')
      assertMatterReviewMutable(transaction, entity.matterId)
      const existingAlias = transaction
        .select()
        .from(entityAliases)
        .where(and(eq(entityAliases.matterId, entity.matterId), eq(entityAliases.alias, input.alias.alias)))
        .get()
      if (existingAlias !== undefined && existingAlias.entityId !== entity.id) {
        throw new Error('Alias already belongs to another Entity in the Matter')
      }
      transaction
        .update(entityAliases)
        .set({ isPrimary: false, aliasType: 'GENERIC' })
        .where(and(eq(entityAliases.entityId, entity.id), eq(entityAliases.isPrimary, true)))
        .run()
      if (existingAlias === undefined) transaction.insert(entityAliases).values(input.alias).run()
      else {
        transaction
          .update(entityAliases)
          .set({ isPrimary: true, aliasType: 'PRIMARY' })
          .where(eq(entityAliases.id, existingAlias.id))
          .run()
      }
      transaction.update(entities).set({ updatedAt: input.updatedAt }).where(eq(entities.id, entity.id)).run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()
      const renamed = transaction
        .select()
        .from(entityAliases)
        .where(and(eq(entityAliases.entityId, entity.id), eq(entityAliases.isPrimary, true)))
        .get()
      if (renamed === undefined) throw new Error('Renamed Entity primary Alias was not found')
      return toEntityAlias(renamed)
    })
  }

  rejectMention(input: RejectMentionInput): Mention {
    if (
      input.event.type !== 'MENTION_REJECTED' ||
      input.event.mentionId !== input.mentionId ||
      input.event.actor !== 'USER'
    ) {
      throw new Error('Reject event must identify the Mention')
    }
    return this.db.transaction((transaction) => {
      const row = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (row === undefined || input.event.matterId !== row.matterId) throw new Error('Mention was not found in the event Matter')
      const document = transaction
        .select({ parseStatus: documents.parseStatus, deletedAt: documents.deletedAt, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, row.documentId))
        .get()
      if (document === undefined) throw new Error('Mention Document was not found')
      assertDocumentReviewMutable(document)
      if (row.entityId !== null && row.protectedValueId !== null) {
        const otherEvidence = transaction
          .select({ id: mentions.id })
          .from(mentions)
          .where(
            and(
              eq(mentions.entityId, row.entityId),
              eq(mentions.protectedValueId, row.protectedValueId),
              ne(mentions.id, row.id),
              ne(mentions.reviewStatus, 'REJECTED')
            )
          )
          .get()
        if (otherEvidence === undefined) {
          transaction
            .delete(entityProtectedValues)
            .where(
              and(
                eq(entityProtectedValues.entityId, row.entityId),
                eq(entityProtectedValues.protectedValueId, row.protectedValueId)
              )
            )
            .run()
        }
      }
      transaction
        .update(mentions)
        .set({ entityId: null, reviewStatus: 'REJECTED' })
        .where(eq(mentions.id, input.mentionId))
        .run()
      transaction
        .update(resolutionCandidates)
        .set({ state: 'REJECTED', resolvedAt: input.resolvedAt })
        .where(and(eq(resolutionCandidates.mentionId, input.mentionId), eq(resolutionCandidates.state, 'PENDING')))
        .run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()
      const updated = transaction.select().from(mentions).where(eq(mentions.id, input.mentionId)).get()
      if (updated === undefined) throw new Error('Rejected Mention was not found')
      return toMention(updated)
    })
  }

  mergeEntities(input: MergeEntitiesInput): Entity {
    if (input.sourceEntityId === input.targetEntityId) throw new Error('Merged Entities must be distinct')
    if (
      input.event.type !== 'ENTITY_MERGED' ||
      input.event.entityId !== input.sourceEntityId ||
      input.event.mentionId !== undefined ||
      input.event.actor !== 'USER'
    ) {
      throw new Error('Merge event must identify the source Entity')
    }
    return this.db.transaction((transaction) => {
      const source = transaction.select().from(entities).where(eq(entities.id, input.sourceEntityId)).get()
      const target = transaction.select().from(entities).where(eq(entities.id, input.targetEntityId)).get()
      if (
        source === undefined || target === undefined || source.status !== 'ACTIVE' || target.status !== 'ACTIVE' ||
        source.matterId !== target.matterId || source.entityType !== target.entityType
      ) {
        throw new Error('Merge requires two active same-type Entities in one Matter')
      }
      if (input.event.matterId !== source.matterId) throw new Error('Merge event must belong to the Entity Matter')
      assertMatterReviewMutable(transaction, source.matterId)
      const prohibited = transaction
        .select({ id: entityConstraints.id })
        .from(entityConstraints)
        .where(
          and(
            eq(entityConstraints.constraintType, 'CANNOT_LINK'),
            eq(entityConstraints.entityAId, source.id < target.id ? source.id : target.id),
            eq(entityConstraints.entityBId, source.id < target.id ? target.id : source.id)
          )
        )
        .get()
      if (prohibited !== undefined) throw new Error('Cannot-Link constraint prohibits this merge')
      const affectedDocuments = transaction
        .select({ parseStatus: documents.parseStatus, deletedAt: documents.deletedAt, matterStatus: matters.status })
        .from(mentions)
        .innerJoin(documents, eq(documents.id, mentions.documentId))
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(mentions.entityId, source.id))
        .all()
      for (const document of affectedDocuments) assertDocumentReviewMutable(document)
      const sourceLinks = transaction
        .select()
        .from(entityProtectedValues)
        .where(eq(entityProtectedValues.entityId, source.id))
        .all()
      for (const link of sourceLinks) {
        transaction
          .insert(entityProtectedValues)
          .values({ ...link, entityId: target.id })
          .onConflictDoNothing()
          .run()
      }
      transaction.update(mentions).set({ entityId: target.id, reviewStatus: 'UNREVIEWED' }).where(eq(mentions.entityId, source.id)).run()
      // Pending proposals scored against the merged Entity must not dangle as
      // ghost candidates: redirect them to the canonical Entity, or close the
      // duplicate when the canonical Entity already has a candidate row for the
      // same Mention.
      const pendingForSource = transaction
        .select({ id: resolutionCandidates.id, mentionId: resolutionCandidates.mentionId })
        .from(resolutionCandidates)
        .where(and(eq(resolutionCandidates.candidateEntityId, source.id), eq(resolutionCandidates.state, 'PENDING')))
        .all()
      for (const candidate of pendingForSource) {
        const canonicalCandidate = transaction
          .select({ id: resolutionCandidates.id })
          .from(resolutionCandidates)
          .where(
            and(
              eq(resolutionCandidates.mentionId, candidate.mentionId),
              eq(resolutionCandidates.candidateEntityId, target.id)
            )
          )
          .get()
        if (canonicalCandidate === undefined) {
          transaction
            .update(resolutionCandidates)
            .set({ candidateEntityId: target.id })
            .where(eq(resolutionCandidates.id, candidate.id))
            .run()
        } else {
          transaction
            .update(resolutionCandidates)
            .set({ state: 'REJECTED', resolvedAt: input.updatedAt })
            .where(eq(resolutionCandidates.id, candidate.id))
            .run()
        }
      }
      // Hard Must-Link/Cannot-Link rules follow the identity: substitute the
      // merged Entity with the canonical one so its constraints keep binding.
      // The direct source-target pair becomes self-referential and is dropped,
      // duplicates collapse onto the existing rule, and an opposite-type rule
      // already on the canonical Entity aborts the merge instead of silently
      // weakening a hard rule. The opposite-type probe runs first: the pair
      // (target, X) may already hold both types, and deduplication must not
      // mask that contradiction because Cannot-Link overrides Must-Link at
      // scoring time.
      const sourceConstraintRows = transaction
        .select()
        .from(entityConstraints)
        .where(or(eq(entityConstraints.entityAId, source.id), eq(entityConstraints.entityBId, source.id)))
        .all()
      for (const constraint of sourceConstraintRows) {
        const otherId = constraint.entityAId === source.id ? constraint.entityBId : constraint.entityAId
        if (otherId === target.id) {
          transaction.delete(entityConstraints).where(eq(entityConstraints.id, constraint.id)).run()
          continue
        }
        const [entityAId, entityBId] = otherId < target.id ? [otherId, target.id] : [target.id, otherId]
        const oppositeType = constraint.constraintType === 'CANNOT_LINK' ? 'MUST_LINK' : 'CANNOT_LINK'
        const opposite = transaction
          .select({ id: entityConstraints.id })
          .from(entityConstraints)
          .where(
            and(
              eq(entityConstraints.matterId, constraint.matterId),
              eq(entityConstraints.entityAId, entityAId),
              eq(entityConstraints.entityBId, entityBId),
              eq(entityConstraints.constraintType, oppositeType)
            )
          )
          .get()
        if (opposite !== undefined) {
          throw new Error('Merge would create contradictory hard constraints on the canonical Entity')
        }
        const sameType = transaction
          .select({ id: entityConstraints.id })
          .from(entityConstraints)
          .where(
            and(
              eq(entityConstraints.matterId, constraint.matterId),
              eq(entityConstraints.entityAId, entityAId),
              eq(entityConstraints.entityBId, entityBId),
              eq(entityConstraints.constraintType, constraint.constraintType)
            )
          )
          .get()
        if (sameType !== undefined) {
          transaction.delete(entityConstraints).where(eq(entityConstraints.id, constraint.id)).run()
          continue
        }
        transaction
          .update(entityConstraints)
          .set({ entityAId, entityBId })
          .where(eq(entityConstraints.id, constraint.id))
          .run()
      }
      transaction
        .update(entities)
        .set({ status: 'MERGED', mergedIntoEntityId: target.id, updatedAt: input.updatedAt })
        .where(eq(entities.id, source.id))
        .run()
      transaction.update(entities).set({ updatedAt: input.updatedAt }).where(eq(entities.id, target.id)).run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()
      const merged = transaction.select().from(entities).where(eq(entities.id, source.id)).get()
      if (merged === undefined) throw new Error('Merged Entity was not found')
      return toEntity(merged)
    })
  }

  createManualMention(input: CreateManualMentionInput): Mention {
    assertMention(input.mention)
    if (input.textCipher.length === 0 || input.mention.detector !== 'USER' || input.mention.entityId !== undefined) {
      throw new Error('Manual Mention must be unassigned USER detection with encrypted text')
    }
    if (
      input.event.type !== 'MENTION_CREATED' ||
      input.event.mentionId !== input.mention.id ||
      input.event.entityId !== undefined ||
      input.event.matterId !== input.mention.matterId ||
      input.event.actor !== 'USER'
    ) {
      throw new Error('Manual Mention event must identify the created Mention')
    }
    return this.db.transaction((transaction) => {
      const block = transaction.select().from(documentBlocks).where(eq(documentBlocks.id, input.mention.blockId)).get()
      const document = transaction
        .select({ document: documents, matterStatus: matters.status })
        .from(documents)
        .innerJoin(matters, eq(matters.id, documents.matterId))
        .where(eq(documents.id, input.mention.documentId))
        .get()
      if (
        block === undefined || document === undefined || block.documentId !== document.document.id ||
        block.pageId !== input.mention.pageId || document.document.matterId !== input.mention.matterId
      ) {
        throw new Error('Manual Mention scope does not match its Document Block')
      }
      assertDocumentReviewMutable({
        parseStatus: document.document.parseStatus,
        deletedAt: document.document.deletedAt,
        matterStatus: document.matterStatus
      })
      const overlapping = transaction
        .select({ startOffset: mentions.startOffset, endOffset: mentions.endOffset })
        .from(mentions)
        // A rejected false positive must not block re-marking the correct span
        // inside its range, so it leaves the overlap set.
        .where(and(eq(mentions.blockId, input.mention.blockId), ne(mentions.reviewStatus, 'REJECTED')))
        .all()
        .some((existing) =>
          existing.startOffset < input.mention.endOffset && existing.endOffset > input.mention.startOffset
        )
      if (overlapping) throw new Error('Manual Mention must not overlap an existing Mention')
      if (input.protectedValue !== undefined) transaction.insert(protectedValues).values(toProtectedValueInsert(input.protectedValue)).run()
      if (input.protectedValueTokenBackfill !== undefined) {
        const backfill = transaction
          .update(protectedValues)
          .set({ publicToken: input.protectedValueTokenBackfill.publicToken })
          .where(and(eq(protectedValues.id, input.protectedValueTokenBackfill.id), isNull(protectedValues.publicToken)))
          .run()
        if (backfill.changes !== 1) throw new Error('Manual Mention ProtectedValue token could not be backfilled')
      }
      transaction
        .insert(mentions)
        .values(toMentionInsert({ ...input.mention, textCipher: input.textCipher, fingerprint: input.fingerprint }))
        .run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()
      const created = transaction.select().from(mentions).where(eq(mentions.id, input.mention.id)).get()
      if (created === undefined) throw new Error('Created manual Mention was not found')
      return toMention(created)
    })
  }

  addConstraint(input: AddEntityConstraintInput): EntityConstraint {
    const constraint = canonicalizeEntityConstraint(input.constraint)
    if (input.event.type !== 'CONSTRAINT_CREATED') {
      throw new Error('Resolution event type must be CONSTRAINT_CREATED')
    }
    // The audit event must bind to the actual constraint it records.
    if (input.event.matterId !== constraint.matterId) {
      throw new Error('Resolution event must belong to the constraint Matter')
    }
    if (input.event.entityId === undefined) {
      throw new Error('Resolution event must reference a constrained Entity')
    }
    if (input.event.entityId !== constraint.entityAId && input.event.entityId !== constraint.entityBId) {
      throw new Error('Resolution event must reference a constrained Entity')
    }
    const expectedActor = constraint.source === 'USER' ? 'USER' : 'SYSTEM'
    if (input.event.actor !== expectedActor) {
      throw new Error('Resolution event actor must match the constraint source')
    }
    return this.db.transaction((transaction) => {
      // The scope trigger backstops this, but verify precisely: both Entities
      // must exist, belong to the constraint Matter, and be active.
      for (const entityId of [constraint.entityAId, constraint.entityBId]) {
        const entityRow = transaction
          .select({ matterId: entities.matterId, status: entities.status })
          .from(entities)
          .where(eq(entities.id, entityId))
          .get()
        if (entityRow === undefined || entityRow.matterId !== constraint.matterId) {
          throw new Error('Constrained Entities must belong to the constraint Matter')
        }
        if (entityRow.status !== 'ACTIVE') {
          throw new Error('Constrained Entities must be active')
        }
      }
      assertMatterReviewMutable(transaction, constraint.matterId)
      transaction
        .insert(entityConstraints)
        .values({
          id: constraint.id,
          matterId: constraint.matterId,
          entityAId: constraint.entityAId,
          entityBId: constraint.entityBId,
          constraintType: constraint.type,
          reason: constraint.reason,
          source: constraint.source,
          createdAt: constraint.createdAt
        })
        .run()
      transaction.insert(resolutionEvents).values(toResolutionEventInsert(input.event)).run()
      return constraint
    })
  }

  findConstraints(matterId: string): readonly EntityConstraint[] {
    return this.db
      .select()
      .from(entityConstraints)
      .where(eq(entityConstraints.matterId, matterId))
      .orderBy(asc(entityConstraints.createdAt), asc(entityConstraints.id))
      .all()
      .map(toEntityConstraint)
  }

  findMentionById(mentionId: string): ResolutionMentionSource | undefined {
    const row = this.db.select().from(mentions).where(eq(mentions.id, mentionId)).get()
    return row === undefined ? undefined : toResolutionMentionSource(row)
  }

  findManualMentionBlock(blockId: string): ManualMentionBlockSource | undefined {
    return this.db
      .select({
        id: documentBlocks.id,
        matterId: documents.matterId,
        documentId: documentBlocks.documentId,
        pageId: documentBlocks.pageId,
        textCipher: documentBlocks.textCipher
      })
      .from(documentBlocks)
      .innerJoin(documents, eq(documents.id, documentBlocks.documentId))
      .where(eq(documentBlocks.id, blockId))
      .get()
  }

  private requireJob(id: string): ProcessingJob {
    const row = this.db.select().from(processingJobs).where(eq(processingJobs.id, id)).get()
    if (row === undefined) throw new Error('ProcessingJob was not found')
    return toProcessingJob(row)
  }
}

export type SanitizationMentionSource = Mention & {
  readonly entityPrimaryAlias: string | null
  readonly entityStatus: EntityStatus | null
  readonly protectedValuePublicToken: string | null
}

export type SanitizationBlockSource = DocumentBlock & {
  readonly matterId: string
  readonly textCipher: Buffer
  readonly mentions: readonly SanitizationMentionSource[]
}

export interface BeginSanitizationInput {
  readonly documentId: string
  readonly jobId: string
  readonly startedAt: number
}

export interface BegunSanitization {
  readonly document: Document
  readonly job: ProcessingJob
  readonly blocks: readonly SanitizationBlockSource[]
}

export type CreateSanitizedBlockInput = SanitizedBlock & {
  readonly textCipher: Buffer
}

export interface CompleteSanitizationInput {
  readonly documentId: string
  readonly jobId: string
  readonly sanitizedDocument: SanitizedDocument
  readonly blocks: readonly CreateSanitizedBlockInput[]
  readonly mappings: readonly SanitizationMapping[]
  readonly finishedAt: number
}

export interface SanitizationResult {
  readonly document: Document
  readonly job: ProcessingJob
  readonly sanitizedDocument: SanitizedDocument
}

export type RehydrationMappingSource = SanitizationMapping & {
  readonly protectedValueId: string
  readonly valueCipher: Buffer
}

export type SanitizedBlockWithCipher = SanitizedBlock & {
  readonly textCipher: Buffer
}

type SanitizedDocumentRow = typeof sanitizedDocuments.$inferSelect
type SanitizedBlockRow = typeof sanitizedBlocks.$inferSelect
type SanitizationMappingRow = typeof sanitizationMappings.$inferSelect

function toSanitizedDocument(row: SanitizedDocumentRow): SanitizedDocument {
  const sanitizedDocument: SanitizedDocument = {
    id: row.id,
    matterId: row.matterId,
    documentId: row.documentId,
    jobId: row.jobId,
    createdAt: row.createdAt
  }
  assertSanitizedDocument(sanitizedDocument)
  return sanitizedDocument
}

function toSanitizedBlockWithCipher(row: SanitizedBlockRow): SanitizedBlockWithCipher {
  const block: SanitizedBlockWithCipher = {
    id: row.id,
    sanitizedDocumentId: row.sanitizedDocumentId,
    documentId: row.documentId,
    pageId: row.pageId,
    blockId: row.blockId,
    textCipher: row.textCipher,
    createdAt: row.createdAt
  }
  assertSanitizedBlock(block)
  return block
}

function toSanitizationMapping(row: SanitizationMappingRow): SanitizationMapping {
  const mapping: SanitizationMapping = {
    id: row.id,
    matterId: row.matterId,
    sanitizedDocumentId: row.sanitizedDocumentId,
    mentionId: row.mentionId,
    ...(row.entityId === null ? {} : { entityId: row.entityId }),
    publicToken: row.publicToken,
    alias: row.alias,
    restorePolicy: row.restorePolicy,
    createdAt: row.createdAt
  }
  assertSanitizationMapping(mapping)
  return mapping
}

/** Owns the SANITIZE job state machine and all sanitized artifact persistence transactions. */
export class SanitizationRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findCompleted(documentId: string): SanitizationResult | undefined {
    const documentRow = this.db
      .select({ document: documents })
      .from(documents)
      .innerJoin(matters, eq(matters.id, documents.matterId))
      .where(and(eq(documents.id, documentId), ne(matters.status, 'DELETED')))
      .get()
    if (
      documentRow === undefined ||
      documentRow.document.parseStatus !== 'SANITIZED' ||
      documentRow.document.deletedAt !== null
    ) {
      return undefined
    }
    const jobRow = this.db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.documentId, documentId),
          eq(processingJobs.jobType, 'SANITIZE'),
          eq(processingJobs.status, 'COMPLETED')
        )
      )
      .orderBy(desc(processingJobs.finishedAt), desc(processingJobs.createdAt))
      .limit(1)
      .get()
    if (jobRow === undefined) throw new Error('Sanitized Document is missing its completed ProcessingJob')
    const sanitizedRow = this.db
      .select()
      .from(sanitizedDocuments)
      .where(eq(sanitizedDocuments.documentId, documentId))
      .get()
    if (sanitizedRow === undefined) throw new Error('Sanitized Document is missing its sanitized artifact')
    return {
      document: toDocument(documentRow.document),
      job: toProcessingJob(jobRow),
      sanitizedDocument: toSanitizedDocument(sanitizedRow)
    }
  }

  begin(input: BeginSanitizationInput): BegunSanitization {
    if (input.jobId.trim().length === 0) throw new Error('jobId must not be empty')
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (current === undefined) throw new Error('Document was not found')
      if (current.deletedAt !== null || !matterIsAvailable(transaction, current.matterId)) {
        throw new Error('Document is not available for sanitization')
      }
      if (input.startedAt < current.updatedAt) throw new Error('Sanitization timestamp must not move backwards')
      if (current.parseStatus !== 'READY' && current.parseStatus !== 'FAILED') {
        throw new Error('Document is not available for sanitization')
      }
      if (current.pageCount === null) throw new Error('Document Model is incomplete')

      if (current.parseStatus === 'FAILED') {
        const latest = transaction
          .select()
          .from(processingJobs)
          .where(and(eq(processingJobs.documentId, input.documentId), eq(processingJobs.jobType, 'SANITIZE')))
          .orderBy(desc(processingJobs.createdAt))
          .limit(1)
          .get()
        if (latest?.status !== 'FAILED') throw new Error('Failed Document did not fail during sanitization')
      }

      const pageCount = transaction
        .select({ id: documentPages.id })
        .from(documentPages)
        .where(eq(documentPages.documentId, input.documentId))
        .all().length
      if (pageCount !== current.pageCount) throw new Error('Document Model is incomplete')
      const existingArtifact = transaction
        .select({ id: sanitizedDocuments.id })
        .from(sanitizedDocuments)
        .where(eq(sanitizedDocuments.documentId, input.documentId))
        .limit(1)
        .get()
      if (existingArtifact !== undefined) throw new Error('Document already has a sanitized artifact')

      const job: ProcessingJob = {
        id: input.jobId,
        documentId: input.documentId,
        type: 'SANITIZE',
        status: 'RUNNING',
        progress: 0,
        createdAt: input.startedAt,
        startedAt: input.startedAt
      }
      assertProcessingJob(job)
      transaction
        .insert(processingJobs)
        .values({
          id: job.id,
          documentId: job.documentId,
          jobType: job.type,
          status: job.status,
          progress: job.progress,
          createdAt: job.createdAt,
          startedAt: job.startedAt
        })
        .run()
      const transition = transaction
        .update(documents)
        .set({ parseStatus: 'SANITIZING', updatedAt: input.startedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, current.parseStatus)))
        .run()
      if (transition.changes !== 1) throw new Error('Document state changed before sanitization began')

      const pageRows = transaction
        .select()
        .from(documentPages)
        .where(eq(documentPages.documentId, input.documentId))
        .orderBy(asc(documentPages.pageNo), asc(documentPages.id))
        .all()
      const blockRows = pageRows.flatMap((page) =>
        transaction
          .select()
          .from(documentBlocks)
          .where(and(eq(documentBlocks.documentId, input.documentId), eq(documentBlocks.pageId, page.id)))
          .orderBy(asc(documentBlocks.readingOrder), asc(documentBlocks.id))
          .all()
      )
      const blocks = blockRows.map((blockRow) => {
        const mentionRows = transaction
          .select({
            mention: mentions,
            entityStatus: entities.status,
            entityPrimaryAlias: entityAliases.alias,
            protectedValuePublicToken: protectedValues.publicToken
          })
          .from(mentions)
          .leftJoin(entities, eq(entities.id, mentions.entityId))
          .leftJoin(
            entityAliases,
            and(eq(entityAliases.entityId, mentions.entityId), eq(entityAliases.isPrimary, true))
          )
          .leftJoin(protectedValues, eq(protectedValues.id, mentions.protectedValueId))
          .where(and(eq(mentions.blockId, blockRow.id), ne(mentions.reviewStatus, 'REJECTED')))
          .orderBy(asc(mentions.startOffset), asc(mentions.id))
          .all()
        const block: SanitizationBlockSource = {
          id: blockRow.id,
          matterId: current.matterId,
          documentId: blockRow.documentId,
          pageId: blockRow.pageId,
          blockType: blockRow.blockType,
          textCipher: blockRow.textCipher,
          source: blockRow.source,
          ...(blockRow.confidence === null ? {} : { confidence: blockRow.confidence }),
          bbox: { x: blockRow.x, y: blockRow.y, width: blockRow.width, height: blockRow.height },
          readingOrder: blockRow.readingOrder,
          mentions: mentionRows.map(({ mention, entityStatus, entityPrimaryAlias, protectedValuePublicToken }) => ({
            ...toMention(mention),
            entityPrimaryAlias,
            entityStatus,
            protectedValuePublicToken
          }))
        }
        assertDocumentBlock(block)
        return block
      })
      const document = toDocument({ ...current, parseStatus: 'SANITIZING', updatedAt: input.startedAt })
      return { document, job, blocks }
    })
  }

  updateProgress(jobId: string, completedBlocks: number, totalBlocks: number): ProcessingJob {
    if (!Number.isSafeInteger(completedBlocks) || completedBlocks < 0) throw new Error('completedBlocks must be non-negative')
    if (!Number.isSafeInteger(totalBlocks) || totalBlocks < 1 || completedBlocks > totalBlocks) {
      throw new Error('totalBlocks must be positive and no smaller than completedBlocks')
    }
    const progress = completedBlocks / totalBlocks
    const result = this.db
      .update(processingJobs)
      .set({ progress, checkpoint: `${completedBlocks}/${totalBlocks}` })
      .where(and(eq(processingJobs.id, jobId), eq(processingJobs.jobType, 'SANITIZE'), eq(processingJobs.status, 'RUNNING')))
      .run()
    if (result.changes !== 1) throw new Error('Sanitization job is not running')
    return this.requireJob(jobId)
  }

  complete(input: CompleteSanitizationInput): SanitizationResult {
    assertSanitizedDocument(input.sanitizedDocument)
    const blockIds = new Set<string>()
    for (const block of input.blocks) {
      assertSanitizedBlock(block)
      if (block.sanitizedDocumentId !== input.sanitizedDocument.id) {
        throw new Error('Sanitized block must belong to the sanitized Document')
      }
      if (block.documentId !== input.documentId) throw new Error('Sanitized block must belong to the sanitized Document')
      if (block.textCipher.length === 0) throw new Error('textCipher must not be empty')
      if (blockIds.has(block.id)) throw new Error('Sanitized block IDs must be unique')
      blockIds.add(block.id)
    }
    const mappingIds = new Set<string>()
    for (const mapping of input.mappings) {
      assertSanitizationMapping(mapping)
      if (mapping.sanitizedDocumentId !== input.sanitizedDocument.id) {
        throw new Error('Sanitization mapping must belong to the sanitized Document')
      }
      if (mappingIds.has(mapping.id)) throw new Error('Sanitization mapping IDs must be unique')
      mappingIds.add(mapping.id)
    }

    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'SANITIZING') {
        throw new Error('Document is not currently sanitizing')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== input.documentId ||
        jobRow.jobType !== 'SANITIZE' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Sanitization job is not running')
      }
      if (input.finishedAt < documentRow.updatedAt || input.finishedAt < jobRow.startedAt) {
        throw new Error('Sanitization timestamp must not move backwards')
      }
      if (input.sanitizedDocument.documentId !== input.documentId) {
        throw new Error('Sanitized Document must belong to the sanitized Document')
      }
      if (input.sanitizedDocument.matterId !== documentRow.matterId) {
        throw new Error('Sanitized Document must remain inside the Document Matter')
      }
      if (input.sanitizedDocument.jobId !== input.jobId) {
        throw new Error('Sanitized Document must reference the running sanitization job')
      }

      // Completeness: the artifact must cover every source Block exactly once.
      const sourceBlocks = transaction
        .select({ id: documentBlocks.id })
        .from(documentBlocks)
        .where(eq(documentBlocks.documentId, input.documentId))
        .all()
      const submittedBlockIds = new Set(input.blocks.map((block) => block.blockId))
      if (submittedBlockIds.size !== input.blocks.length) throw new Error('Sanitized block IDs must be unique')
      if (sourceBlocks.length !== input.blocks.length || sourceBlocks.some((block) => !submittedBlockIds.has(block.id))) {
        throw new Error('Sanitization must produce exactly one SanitizedBlock per source Block')
      }

      // Completeness and consistency: every source Mention must map exactly once.
      // Entity-backed mappings agree with the active assignment and primary
      // Alias; Entity-less mappings preserve value-level restoration without
      // manufacturing an identity owner.
      const sourceMentions = transaction
        .select({
          id: mentions.id,
          entityId: mentions.entityId,
          entityStatus: entities.status,
          entityPrimaryAlias: entityAliases.alias,
          protectedValuePublicToken: protectedValues.publicToken
        })
        .from(mentions)
        .leftJoin(entities, eq(entities.id, mentions.entityId))
        .leftJoin(
          entityAliases,
          and(eq(entityAliases.entityId, mentions.entityId), eq(entityAliases.isPrimary, true))
        )
        .leftJoin(protectedValues, eq(protectedValues.id, mentions.protectedValueId))
        .where(and(eq(mentions.documentId, input.documentId), ne(mentions.reviewStatus, 'REJECTED')))
        .all()
      const mappingByMentionId = new Map<string, SanitizationMapping>()
      for (const mapping of input.mappings) {
        if (mapping.matterId !== documentRow.matterId) {
          throw new Error('Sanitization mapping must remain inside the Document Matter')
        }
        if (mappingByMentionId.has(mapping.mentionId)) {
          throw new Error('Sanitization mapping Mention must be unique')
        }
        mappingByMentionId.set(mapping.mentionId, mapping)
      }
      if (sourceMentions.length !== input.mappings.length) {
        throw new Error('Sanitization must produce exactly one mapping per source Mention')
      }
      for (const mention of sourceMentions) {
        const mapping = mappingByMentionId.get(mention.id)
        if (mapping === undefined) throw new Error('Sanitization mapping must cover every source Mention')
        if ((mapping.entityId ?? null) !== mention.entityId) {
          throw new Error('Sanitization mapping Entity must match the Mention assignment')
        }
        if (mention.entityId === null) {
          if (mention.entityStatus !== null || mention.entityPrimaryAlias !== null) {
            throw new Error('Entity-less sanitization mapping must not reference Entity metadata')
          }
        } else {
          if (mention.entityStatus !== 'ACTIVE') throw new Error('Sanitization mapping Entity must be active')
          if (mapping.alias !== mention.entityPrimaryAlias) {
            throw new Error('Sanitization mapping Alias must match the Entity primary alias')
          }
        }
        if (mapping.publicToken !== mention.protectedValuePublicToken) {
          throw new Error('Sanitization mapping token must match the ProtectedValue restoration token')
        }
      }

      transaction.insert(sanitizedDocuments).values(input.sanitizedDocument).run()
      if (input.blocks.length > 0) {
        transaction
          .insert(sanitizedBlocks)
          .values(
            input.blocks.map((block) => ({
              id: block.id,
              sanitizedDocumentId: block.sanitizedDocumentId,
              documentId: block.documentId,
              pageId: block.pageId,
              blockId: block.blockId,
              textCipher: block.textCipher,
              createdAt: block.createdAt
            }))
          )
          .run()
      }
      if (input.mappings.length > 0) {
        transaction
          .insert(sanitizationMappings)
          .values(input.mappings.map((mapping) => ({ ...mapping, entityId: mapping.entityId ?? null })))
          .run()
      }
      const jobResult = transaction
        .update(processingJobs)
        .set({ status: 'COMPLETED', progress: 1, checkpoint: null, finishedAt: input.finishedAt })
        .where(and(eq(processingJobs.id, input.jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      const documentResult = transaction
        .update(documents)
        .set({ parseStatus: 'SANITIZED', updatedAt: input.finishedAt })
        .where(and(eq(documents.id, input.documentId), eq(documents.parseStatus, 'SANITIZING')))
        .run()
      if (jobResult.changes !== 1 || documentResult.changes !== 1) {
        throw new Error('Sanitization state changed before completion')
      }
      const completedDocument = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      const completedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, input.jobId)).get()
      if (completedDocument === undefined || completedJob === undefined) {
        throw new Error('Completed sanitization state was not found')
      }
      return {
        document: toDocument(completedDocument),
        job: toProcessingJob(completedJob),
        sanitizedDocument: input.sanitizedDocument
      }
    })
  }

  fail(documentId: string, jobId: string, errorCipher: Buffer, finishedAt: number): { document: Document; job: ProcessingJob } {
    if (errorCipher.length === 0) throw new Error('errorCipher must not be empty')
    return this.db.transaction((transaction) => {
      const documentRow = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const jobRow = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (documentRow === undefined || documentRow.parseStatus !== 'SANITIZING') {
        throw new Error('Document is not currently sanitizing')
      }
      if (
        jobRow === undefined ||
        jobRow.documentId !== documentId ||
        jobRow.jobType !== 'SANITIZE' ||
        jobRow.status !== 'RUNNING' ||
        jobRow.startedAt === null
      ) {
        throw new Error('Sanitization job is not running')
      }
      if (finishedAt < documentRow.updatedAt || finishedAt < jobRow.startedAt) {
        throw new Error('Sanitization timestamp must not move backwards')
      }
      transaction
        .update(processingJobs)
        .set({ status: 'FAILED', errorCipher, finishedAt })
        .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, 'RUNNING')))
        .run()
      transaction
        .update(documents)
        .set({ parseStatus: 'FAILED', updatedAt: finishedAt })
        .where(and(eq(documents.id, documentId), eq(documents.parseStatus, 'SANITIZING')))
        .run()
      const failedDocument = transaction.select().from(documents).where(eq(documents.id, documentId)).get()
      const failedJob = transaction.select().from(processingJobs).where(eq(processingJobs.id, jobId)).get()
      if (failedDocument === undefined || failedJob === undefined) {
        throw new Error('Failed sanitization state was not found')
      }
      return { document: toDocument(failedDocument), job: toProcessingJob(failedJob) }
    })
  }

  findSanitizedBlocks(sanitizedDocumentId: string): readonly SanitizedBlockWithCipher[] {
    return this.db
      .select({ block: sanitizedBlocks })
      .from(sanitizedBlocks)
      .innerJoin(documentBlocks, eq(documentBlocks.id, sanitizedBlocks.blockId))
      .where(eq(sanitizedBlocks.sanitizedDocumentId, sanitizedDocumentId))
      .orderBy(asc(documentBlocks.readingOrder), asc(sanitizedBlocks.id))
      .all()
      .map(({ block }) => toSanitizedBlockWithCipher(block))
  }

  findRehydrationMappings(sanitizedDocumentId: string): readonly RehydrationMappingSource[] {
    return this.db
      .select({
        mapping: sanitizationMappings,
        mentionEntityId: mentions.entityId,
        protectedValueId: protectedValues.id,
        protectedValuePublicToken: protectedValues.publicToken,
        valueCipher: protectedValues.valueCipher
      })
      .from(sanitizationMappings)
      .innerJoin(mentions, eq(mentions.id, sanitizationMappings.mentionId))
      .innerJoin(protectedValues, eq(protectedValues.id, mentions.protectedValueId))
      .where(eq(sanitizationMappings.sanitizedDocumentId, sanitizedDocumentId))
      .orderBy(asc(mentions.startOffset), asc(sanitizationMappings.id))
      .all()
      .map(({ mapping, mentionEntityId, protectedValueId, protectedValuePublicToken, valueCipher }) => {
        if (mentionEntityId !== (mapping.entityId ?? null) || protectedValuePublicToken !== mapping.publicToken) {
          throw new Error('Sanitization mapping no longer matches its immutable Mention assignment')
        }
        return {
          ...toSanitizationMapping(mapping),
          protectedValueId,
          valueCipher
        }
      })
  }

  findEntityAliases(matterId: string, entityId: string): readonly string[] {
    return this.db
      .select({ alias: entityAliases.alias })
      .from(entityAliases)
      .where(and(eq(entityAliases.matterId, matterId), eq(entityAliases.entityId, entityId)))
      .orderBy(asc(entityAliases.createdAt), asc(entityAliases.id))
      .all()
      .map(({ alias }) => alias)
  }

  private requireJob(id: string): ProcessingJob {
    const row = this.db.select().from(processingJobs).where(eq(processingJobs.id, id)).get()
    if (row === undefined) throw new Error('ProcessingJob was not found')
    return toProcessingJob(row)
  }
}

/** Encrypted Matter-wide ProtectedValue row feeding the outbound leak denylist. */
export interface MatterProtectedValueCipher {
  readonly id: string
  readonly valueType: ProtectedValueType
  readonly valueCipher: Buffer
}

export interface AiExecutionSource {
  readonly sanitizedDocument: SanitizedDocument
  readonly blocks: readonly SanitizedBlockWithCipher[]
  readonly mappings: readonly RehydrationMappingSource[]
  /**
   * Every ProtectedValue in the Matter, not only this artifact's mappings. The
   * outbound scan denies all of them so a detection miss in this document cannot
   * leak a value already known from another document in the same Matter.
   */
  readonly matterDenylist: readonly MatterProtectedValueCipher[]
  /** Complete set of local row identifiers that must never cross the provider boundary. */
  readonly internalIdentifiers: readonly string[]
}

export interface CreateAiExecutionInput {
  readonly execution: AiExecution
  readonly requestCipher: Buffer
}

export type AiExecutionRecord = AiExecution & {
  readonly requestCipher: Buffer
  readonly responseCipher?: Buffer
  readonly errorCipher?: Buffer
}

type AiExecutionRow = typeof aiExecutions.$inferSelect

function toAiExecutionRecord(row: AiExecutionRow): AiExecutionRecord {
  const execution: AiExecution = {
    id: row.id,
    matterId: row.matterId,
    sanitizedDocumentId: row.sanitizedDocumentId,
    providerId: row.providerId,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt })
  }
  assertAiExecution(execution)
  return {
    ...execution,
    requestCipher: row.requestCipher,
    ...(row.responseCipher === null ? {} : { responseCipher: row.responseCipher }),
    ...(row.errorCipher === null ? {} : { errorCipher: row.errorCipher })
  }
}

/** Owns encrypted AI request/response persistence and its one-way execution lifecycle. */
export class AiExecutionRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findSource(sanitizedDocumentId: string): AiExecutionSource | undefined {
    const source = this.db
      .select({
        sanitizedDocument: sanitizedDocuments,
        documentStatus: documents.parseStatus,
        documentDeletedAt: documents.deletedAt,
        matterStatus: matters.status
      })
      .from(sanitizedDocuments)
      .innerJoin(documents, eq(documents.id, sanitizedDocuments.documentId))
      .innerJoin(matters, eq(matters.id, sanitizedDocuments.matterId))
      .where(eq(sanitizedDocuments.id, sanitizedDocumentId))
      .get()
    if (
      source === undefined ||
      source.documentStatus !== 'SANITIZED' ||
      source.documentDeletedAt !== null ||
      source.matterStatus === 'DELETED'
    ) {
      return undefined
    }

    const sanitizedDocument = toSanitizedDocument(source.sanitizedDocument)
    const blocks = this.db
      .select({ block: sanitizedBlocks })
      .from(sanitizedBlocks)
      .innerJoin(documentBlocks, eq(documentBlocks.id, sanitizedBlocks.blockId))
      .innerJoin(documentPages, eq(documentPages.id, sanitizedBlocks.pageId))
      .where(eq(sanitizedBlocks.sanitizedDocumentId, sanitizedDocumentId))
      .orderBy(asc(documentPages.pageNo), asc(documentBlocks.readingOrder), asc(sanitizedBlocks.id))
      .all()
      .map(({ block }) => toSanitizedBlockWithCipher(block))
    const mappings = this.db
      .select({
        mapping: sanitizationMappings,
        mentionEntityId: mentions.entityId,
        protectedValueId: protectedValues.id,
        protectedValuePublicToken: protectedValues.publicToken,
        valueCipher: protectedValues.valueCipher
      })
      .from(sanitizationMappings)
      .innerJoin(mentions, eq(mentions.id, sanitizationMappings.mentionId))
      .innerJoin(protectedValues, eq(protectedValues.id, mentions.protectedValueId))
      .where(eq(sanitizationMappings.sanitizedDocumentId, sanitizedDocumentId))
      .orderBy(asc(mentions.startOffset), asc(sanitizationMappings.id))
      .all()
      .map(({ mapping, mentionEntityId, protectedValueId, protectedValuePublicToken, valueCipher }) => {
        if (mentionEntityId !== (mapping.entityId ?? null) || protectedValuePublicToken !== mapping.publicToken) {
          throw new Error('Sanitization mapping no longer matches its immutable Mention assignment')
        }
        return {
          ...toSanitizationMapping(mapping),
          protectedValueId,
          valueCipher
        }
      })

    // One row past the application denylist cap (MAX_OUTBOUND_DENIED_VALUES
    // in packages/application/src/ai-execution.ts) so an abnormal Matter is
    // detectable without paying an unbounded read.
    const matterDenylist = this.db
      .selectDistinct({ id: protectedValues.id, valueType: protectedValues.valueType, valueCipher: protectedValues.valueCipher })
      .from(protectedValues)
      .leftJoin(mentions, eq(mentions.protectedValueId, protectedValues.id))
      .leftJoin(entityProtectedValues, eq(entityProtectedValues.protectedValueId, protectedValues.id))
      .where(
        and(
          eq(protectedValues.matterId, sanitizedDocument.matterId),
          or(isNull(mentions.id), ne(mentions.reviewStatus, 'REJECTED'), isNotNull(entityProtectedValues.entityId))
        )
      )
      .limit(2049)
      .all()

    const internalIdentifiers = new Set<string>([
      sanitizedDocument.id,
      sanitizedDocument.matterId,
      sanitizedDocument.documentId,
      sanitizedDocument.jobId
    ])
    for (const block of blocks) {
      internalIdentifiers.add(block.id)
      internalIdentifiers.add(block.sanitizedDocumentId)
      internalIdentifiers.add(block.documentId)
      internalIdentifiers.add(block.pageId)
      internalIdentifiers.add(block.blockId)
    }
    for (const mapping of mappings) {
      internalIdentifiers.add(mapping.id)
      internalIdentifiers.add(mapping.matterId)
      internalIdentifiers.add(mapping.sanitizedDocumentId)
      internalIdentifiers.add(mapping.mentionId)
      if (mapping.entityId !== undefined) internalIdentifiers.add(mapping.entityId)
      internalIdentifiers.add(mapping.protectedValueId)
    }
    return { sanitizedDocument, blocks, mappings, matterDenylist, internalIdentifiers: [...internalIdentifiers] }
  }

  begin(input: CreateAiExecutionInput): AiExecutionRecord {
    assertAiExecution(input.execution)
    if (input.execution.status !== 'RUNNING') throw new Error('AI execution must begin in RUNNING state')
    if (input.requestCipher.length === 0) throw new Error('AI execution requestCipher must not be empty')
    return this.db.transaction((transaction) => {
      const source = transaction
        .select({
          matterId: sanitizedDocuments.matterId,
          documentStatus: documents.parseStatus,
          documentDeletedAt: documents.deletedAt,
          matterStatus: matters.status
        })
        .from(sanitizedDocuments)
        .innerJoin(documents, eq(documents.id, sanitizedDocuments.documentId))
        .innerJoin(matters, eq(matters.id, sanitizedDocuments.matterId))
        .where(eq(sanitizedDocuments.id, input.execution.sanitizedDocumentId))
        .get()
      if (
        source === undefined ||
        source.matterId !== input.execution.matterId ||
        source.documentStatus !== 'SANITIZED' ||
        source.documentDeletedAt !== null ||
        source.matterStatus === 'DELETED'
      ) {
        throw new Error('AI execution source is not an available Sanitized Document in the same Matter')
      }
      transaction
        .insert(aiExecutions)
        .values({
          id: input.execution.id,
          matterId: input.execution.matterId,
          sanitizedDocumentId: input.execution.sanitizedDocumentId,
          providerId: input.execution.providerId,
          status: input.execution.status,
          requestCipher: input.requestCipher,
          createdAt: input.execution.createdAt,
          startedAt: input.execution.startedAt
        })
        .run()
      const inserted = transaction.select().from(aiExecutions).where(eq(aiExecutions.id, input.execution.id)).get()
      if (inserted === undefined) throw new Error('AI execution was not found after insert')
      return toAiExecutionRecord(inserted)
    })
  }

  complete(executionId: string, responseCipher: Buffer, finishedAt: number): AiExecutionRecord {
    if (responseCipher.length === 0) throw new Error('AI execution responseCipher must not be empty')
    return this.finish(executionId, 'COMPLETED', finishedAt, responseCipher)
  }

  fail(executionId: string, errorCipher: Buffer, finishedAt: number): AiExecutionRecord {
    if (errorCipher.length === 0) throw new Error('AI execution errorCipher must not be empty')
    return this.finish(executionId, 'FAILED', finishedAt, errorCipher)
  }

  findById(executionId: string): AiExecutionRecord | undefined {
    const row = this.db.select().from(aiExecutions).where(eq(aiExecutions.id, executionId)).get()
    return row === undefined ? undefined : toAiExecutionRecord(row)
  }

  findLatest(sanitizedDocumentId: string): AiExecutionRecord | undefined {
    const row = this.db
      .select()
      .from(aiExecutions)
      .where(eq(aiExecutions.sanitizedDocumentId, sanitizedDocumentId))
      .orderBy(desc(aiExecutions.createdAt), desc(aiExecutions.id))
      .limit(1)
      .get()
    return row === undefined ? undefined : toAiExecutionRecord(row)
  }

  private finish(
    executionId: string,
    status: 'COMPLETED' | 'FAILED',
    finishedAt: number,
    cipher: Buffer
  ): AiExecutionRecord {
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(aiExecutions).where(eq(aiExecutions.id, executionId)).get()
      if (current === undefined || current.status !== 'RUNNING') throw new Error('AI execution is not running')
      if (!Number.isSafeInteger(finishedAt) || finishedAt < current.startedAt) {
        throw new Error('AI execution finishedAt must not precede startedAt')
      }
      const result = transaction
        .update(aiExecutions)
        .set(
          status === 'COMPLETED'
            ? { status, responseCipher: cipher, finishedAt }
            : { status, errorCipher: cipher, finishedAt }
        )
        .where(and(eq(aiExecutions.id, executionId), eq(aiExecutions.status, 'RUNNING')))
        .run()
      if (result.changes !== 1) throw new Error('AI execution state changed before completion')
      const completed = transaction.select().from(aiExecutions).where(eq(aiExecutions.id, executionId)).get()
      if (completed === undefined) throw new Error('AI execution was not found after completion')
      return toAiExecutionRecord(completed)
    })
  }
}

export interface InterruptedWork {
  readonly processingJobs: readonly { readonly id: string; readonly startedAt: number }[]
  readonly aiExecutions: readonly { readonly id: string; readonly startedAt: number }[]
  readonly documents: readonly { readonly id: string; readonly updatedAt: number }[]
}

export interface RecoverInterruptedWorkInput {
  readonly finishedAt: number
  readonly processingJobs: readonly { readonly id: string; readonly errorCipher: Buffer }[]
  readonly aiExecutions: readonly { readonly id: string; readonly errorCipher: Buffer }[]
}

/** Atomically turns crash-left RUNNING work into retryable FAILED state. */
export class StartupRecoveryRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  findInterrupted(): InterruptedWork {
    const processing = this.db
      .select({ id: processingJobs.id, startedAt: processingJobs.startedAt })
      .from(processingJobs)
      .where(eq(processingJobs.status, 'RUNNING'))
      .all()
      .map((row) => {
        if (row.startedAt === null) throw new Error('Running ProcessingJob is missing startedAt')
        return { id: row.id, startedAt: row.startedAt }
      })
    const ai = this.db
      .select({ id: aiExecutions.id, startedAt: aiExecutions.startedAt })
      .from(aiExecutions)
      .where(eq(aiExecutions.status, 'RUNNING'))
      .all()
    const interruptedDocuments = this.db
      .select({ id: documents.id, updatedAt: documents.updatedAt })
      .from(documents)
      .where(inArray(documents.parseStatus, ['PARSING', 'DETECTING', 'RESOLVING', 'SANITIZING']))
      .all()
    return { processingJobs: processing, aiExecutions: ai, documents: interruptedDocuments }
  }

  recover(input: RecoverInterruptedWorkInput): { readonly processingJobs: number; readonly aiExecutions: number; readonly documents: number } {
    if (!Number.isSafeInteger(input.finishedAt) || input.finishedAt < 0) {
      throw new Error('Recovery finishedAt must be a non-negative safe integer')
    }
    assertUniqueRecoveryCiphers(input.processingJobs, 'ProcessingJob')
    assertUniqueRecoveryCiphers(input.aiExecutions, 'AI execution')
    return this.db.transaction((transaction) => {
      const runningJobs = transaction
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(eq(processingJobs.status, 'RUNNING'))
        .all()
      const runningAi = transaction
        .select({ id: aiExecutions.id })
        .from(aiExecutions)
        .where(eq(aiExecutions.status, 'RUNNING'))
        .all()
      if (!sameIds(runningJobs, input.processingJobs) || !sameIds(runningAi, input.aiExecutions)) {
        throw new Error('Interrupted work changed before recovery')
      }

      for (const job of input.processingJobs) {
        const result = transaction
          .update(processingJobs)
          .set({ status: 'FAILED', errorCipher: job.errorCipher, finishedAt: input.finishedAt })
          .where(and(eq(processingJobs.id, job.id), eq(processingJobs.status, 'RUNNING')))
          .run()
        if (result.changes !== 1) throw new Error('Interrupted ProcessingJob could not be recovered')
      }
      for (const execution of input.aiExecutions) {
        const result = transaction
          .update(aiExecutions)
          .set({ status: 'FAILED', errorCipher: execution.errorCipher, finishedAt: input.finishedAt })
          .where(and(eq(aiExecutions.id, execution.id), eq(aiExecutions.status, 'RUNNING')))
          .run()
        if (result.changes !== 1) throw new Error('Interrupted AI execution could not be recovered')
      }

      const interruptedDocuments = transaction
        .select({ id: documents.id, parseStatus: documents.parseStatus })
        .from(documents)
        .where(inArray(documents.parseStatus, ['PARSING', 'DETECTING', 'RESOLVING', 'SANITIZING']))
        .all()
      for (const document of interruptedDocuments) {
        const result = transaction
          .update(documents)
          .set({
            parseStatus: 'FAILED',
            updatedAt: input.finishedAt,
            ...(document.parseStatus === 'PARSING' ? { pageCount: null } : {})
          })
          .where(eq(documents.id, document.id))
          .run()
        if (result.changes !== 1) throw new Error('Interrupted Document could not be recovered')
      }
      return {
        processingJobs: input.processingJobs.length,
        aiExecutions: input.aiExecutions.length,
        documents: interruptedDocuments.length
      }
    })
  }
}

function assertUniqueRecoveryCiphers(rows: readonly { readonly id: string; readonly errorCipher: Buffer }[], label: string): void {
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`${label} recovery IDs must be unique`)
    if (row.errorCipher.length === 0) throw new Error(`${label} recovery errorCipher must not be empty`)
    ids.add(row.id)
  }
}

function sameIds(
  current: readonly { readonly id: string }[],
  submitted: readonly { readonly id: string }[]
): boolean {
  if (current.length !== submitted.length) return false
  const submittedIds = new Set(submitted.map((row) => row.id))
  return current.every((row) => submittedIds.has(row.id))
}
