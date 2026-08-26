import { decrypt, generateUuidV7 } from '@aliasai/crypto'
import type { DocumentParseStatus, WorkspaceEvent } from '@aliasai/domain'
import { WorkspaceLifecycleRepositoryError, type DocumentRepository, type MatterRepository, type WorkspaceLifecycleRepository } from '@aliasai/database'
import type { ApplicationKeys } from './index'
import { documentOriginalNameContext, matterNameContext } from './index'

export interface TrashedMatterDTO {
  readonly id: string
  readonly name: string
  readonly deletedAt: number
  readonly createdAt: number
}

export interface TrashedDocumentDTO {
  readonly id: string
  readonly matterId: string
  readonly matterName: string
  readonly originalName: string
  readonly mimeType: string
  readonly parseStatus: DocumentParseStatus
  readonly deletedAt: number
  readonly createdAt: number
}

/** Trash view DTO: decrypted display names only, never ciphers or keys. */
export interface WorkspaceTrashDTO {
  readonly matters: readonly TrashedMatterDTO[]
  readonly documents: readonly TrashedDocumentDTO[]
}

export type WorkspaceLifecycleResult = { readonly changed: boolean }

export class WorkspaceLifecycleError extends Error {
  constructor(
    readonly code:
      | 'MATTER_NOT_AVAILABLE'
      | 'DOCUMENT_NOT_AVAILABLE'
      | 'DOCUMENT_BUSY'
      | 'RESTORE_CONFLICT'
      | 'TRASH_OPERATION_FAILED',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'WorkspaceLifecycleError'
  }
}

export type WorkspaceLifecycleIdFactory = (timestamp: number) => string

/**
 * Generates event IDs/timestamps, validates event scope, and maps repository
 * failures to coded application errors. Every real transition appends exactly
 * one user-authored WorkspaceEvent; no-op requests change nothing.
 */
export class WorkspaceLifecycleService {
  constructor(
    private readonly lifecycle: WorkspaceLifecycleRepository,
    private readonly documents: DocumentRepository,
    private readonly matters: MatterRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: WorkspaceLifecycleIdFactory = generateUuidV7
  ) {}

  listTrash(): WorkspaceTrashDTO {
    const source = this.lifecycle.listTrash()
    return {
      matters: source.matters.map((item) => ({
        id: item.matter.id,
        name: this.decryptText(item.nameCipher, matterNameContext(item.matter.id), 'MATTER_NAME'),
        deletedAt: item.matter.updatedAt,
        createdAt: item.matter.createdAt
      })),
      documents: source.documents.map((item) => ({
        id: item.document.id,
        matterId: item.document.matterId,
        matterName: this.decryptText(item.matterNameCipher, matterNameContext(item.document.matterId), 'MATTER_NAME'),
        originalName: this.decryptText(
          item.originalNameCipher,
          documentOriginalNameContext(item.document.id),
          'DOCUMENT_NAME'
        ),
        mimeType: item.document.mimeType,
        parseStatus: item.document.parseStatus,
        deletedAt: item.document.deletedAt as number,
        createdAt: item.document.createdAt
      }))
    }
  }

  trashMatter(matterId: string): WorkspaceLifecycleResult {
    const matter = this.matters.findById(matterId)
    if (matter === undefined) {
      throw new WorkspaceLifecycleError('MATTER_NOT_AVAILABLE', 'Matter is not available')
    }
    return this.mutate(() => ({ matterId, event: this.matterEvent(matterId, 'MATTER_TRASHED') }), (input) =>
      this.lifecycle.trashMatter(input)
    )
  }

  restoreMatter(matterId: string): WorkspaceLifecycleResult {
    const matter = this.matters.findById(matterId)
    if (matter === undefined) {
      throw new WorkspaceLifecycleError('MATTER_NOT_AVAILABLE', 'Matter is not available')
    }
    return this.mutate(() => ({ matterId, event: this.matterEvent(matterId, 'MATTER_RESTORED') }), (input) =>
      this.lifecycle.restoreMatter(input)
    )
  }

  trashDocument(documentId: string): WorkspaceLifecycleResult {
    const document = this.documents.findById(documentId)
    if (document === undefined) {
      throw new WorkspaceLifecycleError('DOCUMENT_NOT_AVAILABLE', 'Document is not available')
    }
    return this.mutate(
      () => ({ documentId, event: this.documentEvent(documentId, document.matterId, 'DOCUMENT_TRASHED') }),
      (input) => this.lifecycle.trashDocument(input)
    )
  }

  restoreDocument(documentId: string): WorkspaceLifecycleResult {
    const document = this.documents.findById(documentId)
    if (document === undefined) {
      throw new WorkspaceLifecycleError('DOCUMENT_NOT_AVAILABLE', 'Document is not available')
    }
    return this.mutate(
      () => ({ documentId, event: this.documentEvent(documentId, document.matterId, 'DOCUMENT_RESTORED') }),
      (input) => this.lifecycle.restoreDocument(input)
    )
  }

  private mutate<Input>(
    buildInput: () => Input,
    operation: (input: Input) => WorkspaceLifecycleResult
  ): WorkspaceLifecycleResult {
    try {
      return operation(buildInput())
    } catch (error) {
      throw this.toApplicationError(error)
    }
  }

  private matterEvent(matterId: string, type: 'MATTER_TRASHED' | 'MATTER_RESTORED'): WorkspaceEvent {
    const timestamp = this.now()
    return { id: this.generateId(timestamp), matterId, type, actor: 'USER', createdAt: timestamp }
  }

  private documentEvent(
    documentId: string,
    matterId: string,
    type: 'DOCUMENT_TRASHED' | 'DOCUMENT_RESTORED'
  ): WorkspaceEvent {
    const timestamp = this.now()
    return { id: this.generateId(timestamp), matterId, documentId, type, actor: 'USER', createdAt: timestamp }
  }

  private toApplicationError(error: unknown): WorkspaceLifecycleError {
    if (error instanceof WorkspaceLifecycleRepositoryError) {
      switch (error.code) {
        case 'MATTER_NOT_FOUND':
        case 'MATTER_UNAVAILABLE':
          return new WorkspaceLifecycleError('MATTER_NOT_AVAILABLE', 'Matter is not available', { cause: error })
        case 'DOCUMENT_NOT_FOUND':
          return new WorkspaceLifecycleError('DOCUMENT_NOT_AVAILABLE', 'Document is not available', { cause: error })
        case 'MATTER_BUSY':
        case 'DOCUMENT_BUSY':
          return new WorkspaceLifecycleError('DOCUMENT_BUSY', 'Document has running work', { cause: error })
        case 'RESTORE_CONFLICT':
          return new WorkspaceLifecycleError(
            'RESTORE_CONFLICT',
            'An active Document with the same file hash already exists',
            { cause: error }
          )
      }
    }
    return new WorkspaceLifecycleError('TRASH_OPERATION_FAILED', 'The trash operation failed', { cause: error })
  }

  private decryptText(cipherText: Buffer, context: Buffer, field: string): string {
    try {
      return decrypt(cipherText, this.keys.persistenceKey, context).toString('utf8')
    } catch (error) {
      throw new WorkspaceLifecycleError('TRASH_OPERATION_FAILED', `${field} could not be decrypted`, { cause: error })
    }
  }
}
