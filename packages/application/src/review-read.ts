import { decrypt } from '@aliasai/crypto'
import type {
  DocumentParseStatus,
  Entity,
  EntityStatus,
  EntityType,
  MentionStrength,
  MentionType,
  MentionReviewStatus,
  MentionDetector
} from '@aliasai/domain'
import type {
  CandidateWithEvidence,
  DocumentListItem,
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterListItem,
  ReviewMentionSource,
  ReviewQueryRepository
} from '@aliasai/database'
import type { ApplicationKeys } from './index'
import { documentBlockTextContext, documentOriginalNameContext, matterNameContext } from './index'
import { mentionTextContext } from './privacy-detection'

export interface MatterSummaryDTO {
  readonly id: string
  readonly name: string
  readonly status: MatterListItem['status']
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DocumentSummaryDTO {
  readonly id: string
  readonly matterId: string
  readonly originalName: string
  readonly mimeType: string
  readonly parseStatus: DocumentParseStatus
  readonly pageCount: number | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EntitySummaryDTO {
  readonly id: string
  readonly publicToken: string
  readonly type: EntityType
  readonly status: EntityStatus
  readonly primaryAlias: string | null
  readonly createdAt: number
}

export interface CandidateEvidenceDTO {
  readonly evidenceType: string
  readonly weight: number
  readonly score: number
}

export interface CandidateDTO {
  readonly candidateId: string
  readonly entity: EntitySummaryDTO
  readonly score: number
  readonly state: 'PENDING' | 'ACCEPTED' | 'REJECTED'
  readonly algorithmVersion: string
  readonly evidence: readonly CandidateEvidenceDTO[]
}

export interface ConstraintDTO {
  readonly id: string
  readonly entityAId: string
  readonly entityBId: string
  readonly type: 'MUST_LINK' | 'CANNOT_LINK'
  readonly reason: string
  readonly createdAt: number
}

/**
 * Per-mention review state derived at read time, not persisted: a mention with
 * open PENDING candidates needs review; an assigned mention either auto-linked
 * or came from a user decision; otherwise it is unresolved.
 */
export type MentionDecisionStatus = 'AUTO_LINKED' | 'USER_ASSIGNED' | 'NEEDS_REVIEW' | 'UNRESOLVED'

export interface MentionReviewDTO {
  readonly mentionId: string
  readonly matterId: string
  readonly documentId: string
  readonly type: MentionType
  readonly strength: MentionStrength
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly blockId: string
  readonly pageNo: number
  readonly confidence: number
  readonly detector: MentionDetector
  readonly reviewStatus: MentionReviewStatus
  readonly decisionStatus: MentionDecisionStatus
  readonly assignedEntity: EntitySummaryDTO | null
  readonly candidates: readonly CandidateDTO[]
  /** Top candidate score minus the runner-up; null with fewer than two candidates. */
  readonly margin: number | null
}

export interface BlockReviewDTO {
  readonly blockId: string
  readonly pageNo: number
  readonly readingOrder: number
  readonly text: string
  readonly mentions: readonly MentionReviewDTO[]
}

export interface JobSummaryDTO {
  readonly type: string
  readonly status: string
  readonly progress: number
  readonly createdAt: number
}

export interface DocumentReviewDTO {
  readonly document: DocumentSummaryDTO
  readonly blocks: readonly BlockReviewDTO[]
  readonly entities: readonly EntitySummaryDTO[]
  readonly constraints: readonly ConstraintDTO[]
  readonly counts: {
    readonly mentions: number
    readonly resolved: number
    readonly needsReview: number
    readonly unresolved: number
  }
  readonly jobs: readonly JobSummaryDTO[]
}

export class ReviewQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ReviewQueryError'
  }
}

/**
 * Read model for the review UI. Decrypts matter names, document names, block
 * text, and mention text for display only; DTOs never carry ciphers or keys.
 * A corrupt row fails loudly rather than rendering silently wrong data.
 */
export class ReviewQueryService {
  constructor(
    private readonly review: ReviewQueryRepository,
    private readonly documents: DocumentRepository,
    private readonly entities: EntityRepository,
    private readonly resolution: EntityResolutionRepository,
    private readonly keys: ApplicationKeys
  ) {}

