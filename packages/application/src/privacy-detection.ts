import { decrypt, encrypt, generateUuidV7 } from '@aliasai/crypto'
import type { Document, Mention, ProcessingJob } from '@aliasai/domain'
import { assertMention } from '@aliasai/domain'
import type { CreateMentionInput, PrivacyDetectionRepository } from '@aliasai/database'
import { RuleBasedPrivacyDetector, type MentionProposal, type PrivacyDetector } from '@aliasai/privacy-detection'
import type { ApplicationKeys } from './index'
import { documentBlockTextContext } from './document-processing'

export type PrivacyDetectionIdFactory = (timestamp: number) => string

export interface PrivacyDetectionRunResult {
  readonly document: Document
  readonly job: ProcessingJob
  readonly mentions: readonly Mention[]
  readonly reused: boolean
}

export class PrivacyDetectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
    /** Stage ownership exists, but its failure-finalizing write did not finish. */
    readonly analysisOwner?: { readonly jobId?: string }
  ) {
    super(message, options)
    this.name = 'PrivacyDetectionError'
  }
}

export function mentionTextContext(mentionId: string): Buffer {
  return Buffer.from(`${mentionId}:mention.text`)
}

export function privacyDetectionErrorContext(jobId: string): Buffer {
  return Buffer.from(`${jobId}:processingJob.error`)
}

/**
 * Reads encrypted Document Blocks, runs a replaceable local detector, and owns
 * the DETECTING -> DETECTED/FAILED application transition. Plaintext never
 * crosses the detector boundary or enters repository inputs unencrypted.
 */
export class PrivacyDetectionService {
  constructor(
    private readonly repository: PrivacyDetectionRepository,
    private readonly keys: ApplicationKeys,
    private readonly detector: PrivacyDetector = new RuleBasedPrivacyDetector(),
    private readonly now: () => number = Date.now,
    private readonly generateId: PrivacyDetectionIdFactory = generateUuidV7
  ) {}

  async detect(documentId: string): Promise<PrivacyDetectionRunResult> {
    const completed = this.repository.findCompleted(documentId)
    if (completed !== undefined) return { ...completed, reused: true }

    const startedAt = this.now()
    const jobId = this.generateId(startedAt)
    let begun: ReturnType<PrivacyDetectionRepository['begin']>
    try {
      begun = this.repository.begin({ documentId, jobId, startedAt })
    } catch (error) {
      throw new PrivacyDetectionError('DETECTION_NOT_AVAILABLE', 'Document could not enter privacy detection', {
        cause: error
      })
    }

    const encryptedMentions: CreateMentionInput[] = []
    try {
      for (const [blockIndex, block] of begun.blocks.entries()) {
        let plaintextBytes: Buffer
        try {
          plaintextBytes = decrypt(block.textCipher, this.keys.persistenceKey, documentBlockTextContext(block.id))
        } catch (error) {
          throw new PrivacyDetectionError('BLOCK_DECRYPTION_FAILED', 'Document Block could not be decrypted', {
            cause: error
          })
        }
        let text: string
        try {
          text = plaintextBytes.toString('utf8')
        } finally {
          plaintextBytes.fill(0)
        }

        const proposals = await this.detector.detect({
          matterId: block.matterId,
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.id,
          text
        })
        const validated = this.validateProposals(proposals, block, text)
        for (const proposal of validated) {
          const createdAt = this.now()
          const id = this.generateId(createdAt)
          const mention: Mention = {
            id,
            matterId: block.matterId,
            documentId: block.documentId,
            pageId: block.pageId,
            blockId: block.id,
            type: proposal.type,
            strength: proposal.strength,
            startOffset: proposal.startOffset,
            endOffset: proposal.endOffset,
            detector: proposal.detector,
            confidence: proposal.confidence,
            reviewStatus: 'UNREVIEWED',
            createdAt
          }
          assertMention(mention)
          const mentionBytes = Buffer.from(text.slice(proposal.startOffset, proposal.endOffset), 'utf8')
          let textCipher: Buffer
          try {
            textCipher = encrypt(mentionBytes, this.keys.persistenceKey, mentionTextContext(id))
          } finally {
            mentionBytes.fill(0)
          }
          encryptedMentions.push({
            ...mention,
            textCipher
          })
        }
        this.repository.updateProgress(jobId, blockIndex + 1, begun.blocks.length)
      }

      const result = this.repository.complete({
        documentId,
        jobId,
        mentions: encryptedMentions,
        finishedAt: this.now()
      })
      return { ...result, reused: false }
    } catch (error) {
      const failure =
        error instanceof PrivacyDetectionError
          ? error
          : new PrivacyDetectionError('DETECTION_FAILED', 'Privacy detection failed')
      try {
        const errorBytes = Buffer.from(JSON.stringify({ code: failure.code }), 'utf8')
        let errorCipher: Buffer
        try {
          errorCipher = encrypt(errorBytes, this.keys.persistenceKey, privacyDetectionErrorContext(jobId))
        } finally {
          errorBytes.fill(0)
        }
        try {
          this.repository.fail(documentId, jobId, errorCipher, this.now())
        } finally {
          errorCipher.fill(0)
        }
      } catch (stateError) {
        throw new PrivacyDetectionError(
          'PERSISTENCE_FAILURE',
          'Privacy detection failed and its state could not be finalized',
          { cause: new AggregateError([failure, stateError]) },
          { jobId }
        )
      }
      throw failure
    } finally {
      for (const mention of encryptedMentions) mention.textCipher.fill(0)
    }
  }

