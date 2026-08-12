import { decrypt, encrypt, generateUuidV7 } from '@aliasai/crypto'
import type { Document } from '@aliasai/domain'
import type {
  CreateDocumentBlockInput,
  CreateDocumentPageInput,
  DocumentRepository
} from '@aliasai/database'
import { inspectDocumentSource } from '@aliasai/document'
import { parseWorkerEvent, type ProcessDocumentRequest, type WorkerEvent, type WorkerTerminalEvent } from '@aliasai/python-bridge'
import type { ApplicationKeys } from './index'

export interface DocumentProcessor {
  readonly parserType: string
  processDocument(
    request: ProcessDocumentRequest,
    onEvent: (event: WorkerEvent) => void | Promise<void>
  ): Promise<WorkerTerminalEvent>
}

export type DocumentProcessingIdFactory = (timestamp: number) => string

export class DocumentProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentProcessingError'
  }
}

export function documentBlockTextContext(blockId: string): Buffer {
  return Buffer.from(`${blockId}:documentBlock.text`)
}

/**
 * Orchestrates Protocol v1 without depending on a concrete PDF or OCR engine.
 * Plaintext block text is encrypted as each page_result arrives; only encrypted
 * persistence inputs are retained until the final atomic database commit.
 */
export class DocumentProcessingService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly processor: DocumentProcessor,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: DocumentProcessingIdFactory = generateUuidV7
  ) {
    if (processor.parserType.trim().length === 0) throw new Error('Document processor parserType must not be empty')
  }

  async process(documentId: string): Promise<Document> {
    const source = this.documents.findProcessingSource(documentId)
    if (source === undefined) throw new DocumentProcessingError('DOCUMENT_NOT_FOUND', 'Document was not found')
    if (source.sourcePathCipher === undefined) {
      throw new DocumentProcessingError('SOURCE_PATH_UNAVAILABLE', 'Document source path is unavailable')
    }

    let filePath: string
    try {
      filePath = decrypt(
        source.sourcePathCipher,
        this.keys.persistenceKey,
        Buffer.from(`${documentId}:document.sourcePath`)
      ).toString('utf8')
    } catch (error) {
      throw new DocumentProcessingError('SOURCE_PATH_DECRYPTION_FAILED', 'Document source path could not be decrypted', {
        cause: error
      })
    }
    if (filePath.length === 0) throw new DocumentProcessingError('SOURCE_PATH_UNAVAILABLE', 'Document source path is unavailable')
    await this.assertSourceUnchanged(source.document, filePath)

    const startedAt = this.now()
    const jobId = this.generateId(startedAt)
    try {
      this.documents.markProcessing(documentId, this.processor.parserType, startedAt)
    } catch (error) {
      throw new DocumentProcessingError('PERSISTENCE_FAILURE', 'Document could not enter processing state', {
        cause: error
      })
    }

    const pages = new Map<number, CreateDocumentPageInput>()
    const blocks: CreateDocumentBlockInput[] = []
    try {
      const processorTerminal = await this.processor.processDocument(
        {
          protocolVersion: 1,
          type: 'process_document',
          jobId,
          documentId,
          filePath,
          options: {
            preferNativeText: true,
            enableOcr: false,
            enableLayoutAnalysis: false,
            pageStart: 1,
            pageEnd: null
          }
        },
        (event) => {
          const validatedEvent = this.validateWorkerEvent(event, jobId, documentId)
          if (validatedEvent.type !== 'page_result') return
          if (pages.has(validatedEvent.page.pageNo)) {
            throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor returned a duplicate page')
          }

          const createdAt = this.now()
          const pageId = this.generateId(createdAt)
          const page: CreateDocumentPageInput = {
            id: pageId,
            documentId,
            pageNo: validatedEvent.page.pageNo,
            originalWidth: validatedEvent.page.originalWidth,
            originalHeight: validatedEvent.page.originalHeight,
            rotation: validatedEvent.page.rotation,
            sourceType: validatedEvent.page.sourceType,
            createdAt
          }
          pages.set(page.pageNo, page)

          const localIds = new Set<string>()
          for (const workerBlock of validatedEvent.page.blocks) {
            if (localIds.has(workerBlock.localId)) {
              throw new DocumentProcessingError(
                'INVALID_DOCUMENT_MODEL',
                'Document processor returned a duplicate page-local block ID'
              )
            }
            localIds.add(workerBlock.localId)
            const blockId = this.generateId(createdAt)
            blocks.push({
              id: blockId,
              documentId,
              pageId,
              blockType: workerBlock.blockType,
              textCipher: encrypt(
                Buffer.from(workerBlock.text, 'utf8'),
                this.keys.persistenceKey,
                documentBlockTextContext(blockId)
              ),
              source: workerBlock.source,
              ...(workerBlock.confidence === undefined ? {} : { confidence: workerBlock.confidence }),
              bbox: workerBlock.bbox,
              readingOrder: workerBlock.readingOrder,
              createdAt
            })
          }
        }
      )

      const terminal = this.validateWorkerEvent(processorTerminal, jobId, documentId)
      if (terminal.type !== 'completed' && terminal.type !== 'cancelled' && terminal.type !== 'error') {
        throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor did not return a terminal event')
      }
      this.assertCompletedModel(terminal, pages)
      await this.assertSourceUnchanged(source.document, filePath)
      const completedAt = this.now()
      try {
        return this.documents.completeProcessing({
          documentId,
          parserType: this.processor.parserType,
          pageCount: terminal.pageCount,
          pages: [...pages.values()].sort((left, right) => left.pageNo - right.pageNo),
          blocks,
          updatedAt: completedAt
        })
      } catch (error) {
        throw new DocumentProcessingError('PERSISTENCE_FAILURE', 'Document Model could not be persisted', {
          cause: error
        })
      }
    } catch (error) {
      const failure =
        error instanceof DocumentProcessingError
          ? error
          : new DocumentProcessingError('PROCESSOR_FAILURE', 'Document processor failed', { cause: error })
      try {
        this.documents.markProcessingFailed(documentId, this.now())
      } catch (stateError) {
        throw new DocumentProcessingError(
          'PERSISTENCE_FAILURE',
          'Document processing failed and its state could not be finalized',
          { cause: new AggregateError([failure, stateError]) }
        )
      }
      throw failure
    }
  }

  private async assertSourceUnchanged(document: Document, filePath: string): Promise<void> {
    let currentSource: Awaited<ReturnType<typeof inspectDocumentSource>>
    try {
      currentSource = await inspectDocumentSource(filePath)
    } catch (error) {
      throw new DocumentProcessingError('SOURCE_VALIDATION_FAILED', 'Document source could not be validated', {
        cause: error
      })
    }
    if (currentSource.fileHash !== document.fileHash) {
      throw new DocumentProcessingError('SOURCE_CHANGED', 'Document source changed after import')
    }
  }

  private validateWorkerEvent(event: WorkerEvent, jobId: string, documentId: string): WorkerEvent {
    let validated: WorkerEvent
    try {
      validated = parseWorkerEvent(event)
    } catch {
      throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor returned an invalid event')
    }
    if (validated.jobId !== jobId || validated.documentId !== documentId) {
      throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor returned an event for another job')
    }
    return validated
  }

  private assertCompletedModel(
    terminal: WorkerTerminalEvent,
    pages: ReadonlyMap<number, CreateDocumentPageInput>
  ): asserts terminal is Extract<WorkerTerminalEvent, { type: 'completed' }> {
    if (terminal.type === 'error') throw new DocumentProcessingError(terminal.code, terminal.message)
    if (terminal.type === 'cancelled') {
      throw new DocumentProcessingError('CANCELLED', 'Document processing was cancelled')
    }
    if (terminal.pageCount < 1 || terminal.processedPages !== terminal.pageCount || pages.size !== terminal.pageCount) {
      throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor returned an incomplete document')
    }
    for (let pageNo = 1; pageNo <= terminal.pageCount; pageNo += 1) {
      if (!pages.has(pageNo)) {
        throw new DocumentProcessingError('INVALID_DOCUMENT_MODEL', 'Document processor returned a non-contiguous document')
      }
    }
  }
}
