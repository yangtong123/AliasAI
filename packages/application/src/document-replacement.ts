import { encrypt, generateUuidV7 } from '@aliasai/crypto'
import type { Document } from '@aliasai/domain'
import {
  WorkspaceLifecycleRepositoryError,
  type DocumentRepository,
  type MatterRepository,
  type WorkspaceLifecycleRepository
} from '@aliasai/database'
import { inspectDocumentSource } from '@aliasai/document'
import { WorkspaceLifecycleError } from './workspace-lifecycle'
import type { ApplicationKeys } from './index'
import { documentOriginalNameContext, documentSourcePathContext } from './index'

export class DocumentReplacementError extends Error {
  constructor(
    readonly code:
      | 'MATTER_NOT_AVAILABLE'
      | 'DOCUMENT_NOT_AVAILABLE'
      | 'DOCUMENT_BUSY'
      | 'RESTORE_CONFLICT'
      | 'LINEAGE_CONFLICT'
      | 'REPLACE_OPERATION_FAILED',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentReplacementError'
  }
}

export type DocumentReplacementIdFactory = (timestamp: number) => string

/**
 * One-step Document replacement: pick a new source file and atomically trash
 * the old active Document, create the replacement as a new active Document,
 * record the version lineage, and append one DOCUMENT_REPLACED event. File
 * inspection and hashing happen before the database transaction, so a failed
 * inspection leaves the old Document untouched; nothing is ever copied from
 * the old Document's pipeline data.
 */
/**
 * Synchronous pre-commit guard: runs AFTER the awaited source inspection and
 * immediately BEFORE the replacement transaction, closing the last async
 * window in which an in-process analysis reservation could land while the
 * database still shows no running work.
 */
export type ReplacementPreCommitGuard = (documentId: string) => void

export class DocumentReplacementService {
  constructor(
    private readonly lifecycle: WorkspaceLifecycleRepository,
    private readonly documents: DocumentRepository,
    private readonly matters: MatterRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: DocumentReplacementIdFactory = generateUuidV7,
    private readonly preCommitGuard?: ReplacementPreCommitGuard
  ) {}

  async replaceFromPath(documentId: string, filePath: string): Promise<Document> {
    try {
      return await this.replaceUnchecked(documentId, filePath)
    } catch (error) {
      // Everything — pre-checks, clock and ID generation, inspection, and the
      // transaction — funnels through one coded boundary so no raw failure
      // degrades to INTERNAL_ERROR at IPC.
      throw this.toApplicationError(error)
    }
  }

  /** Inspection seam: the production implementation reads and hashes the file. */
  protected async inspectSource(filePath: string): Promise<Awaited<ReturnType<typeof inspectDocumentSource>>> {
    return inspectDocumentSource(filePath)
  }

  private async replaceUnchecked(documentId: string, filePath: string): Promise<Document> {
    // Fast pre-checks for friendly early errors; the transaction re-validates
    // authoritatively.
    const current = this.documents.findById(documentId)
    if (current === undefined || current.deletedAt !== undefined) {
      throw new DocumentReplacementError('DOCUMENT_NOT_AVAILABLE', 'Document is not available')
    }
    const matter = this.matters.findById(current.matterId)
    if (matter === undefined || matter.status === 'DELETED') {
      throw new DocumentReplacementError('MATTER_NOT_AVAILABLE', 'Matter is not available')
    }

    // Inspection and hashing run before any database work; a failure here
    // leaves the old Document exactly as it was.
    let source: Awaited<ReturnType<typeof inspectDocumentSource>>
    try {
      source = await this.inspectSource(filePath)
    } catch (error) {
      throw new DocumentReplacementError('REPLACE_OPERATION_FAILED', 'The replacement source could not be read', {
        cause: error
      })
    }
    // The inspection await above is the LAST async window before the
    // transaction; the authoritative reservation guard runs here, on the
    // synchronous path into lifecycle.replaceDocument.
    this.preCommitGuard?.(documentId)
    const timestamp = this.now()
    const id = this.generateId(timestamp)
    const eventId = this.generateId(timestamp)
    return this.lifecycle.replaceDocument({
      supersededDocumentId: documentId,
      replacement: {
        id,
        matterId: current.matterId,
        originalNameCipher: encrypt(
          Buffer.from(source.originalName, 'utf8'),
          this.keys.persistenceKey,
          documentOriginalNameContext(id)
        ),
        sourcePathCipher: encrypt(
          Buffer.from(source.sourcePath, 'utf8'),
          this.keys.persistenceKey,
          documentSourcePathContext(id)
        ),
        fileHash: source.fileHash,
        mimeType: source.mimeType,
        parseStatus: 'IMPORTED',
        createdAt: timestamp,
        updatedAt: timestamp
      },
      event: {
        id: eventId,
        matterId: current.matterId,
        documentId: id,
        supersededDocumentId: documentId,
        type: 'DOCUMENT_REPLACED',
        actor: 'USER',
        createdAt: timestamp
      }
    })
  }

  private toApplicationError(error: unknown): DocumentReplacementError | WorkspaceLifecycleError {
    if (error instanceof WorkspaceLifecycleRepositoryError) {
      switch (error.code) {
        case 'MATTER_NOT_FOUND':
        case 'MATTER_UNAVAILABLE':
          return new DocumentReplacementError('MATTER_NOT_AVAILABLE', 'Matter is not available', { cause: error })
        case 'DOCUMENT_NOT_FOUND':
        case 'DOCUMENT_UNAVAILABLE':
          return new DocumentReplacementError('DOCUMENT_NOT_AVAILABLE', 'Document is not available', { cause: error })
        case 'MATTER_BUSY':
        case 'DOCUMENT_BUSY':
          return new DocumentReplacementError('DOCUMENT_BUSY', 'Document has running work', { cause: error })
        case 'RESTORE_CONFLICT':
          return new DocumentReplacementError(
            'RESTORE_CONFLICT',
            'An active Document with the same file hash already exists',
            { cause: error }
          )
        case 'LINEAGE_CONFLICT':
          return new DocumentReplacementError(
            'LINEAGE_CONFLICT',
            'This Document was already replaced; restore its replacement instead',
            { cause: error }
          )
      }
    }
    if (error instanceof DocumentReplacementError) return error
    // Pre-commit guard failures carry their own actionable code (DOCUMENT_BUSY
    // for an in-process analysis reservation) and must surface verbatim.
    if (error instanceof WorkspaceLifecycleError) return error
    return new DocumentReplacementError('REPLACE_OPERATION_FAILED', 'The replacement failed', { cause: error })
  }
}
