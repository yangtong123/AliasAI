import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateKey } from '@aliasai/crypto'
import type { ApplicationKeys } from '@aliasai/application'

/** The slice of Electron's safeStorage the key store depends on; injectable for tests. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class KeyStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'KeyStoreError'
  }
}

const KEY_FILE_VERSION = 1
const KEY_FILE_NAME = 'aliasai.keys'

/**
 * Loads the local persistence and search keys. On first run both keys are
 * generated (distinct 32-byte values) and persisted as an OS-keychain-encrypted
 * file. Keys live only in main-process memory afterwards; they are never
 * logged and never cross IPC.
 *
 * When safeStorage is unavailable the store fails closed unless
 * ALIASAI_ALLOW_PLAINTEXT_KEYS=1 is set (development fallback).
 */
export class SafeStorageKeyStore {
  constructor(
    private readonly userDataPath: string,
    private readonly safeStorage: SafeStorage,
    private readonly allowPlaintextKeys: boolean = process.env.ALIASAI_ALLOW_PLAINTEXT_KEYS === '1'
  ) {}

  async load(): Promise<ApplicationKeys> {
    const keyFilePath = join(this.userDataPath, KEY_FILE_NAME)
    const usePlaintextFallback = !this.safeStorage.isEncryptionAvailable()
    if (usePlaintextFallback && !this.allowPlaintextKeys) {
      throw new KeyStoreError('KEYSTORE_UNAVAILABLE', 'OS key storage is unavailable on this system')
    }

    let raw: string
    try {
      raw = await readFile(keyFilePath, 'utf8')
    } catch {
      const keys = this.generate()
      await this.persist(keyFilePath, keys, usePlaintextFallback)
      return keys
    }

    const parsed = parseKeyFile(raw)
    if (usePlaintextFallback) {
      return {
        persistenceKey: Buffer.from(parsed.persistence, 'base64'),
        searchKey: Buffer.from(parsed.search, 'base64')
      }
    }
    const persistenceKey = Buffer.from(this.safeStorage.decryptString(Buffer.from(parsed.persistence, 'base64')), 'binary')
    const searchKey = Buffer.from(this.safeStorage.decryptString(Buffer.from(parsed.search, 'base64')), 'binary')
    assertKeys(persistenceKey, searchKey)
    return { persistenceKey, searchKey }
  }

  private generate(): ApplicationKeys {
    const persistenceKey = generateKey()
    let searchKey = generateKey()
    while (searchKey.equals(persistenceKey)) searchKey = generateKey()
    return { persistenceKey, searchKey }
  }

  private async persist(keyFilePath: string, keys: ApplicationKeys, usePlaintextFallback: boolean): Promise<void> {
    const encoded = {
      persistence: usePlaintextFallback
        ? keys.persistenceKey.toString('base64')
        : this.safeStorage.encryptString(keys.persistenceKey.toString('binary')).toString('base64'),
      search: usePlaintextFallback
        ? keys.searchKey!.toString('base64')
        : this.safeStorage.encryptString(keys.searchKey!.toString('binary')).toString('base64')
    }
    await writeFile(keyFilePath, `${JSON.stringify({ version: KEY_FILE_VERSION, ...encoded })}\n`, { mode: 0o600 })
  }
}

function parseKeyFile(raw: string): { persistence: string; search: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new KeyStoreError('KEYSTORE_CORRUPT', 'The local key file could not be read')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== KEY_FILE_VERSION ||
    typeof (parsed as { persistence?: unknown }).persistence !== 'string' ||
    typeof (parsed as { search?: unknown }).search !== 'string'
  ) {
    throw new KeyStoreError('KEYSTORE_CORRUPT', 'The local key file could not be read')
  }
  return parsed as { persistence: string; search: string }
}

function assertKeys(persistenceKey: Buffer, searchKey: Buffer): void {
  if (persistenceKey.length !== 32 || searchKey.length !== 32 || persistenceKey.equals(searchKey)) {
    throw new KeyStoreError('KEYSTORE_CORRUPT', 'The local key file could not be read')
  }
}
