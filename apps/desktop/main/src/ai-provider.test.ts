import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerResponse } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OpenAiCompatibleProviderError } from '@aliasai/ai'
import {
  AiProviderConfigError,
  AiProviderConfigStore,
  AiProviderManager,
  type StoredOpenAiConfig
} from './ai-provider'
import type { SafeStorage } from './keys'

const API_KEY = 'sk-synthetic-provider-key'

function keychainBackedSafeStorage(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`),
    decryptString: (encrypted: Buffer) => {
      const value = encrypted.toString('utf8')
      if (!value.startsWith('enc:')) throw new Error('could not be decrypted')
      return value.slice(4)
    }
  }
}

const unavailableSafeStorage: SafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('unavailable')
  },
  decryptString: () => {
    throw new Error('unavailable')
  }
}

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aliasai-provider-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function managerFixture(safeStorage: SafeStorage = keychainBackedSafeStorage()): Promise<{
  directory: string
  manager: AiProviderManager
}> {
  const directory = await temporaryDirectory()
  const manager = new AiProviderManager(new AiProviderConfigStore(directory, safeStorage))
  await manager.init()
  return { directory, manager }
}

describe('AiProviderManager defaults and switching', () => {
  it('starts on the Mock provider with no configuration file', async () => {
    const { manager } = await managerFixture()

    expect(manager.id).toBe('mock-v1')
    expect(manager.status()).toEqual({ provider: 'mock', openai: null, configErrorCode: null })
    await expect(manager.execute({ content: 'synthetic' })).resolves.toEqual({ content: 'Mock analysis:\nsynthetic' })
  })

  it('activates the OpenAI-compatible provider and never exposes the key in status', async () => {
    const { manager } = await managerFixture()

    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })

    expect(manager.id).toBe('openai-compatible-v1')
    const status = manager.status()
    expect(status).toEqual({
      provider: 'openai-compatible',
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: true },
      configErrorCode: null
    })
    expect(JSON.stringify(status)).not.toContain(API_KEY)
  })

  it('keeps the stored key when re-saving without one, and rejects a missing key', async () => {
    const { manager } = await managerFixture()
    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })

    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-other' })
    expect(manager.status().openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-other',
      apiKeyConfigured: true
    })

    const fresh = new AiProviderManager(new AiProviderConfigStore((await temporaryDirectory()), keychainBackedSafeStorage()))
    await fresh.init()
    await expect(
      fresh.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic' })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_KEY_MISSING' })
  })

  it('validates before persisting: a rejected base URL leaves everything untouched', async () => {
    const { directory, manager } = await managerFixture()

    await expect(
      manager.configureOpenAi({ baseUrl: 'http://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })
    ).rejects.toBeInstanceOf(OpenAiCompatibleProviderError)
    expect(manager.status().provider).toBe('mock')
    const raw = await readFile(join(directory, 'aliasai.ai-provider.json'), 'utf8').catch(() => 'missing')
    expect(raw).toBe('missing')
  })

  it('switches back to Mock and clears the persisted settings', async () => {
    const { directory, manager } = await managerFixture()
    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })

    await manager.configureMock()
    expect(manager.status()).toEqual({ provider: 'mock', openai: null, configErrorCode: null })
    await expect(manager.execute({ content: 'synthetic' })).resolves.toEqual({
      content: 'Mock analysis:\nsynthetic'
    })

    await manager.clear()
    await expect(readFile(join(directory, 'aliasai.ai-provider.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('AiProviderConfigStore key protection', () => {
  it('persists only a keychain ciphertext, never the plaintext key, with mode 0600', async () => {
    const directory = await temporaryDirectory()
    const store = new AiProviderConfigStore(directory, keychainBackedSafeStorage())

    await store.saveOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })

    const path = join(directory, 'aliasai.ai-provider.json')
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(API_KEY)
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKeyCipher: Buffer.from(`enc:${API_KEY}`).toString('base64')
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('re-establishes mode 0600 when overwriting an existing file with looser permissions', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'aliasai.ai-provider.json')
    await writeFile(path, '{}\n', 'utf8')
    await chmod(path, 0o644)
    expect((await stat(path)).mode & 0o777).toBe(0o644)

    const store = new AiProviderConfigStore(directory, keychainBackedSafeStorage())
    await store.saveMock()

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // No temporary file is left behind by the atomic rename.
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(directory))
    expect(entries).toEqual(['aliasai.ai-provider.json'])
  })

  it('restores the full configuration after an application restart', async () => {
    const directory = await temporaryDirectory()
    await new AiProviderConfigStore(directory, keychainBackedSafeStorage()).saveOpenAi({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: API_KEY
    })

    const restarted = new AiProviderManager(new AiProviderConfigStore(directory, keychainBackedSafeStorage()))
    await restarted.init()

    expect(restarted.id).toBe('openai-compatible-v1')
    expect(restarted.status()).toEqual({
      provider: 'openai-compatible',
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: true },
      configErrorCode: null
    })
  })

  it('fails closed when safeStorage is unavailable and plaintext is not allowed', async () => {
    const directory = await temporaryDirectory()
    const store = new AiProviderConfigStore(directory, unavailableSafeStorage)

    await expect(
      store.saveOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_KEYSTORE_UNAVAILABLE' })
    await expect(readFile(join(directory, 'aliasai.ai-provider.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores a marked plaintext key only under the explicit development fallback', async () => {
    const directory = await temporaryDirectory()
    const store = new AiProviderConfigStore(directory, unavailableSafeStorage, true)

    await store.saveOpenAi({ baseUrl: 'http://127.0.0.1:9000/v1', model: 'gpt-synthetic', apiKey: API_KEY })
    const raw = await readFile(join(directory, 'aliasai.ai-provider.json'), 'utf8')
    expect(JSON.parse(raw).apiKeyPlain).toBe(Buffer.from(API_KEY).toString('base64'))
    expect(JSON.parse(raw).apiKeyCipher).toBeUndefined()

    const loaded = await store.load()
    expect(loaded).toMatchObject({ provider: 'openai-compatible', apiKey: API_KEY })

    // The same file on a system without the fallback is treated as tampering.
    const strict = new AiProviderConfigStore(directory, unavailableSafeStorage, false)
    await expect(strict.load()).resolves.toMatchObject({ keyErrorCode: 'AI_PROVIDER_CONFIG_CORRUPT' })
  })
})

describe('AiProviderManager fail-closed states', () => {
  it('refuses to execute when the configuration file is corrupt, without falling back to Mock', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'aliasai.ai-provider.json'), '{not json', 'utf8')

    const manager = new AiProviderManager(new AiProviderConfigStore(directory, keychainBackedSafeStorage()))
    await manager.init()

    expect(manager.status()).toMatchObject({ configErrorCode: 'AI_PROVIDER_CONFIG_CORRUPT' })
    await expect(manager.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'AI_PROVIDER_CONFIG_CORRUPT'
    })
  })

  it('fails closed when the configuration path cannot be read at all', async () => {
    const directory = await temporaryDirectory()
    // Only a missing file means "not configured"; a directory at the path (or
    // EACCES/EIO) must not silently enable the Mock provider.
    await mkdir(join(directory, 'aliasai.ai-provider.json'))

    const manager = new AiProviderManager(new AiProviderConfigStore(directory, keychainBackedSafeStorage()))
    await manager.init()

    expect(manager.status()).toEqual({
      provider: 'mock',
      openai: null,
      configErrorCode: 'AI_PROVIDER_CONFIG_UNREADABLE'
    })
    await expect(manager.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'AI_PROVIDER_CONFIG_UNREADABLE'
    })
  })

  it('degrades a structurally valid but invalid stored configuration to a settings error, not a startup crash', async () => {
    const directory = await temporaryDirectory()
    // Written by hand the way an older build could have: valid JSON and
    // version, real key ciphertext, but a base URL the provider now rejects.
    const encrypted = keychainBackedSafeStorage().encryptString(API_KEY).toString('base64')
    await writeFile(
      join(directory, 'aliasai.ai-provider.json'),
      `${JSON.stringify({
        version: 1,
        provider: 'openai-compatible',
        baseUrl: 'http://api.openai.com/v1',
        model: 'gpt-synthetic',
        apiKeyCipher: encrypted
      })}\n`,
      'utf8'
    )

    const manager = new AiProviderManager(new AiProviderConfigStore(directory, keychainBackedSafeStorage()))
    await manager.init()

    const status = manager.status()
    expect(status.provider).toBe('openai-compatible')
    expect(status.configErrorCode).toBe('PROVIDER_CONFIG_INVALID')
    expect(status.openai).toEqual({
      baseUrl: 'http://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKeyConfigured: false
    })
    // Failure attribution names the configured target, not the Mock placeholder.
    expect(manager.id).toBe('openai-compatible-v1')
    await expect(manager.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_CONFIG_INVALID'
    })

    // The settings page can repair the configuration from here.
    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: API_KEY })
    expect(manager.status().configErrorCode).toBeNull()
    expect(manager.id).toBe('openai-compatible-v1')
  })

  it('refuses to execute when the stored key cannot be decrypted (keychain changed)', async () => {
    const directory = await temporaryDirectory()
    await new AiProviderConfigStore(directory, keychainBackedSafeStorage()).saveOpenAi({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: API_KEY
    })

    const brokenKeychain: SafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`),
      decryptString: () => {
        throw new Error('keychain re-locked')
      }
    }
    const manager = new AiProviderManager(new AiProviderConfigStore(directory, brokenKeychain))
    await manager.init()

    const status = manager.status()
    expect(status.configErrorCode).toBe('AI_PROVIDER_KEY_UNAVAILABLE')
    expect(status.openai).toMatchObject({ baseUrl: 'https://api.openai.com/v1', apiKeyConfigured: false })
    // The execution row must attribute the failure to the selected provider.
    expect(manager.id).toBe('openai-compatible-v1')
    await expect(manager.execute({ content: 'synthetic' })).rejects.toBeInstanceOf(AiProviderConfigError)
    // Re-saving a fresh key recovers the provider.
    await manager.configureOpenAi({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKey: 'sk-rotated' })
    expect(manager.status().configErrorCode).toBeNull()
  })

  it('refuses to execute before init', async () => {
    const manager = new AiProviderManager(new AiProviderConfigStore(await temporaryDirectory(), keychainBackedSafeStorage()))
    await expect(manager.execute({ content: 'synthetic' })).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_READY' })
  })

  it('serializes configuration mutations so a later clear wins over a slow earlier save', async () => {
    const directory = await temporaryDirectory()
    const store = new (class extends AiProviderConfigStore {
      constructor() {
        super(directory, keychainBackedSafeStorage())
      }
      override async saveOpenAi(config: StoredOpenAiConfig): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return super.saveOpenAi(config)
      }
    })()
    const manager = new AiProviderManager(store)
    await manager.init()

    const saving = manager.configureOpenAi({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: API_KEY
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await manager.clear()
    await saving

    expect(manager.status()).toEqual({ provider: 'mock', openai: null, configErrorCode: null })
    await expect(readFile(join(directory, 'aliasai.ai-provider.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('AiProviderManager with a live endpoint', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer((request, response) => {
      const respond = (status: number, payload: unknown): ServerResponse =>
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      if (request.method === 'GET' && request.url === '/v1/models') {
        respond(200, { data: [{ id: 'gpt-synthetic' }] })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        respond(200, { choices: [{ message: { content: '本端点仅用于合成测试' } }] })
        return
      }
      respond(404, {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('dispatches executions and connection tests to the configured endpoint', async () => {
    const { manager } = await managerFixture()
    await manager.configureOpenAi({ baseUrl, model: 'gpt-synthetic', apiKey: API_KEY })

    await expect(manager.execute({ content: 'synthetic sanitized content' })).resolves.toEqual({
      content: '本端点仅用于合成测试'
    })

    const probe = await manager.testConnection()
    expect(probe.httpStatus).toBe(200)

    // Form values override the stored configuration without saving it.
    const statusBefore = manager.status()
    await expect(manager.testConnection({ baseUrl, model: 'unsaved-model', apiKey: 'sk-unsaved' })).resolves.toEqual({
      httpStatus: 200
    })
    expect(manager.status()).toEqual(statusBefore)
  })

  it('requires a complete configuration before testing the connection', async () => {
    const { manager } = await managerFixture()

    await expect(manager.testConnection()).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' })
    await expect(manager.testConnection({ baseUrl, model: 'gpt-synthetic' })).rejects.toMatchObject({
      code: 'AI_PROVIDER_NOT_CONFIGURED'
    })
  })
})
