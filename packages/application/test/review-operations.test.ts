import { beforeEach, describe, expect, it } from 'vitest'
import { deriveMatterSearchKey, encrypt, fingerprintNormalizedValue } from '@aliasai/crypto'
import { normalizeMentionValue } from '@aliasai/entity-resolution'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  EntityResolutionService,
  MatterService,
  ReviewOperationService,
  ReviewQueryService,
  documentBlockTextContext,
  documentOriginalNameContext,
  mentionTextContext,
  type ApplicationKeys
} from '../src/index'

describe('ReviewOperationService', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const searchKey = Buffer.alloc(32, 7)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let operations: ReviewOperationService
  let resolution: EntityResolutionService
  let reviewQuery: ReviewQueryService

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    reviewQuery = new ReviewQueryService(
      new ReviewQueryRepository(db),
      new DocumentRepository(db),
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
    resolution = new EntityResolutionService(
      new EntityResolutionRepository(db),
      new ProtectedValueRepository(db),
      new EntityRepository(db),
      keys
    )
    operations = new ReviewOperationService(resolution, reviewQuery)
    seedDocumentWithReviewableMention()
  })

  it('assigns a pending mention to an entity and refreshes the view', () => {
    const refreshed = operations.assignToEntity('mention-1', 'entity-1')

    expect(refreshed.decisionStatus).toBe('USER_ASSIGNED')
    expect(refreshed.assignedEntity).toMatchObject({ id: 'entity-1', primaryAlias: 'Holder One' })
    expect(refreshed.candidates.map((candidate) => candidate.state)).toEqual(['ACCEPTED'])
    const actors = sqlite
      .prepare("SELECT actor FROM resolution_events WHERE event_type = 'MENTION_ASSIGNED' AND mention_id = 'mention-1'")
      .all() as Array<{ actor: string }>
    expect(actors).toEqual([{ actor: 'USER' }])
  })

  it('rejects assignment to an unknown entity with a safe error', () => {
    expect(() => operations.assignToEntity('mention-1', 'missing-entity')).toThrow(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
  })

  it('confirms an assigned mention idempotently and rejects an unassigned one', () => {
    expect(() => operations.confirmMention('mention-1')).toThrow(
      expect.objectContaining({ code: 'MENTION_UNASSIGNED' })
    )

    operations.assignToEntity('mention-1', 'entity-1')
    const confirmed = operations.confirmMention('mention-1')

    expect(confirmed.assignedEntity!.id).toBe('entity-1')
    expect(confirmed.reviewStatus).toBe('CONFIRMED')
    const events = sqlite
      .prepare("SELECT event_type, actor FROM resolution_events WHERE mention_id = 'mention-1' ORDER BY rowid")
      .all() as Array<{ event_type: string; actor: string }>
    expect(events).toEqual([
      { event_type: 'MENTION_ASSIGNED', actor: 'USER' },
      { event_type: 'ENTITY_CONFIRMED', actor: 'USER' }
    ])
    // Confirming again neither throws nor writes another event.
    operations.confirmMention('mention-1')
    const count = sqlite
      .prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE mention_id = 'mention-1'")
      .all() as Array<{ count: number }>
    expect(count[0]!.count).toBe(2)
  })

  it('restarts review on reassignment so the new assignment can be confirmed', () => {
    operations.assignToEntity('mention-1', 'entity-1')
    operations.confirmMention('mention-1')
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 12, 12)`
      )
      .run()

    operations.assignToEntity('mention-1', 'entity-2')
    const reconfirmed = operations.confirmMention('mention-1')

    expect(reconfirmed.assignedEntity!.id).toBe('entity-2')
    expect(reconfirmed.reviewStatus).toBe('CONFIRMED')
    const confirmations = sqlite
      .prepare(
        "SELECT entity_id FROM resolution_events WHERE event_type = 'ENTITY_CONFIRMED' AND mention_id = 'mention-1' ORDER BY rowid"
      )
      .all() as Array<{ entity_id: string }>
    expect(confirmations).toEqual([{ entity_id: 'entity-1' }, { entity_id: 'entity-2' }])
  })

  it('creates a new entity with a USER creation event and assigns the mention', () => {
    const result = operations.createEntityAndAssign('mention-1', { primaryAlias: 'Reviewer Choice', entityType: 'PERSON' })

    expect(result.entity.primaryAlias).toBe('Reviewer Choice')
    expect(result.mention.decisionStatus).toBe('USER_ASSIGNED')
    expect(result.mention.assignedEntity!.id).toBe(result.entity.id)
    const events = sqlite
      .prepare("SELECT event_type, actor FROM resolution_events WHERE entity_id = ? ORDER BY rowid")
      .all(result.entity.id) as Array<{ event_type: string; actor: string }>
    expect(events).toEqual([
      { event_type: 'ENTITY_CREATED', actor: 'USER' },
      { event_type: 'MENTION_ASSIGNED', actor: 'USER' }
    ])
  })

  it('fails safely when the mention does not exist', () => {
    expect(() => operations.assignToEntity('missing', 'entity-1')).toThrow(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
    expect(() => operations.confirmMention('missing')).toThrow(
      expect.objectContaining({ code: 'MENTION_NOT_FOUND' })
    )
    expect(() =>
      operations.createEntityAndAssign('missing', { primaryAlias: 'Alias', entityType: 'PERSON' })
    ).toThrow(expect.objectContaining({ code: 'MENTION_NOT_FOUND' }))
  })

  it('records a Cannot-Link constraint with its audit event', () => {
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 1, 1)`
      )
      .run()

    const constraint = operations.markConstraint('matter-1', 'entity-1', 'entity-2', 'CANNOT_LINK', 'Different people')

    expect(constraint).toMatchObject({ type: 'CANNOT_LINK', reason: 'Different people' })
    // The stored pair is canonicalized to sorted order.
    expect([constraint.entityAId, constraint.entityBId]).toEqual(['entity-1', 'entity-2'])
    const events = sqlite
      .prepare("SELECT COUNT(*) AS count FROM resolution_events WHERE event_type = 'CONSTRAINT_CREATED'")
      .all() as Array<{ count: number }>
    expect(events[0]!.count).toBe(1)
  })

  it('renames an Entity while preserving its former alias and audit event', () => {
    expect(operations.renameEntity('entity-1', 'Tenant A')).toEqual({ renamed: true })

    expect(
      sqlite.prepare('SELECT alias, alias_type, is_primary FROM entity_aliases WHERE entity_id = ? ORDER BY rowid').all('entity-1')
    ).toEqual([
      { alias: 'Holder One', alias_type: 'GENERIC', is_primary: 0 },
      { alias: 'Tenant A', alias_type: 'PRIMARY', is_primary: 1 }
    ])
    expect(sqlite.prepare("SELECT event_type, actor FROM resolution_events WHERE event_type = 'ENTITY_RENAMED'").all()).toEqual([
      { event_type: 'ENTITY_RENAMED', actor: 'USER' }
    ])
  })

  it('refuses an Entity alias that matches any real protected value elsewhere in the Matter', () => {
    seedProtectedName('Real Party Name')

    expect(() =>
      operations.createEntityAndAssign('mention-1', { primaryAlias: 'Real Party Name', entityType: 'PERSON' })
    ).toThrow(expect.objectContaining({ code: 'UNSAFE_ALIAS' }))
    expect(() => operations.renameEntity('entity-1', 'Real Party Name')).toThrow(
      expect.objectContaining({ code: 'UNSAFE_ALIAS' })
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 1 })
  })

  it('refuses a split alias that matches a protected value instead of masking it as SPLIT_FAILED', () => {
    seedProtectedName('Real Party Name')
    operations.assignToEntity('mention-1', 'entity-1')

    expect(() => operations.splitMention('mention-1', 'Real Party Name')).toThrow(
      expect.objectContaining({ code: 'UNSAFE_ALIAS' })
    )
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 1 })
  })

  it('rejects a false-positive Mention and records the decision', () => {
    const rejected = operations.rejectMention('mention-1')

    expect(rejected.reviewStatus).toBe('REJECTED')
    expect(rejected.decisionStatus).toBe('REJECTED')
    expect(rejected.assignedEntity).toBeNull()
    expect(reviewQuery.getDocumentReview('document-1').counts).toEqual({
      mentions: 1,
      resolved: 0,
      needsReview: 0,
      unresolved: 0,
      rejected: 1
    })
    expect(sqlite.prepare("SELECT event_type, actor FROM resolution_events WHERE event_type = 'MENTION_REJECTED'").all()).toEqual([
      { event_type: 'MENTION_REJECTED', actor: 'USER' }
    ])
  })

  it('removes a rejected Mention\'s derived Entity-value link when no other evidence remains', () => {
    sqlite
      .prepare(
        `INSERT INTO protected_values
           (id, matter_id, value_type, value_cipher, fingerprint, public_token, restore_policy, created_at)
         VALUES ('protected-email', 'matter-1', 'EMAIL', X'01', X'02', '@E-REJECTED1', 'RESTORE_ON_REQUEST', 12)`
      )
      .run()
    sqlite.prepare("UPDATE mentions SET protected_value_id = 'protected-email' WHERE id = 'mention-1'").run()
    operations.assignToEntity('mention-1', 'entity-1')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_protected_values').get()).toEqual({ count: 1 })

    operations.rejectMention('mention-1')

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_protected_values').get()).toEqual({ count: 0 })
  })

  it('adds a non-overlapping manual Mention with a ProtectedValue and event', () => {
    const created = operations.createManualMention({ blockId: 'block-1', type: 'ADDRESS', startOffset: 0, endOffset: 5 })

    expect(created).toMatchObject({ text: 'Reach', detector: 'USER', decisionStatus: 'UNRESOLVED' })
    expect(sqlite.prepare('SELECT protected_value_id FROM mentions WHERE id = ?').get(created.mentionId)).toEqual({
      protected_value_id: expect.any(String)
    })
    expect(sqlite.prepare("SELECT event_type, actor FROM resolution_events WHERE event_type = 'MENTION_CREATED'").all()).toEqual([
      { event_type: 'MENTION_CREATED', actor: 'USER' }
    ])
  })

  it('still blocks a manual Mention overlapping an active detection', () => {
    expect(() =>
      operations.createManualMention({ blockId: 'block-1', type: 'EMAIL', startOffset: 6, endOffset: 28 })
    ).toThrow(expect.objectContaining({ code: 'MANUAL_MENTION_FAILED' }))
  })

  it('allows re-marking the span of a rejected false-positive detection', () => {
    operations.rejectMention('mention-1')

    const created = operations.createManualMention({ blockId: 'block-1', type: 'EMAIL', startOffset: 6, endOffset: 28 })

    expect(created).toMatchObject({ text: 'synthetic@example.test', detector: 'USER', reviewStatus: 'UNREVIEWED' })
  })

  it('merges same-type Entities and redirects the source without deleting it', () => {
    seedSecondEntity()
    operations.assignToEntity('mention-1', 'entity-1')

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    expect(sqlite.prepare('SELECT status, merged_into_entity_id FROM entities WHERE id = ?').get('entity-1')).toEqual({
      status: 'MERGED',
      merged_into_entity_id: 'entity-2'
    })
    expect(sqlite.prepare('SELECT entity_id FROM mentions WHERE id = ?').get('mention-1')).toEqual({ entity_id: 'entity-2' })
    expect(sqlite.prepare("SELECT event_type, actor FROM resolution_events WHERE event_type = 'ENTITY_MERGED'").all()).toEqual([
      { event_type: 'ENTITY_MERGED', actor: 'USER' }
    ])
  })

  it('redirects a PENDING candidate of the merged Entity to the canonical Entity', () => {
    seedSecondEntity()

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    expect(
      sqlite.prepare('SELECT candidate_entity_id, state FROM resolution_candidates WHERE id = ?').get('candidate-1')
    ).toEqual({ candidate_entity_id: 'entity-2', state: 'PENDING' })
  })

  it('closes a PENDING source candidate when the canonical Entity already proposes for the Mention', () => {
    seedSecondEntity()
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at)
         VALUES ('candidate-2', 'mention-1', 'entity-2', 80, 'PENDING', 'er-v2', 10)`
      )
      .run()

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    const rows = sqlite
      .prepare('SELECT candidate_entity_id, state, resolved_at FROM resolution_candidates ORDER BY id')
      .all() as Array<{ candidate_entity_id: string; state: string; resolved_at: number | null }>
    expect(rows[0]).toMatchObject({ candidate_entity_id: 'entity-1', state: 'REJECTED' })
    expect(rows[0]!.resolved_at).not.toBeNull()
    expect(rows[1]).toMatchObject({ candidate_entity_id: 'entity-2', state: 'PENDING' })
    expect(rows[1]!.resolved_at).toBeNull()
  })

  it('migrates the merged Entity hard constraints onto the canonical Entity', () => {
    seedSecondEntity()
    seedThirdEntity()
    operations.markConstraint('matter-1', 'entity-1', 'entity-3', 'CANNOT_LINK', 'distinct parties')

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    expect(sqlite.prepare('SELECT entity_a_id, entity_b_id, constraint_type FROM entity_constraints').all()).toEqual([
      { entity_a_id: 'entity-2', entity_b_id: 'entity-3', constraint_type: 'CANNOT_LINK' }
    ])
  })

  it('refuses a merge that would create contradictory hard constraints and rolls back', () => {
    seedSecondEntity()
    seedThirdEntity()
    operations.markConstraint('matter-1', 'entity-1', 'entity-3', 'MUST_LINK', 'same party')
    operations.markConstraint('matter-1', 'entity-2', 'entity-3', 'CANNOT_LINK', 'distinct parties')

    expect(() => operations.mergeEntities('entity-1', 'entity-2')).toThrow(
      expect.objectContaining({ code: 'MERGE_FAILED' })
    )

    expect(sqlite.prepare('SELECT status FROM entities WHERE id = ?').get('entity-1')).toEqual({ status: 'ACTIVE' })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_constraints').get()).toEqual({ count: 2 })
  })

  it('refuses a merge when the canonical pair already holds both constraint types', () => {
    // source-X MUST plus target-X MUST and CANNOT: deduplication must not mask
    // the contradiction, because Cannot-Link overrides Must-Link at scoring.
    seedSecondEntity()
    seedThirdEntity()
    operations.markConstraint('matter-1', 'entity-1', 'entity-3', 'MUST_LINK', 'same party')
    operations.markConstraint('matter-1', 'entity-2', 'entity-3', 'MUST_LINK', 'same party indeed')
    operations.markConstraint('matter-1', 'entity-2', 'entity-3', 'CANNOT_LINK', 'distinct parties')

    expect(() => operations.mergeEntities('entity-1', 'entity-2')).toThrow(
      expect.objectContaining({ code: 'MERGE_FAILED' })
    )

    expect(sqlite.prepare('SELECT status FROM entities WHERE id = ?').get('entity-1')).toEqual({ status: 'ACTIVE' })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_constraints').get()).toEqual({ count: 3 })
  })

  it('collapses duplicate same-type constraints during a merge', () => {
    seedSecondEntity()
    seedThirdEntity()
    operations.markConstraint('matter-1', 'entity-1', 'entity-3', 'CANNOT_LINK', 'typo party')
    operations.markConstraint('matter-1', 'entity-2', 'entity-3', 'CANNOT_LINK', 'distinct parties')

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_constraints').get()).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT entity_a_id, entity_b_id FROM entity_constraints').all()).toEqual([
      { entity_a_id: 'entity-2', entity_b_id: 'entity-3' }
    ])
  })

  it('drops the source-target constraint that would become self-referential after the merge', () => {
    seedSecondEntity()
    operations.markConstraint('matter-1', 'entity-1', 'entity-2', 'MUST_LINK', 'same party')

    expect(operations.mergeEntities('entity-1', 'entity-2')).toEqual({ merged: true })

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM entity_constraints').get()).toEqual({ count: 0 })
  })

  it('splits one assigned Mention into a new same-type Entity atomically', () => {
    operations.assignToEntity('mention-1', 'entity-1')

    const split = operations.splitMention('mention-1', 'Separate Person')

    expect(split.mention.assignedEntity?.id).toBe(split.entityId)
    expect(split.entityId).not.toBe('entity-1')
    const events = sqlite
      .prepare('SELECT event_type FROM resolution_events WHERE entity_id = ? ORDER BY rowid')
      .all(split.entityId) as Array<{ event_type: string }>
    expect(events.map((event) => event.event_type)).toEqual(['ENTITY_CREATED', 'MENTION_REASSIGNED', 'ENTITY_SPLIT'])
  })

  function seedSecondEntity(): void {
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 12, 12)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO entity_aliases (id, matter_id, entity_id, alias, alias_type, is_primary, created_at)
         VALUES ('alias-2', 'matter-1', 'entity-2', 'Holder Two', 'PRIMARY', 1, 12)`
      )
      .run()
  }

  function seedThirdEntity(): void {
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-3', 'matter-1', 'PERSON', '@P-entity-3', 'ACTIVE', 12, 12)`
      )
      .run()
  }

  /** Inserts a PERSON_NAME ProtectedValue whose fingerprint matches the alias-safety lookup. */
  function seedProtectedName(name: string): void {
    const matterSearchKey = deriveMatterSearchKey(searchKey, 'matter-1')
    const fingerprint = fingerprintNormalizedValue(matterSearchKey, normalizeMentionValue('PERSON', name))
    matterSearchKey.fill(0)
    sqlite
      .prepare(
        `INSERT INTO protected_values
           (id, matter_id, value_type, value_cipher, fingerprint, public_token, restore_policy, created_at)
         VALUES ('pv-protected-name', 'matter-1', 'PERSON_NAME', X'01', ?, '@N-PROTECTED1', 'ALWAYS_RESTORE', 12)`
      )
      .run(fingerprint)
  }

  /** A DETECTED document with one EMAIL mention holding a PENDING candidate for entity-1. */
  function seedDocumentWithReviewableMention(): void {
    new MatterService(new MatterRepository(db), { persistenceKey }).create('Synthetic Matter')
    sqlite.prepare("UPDATE matters SET id = 'matter-1' WHERE rowid = 1").run()
    const documents = new DocumentRepository(db)
    documents.create({
      id: 'document-1',
      matterId: 'matter-1',
      originalNameCipher: encrypt(Buffer.from('synthetic.pdf'), persistenceKey, documentOriginalNameContext('document-1')),
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 2,
      updatedAt: 2
    })
    documents.markProcessing('document-1', 'SYNTHETIC', 3)
    documents.completeProcessing({
      documentId: 'document-1',
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: 'page-1',
          documentId: 'document-1',
          pageNo: 1,
          originalWidth: 100,
          originalHeight: 100,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: 4
        }
      ],
      blocks: [
        {
          id: 'block-1',
          documentId: 'document-1',
          pageId: 'page-1',
          blockType: 'TEXT',
          textCipher: encrypt(Buffer.from('Reach synthetic@example.test.'), persistenceKey, documentBlockTextContext('block-1')),
          source: 'NATIVE',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          readingOrder: 0,
          createdAt: 4
        }
      ],
      updatedAt: 5
    })
    const detection = new PrivacyDetectionRepository(db)
    detection.begin({ documentId: 'document-1', jobId: 'job-detect', startedAt: 6 })
    detection.complete({
      documentId: 'document-1',
      jobId: 'job-detect',
      mentions: [
        {
          id: 'mention-1',
          matterId: 'matter-1',
          documentId: 'document-1',
          pageId: 'page-1',
          blockId: 'block-1',
          type: 'EMAIL',
          strength: 'EXPLICIT',
          textCipher: encrypt(Buffer.from('synthetic@example.test'), persistenceKey, mentionTextContext('mention-1')),
          startOffset: 6,
          endOffset: 27,
          detector: 'REGEX',
          confidence: 0.95,
          reviewStatus: 'UNREVIEWED',
          createdAt: 7
        }
      ],
      finishedAt: 8
    })
    new EntityRepository(db).createWithPrimaryAliasAndEvent({
      entity: {
        id: 'entity-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-1',
        status: 'ACTIVE',
        createdAt: 9,
        updatedAt: 9
      },
      primaryAlias: {
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Holder One',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 9
      },
      event: {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-1',
        actor: 'SYSTEM',
        payloadCipher: encrypt(Buffer.from('{}'), persistenceKey, Buffer.from('event-1:resolutionEvent.payload')),
        createdAt: 9
      }
    })
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at)
         VALUES ('candidate-1', 'mention-1', 'entity-1', 90, 'PENDING', 'er-v1', 10)`
      )
      .run()
    sqlite.prepare("UPDATE documents SET parse_status = 'READY', updated_at = 11 WHERE id = 'document-1'").run()
  }
})
