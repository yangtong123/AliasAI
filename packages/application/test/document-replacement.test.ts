import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DocumentRepository,
  MatterRepository,
  ReviewQueryRepository,
  WorkspaceLifecycleRepository,
  migrateDatabase,
  openDatabase
} from '@aliasai/database'
import type {
  DocumentReplacementError} from '../src/index';
import {
  DocumentImportService,
  DocumentReplacementService,
  MatterService
} from '../src/index'
import type { AliasAiDatabase, SqliteClient } from '@aliasai/database'

describe('document replacement', () => {
  const key = Buffer.alloc(32, 9)
  const temporaryDirectories: string[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let timestamp: number
  let matters: MatterService
  let imports: DocumentImportService
  let replacement: DocumentReplacementService
  let documents: DocumentRepository

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    timestamp = 1_725_000_000_000
    const nextTime = () => timestamp++
    matters = new MatterService(new MatterRepository(db), { persistenceKey: key }, nextTime)
    documents = new DocumentRepository(db)
    imports = new DocumentImportService(documents, new MatterRepository(db), { persistenceKey: key }, nextTime)
    replacement = new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      new MatterRepository(db),
      { persistenceKey: key },
      nextTime,
      (time) => `00000000-0000-7000-8000-${String(time % 10_000_000_000_000).padStart(12, '0')}`
    )
  })

  afterEach(async () => {
    sqlite.close()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function writeSource(name: string, content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-replace-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, name)
    await writeFile(sourcePath, content)
    return sourcePath
  }

  it('replaces an active Document in one atomic step', async () => {
    const matter = matters.create('Synthetic Matter')
    const firstPath = await writeSource('first.pdf', 'first content')
    const old = await imports.importFromPath(matter.id, firstPath)
    const newPath = await writeSource('second.pdf', 'second content')

    const replaced = await replacement.replaceFromPath(old.id, newPath)

    expect(replaced.id).not.toBe(old.id)
    expect(replaced.supersedesDocumentId).toBe(old.id)
    expect(replaced.parseStatus).toBe('IMPORTED')
    expect(replaced.deletedAt).toBeUndefined()

    const oldRow = documents.findById(old.id)
    expect(oldRow?.deletedAt).toBeDefined()
    expect(oldRow?.supersedesDocumentId).toBeUndefined()
    expect(documents.findById(replaced.id)?.deletedAt).toBeUndefined()

    const review = new ReviewQueryRepository(db)
    expect(review.listDocumentsByMatter(matter.id).map((item) => item.document.id)).toEqual([replaced.id])
    const trash = new WorkspaceLifecycleRepository(db).listTrash()
    expect(trash.documents.map((item) => item.document.id)).toEqual([old.id])

    const events = sqlite
      .prepare('SELECT event_type, document_id, superseded_document_id FROM workspace_events')
      .all() as Array<{ event_type: string; document_id: string | null; superseded_document_id: string | null }>
    expect(events).toEqual([
      { event_type: 'DOCUMENT_REPLACED', document_id: replaced.id, superseded_document_id: old.id }
    ])
  })

  it('replaces with the identical file and copies nothing from the old pipeline data', async () => {
    const matter = matters.create('Synthetic Matter')
    const sourcePath = await writeSource('same.pdf', 'same content')
    const old = await imports.importFromPath(matter.id, sourcePath)

    const replaced = await replacement.replaceFromPath(old.id, sourcePath)
    expect(replaced.fileHash).toBe(old.fileHash)
    expect(replaced.id).not.toBe(old.id)

    // The replacement is a brand-new Document: no pages, blocks, mentions,
    // jobs, sanitized artifacts, or AI executions travel with it.
    for (const table of ['document_pages', 'document_blocks', 'mentions', 'processing_jobs', 'sanitized_documents']) {
      const rows = sqlite
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_id = ?`)
        .get(replaced.id) as { count: number }
      expect(rows.count, `${table} must stay empty for the replacement`).toBe(0)
    }
    const executions = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM ai_executions ae
         JOIN sanitized_documents sd ON sd.id = ae.sanitized_document_id
         WHERE sd.document_id = ?`
      )
      .get(replaced.id) as { count: number }
    expect(executions.count).toBe(0)
  })

  it('fails with RESTORE_CONFLICT when another active Document already has the file hash', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    const occupied = await imports.importFromPath(matter.id, await writeSource('occupied.pdf', 'occupied content'))

    try {
      await replacement.replaceFromPath(old.id, await writeSource('copy.pdf', 'occupied content'))
      expect.unreachable('replacement should conflict')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('RESTORE_CONFLICT')
    }
    // The old Document stays active and no event was appended.
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect(documents.findById(occupied.id)?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as { count: number }).count).toBe(0)
  })

  it('fails with DOCUMENT_BUSY while the old Document has running work', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    sqlite
      .prepare(
        `INSERT INTO processing_jobs (id, document_id, job_type, status, progress, created_at, started_at)
         VALUES ('job-running', ?, 'DETECT', 'RUNNING', 0, ?, ?)`
      )
      .run(old.id, timestamp, timestamp)

    try {
      await replacement.replaceFromPath(old.id, await writeSource('new.pdf', 'new content'))
      expect.unreachable('replacement should be busy')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('DOCUMENT_BUSY')
    }
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count).toBe(1)
  })

  it('leaves the old Document active when the replacement source cannot be read', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))

    try {
      await replacement.replaceFromPath(old.id, join(tmpdir(), 'aliasai-missing-replacement.pdf'))
      expect.unreachable('missing source should fail')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('REPLACE_OPERATION_FAILED')
    }
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count).toBe(1)
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as { count: number }).count).toBe(0)
  })

  function seedFullPipelineData(documentId: string, matterId: string): void {
    sqlite.prepare("UPDATE documents SET parse_status = 'SANITIZED' WHERE id = ?").run(documentId)
    sqlite
      .prepare(
        `INSERT INTO document_pages (id, document_id, page_no, original_width, original_height, rotation, source_type, created_at)
         VALUES ('page-seed', ?, 1, 100, 100, 0, 'NATIVE', 10)`
      )
      .run(documentId)
    sqlite
      .prepare(
        `INSERT INTO document_blocks (id, document_id, page_id, block_type, text_cipher, source, x, y, width, height, reading_order, created_at)
         VALUES ('block-seed', ?, 'page-seed', 'TEXT', ?, 'NATIVE', 0, 0, 1, 1, 0, 10)`
      )
      .run(documentId, Buffer.from('block-cipher'))
    sqlite
      .prepare(
        `INSERT INTO mentions (id, matter_id, document_id, page_id, block_id, mention_type, mention_strength, text_cipher, start_offset, end_offset, detector, confidence, review_status, created_at)
         VALUES ('mention-seed', ?, ?, 'page-seed', 'block-seed', 'EMAIL', 'EXPLICIT', ?, 0, 6, 'REGEX', 0.9, 'UNREVIEWED', 11)`
      )
      .run(matterId, documentId, Buffer.from('mention-cipher'))
    sqlite
      .prepare(
        `INSERT INTO processing_jobs (id, document_id, job_type, status, progress, created_at, started_at, finished_at)
         VALUES ('job-seed-sanitize', ?, 'SANITIZE', 'COMPLETED', 1, 12, 12, 12)`
      )
      .run(documentId)
    sqlite
      .prepare(
        `INSERT INTO sanitized_documents (id, matter_id, document_id, job_id, created_at)
         VALUES ('sanitized-seed', ?, ?, 'job-seed-sanitize', 12)`
      )
      .run(matterId, documentId)
    sqlite
      .prepare(
        `INSERT INTO ai_executions (id, matter_id, sanitized_document_id, provider_id, status, request_cipher, created_at, started_at)
         VALUES ('execution-seed', ?, 'sanitized-seed', 'mock-v1', 'RUNNING', ?, 13, 13)`
      )
      .run(matterId, Buffer.from('request-cipher'))
    sqlite
      .prepare(
        `UPDATE ai_executions SET status = 'COMPLETED', response_cipher = ?, finished_at = 14 WHERE id = 'execution-seed'`
      )
      .run(Buffer.from('response-cipher'))
  }

  it('copies nothing from a fully populated old Document', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    seedFullPipelineData(old.id, matter.id)

    const replaced = await replacement.replaceFromPath(old.id, await writeSource('new.pdf', 'new content'))

    // The replacement is empty in every pipeline table...
    for (const table of ['document_pages', 'document_blocks', 'mentions', 'processing_jobs', 'sanitized_documents']) {
      const rows = sqlite
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_id = ?`)
        .get(replaced.id) as { count: number }
      expect(rows.count, `${table} must stay empty for the replacement`).toBe(0)
    }
    const executions = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM ai_executions ae
         JOIN sanitized_documents sd ON sd.id = ae.sanitized_document_id
         WHERE sd.document_id = ?`
      )
      .get(replaced.id) as { count: number }
    expect(executions.count).toBe(0)

    // ...while the old Document keeps every row it produced.
    for (const [table, expected] of [
      ['document_pages', 1],
      ['document_blocks', 1],
      ['mentions', 1],
      ['processing_jobs', 1],
      ['sanitized_documents', 1]
    ] as const) {
      const rows = sqlite
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE document_id = ?`)
        .get(old.id) as { count: number }
      expect(rows.count, `${table} must stay intact for the old Document`).toBe(expected)
    }
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM ai_executions WHERE id = 'execution-seed'").get() as { count: number }).count
    ).toBe(1)
  })

  it('rolls the whole replacement back when the event insert fails mid-transaction', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    // A colliding event primary key makes the final insert fail after the old
    // Document was already trashed inside the transaction.
    sqlite
      .prepare(
        `INSERT INTO workspace_events (id, matter_id, event_type, actor, created_at)
         VALUES ('00000000-0000-7000-8000-000000000001', ?, 'MATTER_TRASHED', 'USER', 1)`
      )
      .run(matter.id)
    const colliding = new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      new MatterRepository(db),
      { persistenceKey: key },
      () => 1_725_000_000_000,
      () => '00000000-0000-7000-8000-000000000001'
    )

    try {
      await colliding.replaceFromPath(old.id, await writeSource('new.pdf', 'new content'))
      expect.unreachable('event collision should fail the replacement')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('REPLACE_OPERATION_FAILED')
    }
    // The old Document is active again, no replacement or event row exists.
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count).toBe(1)
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM workspace_events WHERE event_type = 'DOCUMENT_REPLACED'").get() as { count: number }).count
    ).toBe(0)
  })

  it('rejects replacing a restored old version with LINEAGE_CONFLICT', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    const first = await replacement.replaceFromPath(old.id, await writeSource('first.pdf', 'first content'))

    // Restore the old version and try to replace it again: lineage is linear,
    // so this must not fork into old -> first AND old -> second.
    const lifecycle = new WorkspaceLifecycleRepository(db)
    lifecycle.restoreDocument({
      documentId: old.id,
      event: {
        id: 'event-restore', matterId: matter.id, documentId: old.id,
        type: 'DOCUMENT_RESTORED', actor: 'USER', createdAt: timestamp++
      }
    })
    try {
      await replacement.replaceFromPath(old.id, await writeSource('second.pdf', 'second content'))
      expect.unreachable('second replacement should conflict')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('LINEAGE_CONFLICT')
    }
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect(documents.findById(first.id)?.deletedAt).toBeUndefined()
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM documents WHERE supersedes_document_id IS NOT NULL').get() as { count: number }).count
    ).toBe(1)
  })

  it('maps repository read and ID-generation failures to REPLACE_OPERATION_FAILED', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    const sourcePath = await writeSource('new.pdf', 'new content')

    const failingReads = new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      new MatterRepository(db),
      { persistenceKey: key },
      () => timestamp++
    )
    const findByIdSpy = vi.spyOn(documents, 'findById').mockImplementation(() => {
      throw new Error('SqliteError: database is locked')
    })
    try {
      await failingReads.replaceFromPath(old.id, sourcePath)
      expect.unreachable('read failure should map to REPLACE_OPERATION_FAILED')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('REPLACE_OPERATION_FAILED')
    } finally {
      findByIdSpy.mockRestore()
    }

    const failingIds = new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      new MatterRepository(db),
      { persistenceKey: key },
      () => timestamp++,
      () => {
        throw new Error('entropy source exhausted')
      }
    )
    try {
      await failingIds.replaceFromPath(old.id, sourcePath)
      expect.unreachable('ID failure should map to REPLACE_OPERATION_FAILED')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('REPLACE_OPERATION_FAILED')
    }
    // Neither failed attempt left any state behind.
    expect(documents.findById(old.id)?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number }).count).toBe(1)
  })

  it('rejects replacing a trashed Document or one inside a deleted Matter', async () => {
    const matter = matters.create('Synthetic Matter')
    const old = await imports.importFromPath(matter.id, await writeSource('old.pdf', 'old content'))
    const second = await imports.importFromPath(matter.id, await writeSource('second.pdf', 'second content'))
    const replacementPath = await writeSource('new.pdf', 'new content')

    const lifecycle = new WorkspaceLifecycleRepository(db)
    lifecycle.trashDocument({
      documentId: old.id,
      event: {
        id: 'event-trash', matterId: matter.id, documentId: old.id,
        type: 'DOCUMENT_TRASHED', actor: 'USER', createdAt: timestamp++
      }
    })
    try {
      await replacement.replaceFromPath(old.id, replacementPath)
      expect.unreachable('trashed document should not be replaceable')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('DOCUMENT_NOT_AVAILABLE')
    }

    lifecycle.trashMatter({
      matterId: matter.id,
      event: { id: 'event-matter', matterId: matter.id, type: 'MATTER_TRASHED', actor: 'USER', createdAt: timestamp++ }
    })
    try {
      await replacement.replaceFromPath(second.id, replacementPath)
      expect.unreachable('document in deleted matter should not be replaceable')
    } catch (error) {
      expect((error as DocumentReplacementError).code).toBe('MATTER_NOT_AVAILABLE')
    }
  })
})
