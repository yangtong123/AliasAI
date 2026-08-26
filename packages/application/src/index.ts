import { encrypt, generatePublicToken, generateUuidV7 } from '@aliasai/crypto'
import type { Entity, EntityAlias, EntityType, Matter, Document } from '@aliasai/domain'
import type { EntityRepository, MatterRepository, DocumentRepository } from '@aliasai/database'
import { inspectDocumentSource } from '@aliasai/document'
import { resolutionEventContext } from './entity-resolution'

export interface ApplicationKeys {
  /** Local-only AES-256-GCM key. Never expose this value through renderer IPC. */
  readonly persistenceKey: Buffer
  /**
   * Local-only HMAC search key for ProtectedValue fingerprints. It must differ
   * from persistenceKey and must never be exposed through renderer IPC.
   */
  readonly searchKey?: Buffer
}

export function matterNameContext(matterId: string): Buffer {
  return Buffer.from(`${matterId}:matter.name`)
}

export function documentOriginalNameContext(documentId: string): Buffer {
  return Buffer.from(`${documentId}:document.originalName`)
}

export function documentSourcePathContext(documentId: string): Buffer {
  return Buffer.from(`${documentId}:document.sourcePath`)
}

export class MatterService {
  constructor(
    private readonly matters: MatterRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now
  ) {}

  create(name: string): Matter {
    if (name.trim().length === 0) throw new Error('Matter name must not be empty')
    const timestamp = this.now()
    const id = generateUuidV7(timestamp)
    return this.matters.create({
      id,
      nameCipher: encrypt(Buffer.from(name, 'utf8'), this.keys.persistenceKey, matterNameContext(id)),
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }
}

export class DocumentImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'DocumentImportError'
  }
}

export class DocumentImportService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly matters: MatterRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now
  ) {}

  async importFromPath(matterId: string, filePath: string): Promise<Document> {
    // Fast pre-check for a friendly early error; the authoritative check runs
    // inside the creation transaction below, so trashing the Matter during the
    // async file inspection cannot leave a hidden Document behind.
    const matter = this.matters.findById(matterId)
    if (matter === undefined || matter.status === 'DELETED') {
      throw new DocumentImportError('MATTER_NOT_AVAILABLE', 'Matter is not available')
    }
    const source = await inspectDocumentSource(filePath)
    const timestamp = this.now()
    const id = generateUuidV7(timestamp)
    try {
      const decision = this.documents.createInAvailableMatter({
        id,
        matterId,
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
      })
      if (decision.status === 'MATTER_UNAVAILABLE') {
        throw new DocumentImportError('MATTER_NOT_AVAILABLE', 'Matter is not available')
      }
      return decision.document
    } catch (error) {
      // MATTER_NOT_AVAILABLE keeps its dedicated code; every persistence
      // failure (SQLite, unique-constraint races, ciphers) stays IMPORT_FAILED
      // instead of collapsing to INTERNAL_ERROR at the IPC boundary.
      if (error instanceof DocumentImportError) throw error
      throw new DocumentImportError('IMPORT_FAILED', 'Document could not be imported', { cause: error })
    }
  }
}

export class EntityService {
  constructor(
    private readonly entities: EntityRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now
  ) {}

  create(matterId: string, type: EntityType, primaryAlias: string): { readonly entity: Entity; readonly alias: EntityAlias } {
    if (primaryAlias.trim().length === 0) throw new Error('Primary alias must not be empty')
    const timestamp = this.now()
    const entity: Entity = {
      id: generateUuidV7(timestamp),
      matterId,
      type,
      publicToken: generatePublicToken(type),
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const alias: EntityAlias = {
      id: generateUuidV7(timestamp + 1),
      matterId,
      entityId: entity.id,
      alias: primaryAlias,
      aliasType: 'PRIMARY',
      isPrimary: true,
      createdAt: timestamp
    }
    const eventId = generateUuidV7(timestamp + 2)
    const event = {
      id: eventId,
      matterId,
      type: 'ENTITY_CREATED' as const,
      entityId: entity.id,
      actor: 'USER' as const,
      payloadCipher: encrypt(Buffer.from('{}'), this.keys.persistenceKey, resolutionEventContext(eventId)),
      createdAt: timestamp
    }
    const created = this.entities.createWithPrimaryAliasAndEvent({ entity, primaryAlias: alias, event })
    return { entity: created.entity, alias: created.primaryAlias }
  }
}

export * from './document-processing'
export * from './privacy-detection'
export * from './entity-resolution'
export * from './sanitization'
export * from './review-read'
export * from './review-operations'
export * from './sanitized-preview'
export * from './ai-execution'
export * from './startup-recovery'
export * from './workspace-lifecycle'
