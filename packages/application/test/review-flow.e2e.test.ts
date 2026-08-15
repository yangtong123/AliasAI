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
  EntityService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  RehydrationService,
  ReviewOperationService,
  ReviewQueryService,
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

describe('review flow end to end', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const searchKey = Buffer.alloc(32, 7)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  const directories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let reviewQuery: ReviewQueryService
  let operations: ReviewOperationService
  let preview: SanitizedPreviewService
  let resolution: EntityResolutionService
  let timestamp: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    reviewQuery = new ReviewQueryService(
      new ReviewQueryRepository(db),
      new DocumentRepository(db),
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    resolution = new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys
    )
    operations = new ReviewOperationService(
      resolution,
      new EntityService(new EntityRepository(db), keys),
      reviewQuery
    )
    preview = new SanitizedPreviewService(
      new DocumentRepository(db),
      new ReviewQueryRepository(db),
      new SanitizationRepository(db),
      new PseudonymizationService(new SanitizationRepository(db), keys),
      new RehydrationService(new SanitizationRepository(db), keys),
      keys
    )
    timestamp = 1_730_000_000_000
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const now = () => timestamp++

  it('runs PDF -> Block -> Mention -> Review -> Entity -> Sanitized Preview -> Rehydration', async () => {
    // Import a synthetic PDF into a fresh Matter.
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-review-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf('Holder 110101199003077774 synthetic@example.test.'))
    const matter = new MatterService(new MatterRepository(db), { persistenceKey }, now).create('Synthetic E2E Matter')
    const imported = await new DocumentImportService(new DocumentRepository(db), { persistenceKey }, now).importFromPath(
      matter.id,
      sourcePath
    )

    // Real native PDF parse.
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)
    await new DocumentProcessingService(new DocumentRepository(db), processor, { persistenceKey }, now).process(imported.id)

    // Real rule-based detection finds the checksum-valid ID number and the email.
    await new PrivacyDetectionService(new PrivacyDetectionRepository(db), { persistenceKey }, undefined, now).detect(imported.id)
    const initialReview = reviewQuery.getDocumentReview(imported.id)
    expect(initialReview.document.parseStatus).toBe('DETECTED')

    // Resolution leaves both identifier mentions UNRESOLVED (no prior entities).
    await resolution.resolve(imported.id)
    const resolvedReview = reviewQuery.getDocumentReview(imported.id)
    expect(resolvedReview.document.parseStatus).toBe('READY')
    expect(resolvedReview.blocks).toHaveLength(1)
    const mentions = resolvedReview.blocks[0]!.mentions
    expect(mentions.map((mention) => mention.type).sort()).toEqual(['EMAIL', 'ID_CARD'])
    expect(mentions.every((mention) => mention.decisionStatus === 'UNRESOLVED')).toBe(true)
    expect(resolvedReview.counts).toEqual({ mentions: 2, resolved: 0, needsReview: 0, unresolved: 2 })

    // Preview is blocked until every mention resolves.
    const blocked = preview.getPreview(imported.id)
    expect(blocked.status).toBe('READY')
    if (blocked.status === 'READY') {
      expect(blocked.blockers).toHaveLength(2)
      expect(blocked.blockers.every((blocker) => blocker.reason === 'UNRESOLVED')).toBe(true)
    }

    // The reviewer creates one entity for the holder and assigns both mentions.
    const idMention = mentions.find((mention) => mention.type === 'ID_CARD')!
    const emailMention = mentions.find((mention) => mention.type === 'EMAIL')!
    const created = operations.createEntityAndAssign(idMention.mentionId, {
      primaryAlias: 'Holder One',
      entityType: 'PERSON'
    })
    const assigned = operations.assignToEntity(emailMention.mentionId, created.entity.id)

    expect(created.mention.decisionStatus).toBe('USER_ASSIGNED')
    expect(assigned.assignedEntity!.id).toBe(created.entity.id)
    const finalReview = reviewQuery.getDocumentReview(imported.id)
    expect(finalReview.counts).toEqual({ mentions: 2, resolved: 2, needsReview: 0, unresolved: 0 })

    // Generate the sanitized preview: pseudonyms replace both values.
    const generated = await preview.generatePreview(imported.id)
    expect(generated.status).toBe('AVAILABLE')
    if (generated.status !== 'AVAILABLE') throw new Error('preview should be available')
    const sanitized = generated.blocks[0]!.text
    expect(sanitized).not.toContain('110101199003077774')
    expect(sanitized).not.toContain('synthetic@example.test')
    expect(sanitized.match(/〔@[IET]-[A-Z0-9]+〕/g)).toHaveLength(2)
    expect(generated.mappings.map((mapping) => mapping.restorePolicy).sort()).toEqual([
      'RESTORE_ON_REQUEST',
      'RESTORE_ON_REQUEST'
    ])

    // Simulated AI round trip: withheld by default, restored on request.
    const aiEcho = `当事人:${sanitized}`
    const withheld = preview.rehydrateDemo({ sanitizedDocumentId: generated.sanitizedDocumentId, text: aiEcho })
    expect(withheld.text).not.toContain('110101199003077774')
    const restored = preview.rehydrateDemo({
      sanitizedDocumentId: generated.sanitizedDocumentId,
      text: aiEcho,
      includeRestoreOnRequest: true
    })
    expect(restored.text).toContain('110101199003077774')
    expect(restored.text).toContain('synthetic@example.test')
    expect(restored.unresolvedTokens).toEqual([])

    // A tampered token stays verbatim and is reported for manual review.
    const tampered = preview.rehydrateDemo({
      sanitizedDocumentId: generated.sanitizedDocumentId,
      text: '另见 @I-0000000000000000。',
      includeRestoreOnRequest: true
    })
    expect(tampered.text).toContain('@I-0000000000000000')
    expect(tampered.unresolvedTokens).toEqual(['@I-0000000000000000'])
  })
})
