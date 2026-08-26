import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt, deriveMatterSearchKey, encrypt, fingerprintNormalizedValue, generatePublicToken } from '@aliasai/crypto'
import type { Entity, EntityType, MentionStrength, MentionType, ProcessingJob, ProtectedValueType } from '@aliasai/domain'
import { RuleBasedPrivacyDetector, type MentionProposal, type PrivacyDetector } from '@aliasai/privacy-detection'
import {
  DocumentRepository,
  EntityRepository,
  EntityResolutionRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  SanitizationRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import { normalizeMentionValue } from '@aliasai/entity-resolution'
import { PythonWorkerClient, PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import {
  DocumentImportService,
  DocumentProcessingService,
  EntityResolutionService,
  MatterService,
  PrivacyDetectionService,
  PseudonymizationService,
  documentBlockTextContext,
  privacyDetectionErrorContext,
  protectedValueContext,
  resolutionEventContext,
  sanitizedBlockTextContext,
  type ApplicationKeys
} from '../src/index'

function syntheticPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = `BT /F1 10 Tf 18 84 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${value}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

function syntheticChinesePdf(text: string): Buffer {
  const utf16 = Buffer.from(text, 'utf16le')
  for (let index = 0; index < utf16.length; index += 2) {
    const first = utf16[index]!
    utf16[index] = utf16[index + 1]!
    utf16[index + 1] = first
  }
  const content = `BT /F1 10 Tf 18 84 Td <FEFF${utf16.toString('hex').toUpperCase()}> Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${value}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(output, 'ascii')
}

describe('EntityResolutionService', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const searchKey = Buffer.alloc(32, 7)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  const directories: string[] = []
  const processors: PythonWorkerDocumentProcessor[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let documents: DocumentRepository
  let detection: PrivacyDetectionRepository
  let resolution: EntityResolutionRepository
  let protectedValues: ProtectedValueRepository
  let entities: EntityRepository
  let timestamp: number
  let idSequence: number

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    documents = new DocumentRepository(db)
    detection = new PrivacyDetectionRepository(db)
    resolution = new EntityResolutionRepository(db)
    protectedValues = new ProtectedValueRepository(db)
    entities = new EntityRepository(db)
    timestamp = 1_730_000_000_000
    idSequence = 0
  })

  afterEach(async () => {
    for (const processor of processors.splice(0)) processor.stop()
    sqlite.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const now = () => timestamp++
  const generateId = () => `generated-${++idSequence}`

  function query(sql: string, ...params: unknown[]): unknown[] {
    return sqlite.prepare(sql).all(...params)
  }

  function createMatter(name: string): string {
    return new MatterService(new MatterRepository(db), { persistenceKey }, now).create(name).id
  }

  function seedParsedDocument(
    blockTexts: readonly string[],
    documentId = 'document-1',
    matterId = createMatter('Synthetic Matter')
  ): { documentId: string; matterId: string } {
    documents.create({
      id: documentId,
      matterId,
      originalNameCipher: encrypt(Buffer.from('synthetic.pdf'), persistenceKey, Buffer.from(`${documentId}:document.originalName`)),
      fileHash: `synthetic-hash-${documentId}`,
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: now(),
      updatedAt: now()
    })
    documents.markProcessing(documentId, 'SYNTHETIC', now())
    const pageId = `page-${documentId}`
    documents.completeProcessing({
      documentId,
      parserType: 'SYNTHETIC',
      pageCount: 1,
      pages: [
        {
          id: pageId,
          documentId,
          pageNo: 1,
          originalWidth: 100,
          originalHeight: 100,
          rotation: 0,
          sourceType: 'NATIVE',
          createdAt: now()
        }
      ],
      blocks: blockTexts.map((text, index) => {
        const id = `block-${documentId}-${index + 1}`
        return {
          id,
          documentId,
          pageId,
          blockType: 'TEXT' as const,
          textCipher: encrypt(Buffer.from(text), persistenceKey, documentBlockTextContext(id)),
          source: 'NATIVE' as const,
          bbox: { x: 0, y: index / blockTexts.length, width: 1, height: 1 / blockTexts.length },
          readingOrder: index,
          createdAt: now()
        }
      }),
      updatedAt: now()
    })
    return { documentId, matterId }
  }

  function detectorFor(
    matches: readonly { type: MentionType; text: string; strength?: MentionStrength }[]
  ): PrivacyDetector {
    return {
      detect(block) {
        const proposals: MentionProposal[] = []
        for (const match of matches) {
          const startOffset = block.text.indexOf(match.text)
          if (startOffset < 0) continue
          proposals.push({
            matterId: block.matterId,
            documentId: block.documentId,
            pageId: block.pageId,
            blockId: block.blockId,
            type: match.type,
            strength: match.strength ?? 'EXPLICIT',
            startOffset,
            endOffset: startOffset + match.text.length,
            detector: 'REGEX',
            confidence: 1
          })
        }
        return proposals.sort((left, right) => left.startOffset - right.startOffset)
      }
    }
  }

  async function runDetection(documentId: string, detector: PrivacyDetector): Promise<void> {
    await new PrivacyDetectionService(detection, { persistenceKey }, detector, now, generateId).detect(documentId)
  }

  function makeService(repository: EntityResolutionRepository = resolution): EntityResolutionService {
    return new EntityResolutionService(repository, protectedValues, entities, keys, now, generateId)
  }

  function seedEntity(matterId: string, type: EntityType, primaryAlias: string, id?: string): Entity {
    const createdAt = now()
    const entity: Entity = {
      id: id ?? generateId(),
      matterId,
      type,
      publicToken: generatePublicToken(type),
      status: 'ACTIVE',
      createdAt,
      updatedAt: createdAt
    }
    entities.create(entity)
    entities.addAlias({
      id: generateId(),
      matterId,
      entityId: entity.id,
      alias: primaryAlias,
      aliasType: 'PRIMARY',
      isPrimary: true,
      createdAt: now()
    })
    return entity
  }

  function seedProtectedValue(
    matterId: string,
    type: ProtectedValueType,
    mentionType: MentionType,
    originalText: string
  ): string {
    const createdAt = now()
    const id = generateId()
    const matterSearchKey = deriveMatterSearchKey(searchKey, matterId)
    const fingerprint = fingerprintNormalizedValue(matterSearchKey, normalizeMentionValue(mentionType, originalText))
    matterSearchKey.fill(0)
    protectedValues.create({
      id,
      matterId,
      type,
      valueCipher: encrypt(Buffer.from(originalText, 'utf8'), persistenceKey, protectedValueContext(id)),
      fingerprint,
      restorePolicy: 'ALWAYS_RESTORE',
      createdAt
    })
    return id
  }

  function linkEntityProtectedValue(matterId: string, entityId: string, protectedValueId: string): void {
    protectedValues.linkToEntity({
      id: generateId(),
      matterId,
      entityId,
      protectedValueId,
      relationshipType: 'OWNER',
      confidence: 1,
      isPrimary: true,
      createdAt: now()
    })
  }

  it('requires a distinct 32-byte search key', () => {
    const construct = (candidateKeys: ApplicationKeys) => () =>
      new EntityResolutionService(resolution, protectedValues, entities, candidateKeys, now, generateId)

    expect(construct({ persistenceKey })).toThrowError(expect.objectContaining({ code: 'SEARCH_KEY_UNAVAILABLE' }))
    expect(construct({ persistenceKey, searchKey: persistenceKey })).toThrowError(
      expect.objectContaining({ code: 'SEARCH_KEY_UNAVAILABLE' })
    )
    expect(construct({ persistenceKey, searchKey: Buffer.alloc(16, 3) })).toThrowError(
      expect.objectContaining({ code: 'SEARCH_KEY_UNAVAILABLE' })
    )
  })

  it('creates a new Entity with a synthetic alias for an unmatched EXPLICIT PERSON mention', async () => {
    const { documentId } = seedParsedDocument(['Synthetic Person Alpha signed the agreement.'])
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Person Alpha' }]))

    const result = await makeService().resolve(documentId)

    expect(result).toMatchObject({
      reused: false,
      document: { parseStatus: 'READY' },
      job: { type: 'RESOLVE', status: 'COMPLETED', progress: 1 }
    })
    expect(result.decisions).toHaveLength(1)
    const decision = result.decisions[0]!
    expect(decision.decision).toBe('NEW_ENTITY')
    expect(decision.candidateEntityId).toBeDefined()

    const entityRows = query('SELECT id, entity_type, public_token, status FROM entities') as Array<{
      id: string
      entity_type: string
      public_token: string
      status: string
    }>
    expect(entityRows).toHaveLength(1)
    const entityRow = entityRows[0]!
    expect(entityRow.id).toBe(decision.candidateEntityId)
    expect(entityRow.entity_type).toBe('PERSON')
    expect(entityRow.status).toBe('ACTIVE')
    expect(entityRow.public_token).toMatch(/^@P-[0-9A-F]{16}$/)

    const aliasRows = query('SELECT alias, is_primary FROM entity_aliases WHERE entity_id = ?', entityRow.id) as Array<{
      alias: string
      is_primary: number
    }>
    expect(aliasRows).toHaveLength(1)
    expect(aliasRows[0]!.alias).toMatch(/^Person [A-Z0-9]+$/)
    expect(aliasRows[0]!.is_primary).toBe(1)
    expect(aliasRows[0]!.alias).not.toContain('Synthetic Person Alpha')

    const mentionRows = query(
      'SELECT id, entity_id, protected_value_id, fingerprint FROM mentions WHERE document_id = ?',
      documentId
    ) as Array<{ id: string; entity_id: string; protected_value_id: string; fingerprint: Buffer }>
    expect(mentionRows).toHaveLength(1)
    expect(mentionRows[0]!.id).toBe(decision.mentionId)
    expect(mentionRows[0]!.entity_id).toBe(entityRow.id)
    expect(mentionRows[0]!.fingerprint).toHaveLength(32)

    const protectedValueRows = query(
      'SELECT id, value_type, value_cipher, restore_policy FROM protected_values'
    ) as Array<{ id: string; value_type: string; value_cipher: Buffer; restore_policy: string }>
    expect(protectedValueRows).toHaveLength(1)
    const protectedValue = protectedValueRows[0]!
    expect(protectedValue.id).toBe(mentionRows[0]!.protected_value_id)
    expect(protectedValue.value_type).toBe('PERSON_NAME')
    expect(protectedValue.restore_policy).toBe('ALWAYS_RESTORE')
    expect(decrypt(protectedValue.value_cipher, persistenceKey, protectedValueContext(protectedValue.id)).toString()).toBe(
      'Synthetic Person Alpha'
    )
    expect(protectedValue.value_cipher.includes(Buffer.from('Synthetic Person Alpha'))).toBe(false)

    expect(
      query('SELECT entity_id, protected_value_id, relationship_type, confidence, is_primary FROM entity_protected_values')
    ).toEqual([
      {
        entity_id: entityRow.id,
        protected_value_id: protectedValue.id,
        relationship_type: 'OWNER',
        confidence: 1,
        is_primary: 1
      }
    ])

    const eventRows = query(
      'SELECT id, event_type, entity_id, mention_id, actor, payload_cipher FROM resolution_events ORDER BY created_at, id'
    ) as Array<{
      id: string
      event_type: string
      entity_id: string | null
      mention_id: string | null
      actor: string
      payload_cipher: Buffer
    }>
    expect(eventRows.map((row) => row.event_type)).toEqual(['ENTITY_CREATED', 'MENTION_ASSIGNED'])
    expect(eventRows[0]).toMatchObject({ entity_id: entityRow.id, mention_id: null, actor: 'SYSTEM' })
    expect(eventRows[1]).toMatchObject({ entity_id: entityRow.id, mention_id: decision.mentionId, actor: 'SYSTEM' })
    const payload = decrypt(eventRows[1]!.payload_cipher, persistenceKey, resolutionEventContext(eventRows[1]!.id)).toString()
    expect(JSON.parse(payload)).toEqual({
      decision: 'NEW_ENTITY',
      candidateEntityId: entityRow.id,
      algorithmVersion: 'er-v2'
    })
    expect(payload).not.toContain('Synthetic Person Alpha')
    expect(query('SELECT COUNT(*) AS count FROM resolution_candidates')).toEqual([{ count: 0 }])
  })

  it('creates contract parties and assigns labeled identifiers without manual Entity creation', async () => {
    const contractLine =
      '出租方：湖北众创科技孵化园有限公司 授权代表：喻越 身份证号：421022199406233911 手机：18923414607'
    const { documentId } = seedParsedDocument([contractLine])
    await runDetection(documentId, new RuleBasedPrivacyDetector())

    const result = await makeService().resolve(documentId)

    expect(result.decisions.map((decision) => decision.decision)).toEqual([
      'NEW_ENTITY',
      'NEW_ENTITY',
      'AUTO_LINK',
      'AUTO_LINK'
    ])
    const mentionRows = query(
      'SELECT mention_type, entity_id FROM mentions WHERE document_id = ? ORDER BY start_offset',
      documentId
    ) as Array<{ mention_type: MentionType; entity_id: string | null }>
    expect(mentionRows.map((row) => row.mention_type)).toEqual(['ORGANIZATION', 'PERSON', 'ID_CARD', 'PHONE'])
    const organizationEntityId = mentionRows[0]!.entity_id
    const personEntityId = mentionRows[1]!.entity_id
    expect(organizationEntityId).not.toBeNull()
    expect(personEntityId).not.toBeNull()
    expect(organizationEntityId).not.toBe(personEntityId)
    expect(mentionRows[2]!.entity_id).toBe(personEntityId)
    expect(mentionRows[3]!.entity_id).toBe(personEntityId)

    expect(
      query(
        "SELECT evidence_type, score FROM resolution_evidence WHERE evidence_type = 'SAME_LABELED_FIELD_GROUP' ORDER BY id"
      )
    ).toEqual([
      { evidence_type: 'SAME_LABELED_FIELD_GROUP', score: 100 },
      { evidence_type: 'SAME_LABELED_FIELD_GROUP', score: 100 }
    ])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 2 }])
    expect(query('SELECT event_type, actor FROM resolution_events ORDER BY created_at, id')).toEqual([
      { event_type: 'ENTITY_CREATED', actor: 'SYSTEM' },
      { event_type: 'MENTION_ASSIGNED', actor: 'SYSTEM' },
      { event_type: 'ENTITY_CREATED', actor: 'SYSTEM' },
      { event_type: 'MENTION_ASSIGNED', actor: 'SYSTEM' },
      { event_type: 'MENTION_ASSIGNED', actor: 'SYSTEM' },
      { event_type: 'MENTION_ASSIGNED', actor: 'SYSTEM' }
    ])
  })

  it('merges labeled-field context evidence into an already-scored candidate', async () => {
    const contractLine = '授权代表：张三 电话：13800138000'
    const { documentId, matterId } = seedParsedDocument([contractLine])
    const holder = seedEntity(matterId, 'PERSON', 'Holder Alias')
    const phoneValueId = seedProtectedValue(matterId, 'PHONE', 'PHONE', '13800138000')
    linkEntityProtectedValue(matterId, holder.id, phoneValueId)
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: '张三' },
        { type: 'PHONE', text: '13800138000' }
      ])
    )
    sqlite
      .prepare(`UPDATE mentions SET entity_id = ? WHERE document_id = ? AND mention_type = 'PERSON'`)
      .run(holder.id, documentId)

    const result = await makeService().resolve(documentId)

    // The phone both shares its ProtectedValue with the holder (SAME_PHONE 40)
    // and sits in the holder's labeled field group (100): additive evidence on
    // one candidate auto-links instead of dropping the context explanation.
    expect(result.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'AUTO_LINK', candidateEntityId: holder.id }
    ])
    expect(query('SELECT candidate_entity_id, score, state FROM resolution_candidates')).toEqual([
      { candidate_entity_id: holder.id, score: 140, state: 'ACCEPTED' }
    ])
    expect(query('SELECT evidence_type, weight, score FROM resolution_evidence ORDER BY id')).toEqual([
      { evidence_type: 'SAME_PHONE', weight: 40, score: 40 },
      { evidence_type: 'SAME_LABELED_FIELD_GROUP', weight: 100, score: 100 }
    ])
  })

  it('backfills a restoration token for a pre-existing tokenless ProtectedValue', async () => {
    const { documentId, matterId } = seedParsedDocument(['Synthetic Person Alpha signed the agreement.'])
    const entity = seedEntity(matterId, 'PERSON', 'Synthetic Holder')
    linkEntityProtectedValue(matterId, entity.id, seedProtectedValue(matterId, 'PERSON_NAME', 'PERSON', 'Synthetic Person Alpha'))
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Person Alpha' }]))

    const before = query('SELECT public_token FROM protected_values WHERE matter_id = ?', matterId) as Array<{
      public_token: string | null
    }>
    expect(before[0]!.public_token).toBeNull()

    await makeService().resolve(documentId)

    const after = query('SELECT public_token FROM protected_values WHERE matter_id = ?', matterId) as Array<{
      public_token: string | null
    }>
    expect(after[0]!.public_token).toMatch(/^@N-[A-Z0-9]+$/)
  })

  it('auto-links an ID_CARD mention to the Entity sharing its ProtectedValue (hard Must-Link)', async () => {
    const { documentId, matterId } = seedParsedDocument(['Holder 110101199003077774 signed.'])
    const entity = seedEntity(matterId, 'PERSON', 'Synthetic Holder')
    const protectedValueId = seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774')
    linkEntityProtectedValue(matterId, entity.id, protectedValueId)
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))

    const result = await makeService().resolve(documentId)

    expect(result.document.parseStatus).toBe('READY')
    expect(result.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'AUTO_LINK', candidateEntityId: entity.id }
    ])
    expect(query('SELECT entity_id, protected_value_id FROM mentions WHERE document_id = ?', documentId)).toEqual([
      { entity_id: entity.id, protected_value_id: protectedValueId }
    ])
    // The existing ProtectedValue and link were reused, never duplicated.
    expect(query('SELECT COUNT(*) AS count FROM protected_values')).toEqual([{ count: 1 }])
    expect(query('SELECT COUNT(*) AS count FROM entity_protected_values')).toEqual([{ count: 1 }])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 1 }])

    const candidateRows = query(
      'SELECT id, candidate_entity_id, score, state, algorithm_version, resolved_at FROM resolution_candidates'
    ) as Array<{
      id: string
      candidate_entity_id: string
      score: number
      state: string
      algorithm_version: string
      resolved_at: number | null
    }>
    expect(candidateRows).toHaveLength(1)
    expect(candidateRows[0]).toMatchObject({
      candidate_entity_id: entity.id,
      score: 40,
      state: 'ACCEPTED',
      algorithm_version: 'er-v2'
    })
    expect(candidateRows[0]!.resolved_at).toBe(result.job.finishedAt)
    expect(query('SELECT evidence_type, weight, score FROM resolution_evidence WHERE candidate_id = ?', candidateRows[0]!.id)).toEqual([
      { evidence_type: 'SAME_ID_CARD', weight: 40, score: 40 }
    ])

    const eventRows = query('SELECT id, event_type, actor, payload_cipher FROM resolution_events') as Array<{
      id: string
      event_type: string
      actor: string
      payload_cipher: Buffer
    }>
    expect(eventRows).toHaveLength(1)
    expect(eventRows[0]).toMatchObject({ event_type: 'MENTION_ASSIGNED', actor: 'SYSTEM' })
    const payload = decrypt(eventRows[0]!.payload_cipher, persistenceKey, resolutionEventContext(eventRows[0]!.id)).toString()
    expect(JSON.parse(payload)).toEqual({ decision: 'AUTO_LINK', candidateEntityId: entity.id, algorithmVersion: 'er-v2' })
    expect(payload).not.toContain('110101199003077774')
  })

  it('never auto-merges a same-name PERSON mention into the existing Entity', async () => {
    const { documentId, matterId } = seedParsedDocument(['Synthetic Name appeared.'])
    const seeded = seedEntity(matterId, 'PERSON', 'Synthetic Name')
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Name' }]))

    const result = await makeService().resolve(documentId)

    const decision = result.decisions[0]!
    // A scored name candidate below the review threshold is ambiguity: the
    // mention goes to REVIEW and no duplicate Entity is created.
    expect(decision.decision).toBe('REVIEW')
    expect(decision.candidateEntityId).toBe(seeded.id)
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', matterId)).toEqual([{ count: 1 }])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    // The pre-seeded Entity gained no Mention and no assignment event.
    expect(query('SELECT COUNT(*) AS count FROM resolution_events WHERE entity_id = ?', seeded.id)).toEqual([{ count: 0 }])
    // The name-match candidate stays pending for human review.
    expect(query('SELECT candidate_entity_id, state FROM resolution_candidates')).toEqual([
      { candidate_entity_id: seeded.id, state: 'PENDING' }
    ])
    expect(query('SELECT evidence_type FROM resolution_evidence')).toEqual([{ evidence_type: 'NAME_EXACT' }])
  })

  it('does not link a PERSON mention to an Entity whose ID_CARD conflicts with the document', async () => {
    const { documentId, matterId } = seedParsedDocument(['Conflicting Name presented 22020219850506321X.'])
    const seeded = seedEntity(matterId, 'PERSON', 'Conflicting Name')
    const protectedValueId = seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774')
    linkEntityProtectedValue(matterId, seeded.id, protectedValueId)
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: 'Conflicting Name' },
        { type: 'ID_CARD', text: '22020219850506321X' }
      ])
    )

    const result = await makeService().resolve(documentId)

    const mentionRows = query(
      'SELECT id, mention_type, entity_id FROM mentions WHERE document_id = ? ORDER BY start_offset',
      documentId
    ) as Array<{ id: string; mention_type: string; entity_id: string | null }>
    expect(mentionRows.map((row) => row.mention_type)).toEqual(['PERSON', 'ID_CARD'])
    const [person, idCard] = mentionRows
    const personDecision = result.decisions.find((item) => item.mentionId === person!.id)!
    const idCardDecision = result.decisions.find((item) => item.mentionId === idCard!.id)!
    expect(personDecision.decision).not.toBe('AUTO_LINK')
    expect(person!.entity_id).not.toBe(seeded.id)
    expect(idCardDecision.decision).toBe('UNRESOLVED')
    expect(idCard!.entity_id).toBeNull()
    expect(query('SELECT COUNT(*) AS count FROM resolution_events WHERE entity_id = ?', seeded.id)).toEqual([{ count: 0 }])
    expect(query('SELECT candidate_entity_id, state FROM resolution_candidates')).toEqual([
      { candidate_entity_id: seeded.id, state: 'REJECTED' }
    ])
  })

  it('leaves a REFERENCE PERSON mention unresolved without creating an Entity', async () => {
    const { documentId } = seedParsedDocument(['Someone Unknown called the office.'])
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Someone Unknown', strength: 'REFERENCE' }]))

    const result = await makeService().resolve(documentId)

    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'UNRESOLVED' }])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_events')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_candidates')).toEqual([{ count: 0 }])
    const mentionRows = query(
      'SELECT entity_id, protected_value_id, fingerprint FROM mentions WHERE document_id = ?',
      documentId
    ) as Array<{ entity_id: string | null; protected_value_id: string | null; fingerprint: Buffer | null }>
    expect(mentionRows).toHaveLength(1)
    expect(mentionRows[0]!.entity_id).toBeNull()
    expect(mentionRows[0]!.protected_value_id).not.toBeNull()
    expect(mentionRows[0]!.fingerprint).toHaveLength(32)
  })

  it('leaves an identifier mention without a shared ProtectedValue unresolved', async () => {
    const { documentId } = seedParsedDocument(['Contact synthetic@example.test today.'])
    await runDetection(documentId, detectorFor([{ type: 'EMAIL', text: 'synthetic@example.test' }]))

    const result = await makeService().resolve(documentId)

    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'UNRESOLVED' }])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_events')).toEqual([{ count: 0 }])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    expect(query('SELECT value_type FROM protected_values')).toEqual([{ value_type: 'EMAIL' }])
  })

  it('is idempotent after completion and does not resolve twice', async () => {
    const { documentId } = seedParsedDocument(['Synthetic Person Alpha signed.'])
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Person Alpha' }]))
    const service = makeService()

    const first = await service.resolve(documentId)
    const second = await service.resolve(documentId)

    expect(first.reused).toBe(false)
    expect(second).toMatchObject({ reused: true, decisions: [] })
    expect(second.job.id).toBe(first.job.id)
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 1 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_events')).toEqual([{ count: 2 }])
    expect(query("SELECT COUNT(*) AS count FROM processing_jobs WHERE job_type = 'RESOLVE'")).toEqual([{ count: 1 }])
    expect(query('SELECT COUNT(*) AS count FROM protected_values')).toEqual([{ count: 1 }])
  })

  it('records an encrypted failure without partial writes and succeeds on retry', async () => {
    const { documentId } = seedParsedDocument(['Synthetic Retry Person appeared.'])
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Retry Person' }]))
    const failing = new (class extends EntityResolutionRepository {
      private failedOnce = false
      override updateProgress(jobId: string, completedMentions: number, totalMentions: number): ProcessingJob {
        if (!this.failedOnce) {
          this.failedOnce = true
          throw new Error('synthetic failure; do not persist plaintext')
        }
        return super.updateProgress(jobId, completedMentions, totalMentions)
      }
    })(db)
    const service = makeService(failing)

    await expect(service.resolve(documentId)).rejects.toMatchObject({ code: 'RESOLUTION_FAILED' })
    expect(documents.findById(documentId)?.parseStatus).toBe('FAILED')
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM protected_values')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_candidates')).toEqual([{ count: 0 }])
    expect(query('SELECT entity_id, fingerprint FROM mentions WHERE document_id = ?', documentId)).toEqual([
      { entity_id: null, fingerprint: null }
    ])
    const failedJobs = query(
      "SELECT id, status, error_cipher FROM processing_jobs WHERE document_id = ? AND job_type = 'RESOLVE'",
      documentId
    ) as Array<{ id: string; status: string; error_cipher: Buffer }>
    expect(failedJobs).toHaveLength(1)
    expect(failedJobs[0]!.status).toBe('FAILED')
    expect(decrypt(failedJobs[0]!.error_cipher, persistenceKey, privacyDetectionErrorContext(failedJobs[0]!.id)).toString()).toBe(
      '{"code":"RESOLUTION_FAILED"}'
    )
    expect(failedJobs[0]!.error_cipher.includes(Buffer.from('Synthetic Retry Person'))).toBe(false)

    const retry = await service.resolve(documentId)
    expect(retry.document.parseStatus).toBe('READY')
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 1 }])
    expect(
      query("SELECT status FROM processing_jobs WHERE document_id = ? AND job_type = 'RESOLVE' ORDER BY created_at", documentId)
    ).toEqual([{ status: 'FAILED' }, { status: 'COMPLETED' }])
  })

  it('assigns and reassigns an unresolved Mention with USER audit events', async () => {
    const { documentId, matterId } = seedParsedDocument(['Contact synthetic@example.test today.'])
    await runDetection(documentId, detectorFor([{ type: 'EMAIL', text: 'synthetic@example.test' }]))
    const service = makeService()
    await service.resolve(documentId)
    const mentionId = (query('SELECT id FROM mentions WHERE document_id = ?', documentId) as Array<{ id: string }>)[0]!.id
    const first = seedEntity(matterId, 'PERSON', 'Synthetic First')
    const second = seedEntity(matterId, 'PERSON', 'Synthetic Second')
    const otherMatterId = createMatter('Other Matter')
    const foreign = seedEntity(otherMatterId, 'PERSON', 'Foreign Entity')

    expect(service.assign(mentionId, first.id).entityId).toBe(first.id)
    expect(service.assign(mentionId, second.id).entityId).toBe(second.id)

    const eventRows = query(
      'SELECT id, event_type, actor, payload_cipher FROM resolution_events ORDER BY created_at, id'
    ) as Array<{ id: string; event_type: string; actor: string; payload_cipher: Buffer }>
    expect(eventRows.map((row) => row.event_type)).toEqual(['MENTION_ASSIGNED', 'MENTION_REASSIGNED'])
    expect(eventRows.every((row) => row.actor === 'USER')).toBe(true)
    const payload = decrypt(eventRows[0]!.payload_cipher, persistenceKey, resolutionEventContext(eventRows[0]!.id)).toString()
    expect(JSON.parse(payload)).toEqual({ entityId: first.id })

    expect(() => service.assign(mentionId, foreign.id)).toThrowError(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
    expect(resolution.findMentionById(mentionId)?.entityId).toBe(second.id)
    // Assignment attaches the Mention's ProtectedValue to each confirmed Entity,
    // idempotently and inside the same transaction.
    const mentionValueId = resolution.findMentionById(mentionId)?.protectedValueId
    expect(mentionValueId).toBeDefined()
    const linkRows = query('SELECT entity_id FROM entity_protected_values WHERE protected_value_id = ?', mentionValueId) as Array<{
      entity_id: string
    }>
    expect(linkRows.map((row) => row.entity_id).sort()).toEqual([first.id, second.id].sort())
    expect(() => service.assign('missing-mention', first.id)).toThrowError(
      expect.objectContaining({ code: 'ASSIGNMENT_FAILED' })
    )
  })

  it('keeps a user assignment made before resolution, links the value, and resolves repeats', async () => {
    const { documentId, matterId } = seedParsedDocument(['Holder 110101199003077774 signed.'])
    const seeded = seedEntity(matterId, 'PERSON', 'Synthetic Holder')
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))
    const service = makeService()
    const mentionId = (query('SELECT id FROM mentions WHERE document_id = ?', documentId) as Array<{ id: string }>)[0]!.id
    service.assign(mentionId, seeded.id)

    const result = await service.resolve(documentId)

    expect(result.document.parseStatus).toBe('READY')
    expect(result.decisions).toEqual([])
    const mentionRows = query(
      'SELECT entity_id, protected_value_id, fingerprint FROM mentions WHERE id = ?',
      mentionId
    ) as Array<{ entity_id: string | null; protected_value_id: string | null; fingerprint: Buffer | null }>
    expect(mentionRows[0]!.entity_id).toBe(seeded.id)
    expect(mentionRows[0]!.protected_value_id).not.toBeNull()
    expect(mentionRows[0]!.fingerprint).toHaveLength(32)
    // Only the user's assignment event exists; resolution fabricated none.
    expect(query('SELECT event_type, actor FROM resolution_events WHERE mention_id = ?', mentionId)).toEqual([
      { event_type: 'MENTION_ASSIGNED', actor: 'USER' }
    ])
    // The confirmed Entity is linked to the ProtectedValue exactly once.
    expect(
      query('SELECT entity_id, protected_value_id FROM entity_protected_values WHERE entity_id = ?', seeded.id)
    ).toEqual([{ entity_id: seeded.id, protected_value_id: mentionRows[0]!.protected_value_id }])

    // A second document with the same identifier now finds the confirmed Entity
    // through the fingerprint and auto-links (hard Must-Link).
    const second = seedParsedDocument(['110101199003077774 appears again.'], 'document-2', matterId)
    await runDetection(second.documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))
    const result2 = await service.resolve(second.documentId)
    expect(result2.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'AUTO_LINK', candidateEntityId: seeded.id }
    ])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', second.documentId)).toEqual([
      { entity_id: seeded.id }
    ])
    // The link was not duplicated by the second resolution.
    expect(
      query('SELECT COUNT(*) AS count FROM entity_protected_values WHERE entity_id = ?', seeded.id)
    ).toEqual([{ count: 1 }])
  })

  it('does not treat a missing document identifier as an ID_CARD conflict', async () => {
    // The document contains only a name; the candidate Entity holds an ID_CARD.
    const { documentId, matterId } = seedParsedDocument(['Synthetic Name appeared.'])
    const seeded = seedEntity(matterId, 'PERSON', 'Synthetic Name')
    const idCardValueId = seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774')
    linkEntityProtectedValue(matterId, seeded.id, idCardValueId)
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Name' }]))

    const result = await makeService().resolve(documentId)

    // No ID_CARD in the document means no conflict evidence: the name candidate
    // goes to REVIEW instead of being Cannot-Linked into a duplicate Entity.
    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'REVIEW', candidateEntityId: seeded.id }])
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', matterId)).toEqual([{ count: 1 }])
    expect(query('SELECT candidate_entity_id, state FROM resolution_candidates')).toEqual([
      { candidate_entity_id: seeded.id, state: 'PENDING' }
    ])
    expect(query('SELECT evidence_type FROM resolution_evidence')).toEqual([{ evidence_type: 'NAME_EXACT' }])
  })

  it('persists a canonicalized USER constraint with its audit event', () => {
    const matterId = createMatter('Constraint Matter')
    seedEntity(matterId, 'PERSON', 'Entity A', 'entity-a')
    seedEntity(matterId, 'PERSON', 'Entity B', 'entity-b')
    const service = makeService()

    const constraint = service.addConstraint(matterId, 'entity-b', 'entity-a', 'CANNOT_LINK', 'Synthetic user conflict')

    expect(constraint).toMatchObject({
      matterId,
      entityAId: 'entity-a',
      entityBId: 'entity-b',
      type: 'CANNOT_LINK',
      source: 'USER'
    })
    expect(resolution.findConstraints(matterId)).toEqual([constraint])
    const eventRows = query('SELECT id, event_type, actor, payload_cipher FROM resolution_events') as Array<{
      id: string
      event_type: string
      actor: string
      payload_cipher: Buffer
    }>
    expect(eventRows).toHaveLength(1)
    expect(eventRows[0]).toMatchObject({ event_type: 'CONSTRAINT_CREATED', actor: 'USER' })
    const payload = decrypt(eventRows[0]!.payload_cipher, persistenceKey, resolutionEventContext(eventRows[0]!.id)).toString()
    expect(JSON.parse(payload)).toEqual({ entityAId: 'entity-b', entityBId: 'entity-a', constraintType: 'CANNOT_LINK' })

    expect(() => service.addConstraint(matterId, 'entity-a', 'entity-b', 'CANNOT_LINK', 'Reversed duplicate')).toThrowError(
      expect.objectContaining({ code: 'CONSTRAINT_FAILED' })
    )
  })

  it('escalates a shared-phone mention to REVIEW through a USER MUST_LINK constraint', async () => {
    const { documentId, matterId } = seedParsedDocument(['Call 13800138000 today.'])
    const first = seedEntity(matterId, 'PERSON', 'Synthetic First')
    const second = seedEntity(matterId, 'PERSON', 'Synthetic Second')
    const phoneId = seedProtectedValue(matterId, 'PHONE', 'PHONE', '13800138000')
    linkEntityProtectedValue(matterId, first.id, phoneId)
    linkEntityProtectedValue(matterId, second.id, phoneId)
    await runDetection(documentId, detectorFor([{ type: 'PHONE', text: '13800138000' }]))
    const service = makeService()
    service.addConstraint(matterId, first.id, second.id, 'MUST_LINK', 'Synthetic user link')

    const result = await service.resolve(documentId)

    // Both candidates become hard Must-Link (USER_MUST_LINK), so the mention
    // escalates from UNRESOLVED to REVIEW instead of staying unassigned.
    expect(result.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'REVIEW', candidateEntityId: expect.any(String) }
    ])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    expect(query('SELECT score, state FROM resolution_candidates')).toEqual([
      { score: 40, state: 'PENDING' },
      { score: 40, state: 'PENDING' }
    ])
    expect(query('SELECT DISTINCT evidence_type, weight, score FROM resolution_evidence')).toEqual([
      { evidence_type: 'USER_MUST_LINK', weight: 40, score: 40 }
    ])
  })

  it('routes same-name candidates with a USER MUST_LINK constraint to REVIEW without linking', async () => {
    const { documentId, matterId } = seedParsedDocument(['Synthetic Name appeared.'])
    const first = seedEntity(matterId, 'PERSON', 'Synthetic Name')
    const second = seedEntity(matterId, 'PERSON', 'Synthetic Second')
    // Both Entities carry the same name ProtectedValue, so both name-match.
    const nameValueId = seedProtectedValue(matterId, 'PERSON_NAME', 'PERSON', 'Synthetic Name')
    linkEntityProtectedValue(matterId, first.id, nameValueId)
    linkEntityProtectedValue(matterId, second.id, nameValueId)
    await runDetection(documentId, detectorFor([{ type: 'PERSON', text: 'Synthetic Name' }]))
    const service = makeService()
    service.addConstraint(matterId, first.id, second.id, 'MUST_LINK', 'Synthetic user link')

    const result = await service.resolve(documentId)

    // Both name candidates become hard Must-Link, and conflicting hard
    // Must-Links route to REVIEW — no assignment, no new Entity.
    expect(result.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'REVIEW', candidateEntityId: expect.any(String) }
    ])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', matterId)).toEqual([{ count: 2 }])
    expect(query('SELECT DISTINCT evidence_type FROM resolution_evidence')).toEqual([
      { evidence_type: 'USER_MUST_LINK' }
    ])
  })

  it('keeps a shared-phone mention unassigned when a USER CANNOT_LINK constraint applies', async () => {
    const { documentId, matterId } = seedParsedDocument(['Call 13800138000 today.'])
    const first = seedEntity(matterId, 'PERSON', 'Synthetic First')
    const second = seedEntity(matterId, 'PERSON', 'Synthetic Second')
    const phoneId = seedProtectedValue(matterId, 'PHONE', 'PHONE', '13800138000')
    linkEntityProtectedValue(matterId, first.id, phoneId)
    linkEntityProtectedValue(matterId, second.id, phoneId)
    await runDetection(documentId, detectorFor([{ type: 'PHONE', text: '13800138000' }]))
    const service = makeService()
    service.addConstraint(matterId, first.id, second.id, 'CANNOT_LINK', 'Synthetic user conflict')

    const result = await service.resolve(documentId)

    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'UNRESOLVED' }])
    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_events WHERE mention_id IS NOT NULL')).toEqual([
      { count: 0 }
    ])
    expect(query('SELECT DISTINCT evidence_type FROM resolution_evidence')).toEqual([
      { evidence_type: 'USER_CANNOT_LINK' }
    ])
  })

  it('matches an auto-created Entity through its name ProtectedValue fingerprint on repeated names', async () => {
    // Document A creates the Entity from an EXPLICIT PERSON mention.
    const documentA = seedParsedDocument(['张三 signed the first agreement.'], 'document-a')
    await runDetection(documentA.documentId, detectorFor([{ type: 'PERSON', text: '张三' }]))
    const service = makeService()
    const resultA = await service.resolve(documentA.documentId)
    expect(resultA.decisions[0]!.decision).toBe('NEW_ENTITY')
    const entityId = resultA.decisions[0]!.candidateEntityId!
    const aliasRows = query('SELECT alias FROM entity_aliases WHERE entity_id = ?', entityId) as Array<{
      alias: string
    }>
    expect(aliasRows).toHaveLength(1)
    expect(aliasRows[0]!.alias).not.toContain('张三')

    // Document B: the synthetic alias cannot match the real name, but the
    // name-type ProtectedValue fingerprint does.
    const documentB = seedParsedDocument(['张三 appeared again.'], 'document-b', documentA.matterId)
    await runDetection(documentB.documentId, detectorFor([{ type: 'PERSON', text: '张三' }]))
    const resultB = await service.resolve(documentB.documentId)
    const mentionB = (query('SELECT id FROM mentions WHERE document_id = ?', documentB.documentId) as Array<{ id: string }>)[0]!.id
    // The repeated name matches the existing Entity through its name ProtectedValue
    // fingerprint, so it goes to REVIEW — never to a duplicate NEW_ENTITY.
    expect(resultB.decisions[0]!.decision).toBe('REVIEW')
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', documentA.matterId)).toEqual([
      { count: 1 }
    ])
    expect(
      query('SELECT candidate_entity_id FROM resolution_candidates WHERE mention_id = ?', mentionB)
    ).toEqual([{ candidate_entity_id: entityId }])
    expect(
      query(
        'SELECT evidence_type FROM resolution_evidence WHERE candidate_id IN (SELECT id FROM resolution_candidates WHERE mention_id = ?)',
        mentionB
      )
    ).toEqual([{ evidence_type: 'NAME_EXACT' }])
    // The fingerprint-deduped ProtectedValue is shared, never duplicated.
    expect(query("SELECT COUNT(*) AS count FROM protected_values WHERE value_type = 'PERSON_NAME'")).toEqual([
      { count: 1 }
    ])

    // The user assigns Document B's Mention to the pre-existing Entity.
    expect(service.assign(mentionB, entityId).entityId).toBe(entityId)

    // Document C still resolves against the same Entity rather than losing it.
    const documentC = seedParsedDocument(['张三 returned once more.'], 'document-c', documentA.matterId)
    await runDetection(documentC.documentId, detectorFor([{ type: 'PERSON', text: '张三' }]))
    const resultC = await service.resolve(documentC.documentId)
    const mentionC = (query('SELECT id FROM mentions WHERE document_id = ?', documentC.documentId) as Array<{ id: string }>)[0]!.id
    expect(resultC.decisions[0]!.decision).toBe('REVIEW')
    const candidateEntityIds = (
      query('SELECT candidate_entity_id FROM resolution_candidates WHERE mention_id = ?', mentionC) as Array<{
        candidate_entity_id: string
      }>
    ).map((row) => row.candidate_entity_id)
    expect(candidateEntityIds).toContain(entityId)
    expect(query("SELECT COUNT(*) AS count FROM protected_values WHERE value_type = 'PERSON_NAME'")).toEqual([
      { count: 1 }
    ])
    // Three documents with the same name still resolve against exactly one Entity.
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', documentA.matterId)).toEqual([
      { count: 1 }
    ])
  })

  it('closes review candidates when the user assigns the Mention', async () => {
    const { documentId, matterId } = seedParsedDocument(['Holder 110101199003077774 signed.'])
    const first = seedEntity(matterId, 'PERSON', 'Synthetic First')
    const second = seedEntity(matterId, 'PERSON', 'Synthetic Second')
    const protectedValueId = seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774')
    linkEntityProtectedValue(matterId, first.id, protectedValueId)
    linkEntityProtectedValue(matterId, second.id, protectedValueId)
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))
    const service = makeService()

    const result = await service.resolve(documentId)
    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'REVIEW', candidateEntityId: expect.any(String) }])
    const mentionId = result.decisions[0]!.mentionId
    const pendingRows = query(
      'SELECT candidate_entity_id, state, resolved_at FROM resolution_candidates WHERE mention_id = ?',
      mentionId
    ) as Array<{ candidate_entity_id: string; state: string; resolved_at: number | null }>
    expect(pendingRows).toHaveLength(2)
    expect(pendingRows.every((row) => row.state === 'PENDING' && row.resolved_at === null)).toBe(true)

    expect(service.assign(mentionId, first.id).entityId).toBe(first.id)

    const closedRows = query(
      'SELECT candidate_entity_id, state, resolved_at FROM resolution_candidates WHERE mention_id = ?',
      mentionId
    ) as Array<{ candidate_entity_id: string; state: string; resolved_at: number | null }>
    const byEntity = new Map(closedRows.map((row) => [row.candidate_entity_id, row]))
    expect(byEntity.get(first.id)).toMatchObject({ state: 'ACCEPTED' })
    expect(byEntity.get(second.id)).toMatchObject({ state: 'REJECTED' })
    expect(byEntity.get(first.id)!.resolved_at).not.toBeNull()
    expect(byEntity.get(second.id)!.resolved_at).not.toBeNull()
  })

  it('leaves an invalid identifier mention unresolved without a ProtectedValue or fingerprint', async () => {
    const { documentId } = seedParsedDocument(['ID 123 listed.'])
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '123' }]))

    const result = await makeService().resolve(documentId)

    expect(result.document.parseStatus).toBe('READY')
    expect(result.decisions).toEqual([{ mentionId: expect.any(String), decision: 'UNRESOLVED' }])
    expect(query('SELECT COUNT(*) AS count FROM protected_values')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 0 }])
    expect(query('SELECT COUNT(*) AS count FROM resolution_candidates')).toEqual([{ count: 0 }])
    expect(
      query('SELECT entity_id, protected_value_id, fingerprint FROM mentions WHERE document_id = ?', documentId)
    ).toEqual([{ entity_id: null, protected_value_id: null, fingerprint: null }])
  })

  it('runs the real native PDF worker through PDF -> Block -> Mention -> AUTO_LINK', async () => {
    const idNumber = '110101199003077774'
    const matterId = createMatter('Synthetic E2E Matter')
    const entity = seedEntity(matterId, 'PERSON', 'Synthetic E2E Holder')
    const protectedValueId = seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', idNumber)
    linkEntityProtectedValue(matterId, entity.id, protectedValueId)
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-resolution-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf(`Holder ${idNumber} signed`))
    const imported = await new DocumentImportService(documents, new MatterRepository(db), { persistenceKey }, now).importFromPath(matterId, sourcePath)
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)

    await new DocumentProcessingService(documents, processor, { persistenceKey }, now).process(imported.id)
    await new PrivacyDetectionService(detection, { persistenceKey }, undefined, now, generateId).detect(imported.id)
    const result = await makeService().resolve(imported.id)

    expect(result.document).toMatchObject({ parseStatus: 'READY', parserType: 'NATIVE_PDF', pageCount: 1 })
    expect(result.decisions).toEqual([
      { mentionId: expect.any(String), decision: 'AUTO_LINK', candidateEntityId: entity.id }
    ])
    expect(query('SELECT mention_type, entity_id FROM mentions WHERE document_id = ?', imported.id)).toEqual([
      { mention_type: 'ID_CARD', entity_id: entity.id }
    ])
  })

  it('runs a Chinese contract PDF to automatic parties and labeled value ownership', async () => {
    const contractLine =
      '出租方：湖北众创科技孵化园有限公司 授权代表：喻越 身份证号：421022199406233911 手机：18923414607'
    const matterId = createMatter('Chinese Contract E2E Matter')
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-chinese-contract-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'contract.pdf')
    await writeFile(sourcePath, syntheticChinesePdf(contractLine))
    const imported = await new DocumentImportService(documents, new MatterRepository(db), { persistenceKey }, now).importFromPath(matterId, sourcePath)
    const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
    const processor = new PythonWorkerDocumentProcessor(
      'NATIVE_PDF',
      new PythonWorkerClient({
        command: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3',
        args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
      })
    )
    processors.push(processor)

    await new DocumentProcessingService(documents, processor, { persistenceKey }, now).process(imported.id)
    await new PrivacyDetectionService(detection, { persistenceKey }, undefined, now, generateId).detect(imported.id)
    await makeService().resolve(imported.id)

    const mentionRows = query(
      'SELECT mention_type, entity_id FROM mentions WHERE document_id = ? ORDER BY start_offset',
      imported.id
    ) as Array<{ mention_type: MentionType; entity_id: string | null }>
    expect(mentionRows.map((mention) => mention.mention_type)).toEqual(['ORGANIZATION', 'PERSON', 'ID_CARD', 'PHONE'])
    expect(mentionRows[0]!.entity_id).not.toBe(mentionRows[1]!.entity_id)
    expect(mentionRows[2]!.entity_id).toBe(mentionRows[1]!.entity_id)
    expect(mentionRows[3]!.entity_id).toBe(mentionRows[1]!.entity_id)
    expect(query('SELECT COUNT(*) AS count FROM entities WHERE matter_id = ?', matterId)).toEqual([{ count: 2 }])

    const sanitized = await new PseudonymizationService(
      new SanitizationRepository(db),
      keys,
      now,
      generateId
    ).sanitize(imported.id)
    const sanitizedRow = query(
      'SELECT id, text_cipher FROM sanitized_blocks WHERE sanitized_document_id = ?',
      sanitized.sanitizedDocument.id
    ) as Array<{ id: string; text_cipher: Buffer }>
    const sanitizedText = decrypt(
      sanitizedRow[0]!.text_cipher,
      persistenceKey,
      sanitizedBlockTextContext(sanitizedRow[0]!.id)
    ).toString()
    for (const plaintext of ['湖北众创科技孵化园有限公司', '喻越', '421022199406233911', '18923414607']) {
      expect(sanitizedText).not.toContain(plaintext)
    }
    expect(sanitizedText.match(/〔@[A-Z]-[A-Z0-9]+〕/g)).toHaveLength(4)
  })
})
