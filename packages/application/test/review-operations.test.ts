import { beforeEach, describe, expect, it } from 'vitest'
import { encrypt } from '@aliasai/crypto'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  EntityResolutionService,
  EntityService,
  MatterService,
  ReviewOperationService,
  ReviewQueryService,
  documentBlockTextContext,
  documentOriginalNameContext,
  mentionTextContext,
  type ApplicationKeys
} from '../src/index'

describe('ReviewOperationService', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const searchKey = Buffer.alloc(32, 7)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let operations: ReviewOperationService
  let resolution: EntityResolutionService

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    const reviewQuery = new ReviewQueryService(
      new ReviewQueryRepository(db),
      new DocumentRepository(db),
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    resolution = new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys
    )
    operations = new ReviewOperationService(resolution, new EntityService(new EntityRepository(db), keys), reviewQuery)
    seedDocumentWithReviewableMention()
  })

  it('assigns a pending mention to an entity and refreshes the view', () => {
    const refreshed = operations.assignToEntity('mention-1', 'entity-1')

    expect(refreshed.decisionStatus).toBe('USER_ASSIGNED')
    expect(refreshed.assignedEntity).toMatchObject({ id: 'entity-1', primaryAlias: 'Holder One' })
    expect(refreshed.candidates.map((candidate) => candidate.state)).toEqual(['ACCEPTED'])
    const actors = sqlite
      .prepare("SELECT actor FROM resolution_events WHERE event_type = 'MENTION_ASSIGNED' AND mention_id = 'mention-1'")
      .all() as Array<{ actor: string }>
    expect(actors).toEqual([{ actor: 'USER' }])
  })

  it('rejects assignment to an unknown entity with a safe error', () => {
    expect(() => operations.assignToEntity('mention-1', 'missing-entity')).toThrow(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
  })

  it('confirms an assigned mention idempotently and rejects an unassigned one', () => {
    expect(() => operations.confirmMention('mention-1')).toThrow(
      expect.objectContaining({ code: 'MENTION_UNASSIGNED' })
    )

    operations.assignToEntity('mention-1', 'entity-1')
    const confirmed = operations.confirmMention('mention-1')

    expect(confirmed.assignedEntity!.id).toBe('entity-1')
    // Confirming again neither throws nor writes another event.
    operations.confirmMention('mention-1')
    const events = sqlite
      .prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE mention_id = 'mention-1'")
      .all() as Array<{ count: number }>
    expect(events[0]!.count).toBe(1)
  })

  it('creates a new entity with a USER creation event and assigns the mention', () => {
    const result = operations.createEntityAndAssign('mention-1', { primaryAlias: 'Reviewer Choice', entityType: 'PERSON' })

    expect(result.entity.primaryAlias).toBe('Reviewer Choice')
    expect(result.mention.decisionStatus).toBe('USER_ASSIGNED')
    expect(result.mention.assignedEntity!.id).toBe(result.entity.id)
    const events = sqlite
      .prepare("SELECT event_type, actor FROM resolution_events WHERE entity_id = ? ORDER BY created_at")
      .all(result.entity.id) as Array<{ event_type: string; actor: string }>
    expect(events).toEqual([
      { event_type: 'ENTITY_CREATED', actor: 'USER' },
      { event_type: 'MENTION_ASSIGNED', actor: 'USER' }
    ])
  })

  it('fails safely when the mention does not exist', () => {
    expect(() => operations.assignToEntity('missing', 'entity-1')).toThrow(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
    expect(() => operations.confirmMention('missing')).toThrow(
      expect.objectContaining({ code: 'MENTION_NOT_FOUND' })
    )
    expect(() =>
      operations.createEntityAndAssign('missing', { primaryAlias: 'Alias', entityType: 'PERSON' })
    ).toThrow(expect.objectContaining({ code: 'MENTION_NOT_FOUND' }))
  })

  it('records a Cannot-Link constraint with its audit event', () => {
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 1, 1)`
      )
      .run()

    const constraint = operations.markConstraint('matter-1', 'entity-1', 'entity-2', 'CANNOT_LINK', 'Different people')

    expect(constraint).toMatchObject({ type: 'CANNOT_LINK', reason: 'Different people' })
    // The stored pair is canonicalized to sorted order.
    expect([constraint.entityAId, constraint.entityBId]).toEqual(['entity-1', 'entity-2'])
    const events = sqlite
      .prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE event_type = 'CONSTRAINT_CREATED'")
      .all() as Array<{ count: number }>
    expect(events[0]!.count).toBe(1)
  })

  /** A DETECTED document with one EMAIL mention holding a PENDING candidate for entity-1. */
  function seedDocumentWithReviewableMention(): void {
    new MatterService(new MatterRepository(db), { persistenceKey }).create('Synthetic Matter')
    sqlite.prepare("UPDATE matters SET id = 'matter-1' WHERE rowid = 1").run()
    const documents = new DocumentRepository(db)
    documents.create({
      id: 'document-1',
      matterId: 'matter-1',
      originalNameCipher: encrypt(Buffer.from('synthetic.pdf'), persistenceKey, documentOriginalNameContext('document-1')),
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 2,
      updatedAt: 2
    })
    documents.markProcessing('document-1', 'SYNTHETIC', 3)
    documents.completeProcessing({
      documentId: 'document-1',
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: 'page-1',
          documentId: 'document-1',
          pageNo: 1,
          originalWidth: 100,
          originalHeight: 100,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: 4
        }
      ],
      blocks: [
        {
          id: 'block-1',
          documentId: 'document-1',
          pageId: 'page-1',
          blockType: 'TEXT',
          textCipher: encrypt(Buffer.from('Reach synthetic@example.test.'), persistenceKey, documentBlockTextContext('block-1')),
          source: 'NATIVE',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          readingOrder: 0,
          createdAt: 4
        }
      ],
      updatedAt: 5
    })
    const detection = new PrivacyDetectionRepository(db)
    detection.begin({ documentId: 'document-1', jobId: 'job-detect', startedAt: 6 })
    detection.complete({
      documentId: 'document-1',
      jobId: 'job-detect',
      mentions: [
        {
          id: 'mention-1',
          matterId: 'matter-1',
          documentId: 'document-1',
          pageId: 'page-1',
          blockId: 'block-1',
          type: 'EMAIL',
          strength: 'EXPLICIT',
          textCipher: encrypt(Buffer.from('synthetic@example.test'), persistenceKey, mentionTextContext('mention-1')),
          startOffset: 6,
          endOffset: 27,
          detector: 'REGEX',
          confidence: 0.95,
          reviewStatus: 'UNREVIEWED',
          createdAt: 7
        }
      ],
      finishedAt: 8
    })
    new EntityRepository(db).createWithPrimaryAliasAndEvent({
      entity: {
        id: 'entity-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-1',
        status: 'ACTIVE',
        createdAt: 9,
        updatedAt: 9
      },
      primaryAlias: {
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Holder One',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 9
      },
      event: {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-1',
        actor: 'SYSTEM',
        payloadCipher: encrypt(Buffer.from('{}'), persistenceKey, Buffer.from('event-1:resolutionEvent.payload')),
        createdAt: 9
      }
    })
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at)
         VALUES ('candidate-1', 'mention-1', 'entity-1', 90, 'PENDING', 'er-v1', 10)`
      )
      .run()
    sqlite.prepare("UPDATE documents SET parse_status = 'READY', updated_at = 11 WHERE id = 'document-1'").run()
  }
})
