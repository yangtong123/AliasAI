import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiExecutions,
  createDatabase,
  DocumentRepository,
  MatterRepository,
  migrateDatabase,
  processingJobs,
  ReviewQueryRepository,
  SanitizationRepository,
  sanitizedDocuments,
  WorkspaceLifecycleRepository,
  workspaceEvents
} from '../src/index'
import type { AliasAiDatabase, SqliteClient ,
  WorkspaceLifecycleRepositoryError} from '../src/index'
import type { WorkspaceEvent } from '@aliasai/domain'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('WorkspaceLifecycleRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let lifecycle: WorkspaceLifecycleRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    lifecycle = new WorkspaceLifecycleRepository(db)
  })

  afterEach(() => {
    sqlite.close()
  })

  function insertMatter(id = 'matter-1', status: 'ACTIVE' | 'ARCHIVED' | 'DELETED' = 'ACTIVE'): void {
    new MatterRepository(db).create({
      id,
      nameCipher: cipher(`matter-name-${id}`),
      status,
      createdAt: 1,
      updatedAt: 1
    })
  }

  function insertDocument(id = 'document-1', matterId = 'matter-1', fileHash = 'hash-1'): void {
    new DocumentRepository(db).create({
      id,
      matterId,
      originalNameCipher: cipher(`original-name-${id}`),
      fileHash,
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
  }

  function matterEvent(matterId: string, type: 'MATTER_TRASHED' | 'MATTER_RESTORED', seq: number): WorkspaceEvent {
    return { id: `event-matter-${seq}`, matterId, type, actor: 'USER', createdAt: 100 + seq }
  }

  function documentEvent(
    documentId: string,
    matterId: string,
    type: 'DOCUMENT_TRASHED' | 'DOCUMENT_RESTORED',
    seq: number
  ): WorkspaceEvent {
    return { id: `event-document-${seq}`, matterId, documentId, type, actor: 'USER', createdAt: 100 + seq }
  }

  function eventCount(): number {
    return (sqlite.prepare('SELECT count(*) AS count FROM workspace_events').get() as { count: number }).count
  }

  describe('trash and restore a Document atomically', () => {
    it('trashes and restores with exactly one event per real transition', () => {
      insertMatter()
      insertDocument()

      const trashed = lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      expect(trashed).toEqual({ changed: true })
      const afterTrash = new DocumentRepository(db).findById('document-1')
      expect(afterTrash?.deletedAt).toBe(101)
      expect(afterTrash?.updatedAt).toBe(101)
      expect(afterTrash?.parseStatus).toBe('IMPORTED')

      const restored = lifecycle.restoreDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_RESTORED', 2) })
      expect(restored).toEqual({ changed: true })
      expect(new DocumentRepository(db).findById('document-1')?.deletedAt).toBeUndefined()
      expect(eventCount()).toBe(2)
    })

    it('repeated trash and restore calls are no-ops without duplicate events', () => {
      insertMatter()
      insertDocument()

      expect(
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      ).toEqual({ changed: true })
      expect(
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 2) })
      ).toEqual({ changed: false })
      expect(eventCount()).toBe(1)

      expect(
        lifecycle.restoreDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_RESTORED', 3) })
      ).toEqual({ changed: true })
      expect(
        lifecycle.restoreDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_RESTORED', 4) })
      ).toEqual({ changed: false })
      expect(eventCount()).toBe(2)
    })

    it('rolls back state and event creation on a restore conflict', () => {
      insertMatter()
      insertDocument('document-old', 'matter-1', 'hash-1')
      lifecycle.trashDocument({ documentId: 'document-old', event: documentEvent('document-old', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      // The same file was re-imported while the old copy sat in trash.
      insertDocument('document-new', 'matter-1', 'hash-1')

      const eventsBefore = eventCount()
      try {
        lifecycle.restoreDocument({ documentId: 'document-old', event: documentEvent('document-old', 'matter-1', 'DOCUMENT_RESTORED', 2) })
        expect.unreachable('restore should have conflicted')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('RESTORE_CONFLICT')
      }
      // Nothing partial: the old Document stays trashed and no event was appended.
      expect(new DocumentRepository(db).findById('document-old')?.deletedAt).toBe(101)
      expect(new DocumentRepository(db).findById('document-new')?.deletedAt).toBeUndefined()
      expect(eventCount()).toBe(eventsBefore)
    })

    it('rejects restore while the parent Matter is deleted', () => {
      insertMatter()
      insertDocument()
      lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 2) })

      try {
        lifecycle.restoreDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_RESTORED', 3) })
        expect.unreachable('restore should have failed')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('MATTER_UNAVAILABLE')
      }
    })

    it('fails closed for missing IDs and cross-Matter events', () => {
      insertMatter('matter-1')
      insertMatter('matter-2')
      insertDocument('document-1', 'matter-1')

      try {
        lifecycle.trashDocument({ documentId: 'missing', event: documentEvent('missing', 'matter-1', 'DOCUMENT_TRASHED', 1) })
        expect.unreachable('missing document should fail')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('DOCUMENT_NOT_FOUND')
      }
      try {
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-2', 'DOCUMENT_TRASHED', 2) })
        expect.unreachable('cross-matter event should fail')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('MATTER_SCOPE_MISMATCH')
      }
      try {
        lifecycle.trashMatter({ matterId: 'missing', event: matterEvent('missing', 'MATTER_TRASHED', 3) })
        expect.unreachable('missing matter should fail')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('MATTER_NOT_FOUND')
      }
    })
  })

  describe('Matter trash and restore', () => {
    it('trashes and restores a Matter without rewriting child rows', () => {
      insertMatter()
      insertDocument('document-1', 'matter-1', 'hash-1')
      insertDocument('document-2', 'matter-1', 'hash-2')

      expect(lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 1) })).toEqual({ changed: true })
      expect(new MatterRepository(db).findById('matter-1')?.status).toBe('DELETED')
      // Child rows untouched.
      const documents = new DocumentRepository(db)
      expect(documents.findById('document-1')?.deletedAt).toBeUndefined()
      expect(documents.findById('document-2')?.deletedAt).toBeUndefined()

      expect(lifecycle.restoreMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_RESTORED', 2) })).toEqual({ changed: true })
      expect(new MatterRepository(db).findById('matter-1')?.status).toBe('ACTIVE')
      expect(eventCount()).toBe(2)
    })

    it('repeated Matter trash and restore calls are no-ops without duplicate events', () => {
      insertMatter()
      lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 1) })
      expect(lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 2) })).toEqual({ changed: false })
      expect(eventCount()).toBe(1)
      lifecycle.restoreMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_RESTORED', 3) })
      expect(lifecycle.restoreMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_RESTORED', 4) })).toEqual({ changed: false })
      expect(eventCount()).toBe(2)
    })

    it('keeps an individually trashed Document trashed after Matter restore', () => {
      insertMatter()
      insertDocument('document-1', 'matter-1', 'hash-1')
      insertDocument('document-2', 'matter-1', 'hash-2')
      lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 2) })
      lifecycle.restoreMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_RESTORED', 3) })

      const documents = new DocumentRepository(db)
      expect(documents.findById('document-1')?.deletedAt).toBe(101)
      expect(documents.findById('document-2')?.deletedAt).toBeUndefined()
    })

    it('restores an ARCHIVED Matter to ACTIVE', () => {
      insertMatter('matter-1', 'ARCHIVED')
      expect(lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 1) })).toEqual({ changed: true })
      expect(lifecycle.restoreMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_RESTORED', 2) })).toEqual({ changed: true })
      expect(new MatterRepository(db).findById('matter-1')?.status).toBe('ACTIVE')
    })
  })

  describe('running work blocks trash', () => {
    it('blocks Document and Matter trash while a ProcessingJob is PENDING or RUNNING', () => {
      insertMatter()
      insertDocument()
      for (const status of ['PENDING', 'RUNNING'] as const) {
        db.insert(processingJobs)
          .values({
            id: `job-${status}`,
            documentId: 'document-1',
            jobType: 'DETECT',
            status,
            progress: 0,
            ...(status === 'RUNNING' ? { startedAt: 2 } : {}),
            createdAt: 2
          })
          .run()
        try {
          lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
          expect.unreachable(`${status} job should block document trash`)
        } catch (error) {
          expect((error as WorkspaceLifecycleRepositoryError).code).toBe('DOCUMENT_BUSY')
        }
        try {
          lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 2) })
          expect.unreachable(`${status} job should block matter trash`)
        } catch (error) {
          expect((error as WorkspaceLifecycleRepositoryError).code).toBe('MATTER_BUSY')
        }
        db.delete(processingJobs).run()
      }
      expect(
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 3) })
      ).toEqual({ changed: true })
    })

    it('blocks Document and Matter trash while an AiExecution is RUNNING', () => {
      insertMatter()
      insertDocument()
      // The scope trigger requires a SANITIZED source document for executions.
      sqlite.prepare("UPDATE documents SET parse_status = 'SANITIZED' WHERE id = 'document-1'").run()
      db.insert(processingJobs)
        .values({ id: 'job-1', documentId: 'document-1', jobType: 'SANITIZE', status: 'COMPLETED', progress: 1, createdAt: 1, startedAt: 1, finishedAt: 1 })
        .run()
      db.insert(sanitizedDocuments)
        .values({ id: 'sanitized-1', matterId: 'matter-1', documentId: 'document-1', jobId: 'job-1', createdAt: 1 })
        .run()
      db.insert(aiExecutions)
        .values({
          id: 'execution-1',
          matterId: 'matter-1',
          sanitizedDocumentId: 'sanitized-1',
          providerId: 'mock',
          status: 'RUNNING',
          requestCipher: cipher('request'),
          createdAt: 2,
          startedAt: 2
        })
        .run()
      expect(new SanitizationRepository(db).findCompleted('document-1')).toBeDefined()

      try {
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
        expect.unreachable('running AI execution should block document trash')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('DOCUMENT_BUSY')
      }
      try {
        lifecycle.trashMatter({ matterId: 'matter-1', event: matterEvent('matter-1', 'MATTER_TRASHED', 2) })
        expect.unreachable('running AI execution should block matter trash')
      } catch (error) {
        expect((error as WorkspaceLifecycleRepositoryError).code).toBe('MATTER_BUSY')
      }
      db.update(aiExecutions).set({ status: 'FAILED', errorCipher: cipher('error'), finishedAt: 3 }).run()
      expect(
        lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 3) })
      ).toEqual({ changed: true })
    })
  })

  describe('normal and trash read paths', () => {
    it('normal lists exclude trash and trash lists contain it', () => {
      insertMatter('matter-1')
      insertMatter('matter-2')
      insertDocument('document-1', 'matter-1', 'hash-1')
      insertDocument('document-2', 'matter-1', 'hash-2')
      insertDocument('document-3', 'matter-2', 'hash-3')
      const review = new ReviewQueryRepository(db)

      lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      lifecycle.trashMatter({ matterId: 'matter-2', event: matterEvent('matter-2', 'MATTER_TRASHED', 2) })

      expect(review.listMatters().map((matter) => matter.id)).toEqual(['matter-1'])
      expect(review.listDocumentsByMatter('matter-1').map((item) => item.document.id)).toEqual(['document-2'])
      // A deleted Matter's list is empty and its Documents are not duplicated
      // into the trash document list.
      expect(review.listDocumentsByMatter('matter-2')).toEqual([])

      const trash = lifecycle.listTrash()
      expect(trash.matters.map((item) => item.matter.id)).toEqual(['matter-2'])
      expect(trash.documents.map((item) => item.document.id)).toEqual(['document-1'])
      expect(trash.documents[0]?.matterNameCipher).toBeDefined()
    })

    it('listTrash ordering is newest deletion first', () => {
      insertMatter('matter-1')
      insertDocument('document-1', 'matter-1', 'hash-1')
      insertDocument('document-2', 'matter-1', 'hash-2')
      lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
      lifecycle.trashDocument({ documentId: 'document-2', event: documentEvent('document-2', 'matter-1', 'DOCUMENT_TRASHED', 2) })

      expect(new WorkspaceLifecycleRepository(db).listTrash().documents.map((item) => item.document.id)).toEqual([
        'document-2',
        'document-1'
      ])
    })
  })

  it('import deduplication searches active Documents only', () => {
    insertMatter()
    const documents = new DocumentRepository(db)
    insertDocument('document-1', 'matter-1', 'hash-1')
    expect(documents.findByMatterAndFileHash('matter-1', 'hash-1')?.id).toBe('document-1')

    lifecycle.trashDocument({ documentId: 'document-1', event: documentEvent('document-1', 'matter-1', 'DOCUMENT_TRASHED', 1) })
    expect(documents.findByMatterAndFileHash('matter-1', 'hash-1')).toBeUndefined()
  })

  it('workspace events are append-only', () => {
    insertMatter()
    db.insert(workspaceEvents)
      .values({ id: 'event-1', matterId: 'matter-1', eventType: 'MATTER_TRASHED', actor: 'USER', createdAt: 10 })
      .run()
    expect(() => sqlite.prepare("UPDATE workspace_events SET event_type = 'MATTER_RESTORED'").run()).toThrowError(/append-only/)
    expect(() => sqlite.prepare('DELETE FROM workspace_events').run()).toThrowError(/append-only/)
  })

  it('rejects a document event whose document belongs to another Matter', () => {
    insertMatter('matter-1')
    insertMatter('matter-2')
    insertDocument('document-1', 'matter-1', 'hash-1')
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO workspace_events (id, matter_id, document_id, event_type, actor, created_at) VALUES ('event-x', 'matter-2', 'document-1', 'DOCUMENT_TRASHED', 'USER', 10)"
        )
        .run()
    ).toThrowError(/must belong to its Matter/)
  })
})
