import type { EntityType } from '@aliasai/domain'
import type { ConstraintDTO, EntitySummaryDTO, MentionReviewDTO, ReviewQueryService } from './review-read'
import type { EntityResolutionService, EntityService } from './index'

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
    private readonly entities: EntityService,
    private readonly review: ReviewQueryService
  ) {}

  /** Accepts a pending candidate or reassigns; the repository closes candidates and writes the USER event. */
  assignToEntity(mentionId: string, entityId: string): MentionReviewDTO {
    this.resolution.assign(mentionId, entityId)
    return this.requireMention(mentionId)
  }

  /**
   * Confirms a mention's current assignment. Assigning the same entity would
   * throw, so confirmation is an idempotent read-back; recording a distinct
   * ENTITY_CONFIRMED event needs a repository entry point in a later version.
   */
  confirmMention(mentionId: string): MentionReviewDTO {
    const mention = this.review.getMention(mentionId)
    if (mention === undefined) {
      throw new ReviewOperationError('MENTION_NOT_FOUND', 'Mention was not found')
    }
    if (mention.assignedEntity === null) {
      throw new ReviewOperationError('MENTION_UNASSIGNED', 'Only an assigned Mention can be confirmed')
    }
    return mention
  }

  /**
   * Creates a new USER-actor Entity and assigns the mention to it. The two
   * steps commit in separate transactions; a crash between them leaves a
   * harmless unassigned Entity.
   */
  createEntityAndAssign(
    mentionId: string,
    input: { readonly primaryAlias: string; readonly entityType: EntityType }
  ): { readonly mention: MentionReviewDTO; readonly entity: EntitySummaryDTO } {
    const mention = this.review.getMention(mentionId)
    if (mention === undefined) {
      throw new ReviewOperationError('MENTION_NOT_FOUND', 'Mention was not found')
    }
    const created = this.entities.create(mention.matterId, input.entityType, input.primaryAlias)
    this.resolution.assign(mentionId, created.entity.id)
    const refreshed = this.review.getMention(mentionId)
    const entity = refreshed?.assignedEntity
    if (refreshed === undefined || entity == null || entity.id !== created.entity.id) {
      throw new ReviewOperationError('ASSIGNMENT_FAILED', 'Newly created Entity was not assigned to the Mention')
    }
    return { mention: refreshed, entity }
  }

  markCannotLink(matterId: string, entityAId: string, entityBId: string, reason: string): ConstraintDTO {
    const constraint = this.resolution.addConstraint(matterId, entityAId, entityBId, 'CANNOT_LINK', reason)
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
