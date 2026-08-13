import { describe, expect, it } from 'vitest'
import {
  DomainInvariantError,
  assertDocumentBlock,
  assertEntity,
  assertMention,
  assertProcessingJob,
  assertPublicTokenUnchanged,
  assignMentionToEntity,
  canonicalizeEntityConstraint,
  canonicalizeEntityPair,
  mergeEntity
} from '../src/index'
import type { Entity, Mention } from '../src/index'

const activeEntity: Entity = {
  id: 'entity-a',
  matterId: 'matter-1',
  type: 'PERSON',
  publicToken: '@P-8K3F7A',
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1
}

const mention: Mention = {
  id: 'mention-1',
  matterId: 'matter-1',
  documentId: 'document-1',
  pageId: 'page-1',
  blockId: 'block-1',
  type: 'PERSON',
  strength: 'EXPLICIT',
  startOffset: 0,
  endOffset: 2,
  detector: 'USER',
  confidence: 1,
  reviewStatus: 'CONFIRMED',
  createdAt: 1
}

describe('domain invariants', () => {
  it('accepts normalized block coordinates', () => {
    expect(() =>
      assertDocumentBlock({
        id: 'block-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockType: 'TEXT',
        bbox: { x: 0, y: 0.2, width: 1, height: 0.8 },
        source: 'NATIVE',
        readingOrder: 0
      })
    ).not.toThrow()
  })

  it('rejects block coordinates outside the normalized range', () => {
    expect(() =>
      assertDocumentBlock({
        id: 'block-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockType: 'TEXT',
        bbox: { x: -0.01, y: 0, width: 0.2, height: 0.2 },
        source: 'OCR',
        readingOrder: 1
      })
    ).toThrow(DomainInvariantError)
  })

  it('rejects a normalized rectangle that extends beyond the page', () => {
    expect(() =>
      assertDocumentBlock({
        id: 'block-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockType: 'TEXT',
        bbox: { x: 0.9, y: 0.8, width: 0.2, height: 0.1 },
        source: 'OCR',
        readingOrder: 1
      })
    ).toThrow('bbox horizontal extent must remain within the page')
  })

  it('allows an unassigned Mention but rejects invalid text offsets', () => {
    expect(() => assertMention(mention)).not.toThrow()
    expect(() => assertMention({ ...mention, startOffset: 2, endOffset: 2 })).toThrow(
      'mention.endOffset must be greater than mention.startOffset'
    )
  })

  it('rejects unsupported Mention classifier values at runtime', () => {
    expect(() => assertMention({ ...mention, detector: 'REMOTE_MODEL' as Mention['detector'] })).toThrow(
      'mention.detector is not supported'
    )
  })

  it('enforces ProcessingJob lifecycle timestamps and completion progress', () => {
    expect(() =>
      assertProcessingJob({
        id: 'job-1',
        documentId: 'document-1',
        type: 'DETECT',
        status: 'RUNNING',
        progress: 0.5,
        createdAt: 1,
        startedAt: 1
      })
    ).not.toThrow()
    expect(() =>
      assertProcessingJob({
        id: 'job-1',
        documentId: 'document-1',
        type: 'DETECT',
        status: 'COMPLETED',
        progress: 0.5,
        createdAt: 1,
        startedAt: 1,
        finishedAt: 2
      })
    ).toThrow('completed ProcessingJob must have progress 1')
    expect(() =>
      assertProcessingJob({
        id: 'job-1',
        documentId: 'document-1',
        type: 'REMOTE' as 'DETECT',
        status: 'RUNNING',
        progress: 0,
        createdAt: 1,
        startedAt: 1
      })
    ).toThrow('processingJob.type is not supported')
  })

  it('assigns a Mention only to an active Entity in the same Matter', () => {
    expect(assignMentionToEntity(mention, activeEntity)).toMatchObject({ entityId: 'entity-a' })
    expect(() => assignMentionToEntity(mention, { ...activeEntity, matterId: 'matter-2' })).toThrow(
      'mention and entity must belong to the same Matter'
    )
  })

  it('requires every merged Entity to retain a redirect', () => {
    expect(() => assertEntity({ ...activeEntity, status: 'MERGED' })).toThrow(
      'merged entity must redirect to a canonical entity'
    )
  })

  it('merges by redirect while preserving the source public token', () => {
    const target: Entity = {
      ...activeEntity,
      id: 'entity-b',
      publicToken: '@P-R4N8J2'
    }

    expect(mergeEntity(activeEntity, target, 2)).toEqual({
      ...activeEntity,
      status: 'MERGED',
      mergedIntoEntityId: 'entity-b',
      updatedAt: 2
    })
  })

  it('rejects a changed public token for the same Entity', () => {
    const target: Entity = { ...activeEntity, id: 'entity-b', publicToken: '@P-R4N8J2' }
    const merged = mergeEntity(activeEntity, target, 2)

    expect(() => assertPublicTokenUnchanged(merged, { ...merged, publicToken: '@P-CHANGED' })).toThrow(
      'an entity publicToken is immutable'
    )
  })

  it('canonicalizes constraint entity pairs and rejects self constraints', () => {
    expect(canonicalizeEntityPair('entity-z', 'entity-a')).toEqual(['entity-a', 'entity-z'])
    expect(
      canonicalizeEntityConstraint({
        id: 'constraint-1',
        matterId: 'matter-1',
        entityAId: 'entity-z',
        entityBId: 'entity-a',
        type: 'CANNOT_LINK',
        reason: 'Synthetic test data',
        source: 'USER',
        createdAt: 1
      })
    ).toMatchObject({ entityAId: 'entity-a', entityBId: 'entity-z' })
    expect(() => canonicalizeEntityPair('entity-a', 'entity-a')).toThrow(DomainInvariantError)
  })
})
