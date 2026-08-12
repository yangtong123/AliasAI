import { and, eq } from 'drizzle-orm'
import type { Document, Entity, EntityAlias, Matter, ResolutionEvent } from '@aliasai/domain'
import { assertDocument, assertEntity, assertEntityAlias, assertSameMatter } from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import { documents, entities, entityAliases, matters, resolutionEvents } from './schema'

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
    if (row === undefined) return undefined

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
