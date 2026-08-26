import type { EntityType, MentionType } from '@aliasai/domain'
import type { ConstraintDTO, EntitySummaryDTO, MentionReviewDTO, ReviewQueryService } from './review-read'
import type { EntityResolutionService } from './index'

export class ReviewOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ReviewOperationError'
  }
}

/**
 * Review mutations for the UI. Everything delegates to the audited application
 * services so each decision lands with its ResolutionEvent; the only new logic
 * is composing multi-step use cases and refreshing the read model.
 */
export class ReviewOperationService {
  constructor(
    private readonly resolution: EntityResolutionService,
    private readonly review: ReviewQueryService
  ) {}

  /** Accepts a pending candidate or reassigns; the repository closes candidates and writes the USER event. */
  assignToEntity(mentionId: string, entityId: string): MentionReviewDTO {
    this.resolution.assign(mentionId, entityId)
    return this.requireMention(mentionId)
  }

  /**
   * Confirms a mention's current assignment; the repository writes the
   * ENTITY_CONFIRMED event and marks the mention reviewed. Confirming the same
   * assignment again is an idempotent no-op.
   */
  confirmMention(mentionId: string): MentionReviewDTO {
    const mention = this.review.getMention(mentionId)
    if (mention === undefined) {
      throw new ReviewOperationError('MENTION_NOT_FOUND', 'Mention was not found')
    }
    if (mention.assignedEntity === null) {
      throw new ReviewOperationError('MENTION_UNASSIGNED', 'Only an assigned Mention can be confirmed')
    }
    this.resolution.confirm(mentionId)
    return this.requireMention(mentionId)
  }

  /**
   * Creates a new USER-actor Entity and assigns the mention to it in a single
   * transaction: a crash can never leave an unassigned Entity behind.
   */
  createEntityAndAssign(
    mentionId: string,
    input: { readonly primaryAlias: string; readonly entityType: EntityType }
  ): { readonly mention: MentionReviewDTO; readonly entity: EntitySummaryDTO } {
    const mention = this.review.getMention(mentionId)
    if (mention === undefined) {
      throw new ReviewOperationError('MENTION_NOT_FOUND', 'Mention was not found')
    }
    const created = this.resolution.createEntityWithAssignment(mentionId, input)
    const refreshed = this.review.getMention(mentionId)
    const entity = refreshed?.assignedEntity
    if (refreshed === undefined || entity == null || entity.id !== created.entity.id) {
      throw new ReviewOperationError('ASSIGNMENT_FAILED', 'Newly created Entity was not assigned to the Mention')
    }
    return { mention: refreshed, entity }
  }

  renameEntity(entityId: string, primaryAlias: string): { readonly renamed: true } {
    this.resolution.renameEntity(entityId, primaryAlias)
    return { renamed: true }
  }

  rejectMention(mentionId: string): MentionReviewDTO {
    this.resolution.reject(mentionId)
    return this.requireMention(mentionId)
  }

  mergeEntities(sourceEntityId: string, targetEntityId: string): { readonly merged: true } {
    this.resolution.merge(sourceEntityId, targetEntityId)
    return { merged: true }
  }

  splitMention(
    mentionId: string,
    primaryAlias: string
  ): { readonly mention: MentionReviewDTO; readonly entityId: string } {
    const split = this.resolution.splitMention(mentionId, primaryAlias)
    return { mention: this.requireMention(mentionId), entityId: split.entity.id }
  }

  createManualMention(input: {
    readonly blockId: string
    readonly type: MentionType
    readonly startOffset: number
    readonly endOffset: number
  }): MentionReviewDTO {
    const created = this.resolution.createManualMention(input)
    return this.requireMention(created.id)
  }

  markConstraint(
    matterId: string,
    entityAId: string,
    entityBId: string,
    type: 'MUST_LINK' | 'CANNOT_LINK',
    reason: string
  ): ConstraintDTO {
    const constraint = this.resolution.addConstraint(matterId, entityAId, entityBId, type, reason)
    return {
      id: constraint.id,
      entityAId: constraint.entityAId,
      entityBId: constraint.entityBId,
      type: constraint.type,
      reason: constraint.reason,
      createdAt: constraint.createdAt
    }
  }

  private requireMention(mentionId: string): MentionReviewDTO {
    const mention = this.review.getMention(mentionId)
    if (mention === undefined) {
      throw new ReviewOperationError('MENTION_NOT_FOUND', 'Mention was not found')
    }
    return mention
  }
}
