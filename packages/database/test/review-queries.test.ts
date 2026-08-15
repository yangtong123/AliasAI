import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DocumentRepository,
  EntityRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  createDatabase,
  migrateDatabase,
  processingJobs,
  type AliasAiDatabase,
  type SqliteClient
} from '../src/index'

const cipher = (value: string) => Buffer.from(`synthetic:${value}`)

describe('ReviewQueryRepository', () => {
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let review: ReviewQueryRepository

  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = createDatabase(sqlite)
    migrateDatabase(db)
    review = new ReviewQueryRepository(db)
  })

  afterEach(() => sqlite.close())

  function insertMatter(id: string, createdAt: number): void {
    new MatterRepository(db).create({
      id,
      nameCipher: cipher(`matter-name-${id}`),
      status: 'ACTIVE',
      createdAt,
      updatedAt: createdAt
    })
  }

  /** Runs a Document through parsing and privacy detection so it reaches DETECTED with one Mention. */
  function seedDetectedDocument(matterId: string, documentId: string, mentionType: 'PERSON' | 'EMAIL' = 'PERSON'): string {
    const documents = new DocumentRepository(db)
    documents.create({
      id: documentId,
      matterId,
      originalNameCipher: cipher(`original-name-${documentId}`),
      fileHash: `hash-${documentId}`,
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
    documents.markProcessing(documentId, 'SYNTHETIC', 2)
    documents.completeProcessing({
      documentId,
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: `page-${documentId}`,
          documentId,
          pageNo: 1,
          originalWidth: 1,
          originalHeight: 1,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: 3
        }
      ],
      blocks: [
        {
          id: `block-a-${documentId}`,
          documentId,
          pageId: `page-${documentId}`,
          blockType: 'TEXT',
          textCipher: cipher(`block-a-${documentId}`),
          source: 'NATIVE',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          readingOrder: 0,
          createdAt: 3
        },
        {
          id: `block-b-${documentId}`,
          documentId,
          pageId: `page-${documentId}`,
          blockType: 'TEXT',
          textCipher: cipher(`block-b-${documentId}`),
          source: 'NATIVE',
          bbox: { x: 0, y: 0.5, width: 1, height: 0.5 },
          readingOrder: 1,
          createdAt: 3
        }
      ],
      updatedAt: 4
    })
    const detection = new PrivacyDetectionRepository(db)
    const mentionId = `mention-${documentId}`
    detection.begin({ documentId, jobId: `detect-${documentId}`, startedAt: 5 })
    detection.complete({
      documentId,
      jobId: `detect-${documentId}`,
      mentions: [
        {
          id: `${mentionId}-a`,
          matterId,
          documentId,
          pageId: `page-${documentId}`,
          blockId: `block-a-${documentId}`,
          type: mentionType,
          strength: 'EXPLICIT',
          textCipher: cipher(`${mentionId}-a`),
          startOffset: 0,
          endOffset: 5,
          detector: 'NER',
          confidence: 0.9,
          reviewStatus: 'UNREVIEWED',
          createdAt: 6
        },
        {
          id: `${mentionId}-b`,
          matterId,
          documentId,
          pageId: `page-${documentId}`,
          blockId: `block-b-${documentId}`,
          type: 'PHONE',
          strength: 'EXPLICIT',
          textCipher: cipher(`${mentionId}-b`),
          startOffset: 2,
          endOffset: 13,
          detector: 'REGEX',
          confidence: 0.95,
          reviewStatus: 'UNREVIEWED',
          createdAt: 6
        }
      ],
      finishedAt: 7
    })
    return mentionId
  }

  function insertProcessingJob(id: string, documentId: string, type: 'PARSE' | 'DETECT', createdAt: number): void {
    db.insert(processingJobs)
      .values({
        id,
        documentId,
        jobType: type,
        status: 'COMPLETED',
        progress: 1,
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt + 1
      })
      .run()
  }

  it('lists Matters ordered by creation carrying their name cipher', () => {
    insertMatter('matter-2', 20)
    insertMatter('matter-1', 10)

    const matters = review.listMatters()

    expect(matters.map((matter) => matter.id)).toEqual(['matter-1', 'matter-2'])
    expect(matters[0]!.nameCipher).toEqual(cipher('matter-name-matter-1'))
  })

  it('lists Documents for one Matter ordered by creation carrying the original name cipher', () => {
    insertMatter('matter-1', 1)
    insertMatter('matter-2', 1)
    const documents = new DocumentRepository(db)
    for (const [index, id] of ['document-2', 'document-1'].entries()) {
      const createdAt = 10 - index
      documents.create({
        id,
        matterId: index === 0 ? 'matter-1' : 'matter-2',
        originalNameCipher: cipher(`original-name-${id}`),
        fileHash: `hash-${id}`,
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        createdAt,
        updatedAt: createdAt
      })
    }
    documents.create({
      id: 'document-3',
      matterId: 'matter-1',
      originalNameCipher: cipher('original-name-document-3'),
      fileHash: 'hash-document-3',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 5,
      updatedAt: 5
    })

    const listed = review.listDocumentsByMatter('matter-1')

    expect(listed.map((item) => item.document.id)).toEqual(['document-3', 'document-2'])
    expect(listed[1]!.originalNameCipher).toEqual(cipher('original-name-document-2'))
    expect(listed.every((item) => item.document.matterId === 'matter-1')).toBe(true)
    expect(review.listDocumentsByMatter('matter-2').map((item) => item.document.id)).toEqual(['document-1'])
  })

  it('returns review Blocks in page and reading order with their text ciphers', () => {
    insertMatter('matter-1', 1)
    seedDetectedDocument('matter-1', 'document-1')

    const blocks = review.findReviewBlocks('document-1')

    expect(blocks.map((block) => block.id)).toEqual(['block-a-document-1', 'block-b-document-1'])
    expect(blocks[0]).toMatchObject({ pageNo: 1, readingOrder: 0, blockType: 'TEXT' })
    expect(blocks[0]!.textCipher).toEqual(cipher('block-a-document-1'))
  })

  it('returns review Mentions ordered by page, block order, and offset with their text ciphers', () => {
    insertMatter('matter-1', 1)
    seedDetectedDocument('matter-1', 'document-1')

    const mentions = review.findReviewMentions('document-1')

    expect(mentions.map((mention) => mention.id)).toEqual(['mention-document-1-a', 'mention-document-1-b'])
    expect(mentions[0]).toMatchObject({ type: 'PERSON', blockId: 'block-a-document-1', startOffset: 0 })
    expect(mentions[0]!.textCipher).toEqual(cipher('mention-document-1-a'))
  })

  it('groups Candidates with their evidence per mention ordered by score', () => {
    insertMatter('matter-1', 1)
    const mentionId = seedDetectedDocument('matter-1', 'document-1')
    const mentionA = `${mentionId}-a`
    const entities = new EntityRepository(db)
    entities.createWithPrimaryAliasAndEvent({
      entity: {
        id: 'entity-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-1',
        status: 'ACTIVE',
        createdAt: 8,
        updatedAt: 8
      },
      primaryAlias: {
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Alias One',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 8
      },
      event: {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-1',
        actor: 'SYSTEM',
        payloadCipher: cipher('event-1'),
        createdAt: 8
      }
    })

    const found = review.findCandidatesForMentions([mentionA])

    expect(found).toEqual([])
    expect(review.findCandidatesForMentions([])).toEqual([])

    // Seed candidates directly through the schema: the repository write path is
    // covered by entity-resolution-repository tests; here we verify the read join.
    // Candidates are unique per (mention, entity), so the second uses another entity.
    sqlite
      .prepare(
        `INSERT INTO entities (id, matter_id, entity_type, public_token, status, created_at, updated_at)
         VALUES ('entity-2', 'matter-1', 'PERSON', '@P-entity-2', 'ACTIVE', 8, 8)`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO resolution_candidates (
           id, mention_id, candidate_entity_id, score, state, algorithm_version, created_at
         ) VALUES
           ('candidate-1', ?, 'entity-1', 95, 'PENDING', 'er-v1', 10),
           ('candidate-2', ?, 'entity-2', 80, 'PENDING', 'er-v1', 10)`
      )
      .run(mentionA, mentionA)
    sqlite
      .prepare(
        `INSERT INTO resolution_evidence (id, candidate_id, evidence_type, weight, score, created_at)
         VALUES
           ('evidence-1', 'candidate-1', 'SHARED_PROTECTED_VALUE', 40, 40, 10),
           ('evidence-2', 'candidate-1', 'NAME_EXACT_MATCH', 55, 55, 10),
           ('evidence-3', 'candidate-2', 'NAME_EXACT_MATCH', 80, 80, 10)`
      )
      .run()

    const candidates = review.findCandidatesForMentions([mentionA])

    expect(candidates.map((candidate) => candidate.id)).toEqual(['candidate-1', 'candidate-2'])
    expect(candidates[0]).toMatchObject({ mentionId: mentionA, candidateEntityId: 'entity-1', score: 95, state: 'PENDING' })
    expect(candidates[0]!.evidence.map((item) => item.evidenceType)).toEqual([
      'SHARED_PROTECTED_VALUE',
      'NAME_EXACT_MATCH'
    ])
    expect(candidates[0]!.evidence[1]).toMatchObject({ weight: 55, score: 55 })
  })

  it('returns only the latest job per type', () => {
    insertMatter('matter-1', 1)
    seedDetectedDocument('matter-1', 'document-1')

    insertProcessingJob('parse-1', 'document-1', 'PARSE', 2)
    insertProcessingJob('parse-2', 'document-1', 'PARSE', 20)
    // The DETECT job was already created by seedDetectedDocument's begin().

    const jobs = review.findLatestJobs('document-1')

    const parseJobs = jobs.filter((job) => job.type === 'PARSE')
    const detectJobs = jobs.filter((job) => job.type === 'DETECT')
    expect(parseJobs).toHaveLength(1)
    expect(parseJobs[0]!.id).toBe('parse-2')
    expect(detectJobs).toHaveLength(1)
    expect(new Set(jobs.map((job) => job.type)).size).toBe(jobs.length)
  })

  it('joins sanitization readiness fields for each mention', () => {
    insertMatter('matter-1', 1)
    const mentionId = seedDetectedDocument('matter-1', 'document-1', 'EMAIL')

    // Unresolved mention: no entity at all.
    expect(review.findSanitizationReadiness('document-1')).toEqual([
      {
        mentionId: `${mentionId}-a`,
        mentionType: 'EMAIL',
        entityId: null,
        entityStatus: null,
        entityPrimaryAlias: null,
        protectedValuePublicToken: null
      },
      {
        mentionId: `${mentionId}-b`,
        mentionType: 'PHONE',
        entityId: null,
        entityStatus: null,
        entityPrimaryAlias: null,
        protectedValuePublicToken: null
      }
    ])

    // Assign the first mention to an entity with an alias and a tokened ProtectedValue.
    const entities = new EntityRepository(db)
    entities.createWithPrimaryAliasAndEvent({
      entity: {
        id: 'entity-1',
        matterId: 'matter-1',
        type: 'PERSON',
        publicToken: '@P-entity-1',
        status: 'ACTIVE',
        createdAt: 8,
        updatedAt: 8
      },
      primaryAlias: {
        id: 'alias-1',
        matterId: 'matter-1',
        entityId: 'entity-1',
        alias: 'Alias One',
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt: 8
      },
      event: {
        id: 'event-1',
        matterId: 'matter-1',
        type: 'ENTITY_CREATED',
        entityId: 'entity-1',
        actor: 'USER',
        payloadCipher: cipher('event-1'),
        createdAt: 8
      }
    })
    new ProtectedValueRepository(db).create({
      id: 'protected-1',
      matterId: 'matter-1',
      type: 'EMAIL',
      valueCipher: cipher('value-1'),
      fingerprint: cipher('fingerprint-1'),
      publicToken: '@N-933F7561C93A4DB8',
      restorePolicy: 'RESTORE_ON_REQUEST',
      createdAt: 9
    })
    sqlite
      .prepare('UPDATE mentions SET entity_id = ?, protected_value_id = ? WHERE id = ?')
      .run('entity-1', 'protected-1', `${mentionId}-a`)

    const readiness = review.findSanitizationReadiness('document-1')

    expect(readiness[0]).toEqual({
      mentionId: `${mentionId}-a`,
      mentionType: 'EMAIL',
      entityId: 'entity-1',
      entityStatus: 'ACTIVE',
      entityPrimaryAlias: 'Alias One',
      protectedValuePublicToken: '@N-933F7561C93A4DB8'
    })
    expect(readiness[1]!.entityId).toBeNull()
  })
})
