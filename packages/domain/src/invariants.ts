import type {
  Document,
  DocumentBlock,
  DocumentPage,
  Entity,
  EntityAlias,
  EntityConstraint,
  EntityRelationship,
  Mention,
  NormalizedBBox,
  ProtectedValue
} from './types'

/** Raised when an object would violate a documented AliasAI domain rule. */
export class DomainInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainInvariantError'
  }
}

function requireIdentifier(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainInvariantError(`${field} must not be empty`)
  }
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainInvariantError(`${field} must be a non-negative safe integer`)
  }
}

function requireFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new DomainInvariantError(`${field} must be finite`)
  }
}

function requireUnitInterval(value: number, field: string): void {
  requireFinite(value, field)
  if (value < 0 || value > 1) {
    throw new DomainInvariantError(`${field} must be between 0 and 1`)
  }
}

/** Verifies the sole authoritative coordinate representation used by V1. */
export function assertNormalizedBBox(bbox: NormalizedBBox): void {
  requireUnitInterval(bbox.x, 'bbox.x')
  requireUnitInterval(bbox.y, 'bbox.y')
  requireUnitInterval(bbox.width, 'bbox.width')
  requireUnitInterval(bbox.height, 'bbox.height')
  if (bbox.x + bbox.width > 1) {
    throw new DomainInvariantError('bbox horizontal extent must remain within the page')
  }
  if (bbox.y + bbox.height > 1) {
    throw new DomainInvariantError('bbox vertical extent must remain within the page')
  }
}

export function assertDocument(document: Document): void {
  requireIdentifier(document.id, 'document.id')
  requireIdentifier(document.matterId, 'document.matterId')
  requireIdentifier(document.fileHash, 'document.fileHash')
  requireIdentifier(document.mimeType, 'document.mimeType')
  requireNonNegativeInteger(document.createdAt, 'document.createdAt')
  requireNonNegativeInteger(document.updatedAt, 'document.updatedAt')
  if (document.updatedAt < document.createdAt) {
    throw new DomainInvariantError('document.updatedAt must not precede document.createdAt')
  }
  if (document.pageCount !== undefined && (!Number.isSafeInteger(document.pageCount) || document.pageCount < 1)) {
    throw new DomainInvariantError('document.pageCount must be a positive safe integer when present')
  }
}

export function assertDocumentPage(page: DocumentPage): void {
  requireIdentifier(page.id, 'page.id')
  requireIdentifier(page.documentId, 'page.documentId')
  if (!Number.isSafeInteger(page.pageNo) || page.pageNo < 1) {
    throw new DomainInvariantError('page.pageNo must be a positive safe integer')
  }
  if (!Number.isFinite(page.originalWidth) || page.originalWidth <= 0) {
    throw new DomainInvariantError('page.originalWidth must be positive')
  }
  if (!Number.isFinite(page.originalHeight) || page.originalHeight <= 0) {
    throw new DomainInvariantError('page.originalHeight must be positive')
  }
  if (!Number.isSafeInteger(page.rotation)) {
    throw new DomainInvariantError('page.rotation must be a safe integer')
  }
}

export function assertDocumentBlock(block: DocumentBlock): void {
  requireIdentifier(block.id, 'block.id')
  requireIdentifier(block.documentId, 'block.documentId')
  requireIdentifier(block.pageId, 'block.pageId')
  assertNormalizedBBox(block.bbox)
  if (!Number.isSafeInteger(block.readingOrder) || block.readingOrder < 0) {
    throw new DomainInvariantError('block.readingOrder must be a non-negative safe integer')
  }
  if (block.confidence !== undefined) requireUnitInterval(block.confidence, 'block.confidence')
}

export function assertMention(mention: Mention): void {
  requireIdentifier(mention.id, 'mention.id')
  requireIdentifier(mention.matterId, 'mention.matterId')
  requireIdentifier(mention.documentId, 'mention.documentId')
  requireIdentifier(mention.pageId, 'mention.pageId')
  requireIdentifier(mention.blockId, 'mention.blockId')
  requireNonNegativeInteger(mention.startOffset, 'mention.startOffset')
  requireNonNegativeInteger(mention.endOffset, 'mention.endOffset')
  if (mention.endOffset <= mention.startOffset) {
    throw new DomainInvariantError('mention.endOffset must be greater than mention.startOffset')
  }
  requireUnitInterval(mention.confidence, 'mention.confidence')
  if (mention.bbox !== undefined) assertNormalizedBBox(mention.bbox)
}

export function assertEntity(entity: Entity): void {
  requireIdentifier(entity.id, 'entity.id')
  requireIdentifier(entity.matterId, 'entity.matterId')
  requireIdentifier(entity.publicToken, 'entity.publicToken')
  requireNonNegativeInteger(entity.createdAt, 'entity.createdAt')
  requireNonNegativeInteger(entity.updatedAt, 'entity.updatedAt')
  if (entity.updatedAt < entity.createdAt) {
    throw new DomainInvariantError('entity.updatedAt must not precede entity.createdAt')
  }
  if (entity.resolutionConfidence !== undefined) {
    requireUnitInterval(entity.resolutionConfidence, 'entity.resolutionConfidence')
  }

  if (entity.status === 'MERGED') {
    if (entity.mergedIntoEntityId === undefined) {
      throw new DomainInvariantError('merged entity must redirect to a canonical entity')
    }
    if (entity.mergedIntoEntityId === entity.id) {
      throw new DomainInvariantError('merged entity cannot redirect to itself')
    }
  } else if (entity.mergedIntoEntityId !== undefined) {
    throw new DomainInvariantError('only merged entities may have a redirect')
  }
}

