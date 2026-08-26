import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt } from '@aliasai/crypto'
import { DocumentRepository, EntityRepository, MatterRepository, migrateDatabase, openDatabase } from '@aliasai/database'
import { DocumentImportService, EntityService, MatterService, resolutionEventContext } from '../src/index'
import type { AliasAiDatabase, SqliteClient } from '@aliasai/database'

describe('application use cases', () => {
  const key = Buffer.alloc(32, 9)
  const temporaryDirectories: string[] = []
  let sqlite: SqliteClient
  let db: AliasAiDatabase

  beforeEach(() => {
    const connection = openDatabase(':memory:')
    sqlite = connection.sqlite
    db = connection.db
    migrateDatabase(db)
  })

  afterEach(async () => {
    sqlite.close()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('creates a Matter with its name encrypted before it reaches SQLite', () => {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, () => 1_725_000_000_000).create(
      'Synthetic Matter'
    )
    const row = sqlite.prepare('SELECT name_cipher FROM matters WHERE id = ?').get(matter.id) as { name_cipher: Buffer }

    expect(matter.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.name_cipher).not.toEqual(Buffer.from('Synthetic Matter'))
    expect(decrypt(row.name_cipher, key, Buffer.from(`${matter.id}:matter.name`)).toString('utf8')).toBe('Synthetic Matter')
  })

  it('imports a source by storing only encrypted local metadata', async () => {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, () => 1_725_000_000_000).create(
      'Synthetic Matter'
    )
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-application-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    await writeFile(sourcePath, 'synthetic source')

    const document = await new DocumentImportService(
      new DocumentRepository(db),
      new MatterRepository(db),
      { persistenceKey: key },
      () => 1_725_000_000_001
    ).importFromPath(matter.id, sourcePath)
    const row = sqlite
      .prepare('SELECT original_name_cipher, source_path_cipher FROM documents WHERE id = ?')
      .get(document.id) as { original_name_cipher: Buffer; source_path_cipher: Buffer }

    expect(document).toMatchObject({ matterId: matter.id, mimeType: 'application/pdf', parseStatus: 'IMPORTED' })
    expect(decrypt(row.original_name_cipher, key, Buffer.from(`${document.id}:document.originalName`)).toString()).toBe(
      'synthetic.pdf'
    )
    expect(decrypt(row.source_path_cipher, key, Buffer.from(`${document.id}:document.sourcePath`)).toString()).toBe(sourcePath)
  })

  it('reuses an existing Document when the same file is imported twice into one Matter', async () => {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, () => 1_725_000_000_000).create(
      'Synthetic Matter'
    )
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-application-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'duplicate.pdf')
    await writeFile(sourcePath, 'synthetic duplicate source')
    let timestamp = 1_725_000_000_001
    const imports = new DocumentImportService(new DocumentRepository(db), new MatterRepository(db), { persistenceKey: key }, () => timestamp++)

    const first = await imports.importFromPath(matter.id, sourcePath)
    const second = await imports.importFromPath(matter.id, sourcePath)

    expect(second).toEqual(first)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 })
  })

  it('creates a Matter-scoped Entity, primary alias, and encrypted audit event', () => {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, () => 1_725_000_000_000).create(
      'Synthetic Matter'
    )
    const created = new EntityService(new EntityRepository(db), { persistenceKey: key }, () => 1_725_000_000_010).create(
      matter.id,
      'PERSON',
      'Plaintiff A'
    )
    const event = sqlite
      .prepare('SELECT id, event_type, payload_cipher FROM resolution_events WHERE entity_id = ?')
      .get(created.entity.id) as { id: string; event_type: string; payload_cipher: Buffer }

    expect(created.entity).toMatchObject({ matterId: matter.id, type: 'PERSON', status: 'ACTIVE' })
    expect(created.entity.publicToken).toMatch(/^@P-[0-9A-F]{16}$/)
    expect(created.alias).toMatchObject({ entityId: created.entity.id, isPrimary: true, alias: 'Plaintiff A' })
    expect(event.event_type).toBe('ENTITY_CREATED')
    expect(decrypt(event.payload_cipher, key, resolutionEventContext(event.id)).toString()).toBe('{}')
  })

  it('rolls back Entity creation when its primary alias conflicts', () => {
    const matter = new MatterService(new MatterRepository(db), { persistenceKey: key }, () => 1_725_000_000_000).create(
      'Synthetic Matter'
    )
    const entities = new EntityService(new EntityRepository(db), { persistenceKey: key }, () => 1_725_000_000_010)
    entities.create(matter.id, 'PERSON', 'Plaintiff A')

    expect(() =>
      new EntityService(new EntityRepository(db), { persistenceKey: key }, () => 1_725_000_000_020).create(
        matter.id,
        'PERSON',
        'Plaintiff A'
      )
    ).toThrow(/UNIQUE constraint failed/)

    const counts = sqlite
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM entities) AS entities,
          (SELECT COUNT(*) FROM entity_aliases) AS aliases,
          (SELECT COUNT(*) FROM resolution_events) AS events`
      )
      .get() as { entities: number; aliases: number; events: number }
    expect(counts).toEqual({ entities: 1, aliases: 1, events: 1 })
  })
})
