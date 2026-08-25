import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MockAiProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OpenAiCompatibleProvider,
  OpenAiCompatibleProviderError,
  parseProviderBaseUrl,
  testOpenAiCompatibleConnection,
  type AiProvider,
  type AiProviderRequest,
  type AiProviderResponse
} from '@aliasai/ai'
import type { SafeStorage } from './keys'

export type AiProviderKind = 'mock' | 'openai-compatible'

/**
 * Non-sensitive view of the provider configuration for the renderer. The API
 * key itself never appears — only whether one is configured.
 */
export interface AiProviderStatus {
  readonly provider: AiProviderKind
  readonly openai: {
    readonly baseUrl: string
    readonly model: string
    readonly apiKeyConfigured: boolean
  } | null
  /** Stable code when the persisted configuration exists but cannot be used. */
  readonly configErrorCode: string | null
}

export class AiProviderConfigError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AiProviderConfigError'
  }
}

export interface StoredOpenAiConfig {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
}

export interface ConfigureOpenAiInput {
  /** New key typed by the user; when omitted the stored key is kept. */
  readonly apiKey?: string
  readonly baseUrl: string
  readonly model: string
}

const CONFIG_FILE_VERSION = 1
const CONFIG_FILE_NAME = 'aliasai.ai-provider.json'

/**
 * Persists the AI provider selection and the OpenAI-compatible endpoint
 * settings in `userData/aliasai.ai-provider.json` (mode 0o600). The API key is
 * stored only as a safeStorage (OS keychain) ciphertext blob — never in
 * SQLite or logs. The stored key is never returned to the renderer; a newly
 * typed key crosses IPC only in the explicit save or test request. The
 * ALIASAI_ALLOW_PLAINTEXT_KEYS=1 development fallback mirrors the key store.
 */
export class AiProviderConfigStore {
  constructor(
    private readonly userDataPath: string,
    private readonly safeStorage: SafeStorage,
    private readonly allowPlaintextKeys: boolean = process.env.ALIASAI_ALLOW_PLAINTEXT_KEYS === '1'
  ) {}

  private get configFilePath(): string {
    return join(this.userDataPath, CONFIG_FILE_NAME)
  }

  async load(): Promise<LoadedAiProviderConfig> {
    let raw: string
    try {
      raw = await readFile(this.configFilePath, 'utf8')
    } catch (error) {
      // Only "file does not exist" means "not configured yet". Permission
      // errors, a directory at the path, or I/O failures mean the persisted
      // selection cannot be reliably read and must fail closed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { provider: 'mock' }
      throw new AiProviderConfigError(
        'AI_PROVIDER_CONFIG_UNREADABLE',
        'The AI provider configuration could not be read'
      )
    }
    const parsed = parseConfigFile(raw)
    if (parsed.provider === 'mock') return { provider: 'mock' }

    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : ''
    const model = typeof parsed.model === 'string' ? parsed.model : ''
    const hasCipher = typeof parsed.apiKeyCipher === 'string'
    const hasPlain = typeof parsed.apiKeyPlain === 'string'
    if (!hasCipher && !hasPlain) {
      return { provider: 'openai-compatible', baseUrl, model, keyErrorCode: 'AI_PROVIDER_KEY_MISSING' }
    }
    if (hasPlain) {
      if (!this.allowPlaintextKeys) {
        // A plaintext key on a system that never allowed it is tampering.
        return { provider: 'openai-compatible', baseUrl, model, keyErrorCode: 'AI_PROVIDER_CONFIG_CORRUPT' }
      }
      return {
        provider: 'openai-compatible',
        baseUrl,
        model,
        apiKey: Buffer.from(parsed.apiKeyPlain as string, 'base64').toString('utf8')
      }
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { provider: 'openai-compatible', baseUrl, model, keyErrorCode: 'AI_PROVIDER_KEYSTORE_UNAVAILABLE' }
    }
    try {
      const apiKey = this.safeStorage.decryptString(Buffer.from(parsed.apiKeyCipher as string, 'base64'))
      return { provider: 'openai-compatible', baseUrl, model, apiKey }
    } catch {
      // A different keychain (reinstall, OS migration) cannot decrypt the blob.
      return { provider: 'openai-compatible', baseUrl, model, keyErrorCode: 'AI_PROVIDER_KEY_UNAVAILABLE' }
    }
  }

  async saveMock(): Promise<void> {
    await this.write({ version: CONFIG_FILE_VERSION, provider: 'mock' })
  }

