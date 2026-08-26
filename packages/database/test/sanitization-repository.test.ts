import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AiExecutionRepository,
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  SanitizationRepository,
  createDatabase,
  migrateDatabase,
  type AliasAiDatabase,
  type CompleteSanitizationInput,
  type SqliteClient
} from '../src/index'
import type { Entity, SanitizationMapping, SanitizedBlock, SanitizedDocument } from '@aliasai/domain'
import type { AiExecution } from '@aliasai/domain'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

/** Produces a format-valid restoration token (`@[A-Z]-[A-Z0-9]+`) derived from a stable suffix. */
const valueToken = (suffix: string): string => `@N-${suffix.toUpperCase().replace(/[^A-Z0-9]/g, '')}`

describe('SanitizationRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let entities: EntityRepository
  let resolution: EntityResolutionRepository
  let sanitization: SanitizationRepository
  let aiExecutions: AiExecutionRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    entities = new EntityRepository(db)
    resolution = new EntityResolutionRepository(db)
    sanitization = new SanitizationRepository(db)
    aiExecutions = new AiExecutionRepository(db)
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
    const entity: Entity = { id, matterId, type: 'PERSON', publicToken, status: 'ACTIVE', createdAt: 1, updatedAt: 1 }
    entities.create(entity)
    entities.addAlias({
      id: `alias-${id}`,
      matterId,
      entityId: id,
      alias: `Alias ${id}`,
      aliasType: 'PRIMARY',
      isPrimary: true,
      createdAt: 1
    })
    return entity
  }

  function insertProtectedValue(id: string, publicToken: string): void {
    sqlite
      .prepare(
        `INSERT INTO protected_values (id, matter_id, value_type, value_cipher, fingerprint, public_token, restore_policy, created_at)
         VALUES (?, 'matter-1', 'PERSON_NAME', X'01', ?, ?, 'ALWAYS_RESTORE', 1)`
      )
      .run(id, Buffer.from(`fingerprint:${id}`), publicToken)
  }

  /** Assigns a Mention to an Entity and links them to a ProtectedValue, the state Entity Resolution leaves behind. */
  function resolveMention(mentionId: string, entityId: string, protectedValueId: string): void {
    sqlite.prepare('UPDATE mentions SET entity_id = ?, protected_value_id = ? WHERE id = ?').run(entityId, protectedValueId, mentionId)
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO entity_protected_values (entity_id, protected_value_id, relationship_type, confidence, is_primary, created_at)
         VALUES (?, ?, 'OWNER', 1, 1, 1)`
      )
      .run(entityId, protectedValueId)
  }

  /**
   * Runs a Document through parsing and privacy detection so it reaches
   * DETECTED with two blocks (reading order 0 and 1) and one Mention per block.
   */
  function seedDetectedDocument(documentId: string): { mentionA: string; mentionB: string } {
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
      blocks: [
        {
          id: `block-a-${documentId}`,
          documentId,
          pageId: `page-${documentId}`,
          blockType: 'TEXT',
          textCipher: cipher(`block-a-${documentId}`),
          source: 'NATIVE',
          bbox: { x: 0, y: 0, width: 1, height: 0.5 },
          readingOrder: 0,
          createdAt: 3
        },
        {
          id: `block-b-${documentId}`,
          documentId,
          pageId: `page-${documentId}`,
          blockType: 'TEXT',
          textCipher: cipher(`block-b-${documentId}`),
          source: 'NATIVE',
          bbox: { x: 0, y: 0.5, width: 1, height: 0.5 },
          readingOrder: 1,
          createdAt: 3
        }
      ],
      updatedAt: 4
    })
    const detection = new PrivacyDetectionRepository(db)
    const mentionA = `mention-a-${documentId}`
    const mentionB = `mention-b-${documentId}`
    const mention = (id: string, blockId: string) => ({
      id,
      matterId: 'matter-1',
      documentId,
      pageId: `page-${documentId}`,
      blockId,
      type: 'PERSON' as const,
      strength: 'EXPLICIT' as const,
      textCipher: cipher(id),
      startOffset: 0,
      endOffset: 5,
      detector: 'NER' as const,
      confidence: 0.9,
      reviewStatus: 'UNREVIEWED' as const,
      createdAt: 6
    })
    detection.begin({ documentId, jobId: `detect-${documentId}`, startedAt: 5 })
    detection.complete({
      documentId,
      jobId: `detect-${documentId}`,
      mentions: [mention(mentionA, `block-a-${documentId}`), mention(mentionB, `block-b-${documentId}`)],
      finishedAt: 7
    })
    return { mentionA, mentionB }
  }

  /** Completes entity resolution with no changes so the Document reaches READY. */
  function completeEmptyResolution(documentId: string, startedAt: number, finishedAt: number): void {
    resolution.begin({ documentId, jobId: `resolve-${documentId}`, startedAt })
    resolution.complete({
      documentId,
      jobId: `resolve-${documentId}`,
      protectedValues: [],
      entityProtectedValueLinks: [],
      mentionUpdates: [],
      candidates: [],
      events: [],
      finishedAt
    })
  }

  function seedReadyDocument(documentId: string): { mentionA: string; mentionB: string } {
    const seeded = seedDetectedDocument(documentId)
    const entityA = `entity-a-${documentId}`
    const entityB = `entity-b-${documentId}`
    insertEntity(entityA)
    insertEntity(entityB)
    insertProtectedValue(`pv-a-${documentId}`, valueToken(entityA))
    insertProtectedValue(`pv-b-${documentId}`, valueToken(entityB))
    resolveMention(seeded.mentionA, entityA, `pv-a-${documentId}`)
    resolveMention(seeded.mentionB, entityB, `pv-b-${documentId}`)
    completeEmptyResolution(documentId, 8, 9)
    return seeded
  }

  function sanitizedDocument(documentId: string, jobId: string): SanitizedDocument {
    return { id: `sanitized-${documentId}`, matterId: 'matter-1', documentId, jobId, createdAt: 11 }
  }

  function sanitizedBlock(documentId: string, blockKey: 'a' | 'b'): SanitizedBlock & { textCipher: Buffer } {
    return {
      id: `sblock-${blockKey}-${documentId}`,
      sanitizedDocumentId: `sanitized-${documentId}`,
      documentId,
      pageId: `page-${documentId}`,
      blockId: `block-${blockKey}-${documentId}`,
      textCipher: cipher(`sblock-${blockKey}-${documentId}`),
      createdAt: 11
    }
  }

  function mapping(
    documentId: string,
    key: 'a' | 'b',
    mentionId: string,
    entityId: string
  ): SanitizationMapping {
    return {
      id: `sm-${key}-${documentId}`,
      matterId: 'matter-1',
      sanitizedDocumentId: `sanitized-${documentId}`,
      mentionId,
      entityId,
      publicToken: valueToken(entityId),
      alias: `Alias ${entityId}`,
      restorePolicy: 'ALWAYS_RESTORE',
      createdAt: 11
    }
  }

  function completeInput(documentId: string, overrides: Partial<CompleteSanitizationInput> = {}): CompleteSanitizationInput {
    return {
      documentId,
      jobId: `sanitize-${documentId}`,
      sanitizedDocument: sanitizedDocument(documentId, `sanitize-${documentId}`),
      blocks: [sanitizedBlock(documentId, 'a'), sanitizedBlock(documentId, 'b')],
      mappings: [
        mapping(documentId, 'a', `mention-a-${documentId}`, `entity-a-${documentId}`),
        mapping(documentId, 'b', `mention-b-${documentId}`, `entity-b-${documentId}`)
      ],
      finishedAt: 12,
      ...overrides
    }
  }

  function seedAiSource(documentId = 'document-ai'): string {
    const { mentionA, mentionB } = seedReadyDocument(documentId)
    const sanitizedId = `sanitized-${documentId}`
    sanitization.begin({ documentId, jobId: `sanitize-${documentId}`, startedAt: 10 })
    sanitization.complete(
      completeInput(documentId, {
        blocks: [sanitizedBlock(documentId, 'b'), sanitizedBlock(documentId, 'a')],
        mappings: [
          mapping(documentId, 'b', mentionB, `entity-b-${documentId}`),
          mapping(documentId, 'a', mentionA, `entity-a-${documentId}`)
        ]
      })
    )
    return sanitizedId
  }

  function expectStillSanitizing(documentId: string): void {
    expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get(documentId)).toEqual({
      parse_status: 'SANITIZING'
    })
    expect(sqlite.prepare('SELECT status FROM processing_jobs WHERE id = ?').get(`sanitize-${documentId}`)).toEqual({
      status: 'RUNNING'
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitized_documents').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitized_blocks').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitization_mappings').get()).toEqual({ count: 0 })
  }

  describe('begin', () => {
    it('begins from READY with blocks in reading order and Mention entity context', () => {
      const { mentionA, mentionB } = seedDetectedDocument('document-1')
      insertEntity('entity-1')
      insertProtectedValue('pv-entity-1', valueToken('entity-1'))
      sqlite.prepare('UPDATE mentions SET protected_value_id = ? WHERE id = ?').run('pv-entity-1', mentionA)
      resolution.assignMention({
        mentionId: mentionA,
        entityId: 'entity-1',
        resolvedAt: 8,
        event: {
          id: 'event-assign',
          matterId: 'matter-1',
          type: 'MENTION_ASSIGNED',
          entityId: 'entity-1',
          mentionId: mentionA,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 8
        }
      })
      completeEmptyResolution('document-1', 9, 10)

      const begun = sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 11 })

      expect(begun.document.parseStatus).toBe('SANITIZING')
      expect(begun.job).toMatchObject({ id: 'sanitize-document-1', type: 'SANITIZE', status: 'RUNNING', progress: 0 })
      expect(begun.blocks.map((block) => block.id)).toEqual(['block-a-document-1', 'block-b-document-1'])
      expect(begun.blocks[0]?.mentions).toHaveLength(1)
      expect(begun.blocks[0]?.mentions[0]).toMatchObject({
        id: mentionA,
        entityId: 'entity-1',
        entityPrimaryAlias: 'Alias entity-1',
        entityStatus: 'ACTIVE',
        protectedValuePublicToken: valueToken('entity-1')
      })
      expect(begun.blocks[1]?.mentions[0]).toMatchObject({
        id: mentionB,
        entityPrimaryAlias: null,
        entityStatus: null,
        protectedValuePublicToken: null
      })
      expect(begun.blocks[1]?.mentions[0]?.entityId).toBeUndefined()

      const progressed = sanitization.updateProgress('sanitize-document-1', 1, 2)
      expect(progressed).toMatchObject({ progress: 0.5, checkpoint: '1/2', status: 'RUNNING' })
    })

    it('rejects Documents that have not completed entity resolution', () => {
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
      expect(() => sanitization.begin({ documentId: 'document-imported', jobId: 'sanitize-1', startedAt: 2 })).toThrow(
        'Document is not available for sanitization'
      )

      seedDetectedDocument('document-detected')
      expect(() => sanitization.begin({ documentId: 'document-detected', jobId: 'sanitize-2', startedAt: 8 })).toThrow(
        'Document is not available for sanitization'
      )
    })

    it('retries a FAILED Document only when its latest SANITIZE job failed', () => {
      seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-1', startedAt: 10 })
      const failed = sanitization.fail('document-1', 'sanitize-1', cipher('error'), 11)
      expect(failed.document.parseStatus).toBe('FAILED')
      expect(failed.job).toMatchObject({ status: 'FAILED', finishedAt: 11 })

      const retried = sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-2', startedAt: 12 })
      expect(retried.document.parseStatus).toBe('SANITIZING')
      expect(retried.job).toMatchObject({ id: 'sanitize-2', type: 'SANITIZE', status: 'RUNNING' })
      sanitization.complete(
        completeInput('document-1', {
          jobId: 'sanitize-2',
          sanitizedDocument: sanitizedDocument('document-1', 'sanitize-2'),
          finishedAt: 13
        })
      )
      expect(sanitization.findCompleted('document-1')?.job.id).toBe('sanitize-2')
    })

    it('rejects a Document that FAILED during entity resolution', () => {
      seedDetectedDocument('document-1')
      resolution.begin({ documentId: 'document-1', jobId: 'resolve-1', startedAt: 8 })
      resolution.fail('document-1', 'resolve-1', cipher('error'), 9)

      expect(() => sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-1', startedAt: 10 })).toThrow(
        'Failed Document did not fail during sanitization'
      )
    })

    it('rejects a Document that already has a sanitized artifact', () => {
      seedReadyDocument('document-1')
      sqlite
        .prepare(
          `INSERT INTO processing_jobs (id, document_id, job_type, status, progress, created_at, started_at, finished_at)
           VALUES ('sanitize-existing', 'document-1', 'SANITIZE', 'COMPLETED', 1, 10, 10, 11)`
        )
        .run()
      sqlite
        .prepare(
          `INSERT INTO sanitized_documents (id, matter_id, document_id, job_id, created_at)
           VALUES ('sanitized-foreign', 'matter-1', 'document-1', 'sanitize-existing', 10)`
        )
        .run()

      expect(() => sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-1', startedAt: 11 })).toThrow(
        'Document already has a sanitized artifact'
      )
    })
  })

  describe('complete', () => {
    it('persists the sanitized Document, blocks, and mappings atomically', () => {
      const { mentionA, mentionB } = seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      const result = sanitization.complete(
        completeInput('document-1', {
          mappings: [
            mapping('document-1', 'a', mentionA, 'entity-a-document-1'),
            mapping('document-1', 'b', mentionB, 'entity-b-document-1')
          ]
        })
      )

      expect(result.document.parseStatus).toBe('SANITIZED')
      expect(result.job).toMatchObject({ status: 'COMPLETED', progress: 1, finishedAt: 12 })
      expect(result.job.checkpoint).toBeUndefined()
      expect(result.sanitizedDocument).toEqual(sanitizedDocument('document-1', 'sanitize-document-1'))
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitized_documents').get()).toEqual({ count: 1 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitized_blocks').get()).toEqual({ count: 2 })
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM sanitization_mappings').get()).toEqual({ count: 2 })

      const completed = sanitization.findCompleted('document-1')
      expect(completed?.document.parseStatus).toBe('SANITIZED')
      expect(completed?.job.id).toBe('sanitize-document-1')
      expect(completed?.sanitizedDocument.id).toBe('sanitized-document-1')
    })

    it('rolls back every write when a mapping references a foreign Document Mention', () => {
      const { mentionA } = seedReadyDocument('document-1')
      const { mentionA: foreignMention } = seedReadyDocument('document-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      expect(() =>
        sanitization.complete(
          completeInput('document-1', {
            mappings: [
              mapping('document-1', 'a', mentionA, 'entity-a-document-1'),
              mapping('document-1', 'b', foreignMention, 'entity-a-document-1')
            ]
          })
        )
      ).toThrow('Sanitization mapping must cover every source Mention')
      expectStillSanitizing('document-1')
    })

    it('rolls back when a block references another Document', () => {
      seedReadyDocument('document-1')
      seedReadyDocument('document-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      const foreignBlock = {
        ...sanitizedBlock('document-2', 'a'),
        id: 'sblock-foreign',
        sanitizedDocumentId: 'sanitized-document-1'
      }
      expect(() =>
        sanitization.complete(completeInput('document-1', { blocks: [sanitizedBlock('document-1', 'a'), foreignBlock] }))
      ).toThrow('Sanitized block must belong to the sanitized Document')
      expectStillSanitizing('document-1')
    })

    it('rolls back when a mapping references an Entity from another Matter', () => {
      const { mentionA, mentionB } = seedReadyDocument('document-1')
      insertMatter('matter-2')
      insertEntity('entity-2', 'matter-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      expect(() =>
        sanitization.complete(
          completeInput('document-1', {
            mappings: [
              mapping('document-1', 'a', mentionA, 'entity-2'),
              mapping('document-1', 'b', mentionB, 'entity-b-document-1')
            ]
          })
        )
      ).toThrow('Sanitization mapping Entity must match the Mention assignment')
      expectStillSanitizing('document-1')
    })

    it('rejects an artifact that omits a source Block', () => {
      seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      expect(() => sanitization.complete(completeInput('document-1', { blocks: [] }))).toThrow(
        'Sanitization must produce exactly one SanitizedBlock per source Block'
      )
      expectStillSanitizing('document-1')
    })

    it('rejects an artifact that omits a source Mention mapping', () => {
      seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      expect(() => sanitization.complete(completeInput('document-1', { mappings: [] }))).toThrow(
        'Sanitization must produce exactly one mapping per source Mention'
      )
      expectStillSanitizing('document-1')
    })
  })

  describe('triggers', () => {
    it('rejects updates and deletes on persisted sanitized artifacts', () => {
      seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })
      sanitization.complete(completeInput('document-1'))

      expect(() =>
        sqlite.prepare(`UPDATE sanitized_documents SET created_at = 99 WHERE id = 'sanitized-document-1'`).run()
      ).toThrow('sanitized artifacts are append-only')
      expect(() => sqlite.prepare(`DELETE FROM sanitized_documents WHERE id = 'sanitized-document-1'`).run()).toThrow(
        'sanitized artifacts are append-only'
      )
      expect(() =>
        sqlite.prepare(`UPDATE sanitized_blocks SET created_at = 99 WHERE id = 'sblock-a-document-1'`).run()
      ).toThrow('sanitized artifacts are append-only')
      expect(() => sqlite.prepare(`DELETE FROM sanitized_blocks WHERE id = 'sblock-a-document-1'`).run()).toThrow(
        'sanitized artifacts are append-only'
      )
    })

    it('rejects updates and deletes on sanitization mappings', () => {
      seedReadyDocument('document-1')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })
      sanitization.complete(completeInput('document-1'))

      expect(() =>
        sqlite.prepare(`UPDATE sanitization_mappings SET alias = 'other' WHERE id = 'sm-a-document-1'`).run()
      ).toThrow('sanitized artifacts are append-only')
      expect(() => sqlite.prepare(`DELETE FROM sanitization_mappings WHERE id = 'sm-a-document-1'`).run()).toThrow(
        'sanitized artifacts are append-only'
      )
    })

    it('rejects a sanitized block whose block, page, and document do not line up', () => {
      seedReadyDocument('document-1')
      seedReadyDocument('document-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })
      sanitization.complete(completeInput('document-1'))

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sanitized_blocks
               (id, sanitized_document_id, document_id, page_id, block_id, text_cipher, created_at)
             VALUES ('sblock-foreign', 'sanitized-document-1', 'document-1', 'page-document-1', 'block-a-document-2', X'01', 12)`
          )
          .run()
      ).toThrow('sanitized block must belong to the sanitized Document hierarchy')
    })

    it('rejects a mapping whose Mention belongs to another Matter', () => {
      const { mentionA } = seedReadyDocument('document-1')
      insertMatter('matter-2')
      insertEntity('entity-2', 'matter-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })
      sanitization.complete(completeInput('document-1'))

      expect(mentionA).toBe('mention-a-document-1')
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sanitization_mappings
               (id, matter_id, sanitized_document_id, mention_id, entity_id, public_token, alias, restore_policy, created_at)
             VALUES ('sm-cross', 'matter-2', 'sanitized-document-1', 'mention-a-document-1', 'entity-2', '@P-entity-2', 'Alias entity-2', 'ALWAYS_RESTORE', 12)`
          )
          .run()
      ).toThrow('sanitization mapping references must belong to its Matter and sanitized Document')
    })

    it('rejects a sanitized Document whose Matter or Job does not match its Document', () => {
      seedReadyDocument('document-1')
      insertMatter('matter-2')
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sanitized_documents (id, matter_id, document_id, job_id, created_at)
             VALUES ('sanitized-cross-matter', 'matter-2', 'document-1', 'sanitize-document-1', 12)`
          )
          .run()
      ).toThrow('sanitized artifact must match its Document Matter and SANITIZE job')

      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO sanitized_documents (id, matter_id, document_id, job_id, created_at)
             VALUES ('sanitized-cross-job', 'matter-1', 'document-1', 'resolve-document-1', 12)`
          )
          .run()
      ).toThrow('sanitized artifact must match its Document Matter and SANITIZE job')
    })
  })

  describe('queries', () => {
    function seedSanitizedDocument(): { mentionA: string; mentionB: string } {
      const { mentionA, mentionB } = seedReadyDocument('document-1')
      entities.addAlias({
        id: 'alias-entity-a-document-1-historic',
        matterId: 'matter-1',
        entityId: 'entity-a-document-1',
        alias: 'Historic entity-a-document-1',
        aliasType: 'GENERIC',
        isPrimary: false,
        createdAt: 2
      })
      sanitization.begin({ documentId: 'document-1', jobId: 'sanitize-document-1', startedAt: 10 })
      sanitization.complete(
        completeInput('document-1', {
          // Inserted out of reading order on purpose.
          blocks: [sanitizedBlock('document-1', 'b'), sanitizedBlock('document-1', 'a')],
          mappings: [
            mapping('document-1', 'b', mentionB, 'entity-b-document-1'),
            mapping('document-1', 'a', mentionA, 'entity-a-document-1')
          ]
        })
      )
      return { mentionA, mentionB }
    }

    it('findCompleted is idempotent and reports corrupted state', () => {
      seedReadyDocument('document-ready')
      expect(sanitization.findCompleted('document-ready')).toBeUndefined()

      const { mentionA } = seedSanitizedDocument()
      const first = sanitization.findCompleted('document-1')
      const second = sanitization.findCompleted('document-1')
      expect(first).toEqual(second)
      expect(first?.sanitizedDocument.id).toBe('sanitized-document-1')
      expect(mentionA).toBe('mention-a-document-1')

      sqlite.prepare(`UPDATE documents SET parse_status = 'SANITIZED' WHERE id = 'document-ready'`).run()
      expect(() => sanitization.findCompleted('document-ready')).toThrow(
        'Sanitized Document is missing its completed ProcessingJob'
      )

      sqlite
        .prepare(
          `INSERT INTO processing_jobs (id, document_id, job_type, status, progress, created_at, started_at, finished_at)
           VALUES ('sanitize-orphan', 'document-ready', 'SANITIZE', 'COMPLETED', 1, 10, 10, 11)`
        )
        .run()
      expect(() => sanitization.findCompleted('document-ready')).toThrow(
        'Sanitized Document is missing its sanitized artifact'
      )
    })

    it('returns sanitized blocks in reading order with their ciphers', () => {
      seedSanitizedDocument()

      const blocks = sanitization.findSanitizedBlocks('sanitized-document-1')
      expect(blocks.map((block) => block.blockId)).toEqual(['block-a-document-1', 'block-b-document-1'])
      expect(blocks[0]).toMatchObject({
        id: 'sblock-a-document-1',
        sanitizedDocumentId: 'sanitized-document-1',
        documentId: 'document-1',
        pageId: 'page-document-1',
        textCipher: cipher('sblock-a-document-1')
      })
    })

    it('returns rehydration mappings with their value ciphers', () => {
      seedSanitizedDocument()

      const mappings = sanitization.findRehydrationMappings('sanitized-document-1')
      expect(mappings.map((item) => item.id)).toEqual(['sm-a-document-1', 'sm-b-document-1'])
      expect(mappings[0]).toMatchObject({
        mentionId: 'mention-a-document-1',
        entityId: 'entity-a-document-1',
        publicToken: valueToken('entity-a-document-1'),
        alias: 'Alias entity-a-document-1',
        restorePolicy: 'ALWAYS_RESTORE',
        protectedValueId: 'pv-a-document-1',
        valueCipher: Buffer.from([1])
      })
    })

    it('returns all Entity aliases for rehydration', () => {
      seedSanitizedDocument()

      expect(sanitization.findEntityAliases('matter-1', 'entity-a-document-1')).toEqual([
        'Alias entity-a-document-1',
        'Historic entity-a-document-1'
      ])
      expect(sanitization.findEntityAliases('matter-1', 'entity-b-document-1')).toEqual(['Alias entity-b-document-1'])
      expect(sanitization.findEntityAliases('matter-2', 'entity-a-document-1')).toEqual([])
    })

    it('fails closed if a persisted mapping no longer matches its Mention assignment', () => {
      seedSanitizedDocument()
      sqlite
        .prepare("UPDATE mentions SET protected_value_id = 'pv-b-document-1' WHERE id = 'mention-a-document-1'")
        .run()

      expect(() => sanitization.findRehydrationMappings('sanitized-document-1')).toThrow(
        'Sanitization mapping no longer matches its immutable Mention assignment'
      )
    })
  })

  describe('AI executions', () => {
    function runningExecution(id: string, sanitizedDocumentId: string, overrides: Partial<AiExecution> = {}): AiExecution {
      return {
        id,
        matterId: 'matter-1',
        sanitizedDocumentId,
        providerId: 'mock-v1',
        status: 'RUNNING',
        createdAt: 20,
        startedAt: 20,
        ...overrides
      }
    }

    it('returns the complete encrypted provider source in document order', () => {
      seedReadyDocument('document-other')
      const sanitizedDocumentId = seedAiSource()

      const source = aiExecutions.findSource(sanitizedDocumentId)

      expect(source?.sanitizedDocument).toMatchObject({
        id: sanitizedDocumentId,
        matterId: 'matter-1',
        documentId: 'document-ai'
      })
      expect(source?.blocks.map((block) => block.blockId)).toEqual([
        'block-a-document-ai',
        'block-b-document-ai'
      ])
      expect(source?.mappings.map((mapping) => mapping.mentionId)).toEqual([
        'mention-a-document-ai',
        'mention-b-document-ai'
      ])
      expect(source?.internalIdentifiers).toEqual(
        expect.arrayContaining([
          'matter-1',
          'document-ai',
          'sanitized-document-ai',
          'sblock-a-document-ai',
          'block-a-document-ai',
          'mention-a-document-ai',
          'entity-a-document-ai',
          'pv-a-document-ai'
        ])
      )
      // The denylist is Matter-wide: it includes values from another document
      // in the same Matter, not only this artifact's own mappings.
      expect(source?.matterDenylist.map((denied) => denied.id)).toEqual(
        expect.arrayContaining(['pv-a-document-other', 'pv-a-document-ai', 'pv-b-document-ai'])
      )
      expect(source?.matterDenylist.every((denied) => denied.valueType === 'PERSON_NAME')).toBe(true)
    })

    it('omits a value supported only by rejected Mentions from the outbound denylist', () => {
      seedReadyDocument('document-other')
      sqlite.prepare("UPDATE mentions SET review_status = 'REJECTED', entity_id = NULL WHERE document_id = 'document-other'").run()
      sqlite.prepare("DELETE FROM entity_protected_values WHERE protected_value_id = 'pv-a-document-other'").run()
      const sanitizedDocumentId = seedAiSource()

      expect(aiExecutions.findSource(sanitizedDocumentId)!.matterDenylist.map((denied) => denied.id)).not.toContain(
        'pv-a-document-other'
      )
    })

    it('caps the Matter denylist read at one row past the application limit', () => {
      const sanitizedDocumentId = seedAiSource()
      const insert = sqlite.prepare(
        `INSERT INTO protected_values (id, matter_id, value_type, value_cipher, fingerprint, public_token, restore_policy, created_at)
         VALUES (?, 'matter-1', 'PERSON_NAME', X'01', ?, ?, 'ALWAYS_RESTORE', 1)`
      )
      for (let index = 0; index < 2100; index += 1) {
        insert.run(`pv-flood-${index}`, Buffer.from(`fingerprint:pv-flood-${index}`), valueToken(`pv-flood-${index}`))
      }

      // The repository returns at most 2049 rows (one past the application
      // denylist cap) so an abnormal Matter is detectable without paying an
      // unbounded read.
      expect(aiExecutions.findSource(sanitizedDocumentId)!.matterDenylist).toHaveLength(2049)
    })

    it('persists an encrypted request and performs one terminal completion transition', () => {
      const sanitizedDocumentId = seedAiSource()
      const execution = runningExecution('ai-1', sanitizedDocumentId)

      expect(aiExecutions.begin({ execution, requestCipher: cipher('request') })).toMatchObject(execution)
      expect(aiExecutions.findLatest(sanitizedDocumentId)).toMatchObject({
        id: 'ai-1',
        status: 'RUNNING',
        requestCipher: cipher('request')
      })

      const completed = aiExecutions.complete('ai-1', cipher('response'), 21)
      expect(completed).toMatchObject({
        id: 'ai-1',
        status: 'COMPLETED',
        responseCipher: cipher('response'),
        finishedAt: 21
      })
      expect(() => aiExecutions.complete('ai-1', cipher('other'), 22)).toThrow('AI execution is not running')
      expect(() => sqlite.prepare(`UPDATE ai_executions SET finished_at = 99 WHERE id = 'ai-1'`).run()).toThrow(
        'AI execution permits one immutable terminal transition'
      )
      expect(() => sqlite.prepare(`DELETE FROM ai_executions WHERE id = 'ai-1'`).run()).toThrow(
        'AI executions are append-preserving'
      )
    })

    it('records a code-only encrypted failure and rejects cross-Matter sources', () => {
      const sanitizedDocumentId = seedAiSource()
      aiExecutions.begin({ execution: runningExecution('ai-failed', sanitizedDocumentId), requestCipher: cipher('request') })
      expect(aiExecutions.fail('ai-failed', cipher('error-code'), 21)).toMatchObject({
        status: 'FAILED',
        errorCipher: cipher('error-code')
      })

      insertMatter('matter-2')
      expect(() =>
        aiExecutions.begin({
          execution: runningExecution('ai-cross', sanitizedDocumentId, { matterId: 'matter-2' }),
          requestCipher: cipher('request')
        })
      ).toThrow('AI execution source is not an available Sanitized Document in the same Matter')
      expect(aiExecutions.findById('ai-cross')).toBeUndefined()
    })

    it('enforces Matter scope and sanitized state for direct SQL inserts', () => {
      const sanitizedDocumentId = seedAiSource()
      insertMatter('matter-2')
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO ai_executions
               (id, matter_id, sanitized_document_id, provider_id, status, request_cipher,
                response_cipher, created_at, started_at, finished_at)
             VALUES ('ai-terminal', 'matter-1', ?, 'mock-v1', 'COMPLETED', X'01', X'02', 20, 20, 21)`
          )
          .run(sanitizedDocumentId)
      ).toThrow('AI execution must start in RUNNING state')
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO ai_executions
               (id, matter_id, sanitized_document_id, provider_id, status, request_cipher, created_at, started_at)
             VALUES ('ai-cross', 'matter-2', ?, 'mock-v1', 'RUNNING', X'01', 20, 20)`
          )
          .run(sanitizedDocumentId)
      ).toThrow('AI execution must reference a sanitized Document in the same Matter')
    })
  })

  describe('protected value restoration token invariants', () => {
    it('rejects a duplicate restoration token in the same Matter', () => {
      insertProtectedValue('pv-1', valueToken('pv-1'))
      expect(() => insertProtectedValue('pv-2', valueToken('pv-1'))).toThrow(
        'UNIQUE constraint failed: protected_values.matter_id, protected_values.public_token'
      )
    })

    it('rejects a restoration token with an invalid format', () => {
      for (const [index, token] of ['@N-not-hex', '@N-A B', '@N-A.B', '@N-A@B', '@N-A-B'].entries()) {
        expect(() => insertProtectedValue(`pv-invalid-${index}`, token)).toThrow(
          'protected_values.public_token has an invalid format'
        )
      }
    })

    it('rejects a restoration token mutation', () => {
      insertProtectedValue('pv-1', valueToken('pv-1'))
      expect(() =>
        sqlite.prepare('UPDATE protected_values SET public_token = ? WHERE id = ?').run(valueToken('other'), 'pv-1')
      ).toThrow('protected_values.public_token is immutable')
    })

    it('allows backfilling a tokenless ProtectedValue', () => {
      sqlite
        .prepare(
          `INSERT INTO protected_values (id, matter_id, value_type, value_cipher, fingerprint, public_token, restore_policy, created_at)
           VALUES ('pv-1', 'matter-1', 'PERSON_NAME', X'01', X'02', NULL, 'ALWAYS_RESTORE', 1)`
        )
        .run()
      expect(() =>
        sqlite.prepare('UPDATE protected_values SET public_token = ? WHERE id = ?').run(valueToken('pv-1'), 'pv-1')
      ).not.toThrow()
    })
  })
})
