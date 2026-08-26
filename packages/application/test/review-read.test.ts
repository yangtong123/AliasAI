import { beforeEach, describe, expect, it } from 'vitest'
import { encrypt } from '@aliasai/crypto'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ReviewQueryRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  ReviewQueryService,
  documentBlockTextContext,
  documentOriginalNameContext,
  matterNameContext,
  mentionTextContext,
  type ApplicationKeys
} from '../src/index'

describe('ReviewQueryService', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const keys: ApplicationKeys = { persistenceKey }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let service: ReviewQueryService
  let documents: DocumentRepository

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    service = new ReviewQueryService(
      new ReviewQueryRepository(db),
      documents,
      new EntityRepository(db),
      new EntityResolutionRepository(db),
      keys
    )
  })

  it('fails loudly when the document does not exist', () => {
    expect(() => service.getDocumentReview('missing')).toThrow(
      expect.objectContaining({ code: 'DOCUMENT_NOT_FOUND' })
    )
  })

  it('decrypts matter and document names for the listings', () => {
    const matters = new MatterRepository(db)
    matters.create({
      id: 'matter-1',
      nameCipher: encrypt(Buffer.from('Synthetic Matter'), persistenceKey, matterNameContext('matter-1')),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
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

    expect(service.listMatters()).toEqual([
      { id: 'matter-1', name: 'Synthetic Matter', status: 'ACTIVE', createdAt: 1, updatedAt: 1 }
    ])
    const listed = service.listDocuments('matter-1')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: 'document-1', originalName: 'synthetic.pdf', parseStatus: 'IMPORTED' })
  })

  it('surfaces a decryption failure instead of rendering wrong data', () => {
    const matters = new MatterRepository(db)
    matters.create({
      id: 'matter-1',
      // Encrypted with the wrong AAD context: decryption must fail loudly.
      nameCipher: encrypt(Buffer.from('Synthetic Matter'), persistenceKey, Buffer.from('wrong-context')),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })

    expect(() => service.listMatters()).toThrow('MATTER_NAME could not be decrypted')
  })

  it('builds the full document review DTO with derived decision statuses and margin', () => {
    seedReadyDocument()
    const reviewDto = service.getDocumentReview('document-1')

    expect(reviewDto.document).toMatchObject({ id: 'document-1', originalName: 'synthetic.pdf', parseStatus: 'READY' })
    expect(reviewDto.blocks).toHaveLength(1)
    const block = reviewDto.blocks[0]!
    expect(block.text).toBe('Holder synthetic@example.test 13800138000.')
    // Three mentions in offset order with decrypted text.
    expect(block.mentions.map((mention) => mention.text)).toEqual([
      'Holder',
      'synthetic@example.test',
      '13800138000'
    ])
    // Person mention: auto-linked during resolve (SYSTEM actor).
    expect(block.mentions[0]).toMatchObject({ decisionStatus: 'AUTO_LINKED', type: 'PERSON' })
    expect(block.mentions[0]!.assignedEntity).toMatchObject({ primaryAlias: 'Holder One', publicToken: '@P-entity-1' })
    // Email mention: needs review (PENDING candidate exists).
    expect(block.mentions[1]).toMatchObject({ decisionStatus: 'NEEDS_REVIEW' })
    expect(block.mentions[1]!.candidates).toHaveLength(1)
    const candidate = block.mentions[1]!.candidates[0]!
    expect(candidate).toMatchObject({ score: 90, state: 'PENDING', algorithmVersion: 'er-v1' })
    expect(candidate.evidence).toEqual([{ evidenceType: 'SHARED_PROTECTED_VALUE', weight: 40, score: 40 }])
    // Phone mention: no entity and no candidates.
    expect(block.mentions[2]).toMatchObject({ decisionStatus: 'UNRESOLVED' })
    expect(block.mentions[2]!.candidates).toEqual([])
    expect(reviewDto.counts).toEqual({ mentions: 3, resolved: 1, needsReview: 1, unresolved: 1, rejected: 0 })
    expect(reviewDto.entities.map((entity) => entity.primaryAlias)).toEqual(['Holder One'])
    expect(reviewDto.jobs.map((job) => job.type)).toContain('DETECT')
    expect(reviewDto.jobs.map((job) => job.type)).toContain('RESOLVE')
  })

  it('marks a user assignment as USER_ASSIGNED and reports margin', () => {
    seedReadyDocument()
    // Simulate a USER assignment event on the email mention, closing its PENDING candidate.
    sqlite
      .prepare(
        `INSERT INTO resolution_events (id, matter_id, event_type, entity_id, mention_id, actor, payload_cipher, created_at)
         VALUES ('event-user-1', 'matter-1', 'MENTION_ASSIGNED', 'entity-1', 'mention-2', 'USER', X'01', 20)`
      )
      .run()
    sqlite.prepare("UPDATE mentions SET entity_id = 'entity-1' WHERE id = 'mention-2'").run()
    sqlite
      .prepare(
        `UPDATE resolution_candidates SET state = 'ACCEPTED', resolved_at = 20 WHERE id = 'candidate-1'`
      )
      .run()
    // A second candidate gives the email mention a margin.
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 1, 1)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at)
         VALUES ('candidate-2', 'mention-2', 'entity-2', 70, 'REJECTED', 'er-v1', 10)`
      )
      .run()

    const reviewDto = service.getDocumentReview('document-1')
    const emailMention = reviewDto.blocks[0]!.mentions[1]!

    expect(emailMention.decisionStatus).toBe('USER_ASSIGNED')
    expect(emailMention.assignedEntity!.id).toBe('entity-1')
    expect(emailMention.margin).toBe(20)
    expect(reviewDto.blocks[0]!.mentions[0]!.margin).toBeNull()
  })

  /** Builds a document at READY with one block, three mentions, one entity, one PENDING candidate. */
  function seedReadyDocument(): void {
    const matters = new MatterRepository(db)
    matters.create({
      id: 'matter-1',
      nameCipher: encrypt(Buffer.from('Synthetic Matter'), persistenceKey, matterNameContext('matter-1')),
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1
    })
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
          textCipher: encrypt(
            Buffer.from('Holder synthetic@example.test 13800138000.'),
            persistenceKey,
            documentBlockTextContext('block-1')
          ),
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
      mentions: (
        [
          ['mention-1', 'PERSON', 'Holder', 0],
          ['mention-2', 'EMAIL', 'synthetic@example.test', 7],
          ['mention-3', 'PHONE', '13800138000', 29]
        ] as const
      ).map(([id, type, text, startOffset]) => ({
        id,
        matterId: 'matter-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockId: 'block-1',
        type,
        strength: 'EXPLICIT',
        textCipher: encrypt(Buffer.from(text), persistenceKey, mentionTextContext(id)),
        startOffset,
        endOffset: startOffset + text.length,
        detector: 'REGEX',
        confidence: 0.95,
        reviewStatus: 'UNREVIEWED',
        createdAt: 7
      })),
      finishedAt: 8
    })

    const entities = new EntityRepository(db)
    entities.createWithPrimaryAliasAndEvent({
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
    // Person mention auto-linked at resolve time; email mention has a PENDING candidate.
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at, resolved_at)
         VALUES ('candidate-1', 'mention-2', 'entity-1', 90, 'PENDING', 'er-v1', 10, NULL)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO resolution_evidence (id, candidate_id, evidence_type, weight, score, created_at)
         VALUES ('evidence-1', 'candidate-1', 'SHARED_PROTECTED_VALUE', 40, 40, 10)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO resolution_events (id, matter_id, event_type, entity_id, mention_id, actor, payload_cipher, created_at)
         VALUES ('event-2', 'matter-1', 'MENTION_ASSIGNED', 'entity-1', 'mention-1', 'SYSTEM', X'01', 11)`
      )
      .run()
    sqlite.prepare("UPDATE mentions SET entity_id = 'entity-1' WHERE id = 'mention-1'").run()
    // The document is READY with a completed RESOLVE job.
    sqlite.prepare("UPDATE documents SET parse_status = 'READY', updated_at = 13 WHERE id = 'document-1'").run()
    sqlite
      .prepare(
        `INSERT INTO processing_jobs (id, document_id, job_type, status, progress, created_at, started_at, finished_at)
         VALUES ('job-resolve', 'document-1', 'RESOLVE', 'COMPLETED', 1, 12, 12, 13)`
      )
      .run()
  }
})