  private validateProposals(
    proposals: readonly MentionProposal[],
    block: { readonly matterId: string; readonly documentId: string; readonly pageId: string; readonly id: string },
    text: string
  ): readonly MentionProposal[] {
    const sorted = [...proposals].sort(
      (left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset
    )
    let previousEnd = -1
    for (const proposal of sorted) {
      if (
        proposal.matterId !== block.matterId ||
        proposal.documentId !== block.documentId ||
        proposal.pageId !== block.pageId ||
        proposal.blockId !== block.id
      ) {
        throw new PrivacyDetectionError('INVALID_PROPOSAL', 'Detector proposal crossed a Document boundary')
      }
      if (
        !Number.isSafeInteger(proposal.startOffset) ||
        !Number.isSafeInteger(proposal.endOffset) ||
        proposal.startOffset < 0 ||
        proposal.endOffset <= proposal.startOffset ||
        proposal.endOffset > text.length
      ) {
        throw new PrivacyDetectionError('INVALID_PROPOSAL', 'Detector proposal contained invalid offsets')
      }
      if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
        throw new PrivacyDetectionError('INVALID_PROPOSAL', 'Detector proposal contained invalid confidence')
      }
      if (
        !MENTION_TYPES.has(proposal.type) ||
        !MENTION_STRENGTHS.has(proposal.strength) ||
        !MENTION_DETECTORS.has(proposal.detector)
      ) {
        throw new PrivacyDetectionError('INVALID_PROPOSAL', 'Detector proposal contained an unsupported classifier value')
      }
      if (proposal.startOffset < previousEnd) {
        throw new PrivacyDetectionError('INVALID_PROPOSAL', 'Detector proposals must not overlap')
      }
      previousEnd = proposal.endOffset
    }
    return sorted
  }
}

const MENTION_TYPES = new Set([
  'PERSON',
  'ORGANIZATION',
  'PHONE',
  'EMAIL',
  'ID_CARD',
  'BANK_ACCOUNT',
  'ADDRESS',
  'CASE_NUMBER',
  'CONTRACT_NUMBER',
  'COURT',
  'LAWYER',
  'JUDGE'
])
const MENTION_STRENGTHS = new Set(['EXPLICIT', 'PARTIAL', 'REFERENCE'])
const MENTION_DETECTORS = new Set(['REGEX', 'NER', 'DICTIONARY', 'USER', 'FUSION'])
