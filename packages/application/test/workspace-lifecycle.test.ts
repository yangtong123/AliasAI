import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentRepository,
  MatterRepository,
  migrateDatabase,
  openDatabase,
  ReviewQueryRepository,
  WorkspaceLifecycleRepository
} from '@aliasai/database'
import {
  DocumentImportError,
  DocumentImportService,
  MatterService,
  WorkspaceLifecycleError,
  WorkspaceLifecycleService
} from '../src/index'
import type { AliasAiDatabase, SqliteClient } from '@aliasai/database'

describe('workspace lifecycle application service', () => {
  const key = Buffer.alloc(32, 9)
  const temporaryDirectories: string[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let timestamp: number
  let lifecycle: WorkspaceLifecycleService
  let imports: DocumentImportService
  let matters: MatterService

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    timestamp = 1_725_000_000_000
    const nextTime = () => timestamp++
    matters = new MatterService(new MatterRepository(db), { persistenceKey: key }, nextTime)
    lifecycle = new WorkspaceLifecycleService(
      new WorkspaceLifecycleRepository(db),
      new DocumentRepository(db),
      new MatterRepository(db),
      { persistenceKey: key },
      nextTime,
      (time) => `00000000-0000-7000-8000-${String(time).padStart(12, '0')}`
    )
    imports = new DocumentImportService(new DocumentRepository(db), new MatterRepository(db), { persistenceKey: key }, nextTime)
  })

  afterEach(async () => {
    sqlite.close()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function writeSource(name: string, content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-lifecycle-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, name)
    await writeFile(sourcePath, content)
    return sourcePath
  }

  it('trashes and restores a Document through the service with one event each', () => {
    const matter = matters.create('Synthetic Matter')
    const documents = new DocumentRepository(db)
    documents.create({
      id: 'document-1',
      matterId: matter.id,
      originalNameCipher: Buffer.from('cipher'),
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })

    expect(lifecycle.trashDocument('document-1')).toEqual({ changed: true })
    expect(documents.findById('document-1')?.deletedAt).toBeDefined()
    expect(lifecycle.restoreDocument('document-1')).toEqual({ changed: true })
    expect(documents.findById('document-1')?.deletedAt).toBeUndefined()
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as { count: number }).count).toBe(2)
  })

  it('maps repository failures to coded application errors', () => {
    try {
      lifecycle.trashDocument('missing')
      expect.unreachable('missing document should fail')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLifecycleError)
      expect((error as WorkspaceLifecycleError).code).toBe('DOCUMENT_NOT_AVAILABLE')
    }
    try {
      lifecycle.trashMatter('missing')
      expect.unreachable('missing matter should fail')
    } catch (error) {
      expect((error as WorkspaceLifecycleError).code).toBe('MATTER_NOT_AVAILABLE')
    }
  })

  it('lists trash with decrypted display names only', async () => {
    const matter = matters.create('机密事项')
    const sourcePath = await writeSource('synthetic.pdf', 'synthetic source')
    const imported = await imports.importFromPath(matter.id, sourcePath)

    lifecycle.trashDocument(imported.id)
    const trash = lifecycle.listTrash()
    expect(trash.matters).toEqual([])
    expect(trash.documents).toHaveLength(1)
    expect(trash.documents[0]).toMatchObject({
      id: imported.id,
      matterId: matter.id,
      matterName: '机密事项',
      originalName: 'synthetic.pdf',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED'
    })
    expect(trash.documents[0]?.deletedAt).toBeGreaterThan(0)
    // No cipher ever crosses the DTO boundary.
    expect(JSON.stringify(trash)).not.toContain('cipher')
    expect(JSON.stringify(trash)).not.toContain('Cipher')
  })

  it('keeps normal lists clean while trash holds the item', async () => {
    const matter = matters.create('Synthetic Matter')
    const sourcePath = await writeSource('synthetic.pdf', 'synthetic source')
    const imported = await imports.importFromPath(matter.id, sourcePath)
    const review = new ReviewQueryRepository(db)

    lifecycle.trashDocument(imported.id)
    expect(review.listDocumentsByMatter(matter.id)).toHaveLength(0)
    expect(lifecycle.listTrash().documents).toHaveLength(1)

    lifecycle.restoreDocument(imported.id)
    expect(review.listDocumentsByMatter(matter.id)).toHaveLength(1)
    expect(lifecycle.listTrash().documents).toHaveLength(0)
  })

  it('trashes and restores a Matter with its contents', async () => {
    const matter = matters.create('Synthetic Matter')
    const sourcePath = await writeSource('synthetic.pdf', 'synthetic source')
    await imports.importFromPath(matter.id, sourcePath)
    const review = new ReviewQueryRepository(db)

    expect(lifecycle.trashMatter(matter.id)).toEqual({ changed: true })
    expect(review.listMatters()).toHaveLength(0)
    expect(review.listDocumentsByMatter(matter.id)).toHaveLength(0)
    expect(lifecycle.listTrash().matters).toHaveLength(1)
    expect(lifecycle.listTrash().documents).toHaveLength(0)

    expect(lifecycle.restoreMatter(matter.id)).toEqual({ changed: true })
    expect(review.listMatters()).toHaveLength(1)
    expect(review.listDocumentsByMatter(matter.id)).toHaveLength(1)
  })

  describe('import after trash', () => {
    it('reuses the active Document but creates a new ID after trash', async () => {
      const matter = matters.create('Synthetic Matter')
      const sourcePath = await writeSource('synthetic.pdf', 'same bytes')
      const first = await imports.importFromPath(matter.id, sourcePath)

      const reused = await imports.importFromPath(matter.id, sourcePath)
      expect(reused.id).toBe(first.id)

      expect(lifecycle.trashDocument(first.id)).toEqual({ changed: true })
      const reimported = await imports.importFromPath(matter.id, sourcePath)
      expect(reimported.id).not.toBe(first.id)
      expect(reimported.deletedAt).toBeUndefined()

      const documents = new DocumentRepository(db)
      expect(documents.findById(first.id)?.deletedAt).toBeDefined()
      expect(lifecycle.listTrash().documents.map((item) => item.id)).toEqual([first.id])
    })

    it('imports a same-name file with different content normally', async () => {
      const matter = matters.create('Synthetic Matter')
      const firstPath = await writeSource('contract.pdf', 'first content')
      const secondPath = await writeSource('contract.pdf', 'second content')

      const first = await imports.importFromPath(matter.id, firstPath)
      const second = await imports.importFromPath(matter.id, secondPath)
      expect(second.id).not.toBe(first.id)
      expect(new ReviewQueryRepository(db).listDocumentsByMatter(matter.id)).toHaveLength(2)
    })

    it('fails with MATTER_NOT_AVAILABLE when importing into a deleted Matter', async () => {
      const matter = matters.create('Synthetic Matter')
      const sourcePath = await writeSource('synthetic.pdf', 'synthetic source')
      lifecycle.trashMatter(matter.id)

      try {
        await imports.importFromPath(matter.id, sourcePath)
        expect.unreachable('import into deleted matter should fail')
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentImportError)
        expect((error as DocumentImportError).code).toBe('MATTER_NOT_AVAILABLE')
      }
    })
  })

  it('restoring a Document conflicts with an active same-hash import', async () => {
    const matter = matters.create('Synthetic Matter')
    const sourcePath = await writeSource('synthetic.pdf', 'same bytes')
    const first = await imports.importFromPath(matter.id, sourcePath)
    lifecycle.trashDocument(first.id)
    await imports.importFromPath(matter.id, sourcePath)

    try {
      lifecycle.restoreDocument(first.id)
      expect.unreachable('restore should conflict')
    } catch (error) {
      expect((error as WorkspaceLifecycleError).code).toBe('RESTORE_CONFLICT')
    }
    // Keep the active copy: the trashed one stays trashed with no partial writes.
    expect(new DocumentRepository(db).findById(first.id)?.deletedAt).toBeDefined()
  })
})
