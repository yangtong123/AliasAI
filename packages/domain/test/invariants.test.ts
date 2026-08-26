import { describe, expect, it } from 'vitest'
import {
  DomainInvariantError,
  assertAiExecution,
  assertDocument,
  assertDocumentBlock,
  assertEntity,
  assertMention,
  assertProcessingJob,
  assertPublicTokenUnchanged,
  assertSanitizationMapping,
  assertSanitizedBlock,
  assertSanitizedDocument,
  assertWorkspaceEvent,
  assignMentionToEntity,
  canonicalizeEntityConstraint,
  canonicalizeEntityPair,
  confirmMentionAssignment,
  mergeEntity
} from '../src/index'
import type {
  AiExecution,
  Document,
  Entity,
  Mention,
  SanitizationMapping,
  SanitizedBlock,
  SanitizedDocument
} from '../src/index'

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

const document: Document = {
  id: 'document-1',
  matterId: 'matter-1',
  fileHash: 'hash-1',
  mimeType: 'application/pdf',
  parseStatus: 'IMPORTED',
  createdAt: 1,
  updatedAt: 1
}

const sanitizedDocument: SanitizedDocument = {
  id: 'sanitized-document-1',
  matterId: 'matter-1',
  documentId: 'document-1',
  jobId: 'job-1',
  createdAt: 1
}

const aiExecution: AiExecution = {
  id: 'ai-execution-1',
  matterId: 'matter-1',
  sanitizedDocumentId: 'sanitized-document-1',
  providerId: 'mock-v1',
  status: 'RUNNING',
  createdAt: 1,
  startedAt: 1
}

const sanitizedBlock: SanitizedBlock = {
  id: 'sanitized-block-1',
  sanitizedDocumentId: 'sanitized-document-1',
  documentId: 'document-1',
  pageId: 'page-1',
  blockId: 'block-1',
  createdAt: 1
}

