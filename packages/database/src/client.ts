import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schema } from './schema'

export type SqliteClient = Database.Database
export type AliasAiDatabase = ReturnType<typeof createDatabase>

export function createDatabase(sqlite: SqliteClient) {
  sqlite.pragma('foreign_keys = ON')
  return drizzle(sqlite, { schema })
}

export function openDatabase(filePath: string): { readonly sqlite: SqliteClient; readonly db: AliasAiDatabase } {
  const sqlite = new Database(filePath)
  return { sqlite, db: createDatabase(sqlite) }
}

/** Applies only generated Drizzle migrations; business services never issue ad-hoc schema changes. */
export function migrateDatabase(db: AliasAiDatabase, migrationsFolder = defaultMigrationsFolder()): void {
  migrate(db, { migrationsFolder })
}

function defaultMigrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')
}
