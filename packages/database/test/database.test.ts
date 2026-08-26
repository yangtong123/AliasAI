import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDatabase,
  DocumentRepository,
  EntityRepository,
  MatterRepository,
  migrateDatabase,
  documentBlocks,
  documentPages,
  entities,
  entityAliases,
  entityConstraints,
  entityProtectedValues,
  entityRelationships,
  mentions,
  processingJobs,
  protectedValues,
  resolutionCandidates,
  resolutionEvents
} from '../src/index'
import type { AliasAiDatabase, SqliteClient } from '../src/index'
import type { Entity, EntityAlias } from '@aliasai/domain'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('SQLite schema and repositories', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
  })

  afterEach(() => {
    sqlite.close()
  })

  function insertMatter(id = 'matter-1'): void {
    new MatterRepository(db).create({
      id,
      nameCipher: cipher(`matter-name-${id}`),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
  }

  function insertDocument(id = 'document-1', matterId = 'matter-1', fileHash = 'hash-1'): void {
    new DocumentRepository(db).create({
      id,
      matterId,
      originalNameCipher: cipher(`original-name-${id}`),
      fileHash,
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
  }

  function insertPage(id: string, documentId: string): void {
    db.insert(documentPages)
      .values({
        id,
        documentId,
        pageNo: 1,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        sourceType: 'NATIVE',
        createdAt: 1
      })
      .run()
  }

  function insertBlock(id: string, documentId: string, pageId: string): void {
    db.insert(documentBlocks)
      .values({
        id,
        documentId,
        pageId,
        blockType: 'TEXT',
        textCipher: cipher(`block-${id}`),
        source: 'NATIVE',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        readingOrder: 1,
        createdAt: 1
      })
      .run()
  }

  function insertEntity(id: string, matterId: string, publicToken: string): Entity {
    const entity: Entity = {
      id,
      matterId,
      type: 'PERSON',
      publicToken,
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    }
    new EntityRepository(db).create(entity)
    return entity
  }

  function insertMention(
    id: string,
    matterId: string,
    documentId: string,
    pageId: string,
    blockId: string,
    entityId?: string,
    protectedValueId?: string
  ): void {
    db.insert(mentions)
      .values({
        id,
        matterId,
        documentId,
        pageId,
        blockId,
        ...(entityId === undefined ? {} : { entityId }),
        ...(protectedValueId === undefined ? {} : { protectedValueId }),
        mentionType: 'PERSON',
        mentionStrength: 'EXPLICIT',
        textCipher: cipher(`mention-${id}`),
        startOffset: 0,
        endOffset: 2,
        detector: 'USER',
        confidence: 1,
        reviewStatus: 'CONFIRMED',
        createdAt: 1
      })
      .run()
  }

  it('applies the complete V1 schema migration', () => {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__drizzle%'")
      .all() as Array<{ name: string }>

    expect(tables.map((table) => table.name).sort()).toEqual([
      'ai_executions',
      'document_blocks',
      'document_pages',
      'documents',
      'entities',
      'entity_aliases',
      'entity_constraints',
      'entity_protected_values',
      'entity_relationships',
      'matters',
      'mentions',
      'processing_jobs',
      'protected_values',
      'resolution_candidates',
      'resolution_events',
      'resolution_evidence',
      'sanitization_mappings',
      'sanitized_blocks',
      'sanitized_documents',
      'workspace_events'
    ])
  })

  it('persists encrypted Matter and Document inputs without exposing them through domain reads', () => {
    insertMatter()
    insertDocument()
    const documents = new DocumentRepository(db)

    expect(new MatterRepository(db).findById('matter-1')).toEqual({
      id: 'matter-1',
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
    expect(documents.findByMatterAndFileHash('matter-1', 'hash-1')).toEqual({
      id: 'document-1',
      matterId: 'matter-1',
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
  })

  it('enforces a file hash as unique only within its Matter', () => {
    insertMatter()
    insertMatter('matter-2')
    insertDocument('document-1', 'matter-1', 'same-hash')
    expect(() => insertDocument('document-2', 'matter-1', 'same-hash')).toThrow(/UNIQUE constraint failed/)
    expect(() => insertDocument('document-3', 'matter-2', 'same-hash')).not.toThrow()
  })

  it('enforces document foreign keys and normalized block coordinates', () => {
    expect(() => insertDocument('orphan-document', 'missing-matter')).toThrow(/FOREIGN KEY constraint failed/)

    insertMatter()
    insertDocument()
    db.insert(documentPages)
      .values({
        id: 'page-1',
        documentId: 'document-1',
        pageNo: 1,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        sourceType: 'NATIVE',
        createdAt: 1
      })
      .run()

    expect(() =>
      db.insert(documentBlocks)
        .values({
          id: 'invalid-block',
          documentId: 'document-1',
          pageId: 'page-1',
          blockType: 'TEXT',
          textCipher: cipher('block'),
          source: 'NATIVE',
          x: 1.01,
          y: 0,
          width: 0.1,
          height: 0.1,
          readingOrder: 1,
          createdAt: 1
        })
        .run()
    ).toThrow(/CHECK constraint failed/)
  })

  it('rejects a Mention assignment to an Entity from another Matter at the database boundary', () => {
    insertMatter('matter-1')
    insertMatter('matter-2')
    insertDocument('document-1', 'matter-1')
    db.insert(documentPages)
      .values({
        id: 'page-1',
        documentId: 'document-1',
        pageNo: 1,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        sourceType: 'NATIVE',
        createdAt: 1
      })
      .run()
    db.insert(documentBlocks)
      .values({
        id: 'block-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockType: 'TEXT',
        textCipher: cipher('block'),
        source: 'NATIVE',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        readingOrder: 1,
        createdAt: 1
      })
      .run()
    db.insert(entities)
      .values({
        id: 'entity-2',
        matterId: 'matter-2',
        entityType: 'PERSON',
        publicToken: '@P-SYNTHETIC',
        status: 'ACTIVE',
        createdAt: 1,
        updatedAt: 1
      })
      .run()

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO mentions (
            id, matter_id, document_id, page_id, block_id, entity_id,
            mention_type, mention_strength, text_cipher, start_offset, end_offset,
            detector, confidence, review_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'mention-1',
          'matter-1',
          'document-1',
          'page-1',
          'block-1',
          'entity-2',
          'PERSON',
          'EXPLICIT',
          cipher('mention'),
          0,
          2,
          'USER',
          1,
          'CONFIRMED',
          1
        )
    ).toThrow('mention references must belong to its Matter and document hierarchy')
  })

  it('enforces Mention Matter scope and document hierarchy for every reference', () => {
    insertMatter('matter-1')
    insertMatter('matter-2')
    insertDocument('document-1', 'matter-1', 'hash-1')
    insertDocument('document-2', 'matter-2', 'hash-2')
    insertPage('page-1', 'document-1')
    insertPage('page-2', 'document-2')
    insertBlock('block-1', 'document-1', 'page-1')
    insertBlock('block-2', 'document-2', 'page-2')
    insertEntity('entity-1', 'matter-1', '@P-MATTER1')
    insertEntity('entity-2', 'matter-2', '@P-MATTER2')
    db.insert(protectedValues)
      .values({
        id: 'protected-2',
        matterId: 'matter-2',
        valueType: 'PERSON_NAME',
        valueCipher: cipher('protected-value'),
        fingerprint: cipher('fingerprint'),
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 1
      })
      .run()

    expect(() => insertMention('cross-matter', 'matter-2', 'document-1', 'page-1', 'block-1')).toThrow(
      'mention references must belong to its Matter and document hierarchy'
    )
    expect(() => insertMention('cross-page', 'matter-1', 'document-1', 'page-2', 'block-1')).toThrow(
      'mention references must belong to its Matter and document hierarchy'
    )
    expect(() => insertMention('cross-block', 'matter-1', 'document-1', 'page-1', 'block-2')).toThrow(
      'mention references must belong to its Matter and document hierarchy'
    )
    expect(() =>
      insertMention('cross-protected', 'matter-1', 'document-1', 'page-1', 'block-1', undefined, 'protected-2')
    ).toThrow('mention references must belong to its Matter and document hierarchy')
    expect(() =>
      insertMention('cross-entity', 'matter-1', 'document-1', 'page-1', 'block-1', 'entity-2')
    ).toThrow('mention references must belong to its Matter and document hierarchy')
    expect(() => insertMention('valid-mention', 'matter-1', 'document-1', 'page-1', 'block-1', 'entity-1')).not.toThrow()
  })

  it('prevents every identity association from crossing the Matter boundary', () => {
    insertMatter('matter-1')
    insertMatter('matter-2')
    insertDocument('document-1', 'matter-1', 'hash-1')
    insertPage('page-1', 'document-1')
    insertBlock('block-1', 'document-1', 'page-1')
    insertEntity('entity-1', 'matter-1', '@P-MATTER1')
    insertEntity('entity-2', 'matter-2', '@P-MATTER2')
    db.insert(protectedValues)
      .values({
        id: 'protected-2',
        matterId: 'matter-2',
        valueType: 'PERSON_NAME',
        valueCipher: cipher('protected-value'),
        fingerprint: cipher('fingerprint'),
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 1
      })
      .run()
    insertMention('mention-1', 'matter-1', 'document-1', 'page-1', 'block-1', 'entity-1')

    expect(() =>
      db.insert(entityAliases)
        .values({
          id: 'alias-cross-matter',
          matterId: 'matter-1',
          entityId: 'entity-2',
          alias: 'Synthetic Alias',
          aliasType: 'PRIMARY',
          isPrimary: true,
          createdAt: 1
        })
        .run()
    ).toThrow('entity alias must belong to the Entity Matter')
    expect(() =>
      db.insert(entityProtectedValues)
        .values({
          entityId: 'entity-1',
          protectedValueId: 'protected-2',
          relationshipType: 'NAME',
          confidence: 1,
          isPrimary: true,
          createdAt: 1
        })
        .run()
    ).toThrow('entity and protected value must belong to the same Matter')
    expect(() =>
      db.insert(entityRelationships)
        .values({
          id: 'relationship-cross-matter',
          matterId: 'matter-1',
          sourceEntityId: 'entity-1',
          relationType: 'RELATED_TO',
          targetEntityId: 'entity-2',
          confidence: 1,
          createdAt: 1
        })
        .run()
    ).toThrow('entity relationship references must belong to the same Matter')
    expect(() =>
      db.insert(resolutionCandidates)
        .values({
          id: 'candidate-cross-matter',
          mentionId: 'mention-1',
          candidateEntityId: 'entity-2',
          score: 90,
          state: 'PENDING',
          algorithmVersion: 'synthetic-v1',
          createdAt: 1
        })
        .run()
    ).toThrow('resolution candidate must belong to the Mention Matter')
    expect(() =>
      db.insert(entityConstraints)
        .values({
          id: 'constraint-cross-matter',
          matterId: 'matter-1',
          entityAId: 'entity-1',
          entityBId: 'entity-2',
          constraintType: 'CANNOT_LINK',
          reason: 'Synthetic conflict',
          source: 'USER',
          createdAt: 1
        })
        .run()
    ).toThrow('entity constraint references must belong to the same Matter')
    expect(() =>
      db.insert(resolutionEvents)
        .values({
          id: 'event-cross-matter',
          matterId: 'matter-1',
          eventType: 'ENTITY_CONFIRMED',
          entityId: 'entity-2',
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 1
        })
        .run()
    ).toThrow('resolution event references must belong to its Matter')
  })

  it('keeps Public Tokens immutable and validates merged Entity redirects', () => {
    insertMatter('matter-1')
    insertMatter('matter-2')
    insertEntity('entity-1', 'matter-1', '@P-MATTER1')
    insertEntity('entity-2', 'matter-2', '@P-MATTER2')

    expect(() =>
      sqlite.prepare('UPDATE entities SET public_token = ? WHERE id = ?').run('@P-CHANGED', 'entity-1')
    ).toThrow('entities.public_token is immutable')
    expect(() =>
      db.insert(entities)
        .values({
          id: 'missing-redirect',
          matterId: 'matter-1',
          entityType: 'PERSON',
          publicToken: '@P-MISSING',
          status: 'MERGED',
          createdAt: 1,
          updatedAt: 1
        })
        .run()
    ).toThrow('merged entity redirect must target an active Entity in the same Matter')
    expect(() =>
      db.insert(entities)
        .values({
          id: 'cross-matter-redirect',
          matterId: 'matter-1',
          entityType: 'PERSON',
          publicToken: '@P-CROSS',
          status: 'MERGED',
          mergedIntoEntityId: 'entity-2',
          createdAt: 1,
          updatedAt: 1
        })
        .run()
    ).toThrow('merged entity redirect must target an active Entity in the same Matter')
    expect(() =>
      db.insert(entities)
        .values({
          id: 'valid-redirect',
          matterId: 'matter-1',
          entityType: 'PERSON',
          publicToken: '@P-VALID',
          status: 'MERGED',
          mergedIntoEntityId: 'entity-1',
          createdAt: 1,
          updatedAt: 1
        })
        .run()
    ).not.toThrow()

    insertEntity('entity-3', 'matter-1', '@P-MATTER3')
    expect(() =>
      sqlite
        .prepare("UPDATE entities SET status = 'MERGED', merged_into_entity_id = ? WHERE id = ?")
        .run('valid-redirect', 'entity-1')
    ).toThrow('merged entity redirects must not form a cycle')

    sqlite
      .prepare("UPDATE entities SET status = 'MERGED', merged_into_entity_id = ? WHERE id = ?")
      .run('entity-3', 'entity-1')
    expect(() =>
      sqlite
        .prepare("UPDATE entities SET status = 'MERGED', merged_into_entity_id = ? WHERE id = ?")
        .run('valid-redirect', 'entity-3')
    ).toThrow('merged entity redirects must not form a cycle')
  })

  it('keeps ResolutionEvents append-only at the database boundary', () => {
    insertMatter()
    insertEntity('entity-1', 'matter-1', '@P-MATTER1')
    db.insert(resolutionEvents)
      .values({
        id: 'event-1',
        matterId: 'matter-1',
        eventType: 'ENTITY_CONFIRMED',
        entityId: 'entity-1',
        actor: 'USER',
        payloadCipher: cipher('event'),
        createdAt: 1
      })
      .run()

    expect(() =>
      sqlite.prepare('UPDATE resolution_events SET payload_cipher = ? WHERE id = ?').run(cipher('changed'), 'event-1')
    ).toThrow('resolution events are append-only')
    expect(() => sqlite.prepare('DELETE FROM resolution_events WHERE id = ?').run('event-1')).toThrow(
      'resolution events are append-only'
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events').get()).toEqual({ count: 1 })
  })

  it('enforces numeric, bounding-box, progress, and boolean storage constraints', () => {
    insertMatter()
    insertDocument()
    insertPage('page-1', 'document-1')
    insertEntity('entity-1', 'matter-1', '@P-MATTER1')

    expect(() =>
      db.insert(documentBlocks)
        .values({
          id: 'overflowing-block',
          documentId: 'document-1',
          pageId: 'page-1',
          blockType: 'TEXT',
          textCipher: cipher('block'),
          source: 'NATIVE',
          confidence: 1.1,
          x: 0.9,
          y: 0,
          width: 0.2,
          height: 1,
          readingOrder: 1,
          createdAt: 1
        })
        .run()
    ).toThrow(/CHECK constraint failed/)
    insertBlock('block-1', 'document-1', 'page-1')
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO mentions (
            id, matter_id, document_id, page_id, block_id,
            mention_type, mention_strength, text_cipher, start_offset, end_offset,
            x, detector, confidence, review_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'invalid-mention',
          'matter-1',
          'document-1',
          'page-1',
          'block-1',
          'PERSON',
          'EXPLICIT',
          cipher('mention'),
          2,
          1,
          0.1,
          'USER',
          2,
          'CONFIRMED',
          1
        )
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      db.insert(processingJobs)
        .values({
          id: 'invalid-progress',
          documentId: 'document-1',
          jobType: 'PARSE',
          status: 'RUNNING',
          progress: 1.1,
          createdAt: 1,
          startedAt: 1
        })
        .run()
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO entity_aliases (
            id, matter_id, entity_id, alias, alias_type, is_primary, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('invalid-boolean', 'matter-1', 'entity-1', 'Alias', 'PRIMARY', 2, 1)
    ).toThrow(/CHECK constraint failed/)
  })

  it('rolls back Entity creation when its primary Alias or audit Event cannot be stored', () => {
    insertMatter()
    const repository = new EntityRepository(db)
    const existingEntity = insertEntity('existing-entity', 'matter-1', '@P-EXISTING')
    repository.addAlias({
      id: 'existing-alias',
      matterId: 'matter-1',
      entityId: existingEntity.id,
      alias: 'Reserved Alias',
      aliasType: 'PRIMARY',
      isPrimary: true,
      createdAt: 1
    })
    const entity: Entity = {
      id: 'new-entity',
      matterId: 'matter-1',
      type: 'PERSON',
      publicToken: '@P-NEW',
      status: 'ACTIVE',
      createdAt: 2,
      updatedAt: 2
    }
    const primaryAlias: EntityAlias = {
      id: 'new-alias',
      matterId: 'matter-1',
      entityId: entity.id,
      alias: 'Reserved Alias',
      aliasType: 'PRIMARY',
      isPrimary: true,
      createdAt: 2
    }

    expect(() =>
      repository.createWithPrimaryAliasAndEvent({
        entity,
        primaryAlias,
        event: {
          id: 'new-event',
          matterId: 'matter-1',
          type: 'ENTITY_CREATED',
          entityId: entity.id,
          actor: 'USER',
          payloadCipher: cipher('event'),
          createdAt: 2
        }
      })
    ).toThrow(/UNIQUE constraint failed/)
    expect(repository.findByPublicToken('matter-1', '@P-NEW')).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM resolution_events WHERE id = ?').get('new-event')).toEqual({ count: 0 })

    repository.appendResolutionEvent({
      id: 'reserved-event',
      matterId: 'matter-1',
      type: 'ENTITY_CONFIRMED',
      entityId: existingEntity.id,
      actor: 'USER',
      payloadCipher: cipher('reserved-event'),
      createdAt: 2
    })
    const secondEntity: Entity = {
      ...entity,
      id: 'second-entity',
      publicToken: '@P-SECOND'
    }
    const secondAlias: EntityAlias = {
      ...primaryAlias,
      id: 'second-alias',
      entityId: secondEntity.id,
      alias: 'Available Alias'
    }
    expect(() =>
      repository.createWithPrimaryAliasAndEvent({
        entity: secondEntity,
        primaryAlias: secondAlias,
        event: {
          id: 'reserved-event',
          matterId: 'matter-1',
          type: 'ENTITY_CREATED',
          entityId: secondEntity.id,
          actor: 'USER',
          payloadCipher: cipher('new-event'),
          createdAt: 2
        }
      })
    ).toThrow(/UNIQUE constraint failed/)
    expect(repository.findByPublicToken('matter-1', '@P-SECOND')).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_aliases WHERE id = ?').get('second-alias')).toEqual({
      count: 0
    })
  })
})
