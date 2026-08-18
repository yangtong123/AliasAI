import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  createDatabase,
  migrateDatabase,
  type AliasAiDatabase,
  type CompleteEntityResolutionInput,
  type CreateEntityWithAssignmentInput,
  type SqliteClient
} from '../src/index'
import type { Entity } from '@aliasai/domain'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('Entity Resolution repositories', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let protectedValues: ProtectedValueRepository
  let resolution: EntityResolutionRepository
  let entities: EntityRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    protectedValues = new ProtectedValueRepository(db)
    resolution = new EntityResolutionRepository(db)
    entities = new EntityRepository(db)
    new MatterRepository(db).create({
      id: 'matter-1',
      nameCipher: cipher('matter-name'),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
  })

  afterEach(() => sqlite.close())

  function insertMatter(id: string): void {
    new MatterRepository(db).create({
      id,
      nameCipher: cipher(`matter-name-${id}`),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
  }

  function insertEntity(id: string, matterId = 'matter-1', publicToken = `@P-${id}`): Entity {
    const entity: Entity = {
      id,
      matterId,
      type: 'PERSON',
      publicToken,
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    }
    entities.create(entity)
    return entity
  }

  /** Runs a Document through parsing and privacy detection so it reaches DETECTED with one Mention. */
  function seedDetectedDocument(documentId: string, mentionFingerprint?: Buffer): string {
    const documents = new DocumentRepository(db)
    documents.create({
      id: documentId,
      matterId: 'matter-1',
      originalNameCipher: cipher(`original-name-${documentId}`),
      fileHash: `hash-${documentId}`,
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
    documents.markProcessing(documentId, 'SYNTHETIC', 2)
    documents.completeProcessing({
      documentId,
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [{
        id: `page-${documentId}`,
        documentId,
        pageNo: 1,
        originalWidth: 1,
        originalHeight: 1,
        rotation: 0,
        sourceType: 'NATIVE',
        createdAt: 3
      }],
      blocks: [{
        id: `block-${documentId}`,
        documentId,
        pageId: `page-${documentId}`,
        blockType: 'TEXT',
        textCipher: cipher(`block-${documentId}`),
        source: 'NATIVE',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        readingOrder: 0,
        createdAt: 3
      }],
      updatedAt: 4
    })
    const detection = new PrivacyDetectionRepository(db)
    const mentionId = `mention-${documentId}`
    detection.begin({ documentId, jobId: `detect-${documentId}`, startedAt: 5 })
    detection.complete({
      documentId,
      jobId: `detect-${documentId}`,
      mentions: [{
        id: mentionId,
        matterId: 'matter-1',
        documentId,
        pageId: `page-${documentId}`,
        blockId: `block-${documentId}`,
        type: 'PERSON',
        strength: 'EXPLICIT',
        textCipher: cipher(`mention-${documentId}`),
        ...(mentionFingerprint === undefined ? {} : { fingerprint: mentionFingerprint }),
        startOffset: 0,
        endOffset: 5,
        detector: 'NER',
        confidence: 0.9,
        reviewStatus: 'UNREVIEWED',
        createdAt: 6
      }],
      finishedAt: 7
    })
    return mentionId
  }

  function emptyResolution(documentId: string, jobId: string, finishedAt: number): CompleteEntityResolutionInput {
    return {
      documentId,
      jobId,
      protectedValues: [],
      entityProtectedValueLinks: [],
      mentionUpdates: [],
      candidates: [],
      events: [],
      finishedAt
    }
  }

  describe('ProtectedValueRepository', () => {
    it('round-trips a ProtectedValue through create and findByFingerprint', () => {
      const fingerprint = cipher('fingerprint-1')
      const created = protectedValues.create({
        id: 'protected-1',
        matterId: 'matter-1',
        type: 'PERSON_NAME',
        valueCipher: cipher('value-1'),
        fingerprint,
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 2
      })

      expect(created).toEqual({
        id: 'protected-1',
        matterId: 'matter-1',
        type: 'PERSON_NAME',
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 2
      })
      expect(protectedValues.findByFingerprint('matter-1', 'PERSON_NAME', fingerprint)).toEqual({
        ...created,
        valueCipher: cipher('value-1')
      })
      expect(protectedValues.findByFingerprint('matter-1', 'PERSON_NAME', cipher('other'))).toBeUndefined()
      expect(protectedValues.findByFingerprint('matter-1', 'ORG_NAME', fingerprint)).toBeUndefined()
    })

    it('requires non-empty encrypted material', () => {
      const base = {
        id: 'protected-1',
        matterId: 'matter-1',
        type: 'PERSON_NAME' as const,
        fingerprint: cipher('fingerprint'),
        restorePolicy: 'ALWAYS_RESTORE' as const,
        createdAt: 2
      }
      expect(() => protectedValues.create({ ...base, valueCipher: Buffer.alloc(0) })).toThrow(
        'valueCipher must not be empty'
      )
      expect(() => protectedValues.create({ ...base, valueCipher: cipher('value'), fingerprint: Buffer.alloc(0) }))
        .toThrow('fingerprint must not be empty')
    })

    it('links Entities to a ProtectedValue and reads both directions matter-scoped', () => {
      insertMatter('matter-2')
      const entity = insertEntity('entity-1')
      const otherMatterEntity = insertEntity('entity-2', 'matter-2')
      protectedValues.create({
        id: 'protected-1',
        matterId: 'matter-1',
        type: 'PERSON_NAME',
        valueCipher: cipher('value'),
        fingerprint: cipher('fingerprint'),
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 2
      })

      expect(() =>
        protectedValues.linkToEntity({
          id: 'link-cross',
          matterId: 'matter-1',
          entityId: otherMatterEntity.id,
          protectedValueId: 'protected-1',
          relationshipType: 'NAME',
          confidence: 1,
          isPrimary: true,
          createdAt: 3
        })
      ).toThrow('Entity was not found in the Matter')

      protectedValues.linkToEntity({
        id: 'link-1',
        matterId: 'matter-1',
        entityId: entity.id,
        protectedValueId: 'protected-1',
        relationshipType: 'NAME',
        confidence: 1,
        isPrimary: true,
        createdAt: 3
      })

      expect(protectedValues.findEntitiesByProtectedValue('matter-1', 'protected-1')).toEqual([entity])
      expect(protectedValues.findEntitiesByProtectedValue('matter-2', 'protected-1')).toEqual([])
      expect(protectedValues.findEntityProtectedValues('matter-1', entity.id)).toEqual([{
        protectedValueId: 'protected-1',
        type: 'PERSON_NAME',
        fingerprint: cipher('fingerprint')
      }])
    })
  })

  describe('EntityResolutionRepository.begin', () => {
    it('begins from a DETECTED Document with deterministic encrypted Mention sources', () => {
      const mentionId = seedDetectedDocument('document-1', cipher('mention-fingerprint'))

      const begun = resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      expect(begun.document.parseStatus).toBe('RESOLVING')
      expect(begun.job).toMatchObject({ type: 'RESOLVE', status: 'RUNNING', progress: 0 })
      expect(begun.mentions).toHaveLength(1)
      expect(begun.mentions[0]).toMatchObject({
        id: mentionId,
        matterId: 'matter-1',
        documentId: 'document-1',
        textCipher: cipher('mention-document-1'),
        fingerprint: cipher('mention-fingerprint')
      })
      expect(resolution.findMentionById(mentionId)).toMatchObject({ id: mentionId, documentId: 'document-1' })
    })

    it('rejects Documents that have not completed privacy detection', () => {
      const documents = new DocumentRepository(db)
      documents.create({
        id: 'document-imported',
        matterId: 'matter-1',
        originalNameCipher: cipher('name'),
        fileHash: 'hash-imported',
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        createdAt: 1,
        updatedAt: 1
      })
      expect(() => resolution.begin({ documentId: 'document-imported', jobId: 'resolve-1', startedAt: 2 })).toThrow(
        'Document is not available for entity resolution'
      )

      documents.create({
        id: 'document-parsing',
        matterId: 'matter-1',
        originalNameCipher: cipher('name'),
        fileHash: 'hash-parsing',
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        createdAt: 1,
        updatedAt: 1
      })
      documents.markProcessing('document-parsing', 'SYNTHETIC', 2)
      expect(() => resolution.begin({ documentId: 'document-parsing', jobId: 'resolve-2', startedAt: 3 })).toThrow(
        'Document is not available for entity resolution'
      )
    })

    it('retries a FAILED Document only when its latest RESOLVE job failed', () => {
      seedDetectedDocument('document-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      const failed = resolution.fail('document-1', 'resolve-1', cipher('error'), 9)
      expect(failed.document.parseStatus).toBe('FAILED')
      expect(failed.job).toMatchObject({ status: 'FAILED', finishedAt: 9 })

      const retried = resolution.begin({ documentId: 'document-1', jobId: 'resolve-2', startedAt: 10 })
      expect(retried.document.parseStatus).toBe('RESOLVING')
      expect(retried.job).toMatchObject({ id: 'resolve-2', type: 'RESOLVE', status: 'RUNNING' })
      resolution.complete(emptyResolution('document-1', 'resolve-2', 11))
      expect(resolution.findCompleted('document-1')?.job.id).toBe('resolve-2')
    })

    it('rejects a Document that FAILED during privacy detection', () => {
      const documents = new DocumentRepository(db)
      documents.create({
        id: 'document-1',
        matterId: 'matter-1',
        originalNameCipher: cipher('name'),
        fileHash: 'hash-1',
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        createdAt: 1,
        updatedAt: 1
      })
      documents.markProcessing('document-1', 'SYNTHETIC', 2)
      documents.completeProcessing({
        documentId: 'document-1',
        parserType: 'SYNTHETIC',
        pageCount: 1,
        pages: [{
          id: 'page-1',
          documentId: 'document-1',
          pageNo: 1,
          originalWidth: 1,
          originalHeight: 1,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: 3
        }],
        blocks: [],
        updatedAt: 4
      })
      const detection = new PrivacyDetectionRepository(db)
      detection.begin({ documentId: 'document-1', jobId: 'detect-1', startedAt: 5 })
      detection.fail('document-1', 'detect-1', cipher('error'), 6)

      expect(() => resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 7 })).toThrow(
        'Failed Document did not fail during entity resolution'
      )
    })
  })

  describe('EntityResolutionRepository.complete', () => {
    it('persists values, links, mention updates, candidates, evidence, and events atomically', () => {
      const mentionId = seedDetectedDocument('document-1')
      const entity = insertEntity('entity-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      resolution.updateProgress('resolve-1', 1, 2)

      const result = resolution.complete({
        documentId: 'document-1',
        jobId: 'resolve-1',
        protectedValues: [{
          id: 'protected-1',
          matterId: 'matter-1',
          type: 'PERSON_NAME',
          valueCipher: cipher('value'),
          fingerprint: cipher('fingerprint'),
          restorePolicy: 'ALWAYS_RESTORE',
          createdAt: 9
        }],
        entityProtectedValueLinks: [{
          id: 'link-1',
          matterId: 'matter-1',
          entityId: entity.id,
          protectedValueId: 'protected-1',
          relationshipType: 'NAME',
          confidence: 1,
          isPrimary: true,
          createdAt: 9
        }],
        mentionUpdates: [{
          id: mentionId,
          fingerprint: cipher('mention-fingerprint'),
          protectedValueId: 'protected-1',
          entityId: entity.id
        }],
        candidates: [{
          id: 'candidate-1',
          mentionId,
          candidateEntityId: entity.id,
          score: 0.95,
          state: 'PENDING',
          algorithmVersion: 'synthetic-v1',
          createdAt: 9,
          evidence: [{
            id: 'evidence-1',
            evidenceType: 'EXACT_NAME',
            weight: 1,
            score: 0.95,
            createdAt: 9
          }]
        }],
        events: [{
          id: 'event-1',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: entity.id,
          mentionId,
          actor: 'SYSTEM',
          payloadCipher: cipher('event'),
          createdAt: 9
        }],
        finishedAt: 10
      })

      expect(result.document.parseStatus).toBe('READY')
      expect(result.job).toMatchObject({ status: 'COMPLETED', progress: 1, finishedAt: 10 })
      expect(result.job.checkpoint).toBeUndefined()
      expect(resolution.findMentionById(mentionId)).toMatchObject({
        entityId: entity.id,
        protectedValueId: 'protected-1'
      })
      expect(protectedValues.findEntitiesByProtectedValue('matter-1', 'protected-1')).toEqual([entity])
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_candidates').get()).toEqual({ count: 1 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_evidence').get()).toEqual({ count: 1 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 1 })
      expect(sqlite.prepare('SELECT fingerprint FROM mentions WHERE id = ?').get(mentionId)).toEqual({
        fingerprint: cipher('mention-fingerprint')
      })
    })

    it('reuses an existing ProtectedValue with the same fingerprint instead of duplicating it', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      protectedValues.create({
        id: 'protected-existing',
        matterId: 'matter-1',
        type: 'PERSON_NAME',
        valueCipher: cipher('original-value'),
        fingerprint: cipher('shared-fingerprint'),
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 2
      })
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      resolution.complete({
        ...emptyResolution('document-1', 'resolve-1', 9),
        protectedValues: [{
          id: 'protected-duplicate',
          matterId: 'matter-1',
          type: 'PERSON_NAME',
          valueCipher: cipher('duplicate-value'),
          fingerprint: cipher('shared-fingerprint'),
          restorePolicy: 'ALWAYS_RESTORE',
          createdAt: 9
        }],
        entityProtectedValueLinks: [{
          id: 'link-1',
          matterId: 'matter-1',
          entityId: 'entity-1',
          protectedValueId: 'protected-duplicate',
          relationshipType: 'NAME',
          confidence: 1,
          isPrimary: true,
          createdAt: 9
        }],
        mentionUpdates: [{
          id: mentionId,
          fingerprint: null,
          protectedValueId: 'protected-duplicate',
          entityId: 'entity-1'
        }],
        events: [{
          id: 'event-1',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-1',
          mentionId,
          actor: 'SYSTEM',
          payloadCipher: cipher('event'),
          createdAt: 9
        }]
      })

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM protected_values').get()).toEqual({ count: 1 })
      expect(resolution.findMentionById(mentionId)).toMatchObject({ protectedValueId: 'protected-existing' })
      expect(protectedValues.findEntityProtectedValues('matter-1', 'entity-1')).toEqual([{
        protectedValueId: 'protected-existing',
        type: 'PERSON_NAME',
        fingerprint: cipher('shared-fingerprint')
      }])
    })

    it('rolls back every write when a Mention update references a foreign Document', () => {
      const mentionId = seedDetectedDocument('document-1')
      const foreignMentionId = seedDetectedDocument('document-2')
      insertEntity('entity-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      expect(() =>
        resolution.complete({
          documentId: 'document-1',
          jobId: 'resolve-1',
          protectedValues: [{
            id: 'protected-1',
            matterId: 'matter-1',
            type: 'PERSON_NAME',
            valueCipher: cipher('value'),
            fingerprint: cipher('fingerprint'),
            restorePolicy: 'ALWAYS_RESTORE',
            createdAt: 9
          }],
          entityProtectedValueLinks: [],
          mentionUpdates: [
            { id: mentionId, fingerprint: null, protectedValueId: 'protected-1', entityId: 'entity-1' },
            { id: foreignMentionId, fingerprint: null, protectedValueId: null, entityId: null }
          ],
          candidates: [{
            id: 'candidate-1',
            mentionId,
            candidateEntityId: 'entity-1',
            score: 0.9,
            state: 'PENDING',
            algorithmVersion: 'synthetic-v1',
            createdAt: 9,
            evidence: []
          }],
          events: [],
          finishedAt: 10
        })
      ).toThrow('Mention must belong to the resolved Document')

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM protected_values').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_candidates').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
        parse_status: 'RESOLVING'
      })
      expect(sqlite.prepare('SELECT status FROM processing_jobs WHERE id = ?').get('resolve-1')).toEqual({
        status: 'RUNNING'
      })
      const mention = resolution.findMentionById(mentionId)
      expect(mention?.entityId).toBeUndefined()
      expect(mention?.protectedValueId).toBeUndefined()
    })

    it('persists new Entities with alias and creation event inside the completion transaction', () => {
      const mentionId = seedDetectedDocument('document-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      const result = resolution.complete({
        ...emptyResolution('document-1', 'resolve-1', 10),
        entitiesToCreate: [{
          entity: {
            id: 'entity-new',
            matterId: 'matter-1',
            type: 'PERSON',
            publicToken: '@P-entity-new',
            status: 'ACTIVE',
            createdAt: 9,
            updatedAt: 9
          },
          primaryAlias: {
            id: 'alias-new',
            matterId: 'matter-1',
            entityId: 'entity-new',
            alias: 'Person @P-entity-new',
            aliasType: 'PRIMARY',
            isPrimary: true,
            createdAt: 9
          },
          event: {
            id: 'event-created',
            matterId: 'matter-1',
            type: 'ENTITY_CREATED',
            entityId: 'entity-new',
            actor: 'SYSTEM',
            payloadCipher: cipher('event'),
            createdAt: 9
          }
        }],
        protectedValues: [{
          id: 'protected-1',
          matterId: 'matter-1',
          type: 'PERSON_NAME',
          valueCipher: cipher('value'),
          fingerprint: cipher('fingerprint'),
          restorePolicy: 'ALWAYS_RESTORE',
          createdAt: 9
        }],
        entityProtectedValueLinks: [{
          id: 'link-1',
          matterId: 'matter-1',
          entityId: 'entity-new',
          protectedValueId: 'protected-1',
          relationshipType: 'OWNER',
          confidence: 1,
          isPrimary: true,
          createdAt: 9
        }],
        mentionUpdates: [{ id: mentionId, fingerprint: null, protectedValueId: 'protected-1', entityId: 'entity-new' }],
        events: [{
          id: 'event-assigned',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-new',
          mentionId,
          actor: 'SYSTEM',
          payloadCipher: cipher('event'),
          createdAt: 9
        }]
      })

      expect(result.document.parseStatus).toBe('READY')
      expect(entities.findById('entity-new')).toMatchObject({ matterId: 'matter-1', status: 'ACTIVE' })
      expect(entities.findAliases('matter-1')).toEqual([expect.objectContaining({ entityId: 'entity-new', isPrimary: true })])
      expect(resolution.findMentionById(mentionId)).toMatchObject({ entityId: 'entity-new' })
      expect(protectedValues.findEntitiesByProtectedValue('matter-1', 'protected-1')).toEqual([
        expect.objectContaining({ id: 'entity-new' })
      ])
      expect(sqlite.prepare('SELECT event_type FROM resolution_events ORDER BY rowid').all()).toEqual([
        { event_type: 'ENTITY_CREATED' },
        { event_type: 'MENTION_ASSIGNED' }
      ])
    })

    it('rolls back new Entities when any completion write fails', () => {
      const mentionId = seedDetectedDocument('document-1')
      const foreignMentionId = seedDetectedDocument('document-2')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          entitiesToCreate: [{
            entity: {
              id: 'entity-new',
              matterId: 'matter-1',
              type: 'PERSON',
              publicToken: '@P-entity-new',
              status: 'ACTIVE',
              createdAt: 9,
              updatedAt: 9
            },
            primaryAlias: {
              id: 'alias-new',
              matterId: 'matter-1',
              entityId: 'entity-new',
              alias: 'Person @P-entity-new',
              aliasType: 'PRIMARY',
              isPrimary: true,
              createdAt: 9
            },
            event: {
              id: 'event-created',
              matterId: 'matter-1',
              type: 'ENTITY_CREATED',
              entityId: 'entity-new',
              actor: 'SYSTEM',
              payloadCipher: cipher('event'),
              createdAt: 9
            }
          }],
          mentionUpdates: [
            { id: mentionId, fingerprint: null, protectedValueId: null, entityId: 'entity-new' },
            { id: foreignMentionId, fingerprint: null, protectedValueId: null, entityId: null }
          ]
        })
      ).toThrow('Mention must belong to the resolved Document')

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_aliases').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
        parse_status: 'RESOLVING'
      })
    })

    it('rolls back when a candidate references another Document Mention', () => {
      const mentionId = seedDetectedDocument('document-1')
      const foreignMentionId = seedDetectedDocument('document-2')
      insertEntity('entity-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          protectedValues: [{
            id: 'protected-1',
            matterId: 'matter-1',
            type: 'PERSON_NAME',
            valueCipher: cipher('value'),
            fingerprint: cipher('fingerprint'),
            restorePolicy: 'ALWAYS_RESTORE',
            createdAt: 9
          }],
          mentionUpdates: [{ id: mentionId, fingerprint: null, protectedValueId: 'protected-1', entityId: null }],
          candidates: [{
            id: 'candidate-foreign',
            mentionId: foreignMentionId,
            candidateEntityId: 'entity-1',
            score: 40,
            state: 'PENDING',
            algorithmVersion: 'synthetic-v1',
            createdAt: 9,
            evidence: []
          }]
        })
      ).toThrow('Candidate Mention must belong to the resolved Document')

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM protected_values').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_candidates').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
        parse_status: 'RESOLVING'
      })
      expect(sqlite.prepare('SELECT status FROM processing_jobs WHERE id = ?').get('resolve-1')).toEqual({
        status: 'RUNNING'
      })
    })

    it('rolls back when an event references a foreign Mention, Matter, or Entity', () => {
      const mentionId = seedDetectedDocument('document-1')
      const foreignMentionId = seedDetectedDocument('document-2')
      insertEntity('entity-1')
      insertMatter('matter-2')
      insertEntity('entity-2', 'matter-2')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      const event = (overrides: Record<string, unknown>) => ({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        entityId: 'entity-1',
        mentionId,
        actor: 'SYSTEM' as const,
        payloadCipher: cipher('event'),
        createdAt: 9,
        ...overrides
      })

      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          events: [event({ mentionId: foreignMentionId })]
        })
      ).toThrow('Resolution event Mention must belong to the resolved Document')
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          events: [event({ matterId: 'matter-2' })]
        })
      ).toThrow('Resolution event must belong to the Document Matter')
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          events: [event({ entityId: 'entity-2' })]
        })
      ).toThrow('Resolution event Entity must belong to the Document Matter')

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
        parse_status: 'RESOLVING'
      })
      expect(sqlite.prepare('SELECT status FROM processing_jobs WHERE id = ?').get('resolve-1')).toEqual({
        status: 'RUNNING'
      })
    })

    it('binds assignment events to the actual Mention updates and rejects anything else', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      const event = (overrides: Record<string, unknown>) => ({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        entityId: 'entity-1',
        mentionId,
        actor: 'SYSTEM' as const,
        payloadCipher: cipher('event'),
        createdAt: 9,
        ...overrides
      })
      const assignment = (entityId: string | null) => ({
        id: mentionId,
        fingerprint: null,
        protectedValueId: null,
        entityId
      })
      const expectRollback = () => {
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
        expect(sqlite.prepare('SELECT entity_id FROM mentions WHERE id = ?').get(mentionId)).toEqual({
          entity_id: null
        })
        expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
          parse_status: 'RESOLVING'
        })
      }

      // The event contradicts the actual update (A -> E1, event records A -> E2).
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [assignment('entity-1')],
          events: [event({ entityId: 'entity-2' })]
        })
      ).toThrow('Assignment event must match the Mention update it records')
      expectRollback()

      // An assignment event without any corresponding Mention update.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          events: [event({})]
        })
      ).toThrow('Assignment event must match the Mention update it records')
      expectRollback()

      // A Mention assignment without its audit event.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [assignment('entity-1')],
          events: []
        })
      ).toThrow('Every Mention assignment must be recorded by an assignment event')
      expectRollback()

      // An event type with no corresponding business change in this transaction.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          events: [event({ type: 'ENTITY_MERGED' })]
        })
      ).toThrow('Resolution completion only records Mention assignment events')
      expectRollback()

      // Completion events are always SYSTEM-recorded; user transitions go through assignMention.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [assignment('entity-1')],
          events: [event({ actor: 'USER' })]
        })
      ).toThrow('Resolution completion events must be recorded by the SYSTEM actor')
      expectRollback()

      // The bound pair commits cleanly.
      const result = resolution.complete({
        ...emptyResolution('document-1', 'resolve-1', 10),
        mentionUpdates: [assignment('entity-1')],
        events: [event({})]
      })
      expect(result.document.parseStatus).toBe('READY')
      expect(sqlite.prepare('SELECT entity_id FROM mentions WHERE id = ?').get(mentionId)).toEqual({
        entity_id: 'entity-1'
      })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 1 })
    })

    it('derives the required event type from the stored Mention assignment', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')
      // Pre-assign the Mention to entity-1 through the audited path.
      resolution.assignMention({
        mentionId,
        entityId: 'entity-1',
        resolvedAt: 7,
        event: {
          id: 'event-assign',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-1',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 7
        }
      })
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      let eventSequence = 0
      const event = (overrides: Record<string, unknown>) => ({
        id: `event-transition-${++eventSequence}`,
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        entityId: 'entity-2',
        mentionId,
        actor: 'SYSTEM' as const,
        payloadCipher: cipher('event'),
        createdAt: 9,
        ...overrides
      })
      const update = (entityId: string | null) => ({
        id: mentionId,
        fingerprint: null,
        protectedValueId: null,
        entityId
      })
      const expectStillResolving = () => {
        expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
          parse_status: 'RESOLVING'
        })
        expect(sqlite.prepare('SELECT entity_id FROM mentions WHERE id = ?').get(mentionId)).toEqual({
          entity_id: 'entity-1'
        })
      }

      // Clearing an assignment is not a valid completion transition.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [update(null)],
          events: []
        })
      ).toThrow('Resolution completion must not clear a Mention assignment')
      expectStillResolving()

      // E1 -> E2 recorded as MENTION_ASSIGNED contradicts the stored state.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [update('entity-2')],
          events: [event({ type: 'MENTION_ASSIGNED' })]
        })
      ).toThrow('Assignment event must match the Mention update it records')
      expectStillResolving()

      // E1 -> E1 is no transition; an assignment event must not be fabricated.
      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          mentionUpdates: [update('entity-1')],
          events: [event({ entityId: 'entity-1' })]
        })
      ).toThrow('Assignment event must match the Mention update it records')
      expectStillResolving()

      // E1 -> E2 with exactly one MENTION_REASSIGNED event commits.
      const result = resolution.complete({
        ...emptyResolution('document-1', 'resolve-1', 10),
        mentionUpdates: [update('entity-2')],
        events: [event({ type: 'MENTION_REASSIGNED' })]
      })
      expect(result.document.parseStatus).toBe('READY')
      expect(sqlite.prepare('SELECT entity_id FROM mentions WHERE id = ?').get(mentionId)).toEqual({
        entity_id: 'entity-2'
      })
      expect(sqlite.prepare('SELECT event_type FROM resolution_events ORDER BY rowid').all()).toEqual([
        { event_type: 'MENTION_ASSIGNED' },
        { event_type: 'MENTION_REASSIGNED' }
      ])
    })

    it('rejects new Entities outside the Document Matter', () => {
      seedDetectedDocument('document-1')
      insertMatter('matter-2')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })

      expect(() =>
        resolution.complete({
          ...emptyResolution('document-1', 'resolve-1', 10),
          entitiesToCreate: [{
            entity: {
              id: 'entity-foreign',
              matterId: 'matter-2',
              type: 'PERSON',
              publicToken: '@P-entity-foreign',
              status: 'ACTIVE',
              createdAt: 9,
              updatedAt: 9
            },
            primaryAlias: {
              id: 'alias-foreign',
              matterId: 'matter-2',
              entityId: 'entity-foreign',
              alias: 'Person @P-entity-foreign',
              aliasType: 'PRIMARY',
              isPrimary: true,
              createdAt: 9
            },
            event: {
              id: 'event-foreign',
              matterId: 'matter-2',
              type: 'ENTITY_CREATED',
              entityId: 'entity-foreign',
              actor: 'SYSTEM',
              payloadCipher: cipher('event'),
              createdAt: 9
            }
          }]
        })
      ).toThrow('Entity must remain inside the Document Matter')
      expect(entities.findById('entity-foreign')).toBeUndefined()
    })
  })

  describe('EntityResolutionRepository.assignMention', () => {
    it('enforces the ASSIGN vs REASSIGN event type for the Mention transition', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')

      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 8,
          event: {
            id: 'event-wrong',
            matterId: 'matter-1',
            type: 'MENTION_REASSIGNED',
            entityId: 'entity-1',
            mentionId,
            actor: 'USER',
            payloadCipher: cipher('event'),
            createdAt: 8
          }
        })
      ).toThrow('Resolution event type must match the Mention assignment transition')

      const assigned = resolution.assignMention({
        mentionId,
        entityId: 'entity-1',
        resolvedAt: 8,
        event: {
          id: 'event-assign',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-1',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 8
        }
      })
      expect(assigned.entityId).toBe('entity-1')

      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-2',
          resolvedAt: 9,
          event: {
            id: 'event-wrong-2',
            matterId: 'matter-1',
            type: 'MENTION_ASSIGNED',
            entityId: 'entity-2',
            mentionId,
            actor: 'USER',
            payloadCipher: cipher('event'),
            createdAt: 9
          }
        })
      ).toThrow('Resolution event type must match the Mention assignment transition')

      const reassigned = resolution.assignMention({
        mentionId,
        entityId: 'entity-2',
        resolvedAt: 9,
        event: {
          id: 'event-reassign',
          matterId: 'matter-1',
          type: 'MENTION_REASSIGNED',
          entityId: 'entity-2',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 9
        }
      })
      expect(reassigned.entityId).toBe('entity-2')
      expect(sqlite.prepare('SELECT event_type FROM resolution_events ORDER BY created_at').all()).toEqual([
        { event_type: 'MENTION_ASSIGNED' },
        { event_type: 'MENTION_REASSIGNED' }
      ])
    })

    it('rejects no-op assignments and SYSTEM actors on the manual entry point', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      const event = (overrides: Record<string, unknown>) => ({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        entityId: 'entity-1',
        mentionId,
        actor: 'USER' as const,
        payloadCipher: cipher('event'),
        createdAt: 8,
        ...overrides
      })

      // The manual entry point records user decisions only.
      expect(() =>
        resolution.assignMention({ mentionId, entityId: 'entity-1', resolvedAt: 8, event: event({ actor: 'SYSTEM' }) })
      ).toThrow('Manual assignment events must be recorded by the USER actor')

      resolution.assignMention({ mentionId, entityId: 'entity-1', resolvedAt: 8, event: event({}) })

      // E1 -> E1 is no transition; an audit event must not be fabricated for it.
      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 9,
          event: event({ id: 'event-2', type: 'MENTION_REASSIGNED', createdAt: 9 })
        })
      ).toThrow('Mention is already assigned to this Entity')

      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 1 })
      expect(resolution.findMentionById(mentionId)?.entityId).toBe('entity-1')
    })

    it('rejects cross-Matter and merged Entities before the trigger backstop', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertMatter('matter-2')
      insertEntity('entity-2', 'matter-2')
      insertEntity('canonical-1')
      entities.create({
        id: 'merged-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-merged-1',
        status: 'MERGED',
        mergedIntoEntityId: 'canonical-1',
        createdAt: 2,
        updatedAt: 2
      })

      const event = {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        mentionId,
        actor: 'USER' as const,
        payloadCipher: cipher('event'),
        createdAt: 8
      }
      expect(() => resolution.assignMention({ mentionId, entityId: 'entity-2', resolvedAt: 8, event })).toThrow(
        'mention and entity must belong to the same Matter'
      )
      expect(() => resolution.assignMention({ mentionId, entityId: 'merged-1', resolvedAt: 8, event })).toThrow(
        'mentions may only be assigned to an active canonical entity'
      )
      expect(resolution.findMentionById(mentionId)?.entityId).toBeUndefined()
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('rejects an audit event that does not bind to the assigned Mention and Entity', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      const baseEvent = {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED' as const,
        entityId: 'entity-1',
        mentionId,
        actor: 'USER' as const,
        payloadCipher: cipher('event'),
        createdAt: 8
      }

      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 8,
          event: { ...baseEvent, mentionId: 'mention-other' }
        })
      ).toThrow('Resolution event must reference the assigned Mention')
      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 8,
          event: { ...baseEvent, entityId: 'entity-other' }
        })
      ).toThrow('Resolution event must reference the assigned Entity')
      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 8,
          event: { ...baseEvent, matterId: 'matter-2' }
        })
      ).toThrow('Resolution event must belong to the Mention Matter')

      expect(resolution.findMentionById(mentionId)?.entityId).toBeUndefined()
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('closes open review candidates on assignment and only transitions PENDING rows', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      resolution.complete({
        ...emptyResolution('document-1', 'resolve-1', 10),
        candidates: [
          {
            id: 'candidate-1',
            mentionId,
            candidateEntityId: 'entity-1',
            score: 40,
            state: 'PENDING',
            algorithmVersion: 'synthetic-v1',
            createdAt: 9,
            evidence: []
          },
          {
            id: 'candidate-2',
            mentionId,
            candidateEntityId: 'entity-2',
            score: 40,
            state: 'PENDING',
            algorithmVersion: 'synthetic-v1',
            createdAt: 9,
            evidence: []
          }
        ]
      })

      const assigned = resolution.assignMention({
        mentionId,
        entityId: 'entity-1',
        resolvedAt: 11,
        event: {
          id: 'event-assign',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-1',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 11
        }
      })
      expect(assigned.entityId).toBe('entity-1')
      expect(
        sqlite.prepare('SELECT id, state, resolved_at FROM resolution_candidates ORDER BY id').all()
      ).toEqual([
        { id: 'candidate-1', state: 'ACCEPTED', resolved_at: 11 },
        { id: 'candidate-2', state: 'REJECTED', resolved_at: 11 }
      ])

      // Reassigning only transitions PENDING rows: the earlier ACCEPTED/REJECTED
      // decisions are kept as the audit trail of the first assignment.
      resolution.assignMention({
        mentionId,
        entityId: 'entity-2',
        resolvedAt: 12,
        event: {
          id: 'event-reassign',
          matterId: 'matter-1',
          type: 'MENTION_REASSIGNED',
          entityId: 'entity-2',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 12
        }
      })
      expect(
        sqlite.prepare('SELECT id, state, resolved_at FROM resolution_candidates ORDER BY id').all()
      ).toEqual([
        { id: 'candidate-1', state: 'ACCEPTED', resolved_at: 11 },
        { id: 'candidate-2', state: 'REJECTED', resolved_at: 11 }
      ])
    })

    it('rejects assignment once the Document is sanitized', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      sqlite.prepare("UPDATE documents SET parse_status = 'SANITIZED' WHERE id = 'document-1'").run()

      expect(() =>
        resolution.assignMention({
          mentionId,
          entityId: 'entity-1',
          resolvedAt: 8,
          event: {
            id: 'event-assign',
            matterId: 'matter-1',
            type: 'MENTION_ASSIGNED',
            entityId: 'entity-1',
            mentionId,
            actor: 'USER',
            payloadCipher: cipher('event'),
            createdAt: 8
          }
        })
      ).toThrow('Document review is closed after sanitization')
      expect(resolution.findMentionById(mentionId)?.entityId).toBeUndefined()
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })
  })

  describe('EntityResolutionRepository.confirmMention', () => {
    const confirmEvent = (id: string, mentionId: string, entityId?: string) => ({
      id,
      matterId: 'matter-1',
      type: 'ENTITY_CONFIRMED' as const,
      ...(entityId === undefined ? {} : { entityId }),
      mentionId,
      actor: 'USER' as const,
      payloadCipher: cipher('confirm'),
      createdAt: 9
    })

    function assignFirst(mentionId: string, entityId: string): void {
      resolution.assignMention({
        mentionId,
        entityId,
        resolvedAt: 8,
        event: {
          id: 'event-assign',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId,
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 8
        }
      })
    }

    it('records the ENTITY_CONFIRMED event once and marks the Mention reviewed', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      assignFirst(mentionId, 'entity-1')

      const confirmed = resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm', mentionId, 'entity-1') })
      expect(confirmed.reviewStatus).toBe('CONFIRMED')

      // Confirming the same assignment again is a no-op, not a new transition.
      const again = resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm-2', mentionId, 'entity-1') })
      expect(again.reviewStatus).toBe('CONFIRMED')
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE event_type = 'ENTITY_CONFIRMED'").get()
      ).toEqual({ count: 1 })
    })

    it('rejects confirming an unassigned Mention', () => {
      const mentionId = seedDetectedDocument('document-1')

      expect(() => resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm', mentionId) })).toThrow(
        'only an assigned mention can be confirmed'
      )
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('rejects event bindings that do not match the confirmed assignment', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')
      assignFirst(mentionId, 'entity-1')

      expect(() =>
        resolution.confirmMention({
          mentionId,
          event: { ...confirmEvent('event-confirm', mentionId, 'entity-1'), type: 'MENTION_ASSIGNED' }
        })
      ).toThrow('Resolution event type must be ENTITY_CONFIRMED')
      expect(() =>
        resolution.confirmMention({
          mentionId,
          event: { ...confirmEvent('event-confirm', mentionId, 'entity-1'), actor: 'SYSTEM' }
        })
      ).toThrow('Confirmation events must be recorded by the USER actor')
      expect(() =>
        resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm', mentionId, 'entity-2') })
      ).toThrow('Resolution event must reference the confirmed Entity')
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE event_type = 'ENTITY_CONFIRMED'").get()
      ).toEqual({ count: 0 })
    })

    it('binds confirmation to the current assignment after a reassignment', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertEntity('entity-2')
      assignFirst(mentionId, 'entity-1')
      resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm-1', mentionId, 'entity-1') })

      // Reassigning supersedes the confirmation: the Mention is unreviewed again.
      resolution.assignMention({
        mentionId,
        entityId: 'entity-2',
        resolvedAt: 10,
        event: {
          id: 'event-reassign',
          matterId: 'matter-1',
          type: 'MENTION_REASSIGNED',
          entityId: 'entity-2',
          mentionId,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 10
        }
      })
      expect(resolution.findMentionById(mentionId)?.reviewStatus).toBe('UNREVIEWED')

      // Confirming the new assignment records a second, correctly bound event.
      const reconfirmed = resolution.confirmMention({
        mentionId,
        event: confirmEvent('event-confirm-2', mentionId, 'entity-2')
      })
      expect(reconfirmed.reviewStatus).toBe('CONFIRMED')
      expect(
        sqlite
          .prepare("SELECT entity_id FROM resolution_events WHERE event_type = 'ENTITY_CONFIRMED' ORDER BY rowid")
          .all()
      ).toEqual([{ entity_id: 'entity-1' }, { entity_id: 'entity-2' }])
    })

    it('rejects confirmation once the Document is sanitized', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      assignFirst(mentionId, 'entity-1')
      sqlite.prepare("UPDATE documents SET parse_status = 'SANITIZED' WHERE id = 'document-1'").run()

      expect(() =>
        resolution.confirmMention({ mentionId, event: confirmEvent('event-confirm', mentionId, 'entity-1') })
      ).toThrow('Document review is closed after sanitization')
      expect(resolution.findMentionById(mentionId)?.reviewStatus).toBe('UNREVIEWED')
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE event_type = 'ENTITY_CONFIRMED'").get()
      ).toEqual({ count: 0 })
    })
  })

  describe('EntityResolutionRepository.createEntityWithAssignment', () => {
    const newEntityInput = (mentionId: string): CreateEntityWithAssignmentInput => ({
      entity: {
        id: 'entity-new',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-new',
        status: 'ACTIVE',
        createdAt: 8,
        updatedAt: 8
      },
      primaryAlias: {
        id: 'alias-new',
        matterId: 'matter-1',
        entityId: 'entity-new',
        alias: 'Reviewer Choice',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 8
      },
      creationEvent: {
        id: 'event-create',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-new',
        actor: 'USER',
        payloadCipher: cipher('create'),
        createdAt: 8
      },
      mentionId,
      resolvedAt: 8,
      assignmentEvent: {
        id: 'event-assign',
        matterId: 'matter-1',
        type: 'MENTION_ASSIGNED',
        entityId: 'entity-new',
        mentionId,
        actor: 'USER',
        payloadCipher: cipher('assign'),
        createdAt: 8
      }
    })

    it('creates the Entity, assigns the Mention, and closes candidates atomically', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      sqlite
        .prepare(
          `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at)
           VALUES ('candidate-1', ?, 'entity-1', 90, 'PENDING', 'synthetic-v1', 7)`
        )
        .run(mentionId)

      const created = resolution.createEntityWithAssignment(newEntityInput(mentionId))

      expect(created.mention.entityId).toBe('entity-new')
      expect(entities.findById('entity-new')?.publicToken).toBe('@P-entity-new')
      expect(
        sqlite.prepare('SELECT event_type, actor FROM resolution_events ORDER BY rowid').all()
      ).toEqual([
        { event_type: 'ENTITY_CREATED', actor: 'USER' },
        { event_type: 'MENTION_ASSIGNED', actor: 'USER' }
      ])
      expect(sqlite.prepare('SELECT state, resolved_at FROM resolution_candidates').all()).toEqual([
        { state: 'REJECTED', resolved_at: 8 }
      ])
    })

    it('rolls the Entity back when the assignment fails', () => {
      seedDetectedDocument('document-1')

      expect(() => resolution.createEntityWithAssignment(newEntityInput('missing-mention'))).toThrow(
        'Mention was not found'
      )
      expect(entities.findById('entity-new')).toBeUndefined()
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_aliases').get()).toEqual({ count: 0 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('rolls the Entity back when a mid-transaction write fails', () => {
      const mentionId = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      // A conflicting Matter-wide alias fails the alias insert after the Entity
      // row has been written inside the transaction.
      entities.addAlias({
        id: 'alias-existing',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Reviewer Choice',
        aliasType: 'GENERIC',
        isPrimary: false,
        createdAt: 7
      })

      expect(() => resolution.createEntityWithAssignment(newEntityInput(mentionId))).toThrow()
      expect(entities.findById('entity-new')).toBeUndefined()
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM entity_aliases WHERE id = 'alias-new'").get()).toEqual({
        count: 0
      })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
      expect(resolution.findMentionById(mentionId)?.entityId).toBeUndefined()
    })

    it('rejects creation and assignment once the Document is sanitized', () => {
      const mentionId = seedDetectedDocument('document-1')
      sqlite.prepare("UPDATE documents SET parse_status = 'SANITIZED' WHERE id = 'document-1'").run()

      expect(() => resolution.createEntityWithAssignment(newEntityInput(mentionId))).toThrow(
        'Document review is closed after sanitization'
      )
      expect(entities.findById('entity-new')).toBeUndefined()
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('records user decisions only', () => {
      const mentionId = seedDetectedDocument('document-1')
      const input = newEntityInput(mentionId)

      expect(() =>
        resolution.createEntityWithAssignment({
          ...input,
          creationEvent: { ...input.creationEvent, actor: 'SYSTEM' }
        })
      ).toThrow('Manual creation and assignment events must be recorded by the USER actor')
      expect(entities.findById('entity-new')).toBeUndefined()
    })
  })

  describe('EntityResolutionRepository.addConstraint', () => {
    const constraintEvent = (id: string) => ({
      id,
      matterId: 'matter-1',
      type: 'CONSTRAINT_CREATED' as const,
      entityId: 'entity-a',
      actor: 'USER' as const,
      payloadCipher: cipher('event'),
      createdAt: 8
    })

    it('persists constraints in canonical pair order with their audit event', () => {
      insertEntity('entity-a')
      insertEntity('entity-b')

      const stored = resolution.addConstraint({
        constraint: {
          id: 'constraint-1',
          matterId: 'matter-1',
          entityAId: 'entity-b',
          entityBId: 'entity-a',
          type: 'CANNOT_LINK',
          reason: 'Synthetic conflict',
          source: 'USER',
          createdAt: 8
        },
        event: constraintEvent('event-1')
      })

      expect(stored.entityAId).toBe('entity-a')
      expect(stored.entityBId).toBe('entity-b')
      expect(resolution.findConstraints('matter-1')).toEqual([stored])
      expect(sqlite.prepare('SELECT event_type FROM resolution_events').all()).toEqual([
        { event_type: 'CONSTRAINT_CREATED' }
      ])
    })

    it('rejects reversed duplicates through the canonical unique index', () => {
      insertEntity('entity-a')
      insertEntity('entity-b')
      const constraint = {
        matterId: 'matter-1',
        entityAId: 'entity-a',
        entityBId: 'entity-b',
        type: 'CANNOT_LINK' as const,
        reason: 'Synthetic conflict',
        source: 'USER' as const,
        createdAt: 8
      }
      resolution.addConstraint({
        constraint: { ...constraint, id: 'constraint-1' },
        event: constraintEvent('event-1')
      })

      expect(() =>
        resolution.addConstraint({
          constraint: { ...constraint, id: 'constraint-2', entityAId: 'entity-b', entityBId: 'entity-a' },
          event: constraintEvent('event-2')
        })
      ).toThrow(/UNIQUE constraint failed/)
      expect(resolution.findConstraints('matter-1')).toHaveLength(1)
    })

    it('rejects constraints across Matters or involving non-active Entities', () => {
      insertEntity('entity-a')
      insertMatter('matter-2')
      insertEntity('entity-foreign', 'matter-2')
      entities.create({
        id: 'entity-merged',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-merged',
        status: 'MERGED',
        mergedIntoEntityId: 'entity-a',
        createdAt: 1,
        updatedAt: 1
      })
      const constraint = {
        id: 'constraint-1',
        matterId: 'matter-1',
        type: 'CANNOT_LINK' as const,
        reason: 'Synthetic conflict',
        source: 'USER' as const,
        createdAt: 8
      }

      expect(() =>
        resolution.addConstraint({
          constraint: { ...constraint, entityAId: 'entity-a', entityBId: 'entity-foreign' },
          event: { ...constraintEvent('event-1'), entityId: 'entity-a' }
        })
      ).toThrow('Constrained Entities must belong to the constraint Matter')
      expect(() =>
        resolution.addConstraint({
          constraint: { ...constraint, entityAId: 'entity-a', entityBId: 'entity-merged' },
          event: { ...constraintEvent('event-2'), entityId: 'entity-merged' }
        })
      ).toThrow('Constrained Entities must be active')
      expect(resolution.findConstraints('matter-1')).toHaveLength(0)
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })
    })

    it('requires a CONSTRAINT_CREATED event', () => {
      insertEntity('entity-a')
      insertEntity('entity-b')

      expect(() =>
        resolution.addConstraint({
          constraint: {
            id: 'constraint-1',
            matterId: 'matter-1',
            entityAId: 'entity-a',
            entityBId: 'entity-b',
            type: 'MUST_LINK',
            reason: 'Synthetic link',
            source: 'USER',
            createdAt: 8
          },
          event: { ...constraintEvent('event-1'), type: 'ENTITY_CONFIRMED' }
        })
      ).toThrow('Resolution event type must be CONSTRAINT_CREATED')
      expect(resolution.findConstraints('matter-1')).toHaveLength(0)
    })

    it('rejects an audit event that does not bind to the constraint Matter or Entities', () => {
      insertEntity('entity-a')
      insertEntity('entity-b')
      insertEntity('entity-c')
      const constraint = {
        id: 'constraint-1',
        matterId: 'matter-1',
        entityAId: 'entity-a',
        entityBId: 'entity-b',
        type: 'MUST_LINK' as const,
        reason: 'Synthetic link',
        source: 'USER' as const,
        createdAt: 8
      }

      expect(() =>
        resolution.addConstraint({ constraint, event: { ...constraintEvent('event-1'), matterId: 'matter-2' } })
      ).toThrow('Resolution event must belong to the constraint Matter')
      expect(() =>
        resolution.addConstraint({ constraint, event: { ...constraintEvent('event-2'), entityId: 'entity-c' } })
      ).toThrow('Resolution event must reference a constrained Entity')
      const withoutEntity = {
        id: 'event-4',
        matterId: 'matter-1',
        type: 'CONSTRAINT_CREATED' as const,
        actor: 'USER' as const,
        payloadCipher: cipher('event'),
        createdAt: 8
      }
      expect(() => resolution.addConstraint({ constraint, event: withoutEntity })).toThrow(
        'Resolution event must reference a constrained Entity'
      )
      expect(() =>
        resolution.addConstraint({ constraint, event: { ...constraintEvent('event-5'), actor: 'SYSTEM' } })
      ).toThrow('Resolution event actor must match the constraint source')
      expect(resolution.findConstraints('matter-1')).toHaveLength(0)
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 0 })

      // An event naming one of the constrained Entities binds correctly.
      const stored = resolution.addConstraint({
        constraint,
        event: { ...constraintEvent('event-3'), entityId: 'entity-b' }
      })
      expect(stored.type).toBe('MUST_LINK')
      expect(resolution.findConstraints('matter-1')).toHaveLength(1)
    })
  })

  describe('EntityResolutionRepository.findCompleted', () => {
    it('returns the READY Document with its completed RESOLVE job', () => {
      seedDetectedDocument('document-1')
      expect(resolution.findCompleted('document-1')).toBeUndefined()

      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      resolution.complete(emptyResolution('document-1', 'resolve-1', 9))

      const completed = resolution.findCompleted('document-1')
      expect(completed?.document.parseStatus).toBe('READY')
      expect(completed?.job).toMatchObject({ id: 'resolve-1', type: 'RESOLVE', status: 'COMPLETED' })
    })

    it('throws when a READY Document has no completed RESOLVE job', () => {
      new DocumentRepository(db).create({
        id: 'document-corrupt',
        matterId: 'matter-1',
        originalNameCipher: cipher('name'),
        fileHash: 'hash-corrupt',
        mimeType: 'application/pdf',
        parseStatus: 'READY',
        createdAt: 1,
        updatedAt: 1
      })

      expect(() => resolution.findCompleted('document-corrupt')).toThrow(
        'Ready Document is missing its completed ProcessingJob'
      )
    })
  })

  describe('EntityRepository lookups', () => {
    it('finds Entities by id and by Matter and type, excluding merged ones', () => {
      insertMatter('matter-2')
      const person = insertEntity('entity-1')
      insertEntity('entity-2', 'matter-2')
      entities.create({
        id: 'org-1',
        matterId: 'matter-1',
        type: 'ORGANIZATION',
        publicToken: '@O-org-1',
        status: 'ACTIVE',
        createdAt: 2,
        updatedAt: 2
      })
      entities.create({
        id: 'merged-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-merged-1',
        status: 'MERGED',
        mergedIntoEntityId: person.id,
        createdAt: 3,
        updatedAt: 3
      })

      expect(entities.findById(person.id)).toEqual(person)
      expect(entities.findById('missing')).toBeUndefined()
      expect(entities.findByMatterAndType('matter-1', 'PERSON')).toEqual([person])
      expect(entities.findByMatterAndType('matter-1', 'ORGANIZATION')).toHaveLength(1)
    })

    it('lists Matter-scoped aliases', () => {
      const person = insertEntity('entity-1')
      entities.addAlias({
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: person.id,
        alias: 'Synthetic Alias',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 2
      })

      expect(entities.findAliases('matter-1')).toEqual([{
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: person.id,
        alias: 'Synthetic Alias',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 2
      }])
      expect(entities.findAliases('matter-2')).toEqual([])
    })
  })
})
