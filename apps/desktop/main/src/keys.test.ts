import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SafeStorageKeyStore, type SafeStorage } from './keys'

/** Simulates the OS keychain: encrypt/decrypt round trip keyed by process memory. */
function fakeSafeStorage(available = true, failing = false): SafeStorage {
  const vault = new Map<string, string>()
  let counter = 0
  return {
    isEncryptionAvailable: () => available,
    encryptString(plainText: string): Buffer {
      if (failing) throw new Error('keychain failure at /System/Library/Keychains/private-client-data')
      const key = `entry-${++counter}`
      vault.set(key, plainText)
      return Buffer.from(key, 'utf8')
    },
    decryptString(encrypted: Buffer): string {
      const key = encrypted.toString('utf8')
      const value = vault.get(key)
      if (value === undefined) throw new Error('Could not decrypt the provided data')
      return value
    }
  }
}

describe('SafeStorageKeyStore', () => {
  const directories: string[] = []

  beforeEach(() => {
    process.env.ALIASAI_ALLOW_PLAINTEXT_KEYS = undefined
  })

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function tempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-keystore-'))
    directories.push(directory)
    return directory
  }

  it('generates distinct keys on first run and reloads them on the next run', async () => {
    const directory = await tempDirectory()
    const storage = fakeSafeStorage()

    const first = await new SafeStorageKeyStore(directory, storage).load()
    const reload = await new SafeStorageKeyStore(directory, storage).load()

    expect(first.persistenceKey.length).toBe(32)
    expect(first.searchKey!.length).toBe(32)
    expect(first.persistenceKey.equals(first.searchKey!)).toBe(false)
    expect(reload.persistenceKey.equals(first.persistenceKey)).toBe(true)
    expect(reload.searchKey!.equals(first.searchKey!)).toBe(true)

    // The stored file contains only keychain blobs, never raw key material.
    const stored = await readFile(join(directory, 'aliasai.keys'), 'utf8')
    expect(stored).not.toContain(first.persistenceKey.toString('base64'))
    expect(stored).not.toContain(first.searchKey!.toString('base64'))
  })

  it('fails closed when the OS keychain is unavailable', async () => {
    const directory = await tempDirectory()

    await expect(new SafeStorageKeyStore(directory, fakeSafeStorage(false)).load()).rejects.toThrow(
      expect.objectContaining({ code: 'KEYSTORE_UNAVAILABLE' })
    )
  })

  it('allows the documented plaintext fallback only when explicitly enabled', async () => {
    const directory = await tempDirectory()
    const store = new SafeStorageKeyStore(directory, fakeSafeStorage(false), true)

    const keys = await store.load()

    const stored = await readFile(join(directory, 'aliasai.keys'), 'utf8')
    expect(stored).toContain(keys.persistenceKey.toString('base64'))
  })

  it('rejects a corrupt key file', async () => {
    const directory = await tempDirectory()
    await writeFile(join(directory, 'aliasai.keys'), 'not json at all')

    await expect(new SafeStorageKeyStore(directory, fakeSafeStorage()).load()).rejects.toThrow(
      expect.objectContaining({ code: 'KEYSTORE_CORRUPT' })
    )
  })
})
