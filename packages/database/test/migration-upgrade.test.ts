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
    legacy.sqlite.close()

    const upgraded = openDatabase(databasePath)
    try {
      migrateDatabase(upgraded.db)

      expect(
        upgraded.sqlite.prepare('SELECT id, status FROM matters WHERE id = ?').get('matter-upgrade')
      ).toEqual({ id: 'matter-upgrade', status: 'ACTIVE' })
      expect(
        upgraded.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_executions'")
          .get()
      ).toEqual({ name: 'ai_executions' })
      expect(
        upgraded.sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()
      ).toEqual({ count: 5 })
    } finally {
      upgraded.sqlite.close()
    }
  })
})
