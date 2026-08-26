import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase, openDatabase } from '../src/index'

const migrationsDirectory = fileURLToPath(new URL('../drizzle', import.meta.url))

describe('database migration upgrades', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  it('upgrades a 0003 database to the current schema without losing user data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-migration-upgrade-'))
    temporaryDirectories.push(directory)
    const oldMigrations = join(directory, 'migrations')
    const oldMeta = join(oldMigrations, 'meta')
    const databasePath = join(directory, 'aliasai.sqlite')
    await mkdir(oldMeta, { recursive: true })

    for (const migration of [
      '0000_supreme_quasar.sql',
      '0001_slippery_the_liberteens.sql',
      '0002_breezy_sauron.sql',
      '0003_condemned_shard.sql'
    ]) {
      await copyFile(join(migrationsDirectory, migration), join(oldMigrations, migration))
    }

    const journal = JSON.parse(
      await readFile(join(migrationsDirectory, 'meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number }> }
    await writeFile(
      join(oldMeta, '_journal.json'),
      `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 3) }, null, 2)}\n`
    )

    const legacy = openDatabase(databasePath)
    migrateDatabase(legacy.db, oldMigrations)
    legacy.sqlite
      .prepare(
        'INSERT INTO matters (id, name_cipher, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('matter-upgrade', Buffer.from('encrypted-name'), 'ACTIVE', 1, 1)
    legacy.sqlite
      .prepare(
        `INSERT INTO documents (
           id, matter_id, original_name_cipher, source_path_cipher, file_hash, mime_type,
           parser_type, page_count, parse_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'document-upgrade',
        'matter-upgrade',
        Buffer.from('encrypted-name'),
        Buffer.from('encrypted-path'),
        'hash-upgrade',
        'application/pdf',
        'NATIVE_PDF',
        2,
        'PARSED',
        10,
        10
      )
    legacy.sqlite.close()

    const upgraded = openDatabase(databasePath)
    try {
      migrateDatabase(upgraded.db)

      expect(
        upgraded.sqlite.prepare('SELECT id, status FROM matters WHERE id = ?').get('matter-upgrade')
      ).toEqual({ id: 'matter-upgrade', status: 'ACTIVE' })
      expect(
        upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_executions'").get()
      ).toEqual({ name: 'ai_executions' })
      expect(
        upgraded.sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()
      ).toEqual({ count: 8 })
      expect(
        (upgraded.sqlite.prepare("PRAGMA table_info('sanitization_mappings')").all() as Array<{ name: string; notnull: number }>)
          .find((column) => column.name === 'entity_id')
      ).toMatchObject({ name: 'entity_id', notnull: 0 })
    } finally {
      upgraded.sqlite.close()
    }
  })

  it('upgrades existing documents to the recoverable lifecycle without losing data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-migration-lifecycle-'))
    temporaryDirectories.push(directory)
    const oldMigrations = join(directory, 'migrations')
    const oldMeta = join(oldMigrations, 'meta')
    const databasePath = join(directory, 'aliasai.sqlite')
    await mkdir(oldMeta, { recursive: true })

    for (const migration of [
      '0000_supreme_quasar.sql',
      '0001_slippery_the_liberteens.sql',
      '0002_breezy_sauron.sql',
      '0003_condemned_shard.sql',
      '0004_fancy_timeslip.sql',
      '0005_smiling_diamondback.sql'
    ]) {
      await copyFile(join(migrationsDirectory, migration), join(oldMigrations, migration))
    }

    const journal = JSON.parse(
      await readFile(join(migrationsDirectory, 'meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number }> }
    await writeFile(
      join(oldMeta, '_journal.json'),
      `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 5) }, null, 2)}\n`
    )

    const legacy = openDatabase(databasePath)
    migrateDatabase(legacy.db, oldMigrations)
    legacy.sqlite
      .prepare('INSERT INTO matters (id, name_cipher, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('matter-lifecycle', Buffer.from('encrypted-name'), 'ACTIVE', 1, 1)
    legacy.sqlite
      .prepare(
        `INSERT INTO documents (
           id, matter_id, original_name_cipher, source_path_cipher, file_hash, mime_type,
           parser_type, page_count, parse_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'document-lifecycle',
        'matter-lifecycle',
        Buffer.from('encrypted-name'),
        Buffer.from('encrypted-path'),
        'hash-lifecycle',
        'application/pdf',
        'NATIVE_PDF',
        3,
        'PARSED',
        10,
        10
      )
    legacy.sqlite.close()

    const upgraded = openDatabase(databasePath)
    try {
      migrateDatabase(upgraded.db)

      // Every existing Document upgrades active (deleted_at NULL), preserving
      // its encrypted name/path, parse state, and file hash.
      const document = upgraded.sqlite
        .prepare(
          `SELECT original_name_cipher, source_path_cipher, file_hash, parse_status, page_count, deleted_at
           FROM documents WHERE id = 'document-lifecycle'`
        )
        .get() as Record<string, unknown>
      expect(document.deleted_at).toBeNull()
      expect(document.parse_status).toBe('PARSED')
      expect(document.page_count).toBe(3)
      expect(document.file_hash).toBe('hash-lifecycle')
      expect(document.original_name_cipher).toEqual(Buffer.from('encrypted-name'))
      expect(document.source_path_cipher).toEqual(Buffer.from('encrypted-path'))

      // A trashed Document with this hash no longer blocks a new active import.
      upgraded.sqlite
        .prepare('UPDATE documents SET deleted_at = 20 WHERE id = ?')
        .run('document-lifecycle')
      const insert = upgraded.sqlite.prepare(
        `INSERT INTO documents (
           id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      expect(() =>
        insert.run('document-active-duplicate', 'matter-lifecycle', Buffer.from('x'), 'hash-lifecycle', 'application/pdf', 'IMPORTED', 30, 30)
      ).not.toThrow()
      // But two active Documents with the same matter and hash remain impossible.
      expect(() =>
        insert.run('document-active-second', 'matter-lifecycle', Buffer.from('x'), 'hash-lifecycle', 'application/pdf', 'IMPORTED', 31, 31)
      ).toThrowError(/UNIQUE constraint failed/)

      // Workspace events are append-only.
      upgraded.sqlite
        .prepare(
          `INSERT INTO workspace_events (id, matter_id, event_type, actor, created_at)
           VALUES ('event-1', 'matter-lifecycle', 'MATTER_TRASHED', 'USER', 40)`
        )
        .run()
      expect(() =>
        upgraded.sqlite
          .prepare("UPDATE workspace_events SET event_type = 'MATTER_RESTORED' WHERE id = 'event-1'")
          .run()
      ).toThrowError(/append-only/)
      expect(() =>
        upgraded.sqlite.prepare("DELETE FROM workspace_events WHERE id = 'event-1'").run()
      ).toThrowError(/append-only/)
    } finally {
      upgraded.sqlite.close()
    }
  })

  it('upgrades to replacement lineage without losing audit history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-migration-lineage-'))
    temporaryDirectories.push(directory)
    const oldMigrations = join(directory, 'migrations')
    const oldMeta = join(oldMigrations, 'meta')
    const databasePath = join(directory, 'aliasai.sqlite')
    await mkdir(oldMeta, { recursive: true })

    for (const migration of [
      '0000_supreme_quasar.sql',
      '0001_slippery_the_liberteens.sql',
      '0002_breezy_sauron.sql',
      '0003_condemned_shard.sql',
      '0004_fancy_timeslip.sql',
      '0005_smiling_diamondback.sql',
      '0006_robust_drax.sql'
    ]) {
      await copyFile(join(migrationsDirectory, migration), join(oldMigrations, migration))
    }

    const journal = JSON.parse(
      await readFile(join(migrationsDirectory, 'meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number }> }
    await writeFile(
      join(oldMeta, '_journal.json'),
      `${JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }, null, 2)}\n`
    )

    const legacy = openDatabase(databasePath)
    migrateDatabase(legacy.db, oldMigrations)
    legacy.sqlite
      .prepare('INSERT INTO matters (id, name_cipher, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('matter-lineage', Buffer.from('encrypted-name'), 'ACTIVE', 1, 1)
    legacy.sqlite
      .prepare(
        `INSERT INTO documents (
           id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('document-old', 'matter-lineage', Buffer.from('x'), 'hash-old', 'application/pdf', 'IMPORTED', 10, 10)
    legacy.sqlite
      .prepare(
        `INSERT INTO workspace_events (id, matter_id, event_type, actor, created_at)
         VALUES ('event-legacy', 'matter-lineage', 'MATTER_TRASHED', 'USER', 10)`
      )
      .run()
    legacy.sqlite
      .prepare(
        `INSERT INTO workspace_events (id, matter_id, document_id, event_type, actor, created_at)
         VALUES ('event-legacy-doc', 'matter-lineage', 'document-old', 'DOCUMENT_TRASHED', 'USER', 11)`
      )
      .run()
    legacy.sqlite.close()

    const upgraded = openDatabase(databasePath)
    try {
      migrateDatabase(upgraded.db)

      // Existing Documents upgrade without lineage; legacy audit rows survive.
      expect(
        (upgraded.sqlite.prepare("SELECT supersedes_document_id FROM documents WHERE id = 'document-old'").get() as { supersedes_document_id: string | null }).supersedes_document_id
      ).toBeNull()
      expect(upgraded.sqlite.prepare('SELECT count(*) AS count FROM workspace_events').get()).toEqual({ count: 2 })

      // DOCUMENT_REPLACED requires both lineage IDs; other events reject the column.
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO workspace_events (id, matter_id, document_id, event_type, actor, created_at)
             VALUES ('event-bad', 'matter-lineage', 'document-old', 'DOCUMENT_REPLACED', 'USER', 12)`
          )
          .run()
      ).toThrowError(/CHECK/)
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO workspace_events (id, matter_id, document_id, superseded_document_id, event_type, actor, created_at)
             VALUES ('event-bad-2', 'matter-lineage', 'document-old', 'document-old', 'DOCUMENT_TRASHED', 'USER', 12)`
          )
          .run()
      ).toThrowError(/CHECK/)
      upgraded.sqlite
        .prepare(
          `INSERT INTO documents (
             id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at, supersedes_document_id
           ) VALUES ('document-new', 'matter-lineage', ?, 'hash-new', 'application/pdf', 'IMPORTED', 12, 12, 'document-old')`
        )
        .run(Buffer.from('y'))
      upgraded.sqlite
        .prepare(
          `INSERT INTO workspace_events (id, matter_id, document_id, superseded_document_id, event_type, actor, created_at)
           VALUES ('event-replaced', 'matter-lineage', 'document-new', 'document-old', 'DOCUMENT_REPLACED', 'USER', 12)`
        )
        .run()

      // Lineage constraints: no self-reference, no cross-Matter lineage, immutable.
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO documents (id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at, supersedes_document_id)
             VALUES ('document-self', 'matter-lineage', ?, 'hash-self', 'application/pdf', 'IMPORTED', 13, 13, 'document-self')`
          )
          .run(Buffer.from('z'))
      // The scope guard subsumes self-reference on INSERT (the row does not
      // exist yet), so either lineage guard firing is acceptable.
      ).toThrowError(/cannot reference itself|one Matter/)
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO documents (id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at, supersedes_document_id)
             VALUES ('document-cross', 'matter-lineage', ?, 'hash-cross', 'application/pdf', 'IMPORTED', 13, 13, 'document-other-matter')`
          )
          .run(Buffer.from('z'))
      ).toThrowError(/one Matter/)
      expect(() =>
        upgraded.sqlite
          .prepare("UPDATE documents SET supersedes_document_id = NULL WHERE id = 'document-new'")
          .run()
      ).toThrowError(/immutable/)

      // The rebuilt table keeps its append-only guarantees.
      expect(() =>
        upgraded.sqlite.prepare("UPDATE workspace_events SET event_type = 'MATTER_RESTORED' WHERE id = 'event-replaced'").run()
      ).toThrowError(/append-only/)
      expect(() => upgraded.sqlite.prepare('DELETE FROM workspace_events').run()).toThrowError(/append-only/)

      // A replacement event must match the new Document's recorded lineage
      // exactly: an event claiming a different superseded Document is rejected,
      // so a wrong audit row can never be appended.
      upgraded.sqlite
        .prepare(
          `INSERT INTO documents (id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at, deleted_at)
           VALUES ('document-old-2', 'matter-lineage', ?, 'hash-old-2', 'application/pdf', 'IMPORTED', 14, 14, 14)`
        )
        .run(Buffer.from('w'))
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO workspace_events (id, matter_id, document_id, superseded_document_id, event_type, actor, created_at)
             VALUES ('event-mismatch', 'matter-lineage', 'document-new', 'document-old-2', 'DOCUMENT_REPLACED', 'USER', 14)`
          )
          .run()
      ).toThrowError(/must match the new document lineage/)

      // Lineage is linear: a second Document superseding the same old one is
      // rejected by the partial unique index even after the old one is restored.
      expect(() =>
        upgraded.sqlite
          .prepare(
            `INSERT INTO documents (id, matter_id, original_name_cipher, file_hash, mime_type, parse_status, created_at, updated_at, supersedes_document_id)
             VALUES ('document-fork', 'matter-lineage', ?, 'hash-fork', 'application/pdf', 'IMPORTED', 15, 15, 'document-old')`
          )
          .run(Buffer.from('v'))
      ).toThrowError(/UNIQUE constraint failed/)
    } finally {
      upgraded.sqlite.close()
    }
  })
})