  listMatters(): readonly MatterSummaryDTO[] {
    return this.review.listMatters().map((matter) => ({
      id: matter.id,
      name: this.decryptText(matter.nameCipher, matterNameContext(matter.id), 'MATTER_NAME'),
      status: matter.status,
      createdAt: matter.createdAt,
      updatedAt: matter.updatedAt
    }))
  }

  listDocuments(matterId: string): readonly DocumentSummaryDTO[] {
    return this.review.listDocumentsByMatter(matterId).map((item) => this.toDocumentSummary(item))
  }

  getDocumentReview(documentId: string): DocumentReviewDTO {
    const documentRow = this.documents.findById(documentId)
    if (documentRow === undefined) {
      throw new ReviewQueryError('DOCUMENT_NOT_FOUND', 'Document was not found')
    }
    const listItem = this.review
      .listDocumentsByMatter(documentRow.matterId)
      .find((item) => item.document.id === documentId)
    if (listItem === undefined) {
      throw new ReviewQueryError('DOCUMENT_NOT_FOUND', 'Document was not found')
    }

    const entitySummaries = this.loadEntities(documentRow.matterId)
    const entitiesById = new Map(entitySummaries.map((entity) => [entity.id, entity]))
    const mentions = this.review.findReviewMentions(documentId)
    const blocks = this.review.findReviewBlocks(documentId)
    const pageNoByBlockId = new Map(blocks.map((block) => [block.id, block.pageNo]))
    const candidates = this.review.findCandidatesForMentions(mentions.map((mention) => mention.id))
    const candidatesByMention = new Map<string, CandidateWithEvidence[]>()
    for (const candidate of candidates) {
      const list = candidatesByMention.get(candidate.mentionId)
      if (list === undefined) candidatesByMention.set(candidate.mentionId, [candidate])
      else list.push(candidate)
    }
    const assignmentActors = this.review.findLatestAssignmentActors(mentions.map((mention) => mention.id))

    const mentionDtos = mentions.map((mention) =>
      this.toMentionDto(mention, pageNoByBlockId.get(mention.blockId) ?? 0, entitiesById, candidatesByMention, assignmentActors)
    )
    const mentionsByBlock = new Map<string, MentionReviewDTO[]>()
    for (const mention of mentionDtos) {
      const list = mentionsByBlock.get(mention.blockId)
      if (list === undefined) mentionsByBlock.set(mention.blockId, [mention])
      else list.push(mention)
    }
    const blockDtos = blocks.map((block) => ({
      blockId: block.id,
      pageNo: block.pageNo,
      readingOrder: block.readingOrder,
      text: this.decryptText(block.textCipher, documentBlockTextContext(block.id), 'BLOCK_TEXT'),
      mentions: mentionsByBlock.get(block.id) ?? []
    }))

    const counts = {
      mentions: mentionDtos.length,
      resolved: mentionDtos.filter((mention) => mention.assignedEntity !== null).length,
      needsReview: mentionDtos.filter((mention) => mention.decisionStatus === 'NEEDS_REVIEW').length,
      unresolved: mentionDtos.filter((mention) => mention.decisionStatus === 'UNRESOLVED').length
    }
    const jobs = this.review
      .findLatestJobs(documentId)
      .map((job) => ({ type: job.type, status: job.status, progress: job.progress, createdAt: job.createdAt }))

    return {
      document: this.toDocumentSummary(listItem),
      blocks: blockDtos,
      entities: entitySummaries,
      constraints: this.resolution.findConstraints(documentRow.matterId).map((constraint) => ({
        id: constraint.id,
        entityAId: constraint.entityAId,
        entityBId: constraint.entityBId,
        type: constraint.type,
        reason: constraint.reason,
        createdAt: constraint.createdAt
      })),
      counts,
      jobs
    }
  }

  /** Refreshes a single mention view after a review operation. */
  getMention(mentionId: string): MentionReviewDTO | undefined {
    const mention = this.review.findMentionById(mentionId)
    if (mention === undefined) return undefined
    const blocks = this.review.findReviewBlocks(mention.documentId)
    const pageNo = blocks.find((block) => block.id === mention.blockId)?.pageNo ?? 0
    const entitySummaries = this.loadEntities(mention.matterId)
    const entitiesById = new Map(entitySummaries.map((entity) => [entity.id, entity]))
    const candidates = this.review.findCandidatesForMentions([mentionId])
    const candidatesByMention = new Map<string, CandidateWithEvidence[]>([[mentionId, [...candidates]]])
    const actors = this.review.findLatestAssignmentActors([mentionId])
    return this.toMentionDto(mention, pageNo, entitiesById, candidatesByMention, actors)
  }

