import { and, eq, inArray } from 'drizzle-orm'
import type {
  Document,
  DocumentBlock,
  DocumentPage,
  Entity,
  EntityAlias,
  Matter,
  ResolutionEvent
} from '@aliasai/domain'
import {
  assertDocument,
  assertDocumentBlock,
  assertDocumentPage,
  assertEntity,
  assertEntityAlias,
  assertSameMatter
} from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import { documentBlocks, documentPages, documents, entities, entityAliases, matters, resolutionEvents } from './schema'

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

type DocumentRow = typeof documents.$inferSelect

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
