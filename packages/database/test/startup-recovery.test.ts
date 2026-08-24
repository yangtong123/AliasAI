import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AiExecutionRepository,
  DocumentRepository,
  MatterRepository,
  StartupRecoveryRepository,
  aiExecutions,
  documents,
  migrateDatabase,
  openDatabase,
  processingJobs,
  sanitizedDocuments,
  type AliasAiDatabase,
  type SqliteClient
} from '../src'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('StartupRecoveryRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    seedInterruptedWork()
  })

  afterEach(() => sqlite.close())

  it('atomically fails interrupted jobs, AI executions, and in-flight Documents', () => {
    const repository = new StartupRecoveryRepository(db)
    expect(repository.findInterrupted()).toEqual({
      processingJobs: [{ id: 'job-detect', startedAt: 5 }],
      aiExecutions: [{ id: 'ai-running', startedAt: 7 }],
      documents: expect.arrayContaining([
        { id: 'document-parse', updatedAt: 4 },
        { id: 'document-detect', updatedAt: 5 }
      ])
    })

    expect(
      repository.recover({
        finishedAt: 10,
        processingJobs: [{ id: 'job-detect', errorCipher: cipher('job-interrupted') }],
        aiExecutions: [{ id: 'ai-running', errorCipher: cipher('ai-interrupted') }]
      })
    ).toEqual({ processingJobs: 1, aiExecutions: 1, documents: 2 })

    expect(db.select().from(processingJobs).all()).toEqual([
      expect.objectContaining({ id: 'job-sanitize', status: 'COMPLETED' }),
      expect.objectContaining({
        id: 'job-detect',
        status: 'FAILED',
        finishedAt: 10,
        errorCipher: cipher('job-interrupted')
      })
    ])
    expect(new AiExecutionRepository(db).findById('ai-running')).toMatchObject({
      status: 'FAILED',
      finishedAt: 10,
      errorCipher: cipher('ai-interrupted')
    })
    expect(new DocumentRepository(db).findById('document-parse')).toMatchObject({ parseStatus: 'FAILED' })
    expect(new DocumentRepository(db).findById('document-detect')).toMatchObject({ parseStatus: 'FAILED', pageCount: 1 })
    expect(new DocumentRepository(db).findById('document-sanitized')).toMatchObject({ parseStatus: 'SANITIZED' })
  })

  it('rolls back without partial recovery when the submitted running set is incomplete', () => {
    const repository = new StartupRecoveryRepository(db)

    expect(() =>
      repository.recover({
        finishedAt: 10,
        processingJobs: [{ id: 'job-detect', errorCipher: cipher('job-interrupted') }],
        aiExecutions: []
      })
    ).toThrow('Interrupted work changed before recovery')

    expect(db.select().from(processingJobs).all()).toEqual([
      expect.objectContaining({ id: 'job-sanitize', status: 'COMPLETED' }),
      expect.objectContaining({ id: 'job-detect', status: 'RUNNING' })
    ])
    expect(new AiExecutionRepository(db).findById('ai-running')).toMatchObject({ status: 'RUNNING' })
    expect(new DocumentRepository(db).findById('document-detect')).toMatchObject({ parseStatus: 'DETECTING' })
  })

  function seedInterruptedWork(): void {
    new MatterRepository(db).create({
      id: 'matter-1',
      nameCipher: cipher('matter'),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
    db.insert(documents)
      .values([
        {
          id: 'document-parse',
          matterId: 'matter-1',
          originalNameCipher: cipher('parse.pdf'),
          fileHash: 'hash-parse',
          mimeType: 'application/pdf',
          parseStatus: 'PARSING',
          createdAt: 2,
          updatedAt: 4
        },
        {
          id: 'document-detect',
          matterId: 'matter-1',
          originalNameCipher: cipher('detect.pdf'),
          fileHash: 'hash-detect',
          mimeType: 'application/pdf',
          parserType: 'SYNTHETIC',
          pageCount: 1,
          parseStatus: 'DETECTING',
          createdAt: 2,
          updatedAt: 5
        },
        {
          id: 'document-sanitized',
          matterId: 'matter-1',
          originalNameCipher: cipher('sanitized.pdf'),
          fileHash: 'hash-sanitized',
          mimeType: 'application/pdf',
          parserType: 'SYNTHETIC',
          pageCount: 1,
          parseStatus: 'SANITIZED',
          createdAt: 2,
          updatedAt: 6
        }
      ])
      .run()
    db.insert(processingJobs)
      .values([
        {
          id: 'job-sanitize',
          documentId: 'document-sanitized',
          jobType: 'SANITIZE',
          status: 'COMPLETED',
          progress: 1,
          createdAt: 3,
          startedAt: 3,
          finishedAt: 6
        },
        {
          id: 'job-detect',
          documentId: 'document-detect',
          jobType: 'DETECT',
          status: 'RUNNING',
          progress: 0.5,
          createdAt: 5,
          startedAt: 5
        }
      ])
      .run()
    db.insert(sanitizedDocuments)
      .values({
        id: 'sanitized-1',
        matterId: 'matter-1',
        documentId: 'document-sanitized',
        jobId: 'job-sanitize',
        createdAt: 6
      })
      .run()
    db.insert(aiExecutions)
      .values({
        id: 'ai-running',
        matterId: 'matter-1',
        sanitizedDocumentId: 'sanitized-1',
        providerId: 'mock-v1',
        status: 'RUNNING',
        requestCipher: cipher('request'),
        createdAt: 7,
        startedAt: 7
      })
      .run()
  }
})
