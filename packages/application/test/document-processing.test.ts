import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '@aliasai/crypto'
import {
  DocumentRepository,
  MatterRepository,
  documentBlocks,
  documentPages,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  PythonWorkerClient,
  PythonWorkerDocumentProcessor,
  type ProcessDocumentRequest,
  type WorkerEvent,
  type WorkerTerminalEvent
} from '@aliasai/python-bridge'
import {
  DocumentImportService,
  DocumentProcessingService,
  MatterService,
  documentBlockTextContext,
  type DocumentProcessor
} from '../src/index'

function syntheticPdf(): Buffer {
  const content = 'BT /F1 11 Tf 24 84 Td (Synthetic native text) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
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
  output += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

function successfulFakeProcessor(
  beforeEvents?: (request: ProcessDocumentRequest) => void
): DocumentProcessor {
  return {
    parserType: 'SYNTHETIC_PROTOCOL_PROCESSOR',
    async processDocument(request, onEvent): Promise<WorkerTerminalEvent> {
      beforeEvents?.(request)
      const events: WorkerEvent[] = [
        { protocolVersion: 1, type: 'started', jobId: request.jobId, documentId: request.documentId },
        {
          protocolVersion: 1,
          type: 'page_result',
          jobId: request.jobId,
          documentId: request.documentId,
          page: {
            pageNo: 1,
            originalWidth: 100,
            originalHeight: 200,
            rotation: 0,
            sourceType: 'NATIVE',
            blocks: [
              {
                localId: 'synthetic-block',
                blockType: 'TEXT',
                text: 'Synthetic confidential block',
                bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
                source: 'NATIVE',
                readingOrder: 0
              }
            ]
          }
        }
      ]
      for (const event of events) await onEvent(event)
      const completed = {
        protocolVersion: 1 as const,
        type: 'completed' as const,
        jobId: request.jobId,
        documentId: request.documentId,
        pageCount: 1,
        processedPages: 1
      }
      await onEvent(completed)
      return completed
    }
  }
}

describe('DocumentProcessingService', () => {
  const key = Buffer.alloc(32, 7)
  const temporaryDirectories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let timestamp: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    timestamp = 1_725_000_000_000
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const now = () => timestamp++

  async function importSyntheticSource(contents: string | Buffer = 'synthetic source'): Promise<{
    readonly documentId: string
    readonly sourcePath: string
  }> {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, now).create('Synthetic Matter')
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-document-processing-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, contents)
    const document = await new DocumentImportService(documents, new MatterRepository(db), { persistenceKey: key }, now).importFromPath(
      matter.id,
      sourcePath
    )
    return { documentId: document.id, sourcePath }
  }

  it('uses an engine-independent processor and persists only encrypted block text', async () => {
    const imported = await importSyntheticSource()
    const processor = successfulFakeProcessor((request) => {
      expect(documents.findById(imported.documentId)?.parseStatus).toBe('PARSING')
      expect(request).toMatchObject({
        documentId: imported.documentId,
        filePath: imported.sourcePath,
        options: { preferNativeText: true, enableOcr: false, enableLayoutAnalysis: false }
      })
    })

    const completed = await new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(
      imported.documentId
    )

    expect(completed).toMatchObject({
      id: imported.documentId,
      parseStatus: 'PARSED',
      parserType: 'SYNTHETIC_PROTOCOL_PROCESSOR',
      pageCount: 1
    })
    const page = sqlite.prepare('SELECT * FROM document_pages WHERE document_id = ?').get(imported.documentId) as {
      id: string
      source_type: string
    }
    const block = sqlite.prepare('SELECT * FROM document_blocks WHERE document_id = ?').get(imported.documentId) as {
      id: string
      page_id: string
      text_cipher: Buffer
    }
    expect(page.source_type).toBe('NATIVE')
    expect(block.page_id).toBe(page.id)
    expect(block.text_cipher.includes(Buffer.from('Synthetic confidential block'))).toBe(false)
    expect(decrypt(block.text_cipher, key, documentBlockTextContext(block.id)).toString()).toBe(
      'Synthetic confidential block'
    )
  })

  it('forwards enableOcr to the processor request when configured', async () => {
    const imported = await importSyntheticSource()
    const processor = successfulFakeProcessor((request) => {
      expect(request.options).toMatchObject({ preferNativeText: true, enableOcr: true, enableLayoutAnalysis: false })
    })

    const completed = await new DocumentProcessingService(
      documents,
      processor,
      { persistenceKey: key },
      now,
      undefined,
      { enableOcr: true }
    ).process(imported.documentId)

    expect(completed.parseStatus).toBe('PARSED')
  })

  function rasterFakeProcessor(withOcrBlocks: boolean): DocumentProcessor {
    return {
      parserType: 'SYNTHETIC_RASTER_PROCESSOR',
      async processDocument(request, onEvent): Promise<WorkerTerminalEvent> {
        await onEvent({
          protocolVersion: 1,
          type: 'page_result',
          jobId: request.jobId,
          documentId: request.documentId,
          page: {
            pageNo: 1,
            originalWidth: 100,
            originalHeight: 200,
            rotation: 0,
            sourceType: 'RASTER',
            blocks: withOcrBlocks
              ? [
                  {
                    localId: 'synthetic-ocr-block',
                    blockType: 'TEXT' as const,
                    text: 'Synthetic scanned line',
                    bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
                    confidence: 0.9,
                    source: 'OCR' as const,
                    readingOrder: 0
                  }
                ]
              : []
          }
        })
        return {
          protocolVersion: 1,
          type: 'completed',
          jobId: request.jobId,
          documentId: request.documentId,
          pageCount: 1,
          processedPages: 1
        }
      }
    }
  }

  it('fails closed on raster pages when OCR is disabled', async () => {
    const imported = await importSyntheticSource()

    await expect(
      new DocumentProcessingService(documents, rasterFakeProcessor(false), { persistenceKey: key }, now).process(
        imported.documentId
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT' })

    expect(documents.findById(imported.documentId)?.parseStatus).toBe('FAILED')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(imported.documentId)
    ).toEqual({ count: 0 })
  })

  it('accepts OCRed raster pages when OCR is enabled', async () => {
    const imported = await importSyntheticSource()

    const completed = await new DocumentProcessingService(
      documents,
      rasterFakeProcessor(true),
      { persistenceKey: key },
      now,
      undefined,
      { enableOcr: true }
    ).process(imported.documentId)

    expect(completed.parseStatus).toBe('PARSED')
    const block = sqlite.prepare('SELECT id, source FROM document_blocks WHERE document_id = ?').get(imported.documentId) as {
      id: string
      source: string
    }
    expect(block.source).toBe('OCR')
  })

  it('connects the native PDF worker through the same processor port', async () => {
    const imported = await importSyntheticSource(syntheticPdf())
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const pythonCommand = existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3'
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: pythonCommand,
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)

    const completed = await new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(
      imported.documentId
    )

    expect(completed).toMatchObject({ parseStatus: 'PARSED', parserType: 'NATIVE_PDF', pageCount: 1 })
    const block = sqlite
      .prepare('SELECT id, text_cipher FROM document_blocks WHERE document_id = ?')
      .get(imported.documentId) as { id: string; text_cipher: Buffer }
    expect(decrypt(block.text_cipher, key, documentBlockTextContext(block.id)).toString()).toBe('Synthetic native text')
    expect(await readFile(imported.sourcePath)).toEqual(syntheticPdf())
  })

  it('marks the Document failed without persisting pages when the processor fails', async () => {
    const imported = await importSyntheticSource()
    const processor: DocumentProcessor = {
      parserType: 'FAILING_PROCESSOR',
      async processDocument(request): Promise<WorkerTerminalEvent> {
        return {
          protocolVersion: 1,
          type: 'error',
          jobId: request.jobId,
          documentId: request.documentId,
          code: 'PDF_PARSE_FAILURE',
          message: 'Synthetic parse failure',
          retryable: false
        }
      }
    }

    await expect(
      new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(imported.documentId)
    ).rejects.toMatchObject({ code: 'PDF_PARSE_FAILURE', message: 'Synthetic parse failure' })
    expect(documents.findById(imported.documentId)?.parseStatus).toBe('FAILED')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(imported.documentId)).toEqual(
      { count: 0 }
    )
  })

  it('rejects processor events that do not belong to the requested Document', async () => {
    const imported = await importSyntheticSource()
    const processor: DocumentProcessor = {
      parserType: 'UNTRUSTED_PROCESSOR',
      async processDocument(request, onEvent): Promise<WorkerTerminalEvent> {
        await onEvent({
          protocolVersion: 1,
          type: 'page_result',
          jobId: request.jobId,
          documentId: 'different-document',
          page: {
            pageNo: 1,
            originalWidth: 1,
            originalHeight: 1,
            rotation: 0,
            sourceType: 'NATIVE',
            blocks: []
          }
        })
        return {
          protocolVersion: 1,
          type: 'completed',
          jobId: request.jobId,
          documentId: request.documentId,
          pageCount: 1,
          processedPages: 1
        }
      }
    }

    await expect(
      new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(imported.documentId)
    ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_MODEL' })
    expect(documents.findById(imported.documentId)?.parseStatus).toBe('FAILED')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(imported.documentId)).toEqual(
      { count: 0 }
    )
  })

  it('refuses to process a source whose content changed after import', async () => {
    const imported = await importSyntheticSource('original synthetic content')
    await writeFile(imported.sourcePath, 'replaced synthetic content')
    let processorCalled = false
    const processor = successfulFakeProcessor(() => {
      processorCalled = true
    })

    await expect(
      new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(imported.documentId)
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })

    expect(processorCalled).toBe(false)
    expect(documents.findById(imported.documentId)?.parseStatus).toBe('IMPORTED')
  })

  it('does not commit results when the source changes while the Worker is running', async () => {
    const imported = await importSyntheticSource('original synthetic content')
    const baseProcessor = successfulFakeProcessor()
    const processor: DocumentProcessor = {
      parserType: baseProcessor.parserType,
      async processDocument(request, onEvent): Promise<WorkerTerminalEvent> {
        const terminal = await baseProcessor.processDocument(request, onEvent)
        await writeFile(imported.sourcePath, 'changed during processing')
        return terminal
      }
    }

    await expect(
      new DocumentProcessingService(documents, processor, { persistenceKey: key }, now).process(imported.documentId)
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })

    expect(documents.findById(imported.documentId)?.parseStatus).toBe('FAILED')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(imported.documentId)).toEqual(
      { count: 0 }
    )
  })

  it('rolls back Page and Block inserts when the final persistence transaction fails', async () => {
    const imported = await importSyntheticSource()
    const existingDocumentId = 'existing-document'
    documents.create({
      id: existingDocumentId,
      matterId: documents.findById(imported.documentId)!.matterId,
      originalNameCipher: encrypt(Buffer.from('existing.pdf'), key, Buffer.from('existing-document:document.originalName')),
      fileHash: 'existing-hash',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: now(),
      updatedAt: now()
    })
    db.insert(documentPages)
      .values({
        id: 'existing-page',
        documentId: existingDocumentId,
        pageNo: 1,
        originalWidth: 1,
        originalHeight: 1,
        rotation: 0,
        sourceType: 'NATIVE',
        createdAt: now()
      })
      .run()
    db.insert(documentBlocks)
      .values({
        id: 'existing-block',
        documentId: existingDocumentId,
        pageId: 'existing-page',
        blockType: 'TEXT',
        textCipher: Buffer.from('synthetic cipher'),
        source: 'NATIVE',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        readingOrder: 0,
        createdAt: now()
      })
      .run()
    const generatedIds = ['job-id', 'new-page-id', 'existing-block']

    await expect(
      new DocumentProcessingService(
        documents,
        successfulFakeProcessor(),
        { persistenceKey: key },
        now,
        () => generatedIds.shift() ?? 'unexpected-id'
      ).process(imported.documentId)
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE', message: 'Document Model could not be persisted' })

    expect(documents.findById(imported.documentId)?.parseStatus).toBe('FAILED')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_pages WHERE document_id = ?').get(imported.documentId)).toEqual(
      { count: 0 }
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM document_blocks WHERE document_id = ?').get(imported.documentId)).toEqual(
      { count: 0 }
    )
  })
})