export function assertEntityAlias(alias: EntityAlias): void {
  requireIdentifier(alias.id, 'alias.id')
  requireIdentifier(alias.matterId, 'alias.matterId')
  requireIdentifier(alias.entityId, 'alias.entityId')
  requireIdentifier(alias.alias, 'alias.alias')
  requireNonNegativeInteger(alias.createdAt, 'alias.createdAt')
}

export function assertProtectedValue(value: ProtectedValue): void {
  requireIdentifier(value.id, 'protectedValue.id')
  requireIdentifier(value.matterId, 'protectedValue.matterId')
  if (value.publicToken !== undefined) requireIdentifier(value.publicToken, 'protectedValue.publicToken')
  requireNonNegativeInteger(value.createdAt, 'protectedValue.createdAt')
}

export function assertEntityRelationship(relationship: EntityRelationship): void {
  requireIdentifier(relationship.id, 'relationship.id')
  requireIdentifier(relationship.matterId, 'relationship.matterId')
  requireIdentifier(relationship.sourceEntityId, 'relationship.sourceEntityId')
  requireIdentifier(relationship.targetEntityId, 'relationship.targetEntityId')
  requireIdentifier(relationship.relationshipType, 'relationship.relationshipType')
  requireUnitInterval(relationship.confidence, 'relationship.confidence')
  requireNonNegativeInteger(relationship.createdAt, 'relationship.createdAt')
}

/** Ensures identities do not cross the Matter privacy boundary. */
export function assertSameMatter(
  first: { readonly matterId: string },
  second: { readonly matterId: string },
  description = 'objects'
): void {
  if (first.matterId !== second.matterId) {
    throw new DomainInvariantError(`${description} must belong to the same Matter`)
  }
}

/**
 * Returns a new Mention assignment after checking Matter scope. It cannot add
 * a second assignment because a Mention has only one entityId field.
 */
export function assignMentionToEntity(mention: Mention, entity: Entity): Mention {
  assertMention(mention)
  assertEntity(entity)
  assertSameMatter(mention, entity, 'mention and entity')
  if (entity.status !== 'ACTIVE') {
    throw new DomainInvariantError('mentions may only be assigned to an active canonical entity')
  }

  return { ...mention, entityId: entity.id }
}

/** Public tokens are immutable after creation, even when aliases or status change. */
export function assertPublicTokenUnchanged(previous: Entity, next: Entity): void {
  if (previous.id !== next.id) {
    throw new DomainInvariantError('public token comparison requires the same entity')
  }
  if (previous.publicToken !== next.publicToken) {
    throw new DomainInvariantError('an entity publicToken is immutable')
  }
}

/** Marks an active source Entity as merged while retaining its original public token. */
export function mergeEntity(source: Entity, target: Entity, updatedAt: number): Entity {
  assertEntity(source)
  assertEntity(target)
  assertSameMatter(source, target, 'merge source and target')
  requireNonNegativeInteger(updatedAt, 'updatedAt')
  if (source.id === target.id) {
    throw new DomainInvariantError('an entity cannot merge into itself')
  }
  if (source.status !== 'ACTIVE' || target.status !== 'ACTIVE') {
    throw new DomainInvariantError('only active entities can participate in a merge')
  }
  if (updatedAt < source.updatedAt) {
    throw new DomainInvariantError('merge updatedAt must not precede source.updatedAt')
  }

  const merged: Entity = {
    ...source,
    status: 'MERGED',
    mergedIntoEntityId: target.id,
    updatedAt
  }
  assertEntity(merged)
  assertPublicTokenUnchanged(source, merged)
  return merged
}

/**
 * Produces one canonical ordering so the pair (A, B) cannot duplicate (B, A).
 */
export function canonicalizeEntityPair(entityAId: string, entityBId: string): readonly [string, string] {
  requireIdentifier(entityAId, 'entityAId')
  requireIdentifier(entityBId, 'entityBId')
  if (entityAId === entityBId) {
    throw new DomainInvariantError('an entity constraint requires two distinct entities')
  }
  return entityAId < entityBId ? [entityAId, entityBId] : [entityBId, entityAId]
}

export function canonicalizeEntityConstraint(constraint: EntityConstraint): EntityConstraint {
  requireIdentifier(constraint.id, 'constraint.id')
  requireIdentifier(constraint.matterId, 'constraint.matterId')
  requireIdentifier(constraint.reason, 'constraint.reason')
  requireNonNegativeInteger(constraint.createdAt, 'constraint.createdAt')
  const [entityAId, entityBId] = canonicalizeEntityPair(constraint.entityAId, constraint.entityBId)
  return { ...constraint, entityAId, entityBId }
}
