import { beforeEach, describe, expect, it } from 'vitest'
import { encrypt, generateProtectedValueToken } from '@aliasai/crypto'
import {
  DocumentRepository,
  EntityRepository,
  MatterRepository,
  PrivacyDetectionRepository,
  ProtectedValueRepository,
  ReviewQueryRepository,
  SanitizationRepository,
  migrateDatabase,
  openDatabase,
  type AliasAiDatabase,
  type SqliteClient
} from '@aliasai/database'
import {
  MatterService,
  PseudonymizationService,
  RehydrationService,
  SanitizedPreviewService,
  documentBlockTextContext,
  documentOriginalNameContext,
  mentionTextContext,
  protectedValueContext,
  type ApplicationKeys
} from '../src/index'

describe('SanitizedPreviewService', () => {
  const persistenceKey = Buffer.alloc(32, 9)
  const searchKey = Buffer.alloc(32, 7)
  const keys: ApplicationKeys = { persistenceKey, searchKey }
  let sqlite: SqliteClient
  let db: AliasAiDatabase
  let preview: SanitizedPreviewService

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
    preview = new SanitizedPreviewService(
      new DocumentRepository(db),
      new ReviewQueryRepository(db),
      new SanitizationRepository(db),
      new PseudonymizationService(new SanitizationRepository(db), keys),
      new RehydrationService(new SanitizationRepository(db), keys),
      keys
    )
  })

  it('reports NOT_READY for a document that has not reached resolution', () => {
    new MatterService(new MatterRepository(db), { persistenceKey }).create('Synthetic Matter')
    sqlite.prepare("UPDATE matters SET id = 'matter-1' WHERE rowid = 1").run()
    new DocumentRepository(db).create({
      id: 'document-1',
      matterId: 'matter-1',
      originalNameCipher: encrypt(Buffer.from('synthetic.pdf'), persistenceKey, documentOriginalNameContext('document-1')),
      fileHash: 'hash-1',
      mimeType: 'application/pdf',
      parseStatus: 'PARSED',
      createdAt: 1,
      updatedAt: 1
    })

    expect(preview.getPreview('document-1')).toEqual({ status: 'NOT_READY', parseStatus: 'PARSED' })
  })

  it('lists blockers matching the sanitize fail-closed predicates', () => {
    seedReadyDocument({ assignEmail: false, assignPhone: true, phoneHasToken: false })

    const result = preview.getPreview('document-1')
    expect(result.status).toBe('READY')
    if (result.status !== 'READY') return
    expect(result.blockers).toEqual([
      { mentionId: 'mention-1', reason: 'MISSING_TOKEN' },
      { mentionId: 'mention-2', reason: 'MISSING_TOKEN' }
    ])
  })

  it('generates the preview without exposing Mapping Vault rows and supports local rehydration', async () => {
    seedReadyDocument({ assignEmail: true, assignPhone: true, phoneHasToken: true })

    expect(preview.getPreview('document-1')).toEqual({ status: 'READY', blockers: [] })

    const generated = await preview.generatePreview('document-1')
    expect(generated.status).toBe('AVAILABLE')
    if (generated.status !== 'AVAILABLE') return

    const sanitized = generated.blocks[0]!.text
    expect(sanitized).not.toContain('synthetic@example.test')
    expect(sanitized).not.toContain('13800138000')
    expect(sanitized.match(/〔@[NET]-[A-Z0-9]+〕/g)).toHaveLength(2)
    expect('mappings' in generated).toBe(false)
    expect(JSON.stringify(generated)).not.toContain('synthetic@example.test')
    const exported = preview.getSanitizedText('document-1', generated.sanitizedDocumentId)
    expect(exported).toBe(sanitized)
    expect(exported).not.toContain('synthetic@example.test')
    expect(() => preview.getSanitizedText('document-1', 'sanitized-other')).toThrowError(
      expect.objectContaining({ code: 'SANITIZED_DOCUMENT_NOT_AVAILABLE' })
    )

    // Rehydration demo: restored on request, withheld by default.
    const aiEcho = `联系方式:${sanitized}`
    const withheld = preview.rehydrateDemo({ sanitizedDocumentId: generated.sanitizedDocumentId, text: aiEcho })
    expect(withheld.text).not.toContain('synthetic@example.test')
    const restored = preview.rehydrateDemo({
      sanitizedDocumentId: generated.sanitizedDocumentId,
      text: aiEcho,
      includeRestoreOnRequest: true
    })
    expect(restored.text).toContain('synthetic@example.test')
    expect(restored.text).toContain('13800138000')
    expect(restored.unresolvedTokens).toEqual([])
  })

  it('reports a tampered token as unresolved in the demo', async () => {
    seedReadyDocument({ assignEmail: true, assignPhone: true, phoneHasToken: true })
    const generated = await preview.generatePreview('document-1')
    if (generated.status !== 'AVAILABLE') throw new Error('preview should be available')

    const result = preview.rehydrateDemo({
      sanitizedDocumentId: generated.sanitizedDocumentId,
      text: '另见 @N-0000000000000000。',
      includeRestoreOnRequest: true
    })

    expect(result.text).toContain('@N-0000000000000000')
    expect(result.unresolvedTokens).toEqual(['@N-0000000000000000'])
  })

  /**
   * A READY document whose email mention (mention-1) and phone mention
   * (mention-2) resolve per the flags: the email gets an entity with alias and
   * token, the phone optionally stays tokenless to exercise the blockers.
   */
  function seedReadyDocument(input: { assignEmail: boolean; assignPhone: boolean; phoneHasToken: boolean }): void {
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
          textCipher: encrypt(
            Buffer.from('Email synthetic@example.test or 13800138000.'),
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
          ['mention-1', 'EMAIL', 'synthetic@example.test', 6],
          ['mention-2', 'PHONE', '13800138000', 32]
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
    const protectedValues = new ProtectedValueRepository(db)
    const entityPayload = (entityId: string, alias: string, eventSuffix: string) => ({
      entity: {
        id: entityId,
        matterId: 'matter-1',
        type: 'PERSON' as const,
        publicToken: `@P-${entityId}`,
        status: 'ACTIVE' as const,
        createdAt: 9,
        updatedAt: 9
      },
      primaryAlias: {
        id: `alias-${eventSuffix}`,
        matterId: 'matter-1',
        entityId,
        alias,
        aliasType: 'PRIMARY' as const,
        isPrimary: true,
        createdAt: 9
      },
      event: {
        id: `event-${eventSuffix}`,
        matterId: 'matter-1',
        type: 'ENTITY_CREATED' as const,
        entityId,
        actor: 'USER' as const,
        payloadCipher: encrypt(Buffer.from('{}'), persistenceKey, Buffer.from(`event-${eventSuffix}:resolutionEvent.payload`)),
        createdAt: 9
      }
    })
    if (input.assignEmail) {
      entities.createWithPrimaryAliasAndEvent(entityPayload('entity-1', 'Holder One', '1'))
      protectedValues.create({
        id: 'protected-1',
        matterId: 'matter-1',
        type: 'EMAIL',
        valueCipher: encrypt(
          Buffer.from('synthetic@example.test'),
          persistenceKey,
          protectedValueContext('protected-1')
        ),
        fingerprint: Buffer.from('fingerprint-1'),
        publicToken: generateProtectedValueToken('EMAIL'),
        restorePolicy: 'RESTORE_ON_REQUEST',
        createdAt: 10
      })
      sqlite
        .prepare("UPDATE mentions SET entity_id = 'entity-1', protected_value_id = 'protected-1' WHERE id = 'mention-1'")
        .run()
    }
    if (input.assignPhone) {
      entities.createWithPrimaryAliasAndEvent(entityPayload('entity-2', 'Caller Two', '2'))
      if (input.phoneHasToken) {
        protectedValues.create({
          id: 'protected-2',
          matterId: 'matter-1',
          type: 'PHONE',
          valueCipher: encrypt(Buffer.from('13800138000'), persistenceKey, protectedValueContext('protected-2')),
          fingerprint: Buffer.from('fingerprint-2'),
          publicToken: generateProtectedValueToken('PHONE'),
          restorePolicy: 'RESTORE_ON_REQUEST',
          createdAt: 10
        })
        sqlite
          .prepare("UPDATE mentions SET entity_id = 'entity-2', protected_value_id = 'protected-2' WHERE id = 'mention-2'")
          .run()
      } else {
        sqlite.prepare("UPDATE mentions SET entity_id = 'entity-2' WHERE id = 'mention-2'").run()
      }
    }
    sqlite.prepare("UPDATE documents SET parse_status = 'READY', updated_at = 11 WHERE id = 'document-1'").run()
  }
})
