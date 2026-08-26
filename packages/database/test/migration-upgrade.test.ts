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
      ).toEqual({ count: 7 })
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
})
