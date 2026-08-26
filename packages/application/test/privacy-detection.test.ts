import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '@aliasai/crypto'
import type { PrivacyDetector } from '@aliasai/privacy-detection'
import {
  DocumentRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import { PythonWorkerClient, PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import {
  DocumentImportService,
  DocumentProcessingService,
  MatterService,
  PrivacyDetectionService,
  documentBlockTextContext,
  mentionTextContext,
  privacyDetectionErrorContext
} from '../src/index'

function syntheticPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
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

describe('PrivacyDetectionService', () => {
  const key = Buffer.alloc(32, 9)
  const directories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let detection: PrivacyDetectionRepository
  let timestamp: number
  let idSequence: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    detection = new PrivacyDetectionRepository(db)
    timestamp = 1_730_000_000_000
    idSequence = 0
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const now = () => timestamp++
  const generateId = () => `generated-${++idSequence}`

  function seedParsedDocument(blockTexts: readonly string[]): string {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, now).create('Synthetic Matter')
    const documentId = 'document-1'
    documents.create({
      id: documentId,
      matterId: matter.id,
      originalNameCipher: encrypt(Buffer.from('synthetic.pdf'), key, Buffer.from(`${documentId}:document.originalName`)),
      fileHash: 'synthetic-hash',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: now(),
      updatedAt: now()
    })
    documents.markProcessing(documentId, 'SYNTHETIC', now())
    documents.completeProcessing({
      documentId,
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: 'page-1',
          documentId,
          pageNo: 1,
          originalWidth: 100,
          originalHeight: 100,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: now()
        }
      ],
      blocks: blockTexts.map((text, index) => {
        const id = `block-${index + 1}`
        return {
          id,
          documentId,
          pageId: 'page-1',
          blockType: 'TEXT' as const,
          textCipher: encrypt(Buffer.from(text), key, documentBlockTextContext(id)),
          source: 'NATIVE' as const,
          bbox: { x: 0, y: index / blockTexts.length, width: 1, height: 1 / blockTexts.length },
          readingOrder: index,
          createdAt: now()
        }
      }),
      updatedAt: now()
    })
    return documentId
  }

  function rows(sql: string, documentId: string): unknown[] {
    return sqlite.prepare(sql).all(documentId)
  }

  it('decrypts Blocks transiently and persists encrypted unassigned Mentions with a completed job', async () => {
    const documentId = seedParsedDocument([
      'Contact synthetic@example.test or 13800138000.',
      'No private identifiers here.'
    ])

    const result = await new PrivacyDetectionService(detection, { persistenceKey: key }, undefined, now, generateId).detect(
      documentId
    )

    expect(result).toMatchObject({ reused: false, document: { parseStatus: 'DETECTED' }, job: { status: 'COMPLETED', progress: 1 } })
    expect(result.mentions.map((mention) => mention.type)).toEqual(['EMAIL', 'PHONE'])
    expect(result.mentions.every((mention) => mention.entityId === undefined && mention.protectedValueId === undefined)).toBe(true)
    const persisted = rows(
      'SELECT id, text_cipher, entity_id, protected_value_id FROM mentions WHERE document_id = ? ORDER BY start_offset',
      documentId
    ) as Array<{ id: string; text_cipher: Buffer; entity_id: null; protected_value_id: null }>
    expect(persisted).toHaveLength(2)
    expect(persisted.map((row) => decrypt(row.text_cipher, key, mentionTextContext(row.id)).toString())).toEqual([
      'synthetic@example.test',
      '13800138000'
    ])
    expect(persisted.every((row) => !row.text_cipher.includes(Buffer.from('synthetic@example.test')))).toBe(true)
    expect(rows('SELECT status, progress, checkpoint FROM processing_jobs WHERE document_id = ?', documentId)).toEqual([
      { status: 'COMPLETED', progress: 1, checkpoint: null }
    ])
  })

  it('is idempotent after completion and does not invoke the detector twice', async () => {
    const documentId = seedParsedDocument(['Email synthetic@example.test'])
    let calls = 0
    const detector: PrivacyDetector = {
      detect(block) {
        calls += 1
        const startOffset = block.text.indexOf('synthetic@example.test')
        return [{
          matterId: block.matterId,
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.blockId,
          type: 'EMAIL',
          strength: 'EXPLICIT',
          startOffset,
          endOffset: startOffset + 22,
          detector: 'REGEX',
          confidence: 1
        }]
      }
    }
    const service = new PrivacyDetectionService(detection, { persistenceKey: key }, detector, now, generateId)

    expect((await service.detect(documentId)).reused).toBe(false)
    expect((await service.detect(documentId)).reused).toBe(true)
    expect(calls).toBe(1)
    expect(rows('SELECT id FROM mentions WHERE document_id = ?', documentId)).toHaveLength(1)
    expect(rows('SELECT id FROM processing_jobs WHERE document_id = ?', documentId)).toHaveLength(1)
  })

  it('records an encrypted failure without partial Mentions and succeeds on retry', async () => {
    const documentId = seedParsedDocument(['First synthetic@example.test', 'Second 13800138000'])
    let fail = true
    const detector: PrivacyDetector = {
      detect(block) {
        if (fail && block.blockId === 'block-2') throw new Error(`do not persist ${block.text}`)
        const email = block.text.indexOf('synthetic@example.test')
        const phone = block.text.indexOf('13800138000')
        const startOffset = Math.max(email, phone)
        if (startOffset < 0) return []
        return [{
          matterId: block.matterId,
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.blockId,
          type: email >= 0 ? 'EMAIL' : 'PHONE',
          strength: 'EXPLICIT',
          startOffset,
          endOffset: startOffset + (email >= 0 ? 22 : 11),
          detector: 'REGEX',
          confidence: 1
        }]
      }
    }
    const service = new PrivacyDetectionService(detection, { persistenceKey: key }, detector, now, generateId)

    await expect(service.detect(documentId)).rejects.toMatchObject({ code: 'DETECTION_FAILED' })
    expect(documents.findById(documentId)?.parseStatus).toBe('FAILED')
    expect(rows('SELECT id FROM mentions WHERE document_id = ?', documentId)).toHaveLength(0)
    const failed = rows('SELECT id, status, error_cipher FROM processing_jobs WHERE document_id = ?', documentId) as Array<{
      id: string
      status: string
      error_cipher: Buffer
    }>
    expect(failed).toHaveLength(1)
    expect(failed[0]!.status).toBe('FAILED')
    expect(decrypt(failed[0]!.error_cipher, key, privacyDetectionErrorContext(failed[0]!.id)).toString()).toBe(
      '{"code":"DETECTION_FAILED"}'
    )
    expect(failed[0]!.error_cipher.includes(Buffer.from('Second 13800138000'))).toBe(false)

    fail = false
    const retry = await service.detect(documentId)
    expect(retry.document.parseStatus).toBe('DETECTED')
    expect(retry.mentions).toHaveLength(2)
    expect(rows('SELECT status FROM processing_jobs WHERE document_id = ? ORDER BY created_at', documentId)).toEqual([
      { status: 'FAILED' },
      { status: 'COMPLETED' }
    ])
  })

  it('rejects duplicate generated Mention IDs before persistence and records the failed job', async () => {
    const documentId = seedParsedDocument(['synthetic@example.test and 13800138000'])
    const duplicateIds = () => 'duplicate-id'

    await expect(
      new PrivacyDetectionService(detection, { persistenceKey: key }, undefined, now, duplicateIds).detect(documentId)
    ).rejects.toMatchObject({ code: 'DETECTION_FAILED' })

    expect(documents.findById(documentId)?.parseStatus).toBe('FAILED')
    expect(rows('SELECT id FROM mentions WHERE document_id = ?', documentId)).toHaveLength(0)
    expect(rows('SELECT status FROM processing_jobs WHERE document_id = ?', documentId)).toEqual([{ status: 'FAILED' }])
  })

  it('rejects cross-boundary or invalid proposals and finalizes the job as failed', async () => {
    const documentId = seedParsedDocument(['Synthetic private text'])
    const detector: PrivacyDetector = {
      detect(block) {
        return [{
          matterId: 'other-matter',
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.blockId,
          type: 'PERSON',
          strength: 'EXPLICIT',
          startOffset: 0,
          endOffset: 999,
          detector: 'DICTIONARY',
          confidence: 1
        }]
      }
    }

    await expect(
      new PrivacyDetectionService(detection, { persistenceKey: key }, detector, now, generateId).detect(documentId)
    ).rejects.toMatchObject({ code: 'INVALID_PROPOSAL' })
    expect(documents.findById(documentId)?.parseStatus).toBe('FAILED')
    expect(rows('SELECT id FROM mentions WHERE document_id = ?', documentId)).toHaveLength(0)
  })

  it('fails authentication when Block ciphertext is moved to another row', async () => {
    const documentId = seedParsedDocument(['synthetic@example.test', '13800138000'])
    sqlite.exec("UPDATE document_blocks SET text_cipher = (SELECT text_cipher FROM document_blocks WHERE id = 'block-1') WHERE id = 'block-2'")

    await expect(
      new PrivacyDetectionService(detection, { persistenceKey: key }, undefined, now, generateId).detect(documentId)
    ).rejects.toMatchObject({ code: 'BLOCK_DECRYPTION_FAILED' })
    expect(rows('SELECT id FROM mentions WHERE document_id = ?', documentId)).toHaveLength(0)
  })

  it('runs the real native PDF worker through PDF -> Block -> Mention', async () => {
    const text = 'Contact synthetic@example.test or 13800138000'
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, now).create('Synthetic E2E Matter')
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-privacy-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf(text))
    const imported = await new DocumentImportService(documents, new MatterRepository(db), { persistenceKey: key }, now).importFromPath(
      matter.id,
      sourcePath
    )
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)

    await new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(imported.id)
    const result = await new PrivacyDetectionService(detection, { persistenceKey: key }, undefined, now).detect(imported.id)

    expect(result.document).toMatchObject({ parseStatus: 'DETECTED', parserType: 'NATIVE_PDF', pageCount: 1 })
    expect(result.mentions.map((mention) => mention.type)).toEqual(['EMAIL', 'PHONE'])
    const persisted = rows('SELECT id, text_cipher FROM mentions WHERE document_id = ? ORDER BY start_offset', imported.id) as Array<{
      id: string
      text_cipher: Buffer
    }>
    expect(persisted.map((row) => decrypt(row.text_cipher, key, mentionTextContext(row.id)).toString())).toEqual([
      'synthetic@example.test',
      '13800138000'
    ])
  })
})