  private toDocumentSummary(item: DocumentListItem): DocumentSummaryDTO {
    return {
      id: item.document.id,
      matterId: item.document.matterId,
      originalName: this.decryptText(
        item.originalNameCipher,
        documentOriginalNameContext(item.document.id),
        'DOCUMENT_NAME'
      ),
      mimeType: item.document.mimeType,
      parseStatus: item.document.parseStatus,
      pageCount: item.document.pageCount ?? 0,
      createdAt: item.document.createdAt,
      updatedAt: item.document.updatedAt
    }
  }

  private loadEntities(matterId: string): readonly EntitySummaryDTO[] {
    const aliases = this.entities.findAliases(matterId)
    const primaryByEntity = new Map<string, string>()
    for (const alias of aliases) {
      if (alias.isPrimary && !primaryByEntity.has(alias.entityId)) primaryByEntity.set(alias.entityId, alias.alias)
    }
    const summaries: EntitySummaryDTO[] = []
    for (const type of ['PERSON', 'ORGANIZATION'] as const) {
      for (const entity of this.entities.findByMatterAndType(matterId, type)) {
        summaries.push(this.toEntitySummary(entity, primaryByEntity.get(entity.id) ?? null))
      }
    }
    return summaries
  }

  private toEntitySummary(entity: Entity, primaryAlias: string | null): EntitySummaryDTO {
    return {
      id: entity.id,
      publicToken: entity.publicToken,
      type: entity.type,
      status: entity.status,
      primaryAlias,
      createdAt: entity.createdAt
    }
  }

  private toMentionDto(
    mention: ReviewMentionSource,
    pageNo: number,
    entitiesById: ReadonlyMap<string, EntitySummaryDTO>,
    candidatesByMention: ReadonlyMap<string, readonly CandidateWithEvidence[]>,
    assignmentActors: ReadonlyMap<string, 'SYSTEM' | 'USER'>
  ): MentionReviewDTO {
    const candidates = candidatesByMention.get(mention.id) ?? []
    const candidateDtos: CandidateDTO[] = candidates.map((candidate) => ({
      candidateId: candidate.id,
      entity: entitiesById.get(candidate.candidateEntityId) ?? {
        id: candidate.candidateEntityId,
        publicToken: '',
        type: 'PERSON',
        status: 'ACTIVE',
        primaryAlias: null,
        createdAt: candidate.createdAt
      },
      score: candidate.score,
      state: candidate.state,
      algorithmVersion: candidate.algorithmVersion,
      evidence: candidate.evidence.map((item) => ({
        evidenceType: item.evidenceType,
        weight: item.weight,
        score: item.score
      }))
    }))
    const hasPending = candidates.some((candidate) => candidate.state === 'PENDING')
    const assignedEntity = mention.entityId === undefined ? null : (entitiesById.get(mention.entityId) ?? null)
    // The latest assignment event's actor distinguishes system auto-links from
    // user decisions; both close candidates, so candidate state alone cannot.
    const decisionStatus: MentionDecisionStatus = hasPending
      ? 'NEEDS_REVIEW'
      : mention.entityId === undefined
        ? 'UNRESOLVED'
        : assignmentActors.get(mention.id) === 'USER'
          ? 'USER_ASSIGNED'
          : 'AUTO_LINKED'
    const topTwo = candidates.slice(0, 2)

    return {
      mentionId: mention.id,
      matterId: mention.matterId,
      documentId: mention.documentId,
      type: mention.type,
      strength: mention.strength,
      text: this.decryptText(mention.textCipher, mentionTextContext(mention.id), 'MENTION_TEXT'),
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      blockId: mention.blockId,
      pageNo,
      confidence: mention.confidence,
      detector: mention.detector,
      reviewStatus: mention.reviewStatus,
      decisionStatus,
      assignedEntity,
      candidates: candidateDtos,
      margin: topTwo.length === 2 ? topTwo[0]!.score - topTwo[1]!.score : null
    }
  }

  private decryptText(cipherText: Buffer, context: Buffer, field: string): string {
    try {
      return decrypt(cipherText, this.keys.persistenceKey, context).toString('utf8')
    } catch (error) {
      throw new ReviewQueryError('DECRYPTION_FAILED', `${field} could not be decrypted`, { cause: error })
    }
  }
}
