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
  DocumentReplacementService,
  EntityResolutionService,
  EntityService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  RehydrationService,
  SanitizedPreviewService,
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

describe('document replacement end to end', () => {
  const keys: ApplicationKeys = { persistenceKey: Buffer.alloc(32, 9), searchKey: Buffer.alloc(32, 7) }
  const directories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let matters: MatterRepository
  let timestamp: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    matters = new MatterRepository(db)
    timestamp = 1_730_000_000_000
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const now = () => timestamp++

  async function parse(documentId: string): Promise<void> {
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)
    await new DocumentProcessingService(documents, processor, keys, now).process(documentId)
  }

  async function detectAndResolve(documentId: string): Promise<void> {
    await new PrivacyDetectionService(new PrivacyDetectionRepository(db), keys, undefined, now).detect(documentId)
    await new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys,
      now
    ).resolve(documentId)
  }

  async function runPipeline(matterId: string, sourcePath: string): Promise<string> {
    const imported = await new DocumentImportService(documents, matters, keys, now).importFromPath(matterId, sourcePath)
    await parse(imported.id)
    await detectAndResolve(imported.id)
    return imported.id
  }

  it('replaces a sanitized Document, keeps the old artifact rehydratable, and reuses Matter identity data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-replace-e2e-'))
    directories.push(directory)
    // Both files carry the same ID number; only the email differs.
    const oldPath = join(directory, 'old.pdf')
    const freshPath = join(directory, 'fresh.pdf')
    await writeFile(oldPath, syntheticPdf('Holder 110101199003077774 old@example.test.'))
    await writeFile(freshPath, syntheticPdf('Holder 110101199003077774 fresh@example.test.'))
    const matter = new MatterService(matters, keys, now).create('Synthetic Replacement Matter')

    // Old Document: full pipeline through sanitization.
    const oldId = await runPipeline(matter.id, oldPath)
    const preview = new SanitizedPreviewService(
      documents,
      new ReviewQueryRepository(db),
      new SanitizationRepository(db),
      new PseudonymizationService(new SanitizationRepository(db), keys, now),
      new RehydrationService(new SanitizationRepository(db), keys),
      keys
    )
    const generated = await preview.generatePreview(oldId)
    expect(generated.status).toBe('AVAILABLE')
    if (generated.status !== 'AVAILABLE') throw new Error('preview should be available')
    const oldSanitizedText = generated.blocks.map((block) => block.text).join('\n\n')
    expect(oldSanitizedText).not.toContain('110101199003077774')

    // Matter-scoped identity data exists before the replacement.
    new EntityService(new EntityRepository(db), keys, now).create(matter.id, 'PERSON', 'Plaintiff A')
    const protectedValueBefore = sqlite
      .prepare("SELECT id FROM protected_values WHERE value_type = 'ID_CARD'")
      .get() as { id: string }

    // One-step replacement with the fresh file.
    const replacement = new DocumentReplacementService(
      new WorkspaceLifecycleRepository(db),
      documents,
      matters,
      keys,
      now
    )
    const replaced = await replacement.replaceFromPath(oldId, freshPath)

    // Old Document in trash with recorded lineage; replacement active and fresh.
    expect(replaced.supersedesDocumentId).toBe(oldId)
    expect(documents.findById(oldId)?.deletedAt).toBeDefined()
    expect(documents.findById(replaced.id)?.deletedAt).toBeUndefined()
    expect(documents.findById(replaced.id)?.parseStatus).toBe('IMPORTED')
    expect(new WorkspaceLifecycleRepository(db).listTrash().documents.map((item) => item.document.id)).toEqual([oldId])

    // The old sanitized artifact still rehydrates locally with real values.
    const rehydrated = new RehydrationService(new SanitizationRepository(db), keys).rehydrate({
      sanitizedDocumentId: generated.sanitizedDocumentId,
      text: `当事人: ${oldSanitizedText}`,
      includeRestoreOnRequest: true
    })
    expect(rehydrated.text).toContain('110101199003077774')
    expect(rehydrated.text).toContain('old@example.test')
    expect(rehydrated.unresolvedTokens).toEqual([])

    // The replacement starts with no inherited pipeline data.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM mentions WHERE document_id = ?').get(replaced.id) as { count: number }).count
    ).toBe(0)
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS count FROM document_blocks WHERE document_id = ?').get(replaced.id) as { count: number }).count
    ).toBe(0)

    // The normal pipeline runs on the replacement and reuses the existing
    // Matter-scoped identity data: the repeated ID card maps to the same
    // ProtectedValue instead of creating a duplicate one.
    const freshId = replaced.id
    await parse(freshId)
    await detectAndResolve(freshId)
    expect(documents.findById(freshId)?.parseStatus).toBe('READY')
    const freshMentions = sqlite
      .prepare('SELECT mention_type, protected_value_id FROM mentions WHERE document_id = ?')
      .all(freshId) as Array<{ mention_type: string; protected_value_id: string }>
    expect(freshMentions.map((mention) => mention.mention_type).sort()).toEqual(['EMAIL', 'ID_CARD'])
    const freshIdCard = freshMentions.find((mention) => mention.mention_type === 'ID_CARD')
    expect(freshIdCard?.protected_value_id).toBe(protectedValueBefore.id)
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM protected_values WHERE value_type = 'ID_CARD'").get() as { count: number }).count
    ).toBe(1)

    // Exactly one lifecycle event records the replacement with both IDs.
    const events = sqlite
      .prepare('SELECT event_type, document_id, superseded_document_id FROM workspace_events')
      .all() as Array<{ event_type: string; document_id: string; superseded_document_id: string }>
    expect(events).toEqual([{ event_type: 'DOCUMENT_REPLACED', document_id: replaced.id, superseded_document_id: oldId }])
  })
})
