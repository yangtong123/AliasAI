import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  createDatabase,
  documentBlocks,
  documentPages,
  migrateDatabase,
  processingJobs,
  type AliasAiDatabase,
  type SqliteClient
} from '../src/index'
import Database from 'better-sqlite3'

describe('PrivacyDetectionRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let repository: PrivacyDetectionRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    repository = new PrivacyDetectionRepository(db)
    new MatterRepository(db).create({
      id: 'matter-1',
      nameCipher: Buffer.from('cipher'),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
    const documents = new DocumentRepository(db)
    documents.create({
      id: 'document-1',
      matterId: 'matter-1',
      originalNameCipher: Buffer.from('cipher'),
      fileHash: 'hash',
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
      blocks: [{
        id: 'block-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockType: 'TEXT',
        textCipher: Buffer.from('synthetic-encrypted-block'),
        source: 'NATIVE',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        readingOrder: 0,
        createdAt: 3
      }],
      updatedAt: 4
    })
  })

  afterEach(() => sqlite.close())

  it('begins with an atomic Document/job transition and ordered encrypted Blocks', () => {
    const begun = repository.begin({ documentId: 'document-1', jobId: 'job-1', startedAt: 5 })

    expect(begun.document.parseStatus).toBe('DETECTING')
    expect(begun.job).toMatchObject({ type: 'DETECT', status: 'RUNNING', progress: 0 })
    expect(begun.blocks).toHaveLength(1)
    expect(begun.blocks[0]).toMatchObject({ matterId: 'matter-1', pageId: 'page-1', id: 'block-1' })
  })

  it('rolls back every Mention and terminal state when one insert violates its Block boundary', () => {
    repository.begin({ documentId: 'document-1', jobId: 'job-1', startedAt: 5 })
    const base = {
      matterId: 'matter-1',
      documentId: 'document-1',
      pageId: 'page-1',
      type: 'EMAIL' as const,
      strength: 'EXPLICIT' as const,
      textCipher: Buffer.from('cipher'),
      startOffset: 0,
      endOffset: 22,
      detector: 'REGEX' as const,
      confidence: 1,
      reviewStatus: 'UNREVIEWED' as const,
      createdAt: 6
    }

    expect(() => repository.complete({
      documentId: 'document-1',
      jobId: 'job-1',
      mentions: [
        { ...base, id: 'mention-valid', blockId: 'block-1' },
        { ...base, id: 'mention-invalid', blockId: 'missing-block' }
      ],
      finishedAt: 7
    })).toThrow()

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM mentions').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get('document-1')).toEqual({
      parse_status: 'DETECTING'
    })
    expect(sqlite.prepare('SELECT status FROM processing_jobs WHERE id = ?').get('job-1')).toEqual({ status: 'RUNNING' })
  })

  it('rejects corrupt ProcessingJob lifecycle rows at the SQLite boundary', () => {
    expect(() => db.insert(processingJobs).values({
      id: 'invalid-job',
      documentId: 'document-1',
      jobType: 'DETECT',
      status: 'COMPLETED',
      progress: 0.5,
      createdAt: 5,
      startedAt: 5,
      finishedAt: 6
    }).run()).toThrow(/CHECK constraint failed/)
  })

  it('prevents parsing retry after a downstream detection failure retained Pages', () => {
    repository.begin({ documentId: 'document-1', jobId: 'job-1', startedAt: 5 })
    repository.fail('document-1', 'job-1', Buffer.from('encrypted-error'), 6)

    expect(() => new DocumentRepository(db).markProcessing('document-1', 'NATIVE_PDF', 7)).toThrow(
      'A failed downstream stage cannot be retried as document parsing'
    )
    expect(db.select().from(documentPages).all()).toHaveLength(1)
    expect(db.select().from(documentBlocks).all()).toHaveLength(1)
  })
})
