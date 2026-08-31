import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AnalysisFailureRepository,
  DocumentRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ReviewQueryRepository,
  createDatabase,
  migrateDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '../src/index'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('AnalysisFailureRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    new MatterRepository(db).create({
      id: 'matter-1',
      nameCipher: cipher('matter-name'),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
    const inserted = documents.create({
      id: 'document-1',
      matterId: 'matter-1',
      originalNameCipher: cipher('original-name'),
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 2,
      updatedAt: 2
    })
    void inserted
  })

  afterEach(() => sqlite.close())

  function setStatus(parseStatus: string, trashed = false): void {
    sqlite
      .prepare('UPDATE documents SET parse_status = ?, deleted_at = ? WHERE id = ?')
      .run(parseStatus, trashed ? 99 : null, 'document-1')
  }

  function currentState(): { parseStatus: string; jobTypes: string[]; jobStatuses: string[] } {
    const documentRow = sqlite.prepare('SELECT parse_status AS parseStatus FROM documents WHERE id = ?').get('document-1') as {
      parseStatus: string
    }
    const jobs = sqlite
      .prepare('SELECT job_type AS t, status AS s FROM processing_jobs WHERE document_id = ? ORDER BY created_at')
      .all('document-1') as { t: string; s: string }[]
    return { parseStatus: documentRow.parseStatus, jobTypes: jobs.map((job) => job.t), jobStatuses: jobs.map((job) => job.s) }
  }

  /** Promotes the seeded IMPORTED document through parsing so later-stage
   * source states (PARSED/DETECTED) exist with a real Document Model. */
  function seedParsedDocument(target: 'PARSED' | 'DETECTED' | 'READY' = 'PARSED'): void {
    documents.markProcessing('document-1', 'SYNTHETIC', 5)
    documents.completeProcessing({
      documentId: 'document-1',
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: 'page-1',
          documentId: 'document-1',
          pageNo: 1,
          originalWidth: 1,
          originalHeight: 1,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: 6
        }
      ],
      blocks: [
        {
          id: 'block-1',
          documentId: 'document-1',
          pageId: 'page-1',
          blockType: 'TEXT',
          textCipher: cipher('block-text'),
          source: 'NATIVE' as const,
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          readingOrder: 0,
          createdAt: 7
        }
      ],
      updatedAt: 8
    })
    if (target !== 'PARSED') {
      // Force the requested resting status for guard scenarios.
      sqlite.prepare('UPDATE documents SET parse_status = ? WHERE id = ?').run(target, 'document-1')
    }
  }

  it('finalizes an IMPORTED pre-start failure into FAILED with a PARSE job and cleared model', () => {
    const outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
      documentId: 'document-1',
      job: { id: 'job-1', type: 'PARSE', occurredAt: 10, errorCipher: cipher('code') }
    })

    expect(outcome).toBe('RECORDED')
    const state = currentState()
    expect(state.parseStatus).toBe('FAILED')
    expect(state.jobTypes).toEqual(['PARSE'])
    expect(state.jobStatuses).toEqual(['FAILED'])
    // Parsing invalidates the parsed Document Model on purpose.
    const pageCountRow = sqlite.prepare('SELECT page_count AS c FROM documents WHERE id = ?').get('document-1') as {
      c: number | null
    }
    expect(pageCountRow.c).toBeNull()
  })

  it('preserves pageCount when compensating DETECT and RESOLVE pre-start failures', () => {
    seedParsedDocument()
    let outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
      documentId: 'document-1',
      job: { id: 'job-d', type: 'DETECT', occurredAt: 10, errorCipher: cipher('code') }
    })
    expect(outcome).toBe('RECORDED')
    expect(currentState().parseStatus).toBe('FAILED')
    expect((sqlite.prepare('SELECT page_count AS c FROM documents WHERE id = ?').get('document-1') as { c: number }).c).toBe(1)

    setStatus('DETECTED')
    outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
      documentId: 'document-1',
      job: { id: 'job-r', type: 'RESOLVE', occurredAt: 20, errorCipher: cipher('code') }
    })
    expect(outcome).toBe('RECORDED')
    expect((sqlite.prepare('SELECT page_count AS c FROM documents WHERE id = ?').get('document-1') as { c: number }).c).toBe(1)
  })

  it.each([
    ['PARSED', 'RESOLVE'],
    ['PARSING', 'PARSE'],
    ['DETECTING', 'DETECT'],
    ['RESOLVING', 'RESOLVE']
  ] as const)('refuses to compensate %s with a %s failure record', (parseStatus, stage) => {
    if (parseStatus === 'PARSING') {
      documents.markProcessing('document-1', 'SYNTHETIC', 5)
    } else {
      seedParsedDocument(parseStatus === 'PARSED' ? 'PARSED' : parseStatus === 'DETECTING' ? 'PARSED' : 'DETECTED')
      if (parseStatus !== 'PARSED') {
        sqlite.prepare('UPDATE documents SET parse_status = ? WHERE id = ?').run(parseStatus, 'document-1')
      }
    }
    const before = currentState()
    const outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
      documentId: 'document-1',
      job: { id: `job-x`, type: stage, occurredAt: 30, errorCipher: cipher('code') }
    })
    expect(outcome).toBe('IGNORED')
    expect(currentState().parseStatus).toBe(before.parseStatus)
    expect(currentState().jobTypes).toEqual([])
  })

  it('leaves success / sanitize-domain / already-failed documents untouched', () => {
    seedParsedDocument()
    for (const parseStatus of ['READY', 'SANITIZING', 'SANITIZED', 'FAILED'] as const) {
      sqlite.prepare('UPDATE documents SET parse_status = ? WHERE id = ?').run(parseStatus, 'document-1')
      const outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: `job-y-${parseStatus}`, type: 'DETECT', occurredAt: 10, errorCipher: cipher('code') }
      })
      expect(outcome).toBe('IGNORED')
      expect(currentState().parseStatus).toBe(parseStatus)
      expect(currentState().jobTypes).toEqual([])
    }
  })

  it('never resurrects a trashed document or a deleted matter', () => {
    setStatus('IMPORTED', true)
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-t', type: 'PARSE', occurredAt: 10, errorCipher: cipher('code') }
      })
    ).toBe('IGNORED')

    // Flip back: document itself ACTIVE, only the Matter deleted — the guard
    // must come from matters.status, not from document.deleted_at.
    sqlite.prepare('UPDATE documents SET deleted_at = NULL WHERE id = ?').run('document-1')
    sqlite.prepare("UPDATE matters SET status = 'DELETED' WHERE id = 'matter-1'").run()
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-m', type: 'PARSE', occurredAt: 11, errorCipher: cipher('code') }
      })
    ).toBe('IGNORED')
    expect(currentState().parseStatus).toBe('IMPORTED')
    expect(currentState().jobTypes).toEqual([])
  })

  it('re-compensates a same-stage FAILED retry so every accepted attempt gets a new revision', () => {
    // First failure: IMPORTED -> FAILED(PARSE).
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-first', type: 'PARSE', occurredAt: 10, errorCipher: cipher('code') }
      })
    ).toBe('RECORDED')

    // Retry accepted, fails again before the stage transaction starts: a NEW
    // synthesized job row + newer updatedAt must land (new renderer revision).
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-retry', type: 'PARSE', occurredAt: 20, errorCipher: cipher('code') }
      })
    ).toBe('RECORDED')
    const state = currentState()
    expect(state.parseStatus).toBe('FAILED')
    expect(state.jobTypes).toEqual(['PARSE', 'PARSE'])
    const updatedAt = sqlite.prepare('SELECT updated_at AS u FROM documents WHERE id = ?').get('document-1') as { u: number }
    expect(updatedAt.u).toBe(20)
  })

  it('makes a same-millisecond retry strictly newer even when its ID sorts lower', () => {
    const failures = new AnalysisFailureRepository(db)
    expect(
      failures.recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-z-old', type: 'PARSE', occurredAt: 10, errorCipher: cipher('old') }
      })
    ).toBe('RECORDED')
    expect(
      failures.recordAnalysisFailure({
        documentId: 'document-1',
        job: {
          id: 'job-a-new',
          type: 'PARSE',
          occurredAt: 10,
          errorCipher: cipher('new'),
          expected: { parseStatus: 'FAILED', updatedAt: 10, failedJobId: 'job-z-old' }
        }
      })
    ).toBe('RECORDED')

    const latest = new ReviewQueryRepository(db).findLatestJobs('document-1').find((job) => job.type === 'PARSE')
    expect(latest?.id).toBe('job-a-new')
    expect(latest?.createdAt).toBe(11)
  })

  it('does not duplicate a stage-owned failure that already finalized itself', () => {
    seedParsedDocument()
    const detection = new PrivacyDetectionRepository(db)
    detection.begin({ documentId: 'document-1', jobId: 'job-owned', startedAt: 9 })
    detection.fail('document-1', 'job-owned', cipher('owned'), 10)

    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: {
          id: 'job-synthetic',
          type: 'DETECT',
          occurredAt: 10,
          errorCipher: cipher('outer'),
          expected: { parseStatus: 'PARSED', updatedAt: 8 }
        }
      })
    ).toBe('IGNORED')
    expect(currentState().jobTypes).toEqual(['DETECT'])
    expect(currentState().jobStatuses).toEqual(['FAILED'])
  })

  it('finalizes exactly the running owner when the stage failure write escaped', () => {
    seedParsedDocument()
    new PrivacyDetectionRepository(db).begin({ documentId: 'document-1', jobId: 'job-owned', startedAt: 9 })

    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: {
          id: 'job-unused',
          type: 'DETECT',
          occurredAt: 10,
          errorCipher: cipher('fallback'),
          owner: { jobId: 'job-owned' }
        }
      })
    ).toBe('RECORDED')
    expect(currentState().parseStatus).toBe('FAILED')
    expect(currentState().jobTypes).toEqual(['DETECT'])
    expect(currentState().jobStatuses).toEqual(['FAILED'])
  })

  it('infers the resting stage when the status projection itself failed', () => {
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-inferred', occurredAt: 10, errorCipher: cipher('status-read') }
      })
    ).toBe('RECORDED')
    expect(currentState().jobTypes).toEqual(['PARSE'])

    // An explicit retry may fail to read an already-FAILED projection too;
    // attribution comes from the latest failed job and still advances revision.
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-inferred-retry', occurredAt: 10, errorCipher: cipher('status-read-again') }
      })
    ).toBe('RECORDED')
    expect(new ReviewQueryRepository(db).findLatestJobs('document-1').find((job) => job.type === 'PARSE')?.id).toBe(
      'job-inferred-retry'
    )
  })

  it('keeps ignoring re-compensation from a different stage family', () => {
    sqlite.prepare("UPDATE documents SET parse_status = 'FAILED', updated_at = 10 WHERE id = 'document-1'").run()
    sqlite
      .prepare(
        "INSERT INTO processing_jobs (id, document_id, job_type, status, progress, error_cipher, created_at, started_at, finished_at) VALUES ('job-sanitize', 'document-1', 'SANITIZE', 'FAILED', 0, ?, 10, 10, 10)"
      )
      .run(cipher('code'))
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-other', type: 'PARSE', occurredAt: 30, errorCipher: cipher('code') }
      })
    ).toBe('IGNORED')
    expect(currentState().jobTypes).toEqual(['SANITIZE'])
  })

  it('refuses a compensation older than the document\'s last write', () => {
    // Seed a later write than the incoming compensation timestamp.
    sqlite.prepare('UPDATE documents SET updated_at = 100 WHERE id = ?').run('document-1')
    const outcome = new AnalysisFailureRepository(db).recordAnalysisFailure({
      documentId: 'document-1',
      job: { id: 'job-clock', type: 'PARSE', occurredAt: 50, errorCipher: cipher('code') }
    })
    expect(outcome).toBe('IGNORED')
    expect(currentState().parseStatus).toBe('IMPORTED')

    // Equal input time is allowed but is persisted as a strictly newer revision.
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'document-1',
        job: { id: 'job-clock-2', type: 'PARSE', occurredAt: 100, errorCipher: cipher('code') }
      })
    ).toBe('RECORDED')
    const updatedAt = sqlite.prepare('SELECT updated_at AS u FROM documents WHERE id = ?').get('document-1') as { u: number }
    expect(updatedAt.u).toBe(101)
  })

  it('ignores unknown documents entirely', () => {
    expect(
      new AnalysisFailureRepository(db).recordAnalysisFailure({
        documentId: 'missing-document',
        job: { id: 'job-u', type: 'RESOLVE', occurredAt: 10, errorCipher: cipher('code') }
      })
    ).toBe('IGNORED')
  })
})