const sanitizationMapping: SanitizationMapping = {
  id: 'mapping-1',
  matterId: 'matter-1',
  sanitizedDocumentId: 'sanitized-document-1',
  mentionId: 'mention-1',
  entityId: 'entity-a',
  publicToken: '@P-8K3F7A',
  alias: '原告甲',
  restorePolicy: 'ALWAYS_RESTORE',
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

  it('confirms only an assigned Mention and marks it reviewed', () => {
    const unassigned: Mention = { ...mention, reviewStatus: 'UNREVIEWED' }
    expect(() => confirmMentionAssignment(unassigned)).toThrow('only an assigned mention can be confirmed')

    const assigned = assignMentionToEntity(unassigned, activeEntity)
    expect(confirmMentionAssignment(assigned)).toMatchObject({ entityId: 'entity-a', reviewStatus: 'CONFIRMED' })
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

  it('accepts the SANITIZING document parse status', () => {
    expect(() => assertDocument({ ...document, parseStatus: 'SANITIZING' })).not.toThrow()
  })

  it('accepts a Document without deletedAt and a valid deletion timestamp', () => {
    expect(() => assertDocument(document)).not.toThrow()
    expect(() => assertDocument({ ...document, deletedAt: document.createdAt })).not.toThrow()
    expect(() => assertDocument({ ...document, deletedAt: document.updatedAt + 1 })).not.toThrow()
  })

  it('rejects negative, unsafe, or pre-creation deletion timestamps', () => {
    expect(() => assertDocument({ ...document, deletedAt: -1 })).toThrow(
      'document.deletedAt must be a non-negative safe integer'
    )
    expect(() => assertDocument({ ...document, deletedAt: 1.5 })).toThrow(DomainInvariantError)
    expect(() => assertDocument({ ...document, deletedAt: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'document.deletedAt must be a non-negative safe integer'
    )
    expect(() => assertDocument({ ...document, deletedAt: document.createdAt - 1 })).toThrow(
      'document.deletedAt must not precede document.createdAt'
    )
  })

  it('rejects workspace events with an invalid target shape', () => {
    expect(() =>
      assertWorkspaceEvent({ id: 'event-1', matterId: 'matter-1', type: 'MATTER_TRASHED', actor: 'USER', createdAt: 1 })
    ).not.toThrow()
    expect(() =>
      assertWorkspaceEvent({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'DOCUMENT_RESTORED',
        documentId: 'document-1',
        actor: 'USER',
        createdAt: 1
      })
    ).not.toThrow()
    // Matter events must not carry a documentId.
    expect(() =>
      assertWorkspaceEvent({
        id: 'event-1',
        matterId: 'matter-1',
        documentId: 'document-1',
        type: 'MATTER_TRASHED',
        actor: 'USER',
        createdAt: 1
      })
    ).toThrow('matter workspace events must not carry a documentId')
    // Document events require a documentId.
    expect(() =>
      assertWorkspaceEvent({ id: 'event-1', matterId: 'matter-1', type: 'DOCUMENT_TRASHED', actor: 'USER', createdAt: 1 })
    ).toThrow('document workspace events require a documentId')
    // V1 events are always user-authored.
    expect(() =>
      assertWorkspaceEvent({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'MATTER_TRASHED',
        actor: 'SYSTEM',
        createdAt: 1
      } as unknown as Parameters<typeof assertWorkspaceEvent>[0])
    ).toThrow('workspace events are always user-authored in V1')
    expect(() =>
      assertWorkspaceEvent({
        id: 'event-1',
        matterId: 'matter-1',
        type: 'UNKNOWN',
        actor: 'USER',
        createdAt: 1
      } as unknown as Parameters<typeof assertWorkspaceEvent>[0])
    ).toThrow('workspaceEvent.type is not supported')
    expect(() =>
      assertWorkspaceEvent({ id: '', matterId: 'matter-1', type: 'MATTER_TRASHED', actor: 'USER', createdAt: 1 })
    ).toThrow('workspaceEvent.id must not be empty')
  })

  it('accepts a valid SanitizedDocument and rejects empty identifiers', () => {
    expect(() => assertSanitizedDocument(sanitizedDocument)).not.toThrow()
    expect(() => assertSanitizedDocument({ ...sanitizedDocument, id: ' ' })).toThrow(
      'sanitizedDocument.id must not be empty'
    )
    expect(() => assertSanitizedDocument({ ...sanitizedDocument, matterId: '' })).toThrow(
      'sanitizedDocument.matterId must not be empty'
    )
    expect(() => assertSanitizedDocument({ ...sanitizedDocument, documentId: '' })).toThrow(
      'sanitizedDocument.documentId must not be empty'
    )
    expect(() => assertSanitizedDocument({ ...sanitizedDocument, jobId: '' })).toThrow(
      'sanitizedDocument.jobId must not be empty'
    )
    expect(() => assertSanitizedDocument({ ...sanitizedDocument, createdAt: -1 })).toThrow(
      'sanitizedDocument.createdAt must be a non-negative safe integer'
    )
  })

  it('accepts a valid SanitizedBlock and rejects empty identifiers', () => {
    expect(() => assertSanitizedBlock(sanitizedBlock)).not.toThrow()
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, id: '' })).toThrow(
      'sanitizedBlock.id must not be empty'
    )
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, sanitizedDocumentId: '' })).toThrow(
      'sanitizedBlock.sanitizedDocumentId must not be empty'
    )
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, documentId: '' })).toThrow(
      'sanitizedBlock.documentId must not be empty'
    )
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, pageId: '' })).toThrow(
      'sanitizedBlock.pageId must not be empty'
    )
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, blockId: '' })).toThrow(
      'sanitizedBlock.blockId must not be empty'
    )
    expect(() => assertSanitizedBlock({ ...sanitizedBlock, createdAt: 0.5 })).toThrow(
      'sanitizedBlock.createdAt must be a non-negative safe integer'
    )
  })

  it('accepts a valid SanitizationMapping and rejects each violated rule', () => {
    expect(() => assertSanitizationMapping(sanitizationMapping)).not.toThrow()
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, id: '' })).toThrow(
      'sanitizationMapping.id must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, matterId: '' })).toThrow(
      'sanitizationMapping.matterId must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, sanitizedDocumentId: '' })).toThrow(
      'sanitizationMapping.sanitizedDocumentId must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, mentionId: '' })).toThrow(
      'sanitizationMapping.mentionId must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, entityId: '' })).toThrow(
      'sanitizationMapping.entityId must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, publicToken: '  ' })).toThrow(
      'sanitizationMapping.publicToken must not be empty'
    )
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, alias: '  ' })).toThrow(
      'sanitizationMapping.alias must not be empty'
    )
    expect(() =>
      assertSanitizationMapping({
        ...sanitizationMapping,
        restorePolicy: 'SOMETIMES' as SanitizationMapping['restorePolicy']
      })
    ).toThrow('sanitizationMapping.restorePolicy is not supported')
    expect(() => assertSanitizationMapping({ ...sanitizationMapping, createdAt: -1 })).toThrow(
      'sanitizationMapping.createdAt must be a non-negative safe integer'
    )
  })

  it('enforces the AI execution lifecycle', () => {
    expect(() => assertAiExecution(aiExecution)).not.toThrow()
    expect(() =>
      assertAiExecution({ ...aiExecution, status: 'COMPLETED', finishedAt: 2 })
    ).not.toThrow()
    expect(() => assertAiExecution({ ...aiExecution, providerId: '' })).toThrow(
      'aiExecution.providerId must not be empty'
    )
    expect(() => assertAiExecution({ ...aiExecution, status: 'COMPLETED' })).toThrow(
      'terminal AI execution requires finishedAt'
    )
    expect(() => assertAiExecution({ ...aiExecution, finishedAt: 2 })).toThrow(
      'running AI execution must not be finished'
    )
    expect(() => assertAiExecution({ ...aiExecution, startedAt: 0 })).toThrow(
      'aiExecution.startedAt must not precede createdAt'
    )
  })
})
