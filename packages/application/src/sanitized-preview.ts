import { decrypt } from '@aliasai/crypto'
import { mentionTypeToProtectedValueType } from '@aliasai/entity-resolution'
import type { DocumentParseStatus } from '@aliasai/domain'
import type {
  DocumentRepository,
  ReviewQueryRepository,
  SanitizationReadinessMention,
  SanitizationRepository
} from '@aliasai/database'
import type {
  PseudonymizationService,
  RehydrationInput,
  RehydrationResult,
  RehydrationService
} from './index'
import type { ApplicationKeys } from './index'
import { sanitizedBlockTextContext } from './sanitization'

export type SanitizationBlockerReason =
  | 'UNSUPPORTED_TYPE'
  | 'UNRESOLVED'
  | 'INACTIVE_ENTITY'
  | 'MISSING_ALIAS'
  | 'MISSING_TOKEN'

export type SanitizedPreview =
  | {
      readonly status: 'NOT_READY'
      readonly parseStatus: DocumentParseStatus
    }
  | {
      readonly status: 'READY'
      readonly blockers: readonly { readonly mentionId: string; readonly reason: SanitizationBlockerReason }[]
    }
  | {
      readonly status: 'AVAILABLE'
      readonly sanitizedDocumentId: string
      readonly createdAt: number
      readonly blocks: readonly {
        readonly blockId: string
        readonly pageNo: number
        readonly readingOrder: number
        readonly text: string
      }[]
      readonly mappings: readonly {
        readonly mentionId: string
        readonly alias: string
        readonly publicToken: string
        readonly restorePolicy: string
      }[]
    }

/**
 * Read model for the sanitized preview. Blocker predicates mirror
 * PseudonymizationService.sanitize exactly, so "why can't I generate" in the
 * UI always matches what a real sanitize run would reject.
 */
export class SanitizedPreviewService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly review: ReviewQueryRepository,
    private readonly sanitization: SanitizationRepository,
    private readonly pseudonymization: PseudonymizationService,
    private readonly rehydration: RehydrationService,
    private readonly keys: ApplicationKeys
  ) {}

  getPreview(documentId: string): SanitizedPreview {
    const document = this.documents.findById(documentId)
    if (document === undefined) {
      throw new Error('Document was not found')
    }
    if (document.parseStatus === 'SANITIZED') {
      const completed = this.sanitization.findCompleted(documentId)
      if (completed === undefined) throw new Error('Sanitized Document is missing its artifact')
      return this.toAvailablePreview(documentId, completed.sanitizedDocument.id, completed.sanitizedDocument.createdAt)
    }
    if (document.parseStatus === 'READY' || document.parseStatus === 'FAILED') {
      const blockers = this.review
        .findSanitizationReadiness(documentId)
        .map((mention) => ({ mentionId: mention.mentionId, reason: blockerReason(mention) }))
        .filter((blocker): blocker is { mentionId: string; reason: SanitizationBlockerReason } => blocker !== null)
      return { status: 'READY', blockers }
    }
    return { status: 'NOT_READY', parseStatus: document.parseStatus }
  }

  /** Runs (or reuses) the SANITIZE job and returns the available preview. */
  async generatePreview(documentId: string): Promise<SanitizedPreview> {
    await this.pseudonymization.sanitize(documentId)
    return this.getPreview(documentId)
  }

  /** Local rehydration demo over the Mapping Vault; no AI provider involved. */
  rehydrateDemo(input: RehydrationInput): RehydrationResult {
    return this.rehydration.rehydrate(input)
  }

  private toAvailablePreview(
    documentId: string,
    sanitizedDocumentId: string,
    createdAt: number
  ): Extract<SanitizedPreview, { status: 'AVAILABLE' }> {
    const sourceBlocks = this.review.findReviewBlocks(documentId)
    const sourceByBlockId = new Map(sourceBlocks.map((block) => [block.id, block]))
    const blocks = this.sanitization.findSanitizedBlocks(sanitizedDocumentId)
    const mappings = this.sanitization.findRehydrationMappings(sanitizedDocumentId)
    return {
      status: 'AVAILABLE',
      sanitizedDocumentId,
      createdAt,
      blocks: blocks.map((block) => ({
        blockId: block.blockId,
        pageNo: sourceByBlockId.get(block.blockId)?.pageNo ?? 0,
        readingOrder: sourceByBlockId.get(block.blockId)?.readingOrder ?? 0,
        text: this.decryptText(block.textCipher, sanitizedBlockTextContext(block.id), 'SANITIZED_BLOCK')
      })),
      mappings: mappings.map((mapping) => ({
        mentionId: mapping.mentionId,
        alias: mapping.alias,
        publicToken: mapping.publicToken,
        restorePolicy: mapping.restorePolicy
      }))
    }
  }

  private decryptText(cipherText: Buffer, context: Buffer, field: string): string {
    try {
      return decrypt(cipherText, this.keys.persistenceKey, context).toString('utf8')
    } catch (error) {
      throw new Error(`${field} could not be decrypted`, { cause: error })
    }
  }
}

/** Mirrors the fail-closed predicates of PseudonymizationService.sanitize. */
function blockerReason(mention: SanitizationReadinessMention): SanitizationBlockerReason | null {
  if (mentionTypeToProtectedValueType(mention.mentionType) === undefined) return 'UNSUPPORTED_TYPE'
  if (mention.entityId === null) return 'UNRESOLVED'
  if (mention.entityStatus !== 'ACTIVE') return 'INACTIVE_ENTITY'
  if (mention.entityPrimaryAlias === null) return 'MISSING_ALIAS'
  if (mention.protectedValuePublicToken === null) return 'MISSING_TOKEN'
  return null
}
