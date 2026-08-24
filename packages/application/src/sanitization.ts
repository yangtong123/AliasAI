import { decrypt, encrypt, generateUuidV7 } from '@aliasai/crypto'
import type { SanitizationMapping } from '@aliasai/domain'
import type {
  CreateSanitizedBlockInput,
  SanitizationRepository,
  SanitizationResult
} from '@aliasai/database'
import { mentionTypeToProtectedValueType } from '@aliasai/entity-resolution'
import { defaultRestorePolicy, pseudonymizeText, PseudonymizationError, type Replacement } from '@aliasai/pseudonymization'
import { findPublicTokenReferences, rehydrateText, type RehydrationTarget } from '@aliasai/rehydration'
import type { ApplicationKeys } from './index'
import { documentBlockTextContext } from './document-processing'
import { protectedValueContext } from './entity-resolution'
import { privacyDetectionErrorContext } from './privacy-detection'

export type SanitizationIdFactory = (timestamp: number) => string

export interface SanitizationRunResult extends SanitizationResult {
  readonly reused: boolean
}

export interface RehydrationInput {
  readonly sanitizedDocumentId: string
  /** Sanitized AI result text received from the provider boundary. */
  readonly text: string
  /** Also restore values whose policy is RESTORE_ON_REQUEST. NEVER_RESTORE values are never restored. */
  readonly includeRestoreOnRequest?: boolean
}

export interface RehydrationResult {
  readonly text: string
  /** Tokens left verbatim for manual review: unknown, tampered, or policy-withheld. */
  readonly unresolvedTokens: readonly string[]
}

export class SanitizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SanitizationError'
  }
}

export function sanitizedBlockTextContext(sanitizedBlockId: string): Buffer {
  return Buffer.from(`${sanitizedBlockId}:sanitizedBlock.text`)
}

/**
 * Converts a READY Document Model into an encrypted sanitized artifact and its
 * Mapping Vault. Replacements come strictly from Mention -> Entity -> Primary
 * Alias/Public Token; the workflow is fail-closed, so unresolved, overlapping,
 * out-of-range, or tokenless Mentions abort the run instead of producing a
 * sendable artifact. Plaintext never persists; the vault stores only pseudonym
 * metadata.
 */
export class PseudonymizationService {
  constructor(
    private readonly sanitization: SanitizationRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: SanitizationIdFactory = generateUuidV7
  ) {}