  async saveOpenAi(config: StoredOpenAiConfig): Promise<void> {
    parseProviderBaseUrl(config.baseUrl)
    const encryptedAvailable = this.safeStorage.isEncryptionAvailable()
    if (!encryptedAvailable && !this.allowPlaintextKeys) {
      throw new AiProviderConfigError(
        'AI_PROVIDER_KEYSTORE_UNAVAILABLE',
        'OS key storage is unavailable; the API key cannot be protected'
      )
    }
    const encoded = encryptedAvailable
      ? { apiKeyCipher: this.safeStorage.encryptString(config.apiKey).toString('base64') }
      : { apiKeyPlain: Buffer.from(config.apiKey, 'utf8').toString('base64') }
    await this.write({
      version: CONFIG_FILE_VERSION,
      provider: 'openai-compatible',
      baseUrl: config.baseUrl,
      model: config.model,
      ...encoded
    })
  }

  /** Removes the configuration file entirely; the app returns to the Mock default. */
  async clear(): Promise<void> {
    await rm(this.configFilePath, { force: true })
  }

  /**
   * Writes through a same-directory temporary file and an atomic rename, so
   * the stored configuration is never truncated by a crash mid-write and the
   * 0o600 mode is re-established on every save (writeFile's mode applies only
   * to first creation).
   */
  private async write(contents: Record<string, unknown>): Promise<void> {
    const temporary = join(this.userDataPath, `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(contents)}\n`, { mode: 0o600 })
      await rename(temporary, this.configFilePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export interface LoadedAiProviderConfig {
  readonly provider: AiProviderKind
  readonly baseUrl?: string
  readonly model?: string
  readonly apiKey?: string
  /** Present when the stored selection is unusable; executions fail closed. */
  readonly keyErrorCode?: string
}

interface ParsedConfigFile {
  readonly provider: AiProviderKind
  readonly baseUrl?: unknown
  readonly model?: unknown
  readonly apiKeyCipher?: unknown
  readonly apiKeyPlain?: unknown
}

function parseConfigFile(raw: string): ParsedConfigFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AiProviderConfigError('AI_PROVIDER_CONFIG_CORRUPT', 'The AI provider configuration could not be read')
  }
  const record = parsed as { version?: unknown; provider?: unknown } | null
  if (
    typeof record !== 'object' ||
    record === null ||
    record.version !== CONFIG_FILE_VERSION ||
    (record.provider !== 'mock' && record.provider !== 'openai-compatible')
  ) {
    throw new AiProviderConfigError('AI_PROVIDER_CONFIG_CORRUPT', 'The AI provider configuration could not be read')
  }
  return record as ParsedConfigFile
}

/**
 * The provider the application actually dispatches to. It delegates to the
 * currently configured provider (Mock or OpenAI-compatible) and fails closed —
 * never silently falling back to Mock — when the persisted configuration is
 * present but unusable.
 */
export class AiProviderManager implements AiProvider {
  private selected: AiProviderKind = 'mock'
  private provider: AiProvider = new MockAiProvider()
  /** Non-secret endpoint view for status and the settings form. */
  private openaiView: { readonly baseUrl: string; readonly model: string } | undefined
  /** Full usable configuration; defined only when the key could be loaded. */
  private openaiSecret: StoredOpenAiConfig | undefined
  private configErrorCode: string | null = null
  private initialized = false
  /** Serializes configuration mutations so a slow earlier save can never reactivate after a later clear. */
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: AiProviderConfigStore) {}

  async init(): Promise<void> {
    let loaded: LoadedAiProviderConfig
    try {
      loaded = await this.store.load()
    } catch (error) {
      if (error instanceof AiProviderConfigError || error instanceof OpenAiCompatibleProviderError) {
        this.applyError(error.code)
        this.initialized = true
        return
      }
      throw error
    }
    this.applyLoaded(loaded)
    this.initialized = true
  }

  /**
   * The id of the provider the user selected, even when that selection is
   * currently unusable — execution records must attribute failures to the
   * configured target, not to the internal Mock placeholder.
   */
  get id(): string {
    return this.selected === 'openai-compatible' ? OPENAI_COMPATIBLE_PROVIDER_ID : this.provider.id
  }

  async execute(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (!this.initialized) {
      throw new AiProviderConfigError('AI_PROVIDER_NOT_READY', 'The AI provider has not been initialized')
    }
    if (this.configErrorCode !== null) {
      throw new AiProviderConfigError(
        this.configErrorCode,
        'The configured AI provider is unavailable; review the provider settings'
      )
    }
    return this.provider.execute(request)
  }

  /** Switches to the deterministic local Mock provider and forgets the endpoint settings. */
  configureMock(): Promise<void> {
    return this.serialize(async () => {
      await this.store.saveMock()
      this.resetToMock()
    })
  }

