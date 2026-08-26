import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { PythonWorkerClient, PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import {
  DocumentImportService,
  DocumentProcessingService,
  EntityResolutionService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  RehydrationService,
  ReviewQueryService,
  SanitizedPreviewService,
  WorkspaceLifecycleService,
  type ApplicationKeys
} from '../src/index'

function syntheticPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\)').replaceAll('(', '\\(')
  const content = `BT /F1 10 Tf 18 84 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${value}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

describe('workspace trash end to end', () => {
  const keys: ApplicationKeys = { persistenceKey: Buffer.alloc(32, 9), searchKey: Buffer.alloc(32, 7) }
  const directories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let matters: MatterRepository
  let lifecycle: WorkspaceLifecycleService
  let imports: DocumentImportService
  let preview: SanitizedPreviewService
  let reviewQuery: ReviewQueryService
  let timestamp: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    matters = new MatterRepository(db)
    reviewQuery = new ReviewQueryService(
      new ReviewQueryRepository(db),
      documents,
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    preview = new SanitizedPreviewService(
      documents,
      new ReviewQueryRepository(db),
      new SanitizationRepository(db),
      new PseudonymizationService(new SanitizationRepository(db), keys, () => timestamp++),
      new RehydrationService(new SanitizationRepository(db), keys),
      keys
    )
    timestamp = 1_730_000_000_000
    lifecycle = new WorkspaceLifecycleService(
      new WorkspaceLifecycleRepository(db),
      documents,
      matters,
      keys,
      () => timestamp++,
      (time) => `00000000-0000-7000-8000-${String(time % 10_000_000_000_000).padStart(12, '0')}`
    )
    imports = new DocumentImportService(documents, matters, keys, () => timestamp++)
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function runPipeline(matterId: string, sourcePath: string): Promise<string> {
    const imported = await imports.importFromPath(matterId, sourcePath)
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)
    await new DocumentProcessingService(documents, processor, keys, () => timestamp++).process(imported.id)
    await new PrivacyDetectionService(new PrivacyDetectionRepository(db), keys, undefined, () => timestamp++).detect(
      imported.id
    )
    await new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys,
      () => timestamp++
    ).resolve(imported.id)
    const generated = await preview.generatePreview(imported.id)
    expect(generated.status).toBe('AVAILABLE')
    if (generated.status !== 'AVAILABLE') throw new Error('preview should be available')
    return imported.id
  }

  it('trashes a sanitized Document, re-imports the same file with a new ID, and rehydrates the old artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-trash-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf('Holder 110101199003077774 synthetic@example.test.'))
    const matter = new MatterService(matters, keys, () => timestamp++).create('Synthetic Trash Matter')

    const oldDocumentId = await runPipeline(matter.id, sourcePath)
    const oldPreview = preview.getPreview(oldDocumentId)
    expect(oldPreview.status).toBe('AVAILABLE')
    if (oldPreview.status !== 'AVAILABLE') throw new Error('old preview should be available')
    const sanitizedDocumentId = oldPreview.sanitizedDocumentId

    // Trash: the Document disappears from the normal workspace but its
    // sanitized artifact still rehydrates locally through historical reads.
    expect(lifecycle.trashDocument(oldDocumentId)).toEqual({ changed: true })
    expect(reviewQuery.listDocuments(matter.id)).toHaveLength(0)
    expect(() => preview.getPreview(oldDocumentId)).toThrowError(/not available/)
    const rehydratedWhileTrashed = preview.rehydrateDemo({
      sanitizedDocumentId,
      text: '当事人:身份证号〔@I-0000000000000000〕',
      includeRestoreOnRequest: true
    })
    expect(rehydratedWhileTrashed.unresolvedTokens).toEqual(['@I-0000000000000000'])

    // Re-importing the identical PDF creates a new active Document with a new
    // ID while the old copy stays in trash.
    const reimported = await imports.importFromPath(matter.id, sourcePath)
    expect(reimported.id).not.toBe(oldDocumentId)
    expect(reimported.deletedAt).toBeUndefined()
    expect(reviewQuery.listDocuments(matter.id).map((item) => item.id)).toEqual([reimported.id])
    expect(lifecycle.listTrash().documents.map((item) => item.id)).toEqual([oldDocumentId])

    // Trash the new copy, then restore the old one without a conflict.
    expect(lifecycle.trashDocument(reimported.id)).toEqual({ changed: true })
    expect(lifecycle.restoreDocument(oldDocumentId)).toEqual({ changed: true })
    expect(reviewQuery.listDocuments(matter.id).map((item) => item.id)).toEqual([oldDocumentId])
    expect(lifecycle.listTrash().documents.map((item) => item.id)).toEqual([reimported.id])

    // The original sanitized artifact still rehydrates after restore.
    const restoredPreview = preview.getPreview(oldDocumentId)
    expect(restoredPreview.status).toBe('AVAILABLE')
    const rehydratedAfterRestore = preview.rehydrateDemo({
      sanitizedDocumentId,
      text: '当事人:身份证号〔@I-0000000000000000〕',
      includeRestoreOnRequest: true
    })
    expect(rehydratedAfterRestore.unresolvedTokens).toEqual(['@I-0000000000000000'])

    // Every real transition appended exactly one workspace event.
    const events = sqlite
      .prepare('SELECT event_type, document_id FROM workspace_events ORDER BY created_at, id')
      .all() as Array<{ event_type: string; document_id: string | null }>
    expect(events).toEqual([
      { event_type: 'DOCUMENT_TRASHED', document_id: oldDocumentId },
      { event_type: 'DOCUMENT_TRASHED', document_id: reimported.id },
      { event_type: 'DOCUMENT_RESTORED', document_id: oldDocumentId }
    ])
  })

  it('trashes and restores a Matter while preserving an individually trashed Document', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-trash-e2e-'))
    directories.push(directory)
    const first = join(directory, 'first.pdf')
    const second = join(directory, 'second.pdf')
    await writeFile(first, syntheticPdf('Holder 110101199003077774'))
    await writeFile(second, syntheticPdf('Other holder synthetic@example.test.'))
    const matter = new MatterService(matters, keys, () => timestamp++).create('Synthetic Matter Trash')

    const firstId = await runPipeline(matter.id, first)
    const secondId = await runPipeline(matter.id, second)

    // Trash one Document individually, then trash the whole Matter.
    expect(lifecycle.trashDocument(firstId)).toEqual({ changed: true })
    expect(lifecycle.trashMatter(matter.id)).toEqual({ changed: true })
    expect(reviewQuery.listMatters()).toHaveLength(0)
    expect(reviewQuery.listDocuments(matter.id)).toHaveLength(0)
    // The deleted Matter holds its tree; only individually trashed Documents
    // under live Matters appear in the trash document list.
    expect(lifecycle.listTrash().matters.map((item) => item.id)).toEqual([matter.id])
    expect(lifecycle.listTrash().documents).toHaveLength(0)

    // Restore: the live Document reappears; the individually trashed one stays trashed.
    expect(lifecycle.restoreMatter(matter.id)).toEqual({ changed: true })
    expect(reviewQuery.listMatters().map((item) => item.id)).toEqual([matter.id])
    expect(reviewQuery.listDocuments(matter.id).map((item) => item.id)).toEqual([secondId])
    expect(lifecycle.listTrash().documents.map((item) => item.id)).toEqual([firstId])
    expect(documents.findById(firstId)?.deletedAt).toBeDefined()
    expect(documents.findById(secondId)?.deletedAt).toBeUndefined()
  })
})