  async sanitize(documentId: string): Promise<SanitizationRunResult> {
    const completed = this.sanitization.findCompleted(documentId)
    if (completed !== undefined) return { ...completed, reused: true }

    const startedAt = this.now()
    const jobId = this.generateId(startedAt)
    let begun: ReturnType<SanitizationRepository['begin']>
    try {
      begun = this.sanitization.begin({ documentId, jobId, startedAt })
    } catch (error) {
      throw new SanitizationError('SANITIZATION_NOT_AVAILABLE', 'Document could not enter pseudonymization', {
        cause: error
      })
    }

    const transientCiphers: Buffer[] = []
    try {
      const sanitizedDocumentId = this.generateId(this.now())
      const blocks: CreateSanitizedBlockInput[] = []
      const mappings: SanitizationMapping[] = []
      for (const [blockIndex, block] of begun.blocks.entries()) {
        let plaintextBytes: Buffer
        try {
          plaintextBytes = decrypt(block.textCipher, this.keys.persistenceKey, documentBlockTextContext(block.id))
        } catch (error) {
          throw new SanitizationError('BLOCK_DECRYPTION_FAILED', 'Document Block could not be decrypted', {
            cause: error
          })
        }
        let text: string
        try {
          text = plaintextBytes.toString('utf8')
        } finally {
          plaintextBytes.fill(0)
        }

        const replacements: Replacement[] = []
        for (const mention of block.mentions) {
          const protectedValueType = mentionTypeToProtectedValueType(mention.type)
          if (protectedValueType === undefined) {
            throw new SanitizationError(
              'UNSUPPORTED_MENTION_TYPE',
              `Mention type ${mention.type} cannot be sanitized in V1`
            )
          }
          if (
            mention.entityId === undefined ||
            mention.entityStatus !== 'ACTIVE' ||
            mention.entityPrimaryAlias === null ||
            mention.protectedValuePublicToken === null
          ) {
            throw new SanitizationError(
              'UNRESOLVED_MENTION',
              'Every Mention must resolve to an active Entity with a restoration token before sanitization'
            )
          }
          replacements.push({
            startOffset: mention.startOffset,
            endOffset: mention.endOffset,
            alias: mention.entityPrimaryAlias,
            publicToken: mention.protectedValuePublicToken
          })
          mappings.push({
            id: this.generateId(this.now()),
            matterId: block.matterId,
            sanitizedDocumentId,
            mentionId: mention.id,
            entityId: mention.entityId,
            publicToken: mention.protectedValuePublicToken,
            alias: mention.entityPrimaryAlias,
            restorePolicy: defaultRestorePolicy(protectedValueType),
            createdAt: this.now()
          })
        }

        let sanitized: string
        try {
          sanitized = pseudonymizeText(text, replacements)
        } catch (error) {
          if (error instanceof PseudonymizationError) {
            throw new SanitizationError('INVALID_REPLACEMENT', 'Mention ranges could not be replaced safely', {
              cause: error
            })
          }
          throw error
        }

        // Leak self-check: no replaced Mention plaintext may survive in the
        // sendable text (an alias equal to the real value is a leak too).
        for (const mention of block.mentions) {
          if (sanitized.includes(text.slice(mention.startOffset, mention.endOffset))) {
            throw new SanitizationError('LEAK_DETECTED', 'Sanitized text still contains Mention plaintext')
          }
        }

        const sanitizedBlockId = this.generateId(this.now())
        const sanitizedBytes = Buffer.from(sanitized, 'utf8')
        let textCipher: Buffer
        try {
          textCipher = encrypt(sanitizedBytes, this.keys.persistenceKey, sanitizedBlockTextContext(sanitizedBlockId))
        } finally {
          sanitizedBytes.fill(0)
        }
        transientCiphers.push(textCipher)
        blocks.push({
          id: sanitizedBlockId,
          sanitizedDocumentId,
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.id,
          textCipher,
          createdAt: this.now()
        })
        if (begun.blocks.length > 0) {
          this.sanitization.updateProgress(jobId, blockIndex + 1, begun.blocks.length)
        }
      }

      const result = this.sanitization.complete({
        documentId,
        jobId,
        sanitizedDocument: {
          id: sanitizedDocumentId,
          matterId: begun.document.matterId,
          documentId,
          jobId,
          createdAt: this.now()
        },
        blocks,
        mappings,
        finishedAt: this.now()
      })
      return { ...result, reused: false }
    } catch (error) {
      const failure =
        error instanceof SanitizationError ? error : new SanitizationError('SANITIZATION_FAILED', 'Pseudonymization failed')
      try {
        const errorBytes = Buffer.from(JSON.stringify({ code: failure.code }), 'utf8')
        let errorCipher: Buffer
        try {
          errorCipher = encrypt(errorBytes, this.keys.persistenceKey, privacyDetectionErrorContext(jobId))
        } finally {
          errorBytes.fill(0)
        }
        try {
          this.sanitization.fail(documentId, jobId, errorCipher, this.now())
        } finally {
          errorCipher.fill(0)
        }
      } catch (stateError) {
        throw new SanitizationError(
          'PERSISTENCE_FAILURE',
          'Pseudonymization failed and its state could not be finalized',
          { cause: new AggregateError([failure, stateError]) }
        )
      }
      throw failure
    } finally {
      for (const cipher of transientCiphers) cipher.fill(0)
    }
  }
}

/**
 * Restores sanitized AI output locally using the Mapping Vault. Public Tokens
 * are the lookup anchor; restore policies are honored per mapping; unknown or
 * tampered tokens remain verbatim and are reported for manual review.
 */
export class RehydrationService {
  constructor(
    private readonly sanitization: SanitizationRepository,
    private readonly keys: ApplicationKeys
  ) {}

  rehydrate(input: RehydrationInput): RehydrationResult {
    const tokenToTarget = new Map<string, RehydrationTarget>()
    // Several mappings often point at the same Entity; load its aliases once.
    const aliasesByEntity = new Map<string, readonly string[]>()
    const aliasesFor = (matterId: string, entityId: string): readonly string[] => {
      const key = `${matterId}:${entityId}`
      let aliases = aliasesByEntity.get(key)
      if (aliases === undefined) {
        aliases = this.sanitization.findEntityAliases(matterId, entityId)
        aliasesByEntity.set(key, aliases)
      }
      return aliases
    }
    for (const mapping of this.sanitization.findRehydrationMappings(input.sanitizedDocumentId)) {
      if (mapping.restorePolicy === 'NEVER_RESTORE') continue
      if (mapping.restorePolicy === 'RESTORE_ON_REQUEST' && input.includeRestoreOnRequest !== true) continue
      let valueBytes: Buffer
      try {
        valueBytes = decrypt(mapping.valueCipher, this.keys.persistenceKey, protectedValueContext(mapping.protectedValueId))
      } catch (error) {
        throw new SanitizationError('VALUE_DECRYPTION_FAILED', 'Mapping Vault value could not be decrypted', {
          cause: error
        })
      }
      try {
        tokenToTarget.set(mapping.publicToken, {
          value: valueBytes.toString('utf8'),
          aliases: aliasesFor(mapping.matterId, mapping.entityId)
        })
      } finally {
        valueBytes.fill(0)
      }
    }

    const text = rehydrateText(input.text, tokenToTarget)
    // Report only tokens still present in the rehydrated text: unknown tokens,
    // policy-withheld tokens that were actually referenced, and known tokens whose
    // alias was tampered with (left verbatim by rehydrateText).
    return { text, unresolvedTokens: [...new Set(findPublicTokenReferences(text))].sort() }
  }
}