  /** Saves and activates the OpenAI-compatible endpoint; validates before persisting. */
  configureOpenAi(input: ConfigureOpenAiInput): Promise<void> {
    return this.serialize(async () => {
      const apiKey = input.apiKey !== undefined && input.apiKey.length > 0 ? input.apiKey : this.openaiSecret?.apiKey
      if (apiKey === undefined) {
        throw new AiProviderConfigError('AI_PROVIDER_KEY_MISSING', 'An API key is required for the OpenAI-compatible provider')
      }
      // Constructing the provider validates baseUrl, model, and key shape before
      // anything is persisted; a rejected configuration leaves state untouched.
      const provider = new OpenAiCompatibleProvider({ baseUrl: input.baseUrl, model: input.model, apiKey })
      await this.store.saveOpenAi({ baseUrl: input.baseUrl, model: input.model, apiKey })
      this.provider = provider
      this.selected = 'openai-compatible'
      this.openaiView = { baseUrl: input.baseUrl, model: input.model }
      this.openaiSecret = { baseUrl: input.baseUrl, model: input.model, apiKey }
      this.configErrorCode = null
    })
  }

  /** Removes every persisted provider setting (including the stored key) and returns to Mock. */
  clear(): Promise<void> {
    return this.serialize(async () => {
      await this.store.clear()
      this.resetToMock()
    })
  }

  /**
   * Probes the endpoint with the same transport rules as a real execution.
   * Uses the form values when given (an unsaved key stays in memory only) and
   * otherwise the stored configuration. Read-only, so it never queues behind
   * mutations.
   */
  async testConnection(input?: {
    readonly baseUrl?: string
    readonly model?: string
    readonly apiKey?: string
  }): Promise<{ readonly httpStatus: number }> {
    const baseUrl = input?.baseUrl ?? this.openaiSecret?.baseUrl
    const model = input?.model ?? this.openaiSecret?.model
    const apiKey = input?.apiKey !== undefined && input.apiKey.length > 0 ? input.apiKey : this.openaiSecret?.apiKey
    if (baseUrl === undefined || model === undefined || apiKey === undefined) {
      throw new AiProviderConfigError(
        'AI_PROVIDER_NOT_CONFIGURED',
        'A base URL, model, and API key are required before testing the connection'
      )
    }
    return testOpenAiCompatibleConnection({ baseUrl, model, apiKey }, 15_000)
  }

  status(): AiProviderStatus {
    return {
      provider: this.selected,
      openai:
        this.selected === 'openai-compatible' && this.openaiView !== undefined
          ? {
              baseUrl: this.openaiView.baseUrl,
              model: this.openaiView.model,
              apiKeyConfigured: this.openaiSecret !== undefined && this.configErrorCode === null
            }
          : null,
      configErrorCode: this.configErrorCode
    }
  }

  private resetToMock(): void {
    this.selected = 'mock'
    this.provider = new MockAiProvider()
    this.openaiView = undefined
    this.openaiSecret = undefined
    this.configErrorCode = null
  }

  /** Runs configuration mutations strictly in invocation order. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const chained = this.mutations.then(operation, operation)
    this.mutations = chained.then(
      () => undefined,
      () => undefined
    )
    return chained
  }

  private applyLoaded(loaded: LoadedAiProviderConfig): void {
    if (loaded.provider === 'mock') return
    this.selected = 'openai-compatible'
    if (loaded.baseUrl && loaded.model) this.openaiView = { baseUrl: loaded.baseUrl, model: loaded.model }
    if (loaded.keyErrorCode !== undefined || loaded.apiKey === undefined || !loaded.baseUrl || !loaded.model) {
      // The selection is real but unusable: executions must fail closed, so no
      // provider instance is built and the stable code surfaces in settings.
      this.provider = new MockAiProvider()
      this.openaiSecret = undefined
      this.configErrorCode = loaded.keyErrorCode ?? 'AI_PROVIDER_KEY_MISSING'
      return
    }
    try {
      this.provider = new OpenAiCompatibleProvider({
        baseUrl: loaded.baseUrl,
        model: loaded.model,
        apiKey: loaded.apiKey
      })
    } catch (error) {
      // A structurally valid file with invalid fields (for example a non-HTTPS
      // non-loopback base URL saved by an older build) must land the app in
      // the settings page, not crash startup.
      if (!(error instanceof OpenAiCompatibleProviderError)) throw error
      this.provider = new MockAiProvider()
      this.openaiSecret = undefined
      this.configErrorCode = error.code
      return
    }
    this.openaiSecret = { baseUrl: loaded.baseUrl, model: loaded.model, apiKey: loaded.apiKey }
    this.configErrorCode = null
  }

  private applyError(code: string): void {
    this.resetToMock()
    this.configErrorCode = code
  }
}
