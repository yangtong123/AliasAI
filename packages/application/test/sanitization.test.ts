import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt, deriveMatterSearchKey, encrypt, fingerprintNormalizedValue, generateProtectedValueToken, generatePublicToken } from '@aliasai/crypto'
import type { Entity, EntityType, MentionStrength, MentionType, ProtectedValueType } from '@aliasai/domain'
import type { MentionProposal, PrivacyDetector } from '@aliasai/privacy-detection'
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
  RehydrationService,
  documentBlockTextContext,
  protectedValueContext,
  sanitizedBlockTextContext,
  type ApplicationKeys
} from '../src/index'

function syntheticPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\)').replaceAll('(', '\\(')
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

describe('PseudonymizationService and RehydrationService', () => {
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
  let sanitization: SanitizationRepository
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
    sanitization = new SanitizationRepository(db)
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

  function makeResolution(): EntityResolutionService {
    return new EntityResolutionService(resolution, protectedValues, entities, keys, now, generateId)
  }

  function makeSanitizer(): PseudonymizationService {
    return new PseudonymizationService(sanitization, keys, now, generateId)
  }

  function makeRehydration(): RehydrationService {
    return new RehydrationService(sanitization, keys)
  }

  function seedEntity(matterId: string, type: EntityType, primaryAlias: string): Entity {
    const createdAt = now()
    const entity: Entity = {
      id: generateId(),
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
      publicToken: generateProtectedValueToken(type),
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

  function sanitizedBlockTexts(sanitizedDocumentId: string): string[] {
    const rows = query(
      'SELECT id, text_cipher FROM sanitized_blocks WHERE sanitized_document_id = ? ORDER BY rowid',
      sanitizedDocumentId
    ) as Array<{ id: string; text_cipher: Buffer }>
    return rows.map((row) => decrypt(row.text_cipher, persistenceKey, sanitizedBlockTextContext(row.id)).toString())
  }

  it('sanitizes a fully resolved Document into an encrypted artifact and a pseudonym-only vault', async () => {
    const { documentId, matterId } = seedParsedDocument(['Synthetic Name presented 110101199003077774.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774'))
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: 'Synthetic Name' },
        { type: 'ID_CARD', text: '110101199003077774' }
      ])
    )
    await makeResolution().resolve(documentId)

    const result = await makeSanitizer().sanitize(documentId)

    expect(result.reused).toBe(false)
    expect(result.document.parseStatus).toBe('SANITIZED')
    expect(result.job).toMatchObject({ type: 'SANITIZE', status: 'COMPLETED', progress: 1 })
    const sanitizedTexts = sanitizedBlockTexts(result.sanitizedDocument.id)
    expect(sanitizedTexts).toHaveLength(1)
    const sanitized = sanitizedTexts[0]!
    // Leak verification: no Mention plaintext, no ProtectedValue plaintext, no key material.
    expect(sanitized).not.toContain('Synthetic Name')
    expect(sanitized).not.toContain('110101199003077774')
    expect(sanitized).not.toContain(persistenceKey.toString('hex'))
    expect(sanitized).not.toContain(persistenceKey.toString('base64'))
    expect(sanitized).not.toContain(searchKey.toString('hex'))
    // Every Mention was replaced by an Alias〔@Token〕 span.
    expect(sanitized.match(/〔@[A-Z]-[A-Z0-9]+〕/g)).toHaveLength(2)
    // The Mapping Vault stores pseudonym metadata only.
    const mappings = query(
      'SELECT public_token, alias, restore_policy FROM sanitization_mappings WHERE sanitized_document_id = ? ORDER BY rowid',
      result.sanitizedDocument.id
    ) as Array<{ public_token: string; alias: string; restore_policy: string }>
    expect(mappings).toHaveLength(2)
    for (const mapping of mappings) {
      expect(sanitized).toContain(`${mapping.alias}〔${mapping.public_token}〕`)
    }
    expect(mappings.map((row) => row.restore_policy).sort()).toEqual(['ALWAYS_RESTORE', 'RESTORE_ON_REQUEST'])
    expect(JSON.stringify(mappings)).not.toContain('Synthetic Name')
    expect(JSON.stringify(mappings)).not.toContain('110101199003077774')
  })

  it('sanitizes an Entity-less identifier with a value-level restoration token', async () => {
    const { documentId } = seedParsedDocument(['Holder 110101199003077774 signed.'])
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))
    await makeResolution().resolve(documentId)

    expect(query('SELECT entity_id FROM mentions WHERE document_id = ?', documentId)).toEqual([{ entity_id: null }])
    expect(query('SELECT COUNT(*) AS count FROM entities')).toEqual([{ count: 0 }])

    const result = await makeSanitizer().sanitize(documentId)
    expect(result.document.parseStatus).toBe('SANITIZED')
    const sanitized = sanitizedBlockTexts(result.sanitizedDocument.id)[0]!
    expect(sanitized).not.toContain('110101199003077774')
    expect(sanitized).toContain('身份证号〔@I-')
    const mappings = query(
      'SELECT entity_id, alias, public_token FROM sanitization_mappings WHERE sanitized_document_id = ?',
      result.sanitizedDocument.id
    ) as Array<{ entity_id: string | null; alias: string; public_token: string }>
    expect(mappings).toHaveLength(1)
    expect(mappings[0]).toMatchObject({ entity_id: null, alias: '身份证号' })

    expect(
      makeRehydration().rehydrate({ sanitizedDocumentId: result.sanitizedDocument.id, text: sanitized }).text
    ).toBe(sanitized)
    expect(
      makeRehydration().rehydrate({
        sanitizedDocumentId: result.sanitizedDocument.id,
        text: sanitized,
        includeRestoreOnRequest: true
      }).text
    ).toContain('110101199003077774')
  })

  it('restores every alias form backed by one shared restoration token', async () => {
    const sourceText = 'Holder 110101199003077774 and again 110101199003077774.'
    const { documentId, matterId } = seedParsedDocument([sourceText])
    await runDetection(documentId, {
      detect(block) {
        const value = '110101199003077774'
        const first = block.text.indexOf(value)
        const second = block.text.indexOf(value, first + 1)
        return [first, second]
          .filter((offset) => offset >= 0)
          .map((offset) => ({
            matterId: block.matterId,
            documentId: block.documentId,
            pageId: block.pageId,
            blockId: block.blockId,
            type: 'ID_CARD' as const,
            strength: 'EXPLICIT' as const,
            startOffset: offset,
            endOffset: offset + value.length,
            detector: 'REGEX' as const,
            confidence: 1
          }))
      }
    })
    await makeResolution().resolve(documentId)
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    const mentionIds = query(
      'SELECT id FROM mentions WHERE document_id = ? ORDER BY start_offset',
      documentId
    ) as Array<{ id: string }>
    expect(mentionIds).toHaveLength(2)
    makeResolution().assign(mentionIds[0]!.id, holder.id)

    const result = await makeSanitizer().sanitize(documentId)
    const sanitized = sanitizedBlockTexts(result.sanitizedDocument.id)[0]!
    // One value, two mappings: an Entity-backed alias and a value-level alias
    // share the same restoration token.
    expect(sanitized).toContain('Holder One〔@I-')
    expect(sanitized).toContain('身份证号〔@I-')

    const rehydrated = makeRehydration().rehydrate({
      sanitizedDocumentId: result.sanitizedDocument.id,
      text: sanitized,
      includeRestoreOnRequest: true
    })
    expect(rehydrated.text).toBe(sourceText)
    expect(rehydrated.unresolvedTokens).toEqual([])
  })

  it('is idempotent after completion', async () => {
    const { documentId, matterId } = seedParsedDocument(['Holder 110101199003077774 signed.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774'))
    await runDetection(documentId, detectorFor([{ type: 'ID_CARD', text: '110101199003077774' }]))
    await makeResolution().resolve(documentId)

    const service = makeSanitizer()
    const first = await service.sanitize(documentId)
    const second = await service.sanitize(documentId)

    expect(second.reused).toBe(true)
    expect(second.sanitizedDocument.id).toBe(first.sanitizedDocument.id)
    expect(query('SELECT COUNT(*) AS count FROM sanitized_documents')).toEqual([{ count: 1 }])
    expect(
      query("SELECT COUNT(*) AS count FROM processing_jobs WHERE document_id = ? AND job_type = 'SANITIZE'", documentId)
    ).toEqual([{ count: 1 }])
  })

  it('honors restore policies and reports unknown or tampered tokens for review', async () => {
    const { documentId, matterId } = seedParsedDocument(['Reach Synthetic Name via synthetic@example.test.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: 'Synthetic Name' },
        { type: 'EMAIL', text: 'synthetic@example.test' }
      ])
    )
    await makeResolution().resolve(documentId)
    // PERSON auto-created its Entity; the EMAIL mention stays unresolved until the user assigns it.
    const emailMention = (
      query(
        "SELECT id FROM mentions WHERE document_id = ? AND mention_type = 'EMAIL'",
        documentId
      ) as Array<{ id: string }>
    )[0]!.id
    makeResolution().assign(emailMention, holder.id)
    const sanitized = await makeSanitizer().sanitize(documentId)
    const sanitizedText = sanitizedBlockTexts(sanitized.sanitizedDocument.id)[0]!
    expect(sanitizedText).not.toContain('synthetic@example.test')
    // The EMAIL restoration anchor is its ProtectedValue token, not the Entity token.
    const emailToken = sanitizedText.match(/〔(@E-[A-Z0-9]+)〕/)![1]!

    const rehydration = makeRehydration()
    const aiResult = `经核实,${sanitizedText.replace('Reach ', '').replace('via ', '联系方式 ')} 另见 @P-UNK0WN 与 Tampered〔${emailToken}〕。`

    const strict = rehydration.rehydrate({ sanitizedDocumentId: sanitized.sanitizedDocument.id, text: aiResult })
    // PERSON_NAME restores by default; EMAIL is RESTORE_ON_REQUEST and stays withheld.
    expect(strict.text).toContain('Synthetic Name')
    expect(strict.text).not.toContain('synthetic@example.test')
    expect(strict.unresolvedTokens).toContain('@P-UNK0WN')
    expect(strict.unresolvedTokens).toContain(emailToken)

    const onRequest = rehydration.rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: aiResult,
      includeRestoreOnRequest: true
    })
    expect(onRequest.text).toContain('synthetic@example.test')
    // The tampered alias span and the unknown token remain verbatim and reported.
    expect(onRequest.text).toContain(`Tampered〔${emailToken}〕`)
    expect(onRequest.text).toContain('@P-UNK0WN')
    expect(onRequest.unresolvedTokens).toEqual(['@P-UNK0WN', emailToken].sort())
  })

  it('loads entity aliases once per entity during a single rehydration', async () => {
    const { documentId, matterId } = seedParsedDocument(['Reach Synthetic Name via synthetic@example.test.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: 'Synthetic Name' },
        { type: 'EMAIL', text: 'synthetic@example.test' }
      ])
    )
    await makeResolution().resolve(documentId)
    // Both mentions resolve to the same Entity, producing two mappings that
    // must not trigger two alias lookups.
    for (const row of query(
      "SELECT id FROM mentions WHERE document_id = ? AND mention_type IN ('PERSON', 'EMAIL')",
      documentId
    ) as Array<{ id: string }>) {
      makeResolution().assign(row.id, holder.id)
    }
    const sanitized = await makeSanitizer().sanitize(documentId)

    const aliasesSpy = vi.spyOn(sanitization, 'findEntityAliases')
    makeRehydration().rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: sanitizedBlockTexts(sanitized.sanitizedDocument.id).join('\n'),
      includeRestoreOnRequest: true
    })
    expect(aliasesSpy).toHaveBeenCalledTimes(1)
    expect(aliasesSpy).toHaveBeenCalledWith(matterId, holder.id)
  })

  it('never restores NEVER_RESTORE values even on request', async () => {
    const { documentId, matterId } = seedParsedDocument(['Account 6222020200112233445 on file.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    await runDetection(documentId, detectorFor([{ type: 'BANK_ACCOUNT', text: '6222020200112233445' }]))
    await makeResolution().resolve(documentId)
    const mentionId = (query('SELECT id FROM mentions WHERE document_id = ?', documentId) as Array<{ id: string }>)[0]!.id
    makeResolution().assign(mentionId, holder.id)
    const sanitized = await makeSanitizer().sanitize(documentId)
    const sanitizedText = sanitizedBlockTexts(sanitized.sanitizedDocument.id)[0]!
    expect(sanitizedText).not.toContain('6222020200112233445')
    const bankToken = sanitizedText.match(/〔(@B-[A-Z0-9]+)〕/)![1]!

    const restored = makeRehydration().rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: `打款账户:${sanitizedText}`,
      includeRestoreOnRequest: true
    })
    expect(restored.text).not.toContain('6222020200112233445')
    expect(restored.unresolvedTokens).toEqual([bankToken])
  })

  it('reports only withheld tokens that the AI text actually references', async () => {
    const { documentId, matterId } = seedParsedDocument(['Account 6222020200112233445 on file.'])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    await runDetection(documentId, detectorFor([{ type: 'BANK_ACCOUNT', text: '6222020200112233445' }]))
    await makeResolution().resolve(documentId)
    const mentionId = (query('SELECT id FROM mentions WHERE document_id = ?', documentId) as Array<{ id: string }>)[0]!.id
    makeResolution().assign(mentionId, holder.id)
    const sanitized = await makeSanitizer().sanitize(documentId)

    // The AI response never echoes the withheld bank token.
    const restored = makeRehydration().rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: 'No protected value was referenced.',
      includeRestoreOnRequest: true
    })
    expect(restored.text).toBe('No protected value was referenced.')
    expect(restored.unresolvedTokens).toEqual([])
  })

  it('uses a distinct restoration token per ProtectedValue of the same Entity', async () => {
    const { documentId, matterId } = seedParsedDocument([
      'Synthetic Name 110101199003077774 synthetic@example.test 6222020200112233445.'
    ])
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'PERSON_NAME', 'PERSON', 'Synthetic Name'))
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774'))
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'EMAIL', 'EMAIL', 'synthetic@example.test'))
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'BANK_ACCOUNT', 'BANK_ACCOUNT', '6222020200112233445'))
    await runDetection(
      documentId,
      detectorFor([
        { type: 'PERSON', text: 'Synthetic Name' },
        { type: 'ID_CARD', text: '110101199003077774' },
        { type: 'EMAIL', text: 'synthetic@example.test' },
        { type: 'BANK_ACCOUNT', text: '6222020200112233445' }
      ])
    )
    await makeResolution().resolve(documentId)
    // Auto-linking only assigns the ID_CARD; assign the remaining Mentions to the
    // same Entity so one Entity carries all four value types.
    for (const { id } of query(
      'SELECT id FROM mentions WHERE document_id = ? AND entity_id IS NULL',
      documentId
    ) as Array<{ id: string }>) {
      makeResolution().assign(id, holder.id)
    }

    const sanitized = await makeSanitizer().sanitize(documentId)
    const sanitizedText = sanitizedBlockTexts(sanitized.sanitizedDocument.id)[0]!

    // One Entity, four value types, four distinct restoration tokens.
    const tokens = [...sanitizedText.matchAll(/〔(@[A-Z]-[A-Z0-9]+)〕/g)].map((match) => match[1]!)
    expect(tokens).toHaveLength(4)
    expect(new Set(tokens).size).toBe(4)
    expect(tokens.map((token) => token.slice(0, 3)).sort()).toEqual(['@B-', '@E-', '@I-', '@N-'])
    for (const plaintext of ['Synthetic Name', '110101199003077774', 'synthetic@example.test', '6222020200112233445']) {
      expect(sanitizedText).not.toContain(plaintext)
    }

    // Each token restores its own value under its own policy.
    const onRequest = makeRehydration().rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: sanitizedText,
      includeRestoreOnRequest: true
    })
    expect(onRequest.text).toContain('Synthetic Name')
    expect(onRequest.text).toContain('110101199003077774')
    expect(onRequest.text).toContain('synthetic@example.test')
    expect(onRequest.text).not.toContain('6222020200112233445')
  })

  it('fails closed with UNSUPPORTED_MENTION_TYPE for metadata Mentions', async () => {
    const { documentId } = seedParsedDocument(['北京市朝阳区人民法院 heard the case.'])
    await runDetection(documentId, detectorFor([{ type: 'COURT', text: '北京市朝阳区人民法院' }]))
    await makeResolution().resolve(documentId)

    await expect(makeSanitizer().sanitize(documentId)).rejects.toMatchObject({ code: 'UNSUPPORTED_MENTION_TYPE' })
  })

  it('runs the full chain: PDF -> Block -> Mention -> Entity -> Sanitized Document -> Rehydrated Text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-sanitize-e2e-'))
    directories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, syntheticPdf('Holder 110101199003077774 signed'))
    const matterId = createMatter('Synthetic E2E Matter')
    const holder = seedEntity(matterId, 'PERSON', 'Holder One')
    linkEntityProtectedValue(matterId, holder.id, seedProtectedValue(matterId, 'ID_CARD', 'ID_CARD', '110101199003077774'))

    const imported = await new DocumentImportService(documents, { persistenceKey }, now).importFromPath(matterId, sourcePath)
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
    // The real regex detector finds the checksum-valid ID number.
    await new PrivacyDetectionService(detection, { persistenceKey }, undefined, now, generateId).detect(imported.id)
    await makeResolution().resolve(imported.id)

    const sanitized = await makeSanitizer().sanitize(imported.id)
    expect(sanitized.document.parseStatus).toBe('SANITIZED')
    const sanitizedText = sanitizedBlockTexts(sanitized.sanitizedDocument.id)[0]!
    expect(sanitizedText).not.toContain('110101199003077774')
    expect(sanitizedText).toContain('Holder One〔@I-')
    const idToken = sanitizedText.match(/〔(@I-[A-Z0-9]+)〕/)![1]!

    const restored = makeRehydration().rehydrate({
      sanitizedDocumentId: sanitized.sanitizedDocument.id,
      text: `经审查,${sanitizedText}的证件有效。`,
      includeRestoreOnRequest: true
    })
    expect(restored.text).toContain('110101199003077774')
    expect(restored.text).not.toContain(idToken)
    expect(restored.unresolvedTokens).toEqual([])
  })
})
