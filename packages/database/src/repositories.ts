import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type {
  Document,
  DocumentBlock,
  DocumentPage,
  Entity,
  EntityAlias,
  Matter,
  Mention,
  ProcessingJob,
  ResolutionEvent
} from '@aliasai/domain'
import {
  assertDocument,
  assertDocumentBlock,
  assertDocumentPage,
  assertEntity,
  assertEntityAlias,
  assertMention,
  assertProcessingJob,
  assertSameMatter
} from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import {
  documentBlocks,
  documentPages,
  documents,
  entities,
  entityAliases,
  matters,
  mentions,
  processingJobs,
  resolutionEvents
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

  findByMatterAndFileHash(matterId: string, fileHash: string): Document | undefined {
    const row = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.matterId, matterId), eq(documents.fileHash, fileHash)))
      .get()
    return row === undefined ? undefined : toDocument(row)
  }

  findById(id: string): Document | undefined {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get()
    return row === undefined ? undefined : toDocument(row)
  }

  findProcessingSource(id: string): DocumentProcessingSource | undefined {
    const row = this.db.select().from(documents).where(eq(documents.id, id)).get()
    if (row === undefined) return undefined
    return {
      document: toDocument(row),
      ...(row.sourcePathCipher === null ? {} : { sourcePathCipher: row.sourcePathCipher })
    }
  }

  markProcessing(documentId: string, parserType: string, updatedAt: number): Document {
    if (parserType.trim().length === 0) throw new Error('parserType must not be empty')
    const current = this.findById(documentId)
    if (current === undefined) throw new Error('Document was not found')
    if (updatedAt < current.updatedAt) throw new Error('Document processing timestamp must not move backwards')
    if (
      current.parseStatus === 'FAILED' &&
      this.db.select({ id: documentPages.id }).from(documentPages).where(eq(documentPages.documentId, documentId)).limit(1).get() !==
        undefined
    ) {
      throw new Error('A failed downstream stage cannot be retried as document parsing')
    }

    const result = this.db
      .update(documents)
      .set({ parseStatus: 'PARSING', parserType, pageCount: null, updatedAt })
      .where(
        and(
          eq(documents.id, documentId),
          inArray(documents.parseStatus, ['IMPORTED', 'FAILED'])
        )
      )
      .run()
    if (result.changes !== 1) throw new Error('Document is not available for processing')
    return this.requireById(documentId)
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
    const documentRow = this.db.select().from(documents).where(eq(documents.id, documentId)).get()
    if (documentRow === undefined || documentRow.parseStatus !== 'DETECTED') return undefined
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
      document: toDocument(documentRow),
      job: toProcessingJob(jobRow),
      mentions: this.findMentions(documentId)
    }
  }

  begin(input: BeginPrivacyDetectionInput): BegunPrivacyDetection {
    if (input.jobId.trim().length === 0) throw new Error('jobId must not be empty')
    return this.db.transaction((transaction) => {
      const current = transaction.select().from(documents).where(eq(documents.id, input.documentId)).get()
      if (current === undefined) throw new Error('Document was not found')
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
    updatedAt: row.updatedAt
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

function toMention(row: MentionRow): Mention {
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

function toProcessingJob(row: ProcessingJobRow): ProcessingJob {
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
    const eventRow = {
      id: event.id,
      matterId: event.matterId,
      eventType: event.type,
      entityId: event.entityId,
      actor: event.actor,
      payloadCipher: event.payloadCipher,
      createdAt: event.createdAt
    }

    return this.db.transaction((transaction) => {
      transaction.insert(entities).values(entityRow).run()
      transaction.insert(entityAliases).values(primaryAlias).run()
      transaction.insert(resolutionEvents).values(eventRow).run()
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
    this.db.insert(resolutionEvents).values({
      id: event.id,
      matterId: event.matterId,
      eventType: event.type,
      ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
      ...(event.mentionId === undefined ? {} : { mentionId: event.mentionId }),
      actor: event.actor,
      payloadCipher: event.payloadCipher,
      createdAt: event.createdAt
    }).run()
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

  findByPublicToken(matterId: string, publicToken: string): Entity | undefined {
    const row = this.db
      .select()
      .from(entities)
      .where(and(eq(entities.matterId, matterId), eq(entities.publicToken, publicToken)))
      .get()
    if (row === undefined) return undefined
    return {
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
  }
}
