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
  SanitizationRepository,
  WorkspaceLifecycleRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  EntityResolutionService,
  MatterService,
  PseudonymizationService,
  ReviewOperationService,
  ReviewQueryService,
  WorkspaceLifecycleService,
  documentBlockTextContext,
  documentOriginalNameContext,
  mentionTextContext,
  type ApplicationKeys
} from '../src/index'

/**
 * Lifecycle guards at the persistence boundary: review writes, parsing, and
 * import must all fail closed once the target Document or Matter is trashed,
 * without partial state or audit events.
 */
describe('workspace lifecycle guards', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const keys: ApplicationKeys = { persistenceKey, searchKey: Buffer.alloc(32, 7) }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let lifecycle: WorkspaceLifecycleService
  let operations: ReviewOperationService
  let resolution: EntityResolutionService
  let reviewQuery: ReviewQueryService
  let timestamp: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    timestamp = 1_725_000_000_000
    lifecycle = new WorkspaceLifecycleService(
      new WorkspaceLifecycleRepository(db),
      documents,
      new MatterRepository(db),
      keys,
      () => timestamp++,
      (time) => `00000000-0000-7000-8000-${String(time % 10_000_000_000_000).padStart(12, '0')}`
    )
    reviewQuery = new ReviewQueryService(
      new ReviewQueryRepository(db),
      documents,
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    resolution = new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys,
      () => timestamp++
    )
    operations = new ReviewOperationService(resolution, reviewQuery)
    seedDocumentWithReviewableMention()
  })

  function seedDocumentWithReviewableMention(): void {
    new MatterService(new MatterRepository(db), { persistenceKey }, () => timestamp++).create('Synthetic Matter')
    sqlite.prepare("UPDATE matters SET id = 'matter-1' WHERE rowid = 1").run()
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
        publicToken: '@P-0000000000000001',
        status: 'ACTIVE',
        createdAt: 12,
        updatedAt: 12
      },
      primaryAlias: {
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Holder One',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 12
      },
      event: {
        id: 'event-seed',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-1',
        actor: 'USER',
        payloadCipher: encrypt(Buffer.from('{}'), persistenceKey, Buffer.from('event-seed:resolutionEvent.payload')),
        createdAt: 12
      }
    })
    sqlite.prepare("UPDATE documents SET parse_status = 'DETECTED' WHERE id = 'document-1'").run()
  }

  function resolutionEventCount(): number {
    return (sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number }).count
  }

  function documentCount(): number {
    return (sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count
  }

  describe('review writes fail closed on trashed Documents', () => {
    it('rejects assign, confirm, create-and-assign, reject, split, and manual mention without side effects', () => {
      // Assign while the Document is still active so confirm and split reach
      // their repository transaction guards instead of failing earlier on an
      // unassigned Mention. A second live Entity makes the post-trash assign a
      // genuine reassignment, so its failure can only come from the lifecycle
      // guard — not from a same-Entity no-op.
      operations.assignToEntity('mention-1', 'entity-1')
      sqlite
        .prepare(
          `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
           VALUES ('entity-2', 'matter-1', 'PERSON', '@P-0000000000000002', 'ACTIVE', 20, 20)`
        )
        .run()
      const eventsBefore = resolutionEventCount()
      expect(lifecycle.trashDocument('document-1')).toEqual({ changed: true })
      const mentionBefore = sqlite
        .prepare('SELECT entity_id, review_status FROM mentions WHERE id = ?')
        .get('mention-1') as { entity_id: string | null; review_status: string }

      expect(() => operations.assignToEntity('mention-1', 'entity-2')).toThrow(expect.objectContaining({ code: 'ASSIGNMENT_FAILED' }))
      expect(() => operations.confirmMention('mention-1')).toThrow(expect.objectContaining({ code: 'CONFIRMATION_FAILED' }))
      expect(() =>
        operations.createEntityAndAssign('mention-1', { primaryAlias: 'Party A', entityType: 'PERSON' })
      ).toThrow(expect.objectContaining({ code: 'ASSIGNMENT_FAILED' }))
      expect(() => operations.rejectMention('mention-1')).toThrow(expect.objectContaining({ code: 'REJECTION_FAILED' }))
      // Split composes createEntityWithAssignment, whose transaction guard
      // fails first; the inner ASSIGNMENT_FAILED code surfaces unchanged.
      expect(() => operations.splitMention('mention-1', 'Party B')).toThrow(
        expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
      )
      expect(() =>
        operations.createManualMention({ blockId: 'block-1', type: 'EMAIL', startOffset: 0, endOffset: 5 })
      ).toThrow(expect.objectContaining({ code: 'MANUAL_MENTION_FAILED' }))

      expect(resolutionEventCount()).toBe(eventsBefore)
      expect(
        sqlite.prepare('SELECT entity_id, review_status FROM mentions WHERE id = ?').get('mention-1')
      ).toEqual(mentionBefore)
      // No new entity or mention appeared either — in particular the split
      // created no half-built Entity.
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM entities').get() as { count: number }).count).toBe(2)
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM mentions').get() as { count: number }).count).toBe(1)
    })
  })

  describe('entity-level review writes fail closed on deleted Matters', () => {
    beforeEach(() => {
      expect(lifecycle.trashMatter('matter-1')).toEqual({ changed: true })
    })

    it('rejects rename, merge, and constraint operations without side effects', () => {
      const eventsBefore = resolutionEventCount()
      sqlite.prepare("INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at) VALUES ('entity-2', 'matter-1', 'PERSON', '@P-0000000000000002', 'ACTIVE', 20, 20)").run()

      expect(() => operations.renameEntity('entity-1', 'Party A')).toThrow(expect.objectContaining({ code: 'RENAME_FAILED' }))
      expect(() => operations.mergeEntities('entity-1', 'entity-2')).toThrow(expect.objectContaining({ code: 'MERGE_FAILED' }))
      expect(() =>
        operations.markConstraint('matter-1', 'entity-1', 'entity-2', 'CANNOT_LINK', 'Synthetic reason')
      ).toThrow(expect.objectContaining({ code: 'CONSTRAINT_FAILED' }))

      expect(resolutionEventCount()).toBe(eventsBefore)
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM entity_constraints').get() as { count: number }).count).toBe(0)
      expect((sqlite.prepare("SELECT status FROM entities WHERE id = 'entity-1'").get() as { status: string }).status).toBe('ACTIVE')
    })

    it('rejects mention-level operations inside a deleted Matter even without a per-document trash', () => {
      const eventsBefore = resolutionEventCount()
      expect(() => operations.assignToEntity('mention-1', 'entity-1')).toThrow(expect.objectContaining({ code: 'ASSIGNMENT_FAILED' }))
      expect(() => operations.rejectMention('mention-1')).toThrow(expect.objectContaining({ code: 'REJECTION_FAILED' }))
      expect(resolutionEventCount()).toBe(eventsBefore)
    })
  })

  describe('parsing and import fail closed on trashed lifecycle state', () => {
    it('blocks trash while a Document is PARSING even without a ProcessingJob row', () => {
      sqlite.prepare("UPDATE documents SET parse_status = 'PARSING' WHERE id = 'document-1'").run()
      expect(documents.findById('document-1')?.parseStatus).toBe('PARSING')

      try {
        lifecycle.trashDocument('document-1')
        expect.unreachable('parsing document should be busy')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('DOCUMENT_BUSY')
      }
      try {
        lifecycle.trashMatter('matter-1')
        expect.unreachable('parsing document should make the matter busy')
      } catch (error) {
        // The service maps both repository busy codes to the single
        // user-facing DOCUMENT_BUSY code from the plan's error table.
        expect((error as { code?: string }).code).toBe('DOCUMENT_BUSY')
      }
      expect(documents.findById('document-1')?.deletedAt).toBeUndefined()
    })

    it('refuses to start parsing a Document whose Matter was trashed mid-inspection', () => {
      // The exact TOCTOU state: the Matter is deleted by the time the import
      // transaction runs, even though the service pre-check passed earlier.
      lifecycle.trashMatter('matter-1')
      const decision = documents.createInAvailableMatter({
        id: 'document-late',
        matterId: 'matter-1',
        originalNameCipher: Buffer.from('late-cipher'),
        fileHash: 'hash-late',
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        createdAt: timestamp++,
        updatedAt: timestamp
      })
      expect(decision.status).toBe('MATTER_UNAVAILABLE')
      expect(documentCount()).toBe(1)

      sqlite.prepare("UPDATE documents SET deleted_at = 5 WHERE id = 'document-1'").run()
      expect(() => documents.markProcessing('document-1', 'SYNTHETIC-RETRY', timestamp + 5)).toThrow(
        'Document is not available for processing'
      )
      expect(documents.findById('document-1')?.parseStatus).toBe('DETECTED')
    })

    it('refuses to commit parsed content into a Document trashed mid-parse', () => {
      sqlite.prepare("UPDATE documents SET parse_status = 'PARSING', page_count = NULL WHERE id = 'document-1'").run()
      sqlite.prepare('DELETE FROM mentions WHERE document_id = ?').run('document-1')
      sqlite.prepare('DELETE FROM document_blocks WHERE document_id = ?').run('document-1')
      sqlite.prepare('DELETE FROM document_pages WHERE document_id = ?').run('document-1')
      // The lifecycle service would refuse this state (PARSING is busy); raw
      // SQL simulates the impossible-but-defended interleaving directly.
      sqlite.prepare("UPDATE documents SET deleted_at = 9 WHERE id = 'document-1'").run()

      expect(() =>
        documents.completeProcessing({
          documentId: 'document-1',
          parserType: 'SYNTHETIC',
          pageCount: 1,
          pages: [
            {
              id: 'page-late',
              documentId: 'document-1',
              pageNo: 1,
              originalWidth: 100,
              originalHeight: 100,
              rotation: 0,
              sourceType: 'NATIVE',
              createdAt: timestamp
            }
          ],
          blocks: [],
          updatedAt: timestamp
        })
      ).toThrow('Document is not available for processing')
      expect(documents.findById('document-1')?.parseStatus).toBe('PARSING')
      expect((sqlite.prepare("SELECT COUNT(*) AS count FROM document_pages WHERE document_id = 'document-1'").get() as { count: number }).count).toBe(0)
    })

    it('refuses to commit parsed content into a Document whose Matter was deleted mid-parse', () => {
      sqlite.prepare("UPDATE documents SET parse_status = 'PARSING', page_count = NULL WHERE id = 'document-1'").run()
      sqlite.prepare('DELETE FROM mentions WHERE document_id = ?').run('document-1')
      sqlite.prepare('DELETE FROM document_blocks WHERE document_id = ?').run('document-1')
      sqlite.prepare('DELETE FROM document_pages WHERE document_id = ?').run('document-1')
      sqlite.prepare("UPDATE matters SET status = 'DELETED' WHERE id = 'matter-1'").run()

      expect(() =>
        documents.completeProcessing({
          documentId: 'document-1',
          parserType: 'SYNTHETIC',
          pageCount: 1,
          pages: [
            {
              id: 'page-late',
              documentId: 'document-1',
              pageNo: 1,
              originalWidth: 100,
              originalHeight: 100,
              rotation: 0,
              sourceType: 'NATIVE',
              createdAt: timestamp
            }
          ],
          blocks: [],
          updatedAt: timestamp
        })
      ).toThrow('Document is not available for processing')
      expect(documents.findById('document-1')?.parseStatus).toBe('PARSING')
    })
  })

  describe('completed fast paths respect the lifecycle', () => {
    // A Document sits in exactly one completed stage at a time, so each fast
    // path gets its own fixture advanced through the real pipeline.
    it('stops reusing completed detection after Matter or Document trash', () => {
      const detection = new PrivacyDetectionRepository(db)
      expect(detection.findCompleted('document-1')).toBeDefined()

      lifecycle.trashMatter('matter-1')
      expect(detection.findCompleted('document-1')).toBeUndefined()
      lifecycle.restoreMatter('matter-1')
      expect(detection.findCompleted('document-1')).toBeDefined()
      lifecycle.trashDocument('document-1')
      expect(detection.findCompleted('document-1')).toBeUndefined()
    })

    it('stops reusing completed resolution after Matter or Document trash', async () => {
      await resolution.resolve('document-1')
      expect(documents.findById('document-1')?.parseStatus).toBe('READY')
      const resolutionRepository = new EntityResolutionRepository(db)
      expect(resolutionRepository.findCompleted('document-1')).toBeDefined()

      lifecycle.trashMatter('matter-1')
      expect(resolutionRepository.findCompleted('document-1')).toBeUndefined()
      lifecycle.restoreMatter('matter-1')
      expect(resolutionRepository.findCompleted('document-1')).toBeDefined()
      lifecycle.trashDocument('document-1')
      expect(resolutionRepository.findCompleted('document-1')).toBeUndefined()
    })

    it('stops reusing completed sanitization after Matter or Document trash', async () => {
      await resolution.resolve('document-1')
      await new PseudonymizationService(new SanitizationRepository(db), { persistenceKey }, () => timestamp++).sanitize(
        'document-1'
      )
      expect(documents.findById('document-1')?.parseStatus).toBe('SANITIZED')
      const sanitization = new SanitizationRepository(db)
      expect(sanitization.findCompleted('document-1')).toBeDefined()

      lifecycle.trashMatter('matter-1')
      expect(sanitization.findCompleted('document-1')).toBeUndefined()
      lifecycle.restoreMatter('matter-1')
      expect(sanitization.findCompleted('document-1')).toBeDefined()
      lifecycle.trashDocument('document-1')
      expect(sanitization.findCompleted('document-1')).toBeUndefined()
    })
  })
})
