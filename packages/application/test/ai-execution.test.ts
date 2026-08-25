import { describe, expect, it, vi } from 'vitest'
import type { AiProvider } from '@aliasai/ai'
import { decrypt, encrypt, generateKey } from '@aliasai/crypto'
import type { AiExecution, ProtectedValueType } from '@aliasai/domain'
import type {
  AiExecutionRecord,
  AiExecutionSource,
  CreateAiExecutionInput
} from '@aliasai/database'
import {
  AiExecutionError,
  AiExecutionService,
  aiExecutionErrorContext,
  aiExecutionRequestContext,
  aiExecutionResponseContext,
  protectedValueContext,
  sanitizedBlockTextContext
} from '../src'

const persistenceKey = generateKey()
const token = '@N-ABC123'

function source(content = `原告甲〔${token}〕提交证据。`): AiExecutionSource {
  return {
    sanitizedDocument: {
      id: 'sanitized-1',
      matterId: 'matter-1',
      documentId: 'document-1',
      jobId: 'sanitize-job-1',
      createdAt: 10
    },
    blocks: [
      {
        id: 'sanitized-block-1',
        sanitizedDocumentId: 'sanitized-1',
        documentId: 'document-1',
        pageId: 'page-1',
        blockId: 'block-1',
        textCipher: encrypt(Buffer.from(content), persistenceKey, sanitizedBlockTextContext('sanitized-block-1')),
        createdAt: 10
      }
    ],
    mappings: [
      {
        id: 'mapping-1',
        matterId: 'matter-1',
        sanitizedDocumentId: 'sanitized-1',
        mentionId: 'mention-1',
        entityId: 'entity-1',
        publicToken: token,
        alias: '原告甲',
        restorePolicy: 'ALWAYS_RESTORE',
        createdAt: 10,
        protectedValueId: 'protected-value-1',
        valueCipher: encrypt(Buffer.from('张伟'), persistenceKey, protectedValueContext('protected-value-1'))
      }
    ],
    internalIdentifiers: [
      'matter-1',
      'document-1',
      'sanitized-1',
      'sanitize-job-1',
      'sanitized-block-1',
      'page-1',
      'block-1',
      'mapping-1',
      'mention-1',
      'entity-1',
      'protected-value-1'
    ],
    matterDenylist: [
      {
        id: 'protected-value-1',
        valueType: 'PERSON_NAME',
        valueCipher: encrypt(Buffer.from('张伟'), persistenceKey, protectedValueContext('protected-value-1'))
      },
      {
        // Known from another document in the same Matter; never mapped here.
        id: 'protected-value-phone',
        valueType: 'PHONE',
        valueCipher: encrypt(
          Buffer.from('138 0013 8000'),
          persistenceKey,
          protectedValueContext('protected-value-phone')
        )
      }
    ]
  }
}

class MemoryAiExecutionStore {
  readonly records = new Map<string, AiExecutionRecord>()

  constructor(readonly sourceValue: AiExecutionSource | undefined) {}

  findSource(sanitizedDocumentId: string): AiExecutionSource | undefined {
    return this.sourceValue?.sanitizedDocument.id === sanitizedDocumentId ? this.sourceValue : undefined
  }

  begin(input: CreateAiExecutionInput): AiExecutionRecord {
    const record = { ...input.execution, requestCipher: Buffer.from(input.requestCipher) }
    this.records.set(record.id, record)
    return record
  }

  complete(executionId: string, responseCipher: Buffer, finishedAt: number): AiExecutionRecord {
    const current = this.require(executionId)
    const record: AiExecutionRecord = {
      ...current,
      status: 'COMPLETED',
      responseCipher: Buffer.from(responseCipher),
      finishedAt
    }
    this.records.set(executionId, record)
    return record
  }

  fail(executionId: string, errorCipher: Buffer, finishedAt: number): AiExecutionRecord {
    const current = this.require(executionId)
    const record: AiExecutionRecord = {
      ...current,
      status: 'FAILED',
      errorCipher: Buffer.from(errorCipher),
      finishedAt
    }
    this.records.set(executionId, record)
    return record
  }

  findById(executionId: string): AiExecutionRecord | undefined {
    return this.records.get(executionId)
  }

  findLatest(sanitizedDocumentId: string): AiExecutionRecord | undefined {
    return [...this.records.values()]
      .filter((record) => record.sanitizedDocumentId === sanitizedDocumentId)
      .sort((left, right) => right.createdAt - left.createdAt)[0]
  }

  private require(executionId: string): AiExecutionRecord {
    const record = this.records.get(executionId)
    if (record === undefined) throw new Error('missing execution')
    return record
  }
}

function service(input: {
  source?: AiExecutionSource
  provider?: AiProvider
  store?: MemoryAiExecutionStore
  rehydrate?: (text: string) => { text: string; unresolvedTokens: readonly string[] }
} = {}) {
  const store = input.store ?? new MemoryAiExecutionStore(input.source ?? source())
  const provider =
    input.provider ??
    ({
      id: 'mock-v1',
      execute: vi.fn(async ({ content }: { content: string }) => ({ content: `分析：${content}` }))
    } satisfies AiProvider)
  let now = 100
  const executions = new AiExecutionService(
    store,
    {
      rehydrate: ({ text }) =>
        input.rehydrate?.(text) ?? {
          text: text.replaceAll(`原告甲〔${token}〕`, '张伟').replaceAll(token, '张伟'),
          unresolvedTokens: []
        }
    },
    provider,
    { persistenceKey },
    () => now++,
    () => 'ai-execution-1'
  )
  return { executions, store, provider }
}

describe('AiExecutionService', () => {
  it('sends only persisted sanitized Block text and rehydrates the response locally', async () => {
    const execute = vi.fn(
      async (request: { readonly content: string; readonly signal?: AbortSignal }) => ({
        content: `结论：${request.content}`
      })
    )
    const provider: AiProvider = { id: 'mock-v1', execute }
    const { executions, store } = service({ provider })

    await expect(executions.execute('sanitized-1')).resolves.toMatchObject({
      status: 'COMPLETED',
      providerId: 'mock-v1',
      sanitizedResponse: `结论：原告甲〔${token}〕提交证据。`,
      rehydratedResponse: '结论：张伟提交证据。',
      unresolvedTokens: []
    })
    expect(execute).toHaveBeenCalledTimes(1)
    // Only the sanitized content plus the cooperative cancel signal — never
    // Matter, Entity, Mapping, or decrypted values — crosses the provider port.
    expect(Object.keys(execute.mock.calls[0]![0])).toEqual(['content', 'signal'])
    expect(execute.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)

    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('COMPLETED')
    expect(
      decrypt(record.requestCipher, persistenceKey, aiExecutionRequestContext(record.id)).toString('utf8')
    ).toBe(`原告甲〔${token}〕提交证据。`)
    expect(
      decrypt(record.responseCipher!, persistenceKey, aiExecutionResponseContext(record.id)).toString('utf8')
    ).toBe(`结论：原告甲〔${token}〕提交证据。`)
  })

  it('reloads one exact completed execution for a local copy or export action', async () => {
    const { executions } = service()
    await executions.execute('sanitized-1')

    expect(executions.getCompleted('ai-execution-1')).toMatchObject({
      id: 'ai-execution-1',
      status: 'COMPLETED',
      sanitizedResponse: `分析：原告甲〔${token}〕提交证据。`,
      rehydratedResponse: '分析：张伟提交证据。'
    })
    expect(() => executions.getCompleted('missing-execution')).toThrowError(
      expect.objectContaining({ code: 'AI_RESULT_NOT_AVAILABLE' })
    )
  })

  it.each([
    ['protected plaintext', `张伟与原告甲〔${token}〕`],
    ['internal identifier', `document-1 原告甲〔${token}〕`],
    ['unknown token', '原告甲〔@N-UNKNOWN〕'],
    ['malformed token', '原告甲〔@N-A-B〕'],
    ['missing mapped token', '没有恢复锚点'],
    // Value known from another document in the same Matter, in a variant that
    // survives naive bounded-span scanning.
    ['unmapped Matter-wide phone', `原告甲〔${token}〕备用号码 138-0013-8000。`],
    ['unmapped Matter-wide phone with +86', `原告甲〔${token}〕备用号码 +86 138 0013 8000。`],
    ['unmapped Matter-wide phone in parentheses', `原告甲〔${token}〕备用号码 (138) 0013-8000。`],
    ['unmapped Matter-wide phone with extension', `原告甲〔${token}〕备用号码 138-0013-8000/123。`],
    ['unmapped Matter-wide phone with unicode dashes', `原告甲〔${token}〕备用号码 138–0013–8000。`],
    ['unmapped Matter-wide phone with zero-width separators', `原告甲〔${token}〕备用号码 138\u200B0013\u200B8000。`],
    ['unmapped Matter-wide phone followed by a year', `原告甲〔${token}〕备用号码 138-0013-8000 2026年。`]
  ])('fails closed before provider dispatch for %s', async (_name, content) => {
    const execute = vi.fn(async () => ({ content: 'should not run' }))
    const { executions, store } = service({ source: source(content), provider: { id: 'mock-v1', execute } })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'OUTBOUND_LEAK_DETECTED'
    })
    expect(execute).not.toHaveBeenCalled()
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    expect(
      JSON.parse(decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8'))
    ).toEqual({ code: 'OUTBOUND_LEAK_DETECTED' })
  })

  it('rejects an oversized artifact before joining, encrypting, or persisting it', async () => {
    const execute = vi.fn(async () => ({ content: 'should not run' }))
    const { executions, store } = service({
      source: source(`原告甲〔${token}〕${'x'.repeat(5 * 1024 * 1024 + 1)}`),
      provider: { id: 'mock-v1', execute }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'OUTBOUND_PAYLOAD_TOO_LARGE'
    })
    expect(execute).not.toHaveBeenCalled()
    // The size gate precedes the RUNNING insert: nothing was encrypted or persisted.
    expect(store.records.size).toBe(0)
  })

  it('fails closed when the Matter denylist exceeds the scan capacity', async () => {
    const execute = vi.fn(async () => ({ content: 'should not run' }))
    const oversizedDenylist = [
      ...source().matterDenylist,
      ...Array.from({ length: 2048 }, (_, index) => ({
        id: `protected-value-extra-${index}`,
        valueType: 'PERSON_NAME' as const,
        valueCipher: encrypt(
          Buffer.from(`合成值${index}`),
          persistenceKey,
          protectedValueContext(`protected-value-extra-${index}`)
        )
      }))
    ]
    const { executions, store } = service({
      source: { ...source(), matterDenylist: oversizedDenylist },
      provider: { id: 'mock-v1', execute }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DENYLIST_TOO_LARGE'
    })
    expect(execute).not.toHaveBeenCalled()
    expect(store.records.size).toBe(0)
  })

  const integrityFailures: readonly (readonly [name: string, legacyType: ProtectedValueType, legacyValue: string])[] = [
    // Legacy or corrupt rows the outbound digit grammar cannot verify: old
    // whitespace-collapsed values, and below-threshold values no valid Vault
    // row could ever hold.
    ['legacy whitespace-collapsed PHONE', 'PHONE', '1380\n013\t8000'],
    ['below-threshold PHONE', 'PHONE', '1234'],
    ['below-threshold ID_CARD', 'ID_CARD', '1234']
  ]
  it.each(integrityFailures)('fails closed with an integrity error for a %s', async (_name, legacyType, legacyValue) => {
    const execute = vi.fn(async () => ({ content: 'should not run' }))
    const legacySource = {
      ...source(),
      matterDenylist: [
        ...source().matterDenylist,
        {
          id: 'protected-value-legacy',
          valueType: legacyType,
          valueCipher: encrypt(
            Buffer.from(legacyValue),
            persistenceKey,
            protectedValueContext('protected-value-legacy')
          )
        }
      ]
    }
    const { executions, store } = service({ source: legacySource, provider: { id: 'mock-v1', execute } })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'OUTBOUND_DENYLIST_INTEGRITY_FAILURE'
    })
    expect(execute).not.toHaveBeenCalled()
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    const errorPayload = decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    expect(errorPayload).toBe('{"code":"OUTBOUND_DENYLIST_INTEGRITY_FAILURE"}')
    expect(errorPayload).not.toContain(legacyValue)
  })

  it('persists only a stable error code when the provider fails', async () => {
    const providerError = new Error('secret provider stack and local path')
    const { executions, store } = service({
      provider: { id: 'mock-v1', execute: vi.fn(async () => Promise.reject(providerError)) }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILURE' })
    const record = store.records.get('ai-execution-1')!
    const errorPayload = decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    expect(errorPayload).toBe('{"code":"AI_PROVIDER_FAILURE"}')
    expect(errorPayload).not.toContain(providerError.message)
  })

  it('does not trust provider-thrown application-shaped error codes or messages', async () => {
    const { executions, store } = service({
      provider: {
        id: 'mock-v1',
        execute: vi.fn(async () => {
          throw new AiExecutionError('PROVIDER_CONTROLLED_CODE', 'provider-controlled renderer message')
        })
      }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'AI_PROVIDER_FAILURE',
      message: 'AI provider request failed'
    })
    const record = store.records.get('ai-execution-1')!
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"AI_PROVIDER_FAILURE"}')
  })

  it('classifies response persistence failures separately from provider failures', async () => {
    const store = new MemoryAiExecutionStore(source())
    const complete = vi.spyOn(store, 'complete').mockImplementation(() => {
      throw new Error('local sqlite path and response details')
    })
    const { executions } = service({ store })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'AI_PERSISTENCE_FAILURE'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"AI_PERSISTENCE_FAILURE"}')
  })

  it.each([
    ['non-string content', 42 as unknown as string],
    ['empty content', ''],
    ['content over the 5 MiB limit', 'x'.repeat(5 * 1024 * 1024 + 1)]
  ])('rejects a provider response with %s before persistence', async (_name, content) => {
    const { executions, store } = service({
      provider: { id: 'mock-v1', execute: vi.fn(async () => ({ content })) }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE'
    })
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"INVALID_PROVIDER_RESPONSE"}')
  })

  it('fails closed for a dash-separated ID card known in the Matter', async () => {
    const provider = { id: 'mock-v1', execute: vi.fn(async () => ({ content: 'should not run' })) }
    const { executions, store } = service({
      source: {
        ...source(`证号 110101-19900307-777X 与原告甲〔${token}〕。`),
        matterDenylist: [
          {
            id: 'protected-value-id',
            valueType: 'ID_CARD',
            valueCipher: encrypt(
              Buffer.from('11010119900307777X'),
              persistenceKey,
              protectedValueContext('protected-value-id')
            )
          }
        ]
      },
      provider
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'OUTBOUND_LEAK_DETECTED'
    })
    expect(provider.execute).not.toHaveBeenCalled()
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
  })

  it('fails closed when a Matter denylist cipher cannot be decrypted', async () => {
    const corrupted: AiExecutionSource = {
      ...source(),
      matterDenylist: [
        {
          id: 'protected-value-1',
          valueType: 'PERSON_NAME',
          valueCipher: Buffer.from('not-a-valid-cipher')
        }
      ]
    }
    const provider = { id: 'mock-v1', execute: vi.fn(async () => ({ content: 'should not run' })) }
    const { executions, store } = service({ source: corrupted, provider })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'MAPPING_DECRYPTION_FAILED'
    })
    expect(provider.execute).not.toHaveBeenCalled()
    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"MAPPING_DECRYPTION_FAILED"}')
  })

  it('reports unknown or tampered provider tokens without sending Mapping data back out', async () => {
    const execute = vi.fn(async ({ content }: { readonly content: string }) => ({
      content: `原告乙〔@N-UNKNOWN〕与原告乙〔@N-ABC123〕（${content.length} 字符）`
    }))
    const { executions } = service({
      provider: { id: 'mock-v1', execute },
      rehydrate: (text) => ({ text, unresolvedTokens: ['@N-ABC123', '@N-UNKNOWN'] })
    })

    await expect(executions.execute('sanitized-1')).resolves.toMatchObject({
      status: 'COMPLETED',
      unresolvedTokens: ['@N-ABC123', '@N-UNKNOWN']
    })
    expect(execute.mock.calls[0]![0]).toEqual({
      content: `原告甲〔${token}〕提交证据。`,
      signal: expect.any(AbortSignal)
    })
  })

  it('fails closed as AI_CANCELLED, with no partial response, when the user cancels', async () => {
    const execute = vi.fn(
      (request: { readonly signal?: AbortSignal }) =>
        new Promise<{ content: string }>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true })
        })
    )
    const { executions, store } = service({ provider: { id: 'mock-v1', execute } })

    const pending = executions.execute('sanitized-1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(executions.cancelActive()).toBe(1)
    await expect(pending).rejects.toMatchObject({ code: 'AI_CANCELLED' })

    const record = store.records.get('ai-execution-1')!
    expect(record.status).toBe('FAILED')
    expect(record.responseCipher).toBeUndefined()
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"AI_CANCELLED"}')
    // No abort controller leaks across executions.
    expect(executions.cancelActive()).toBe(0)
  })

  it('keeps a genuine provider failure classified even if cancellation races it', async () => {
    const { executions, store } = service({
      provider: { id: 'mock-v1', execute: vi.fn(async () => Promise.reject(new Error('provider broke'))) }
    })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILURE' })
    const record = store.records.get('ai-execution-1')!
    expect(
      decrypt(record.errorCipher!, persistenceKey, aiExecutionErrorContext(record.id)).toString('utf8')
    ).toBe('{"code":"AI_PROVIDER_FAILURE"}')
    expect(executions.cancelActive()).toBe(0)
  })

  it('authenticates response ciphertext to its execution row', () => {
    const { executions, store } = service()
    const first: AiExecution = {
      id: 'ai-1',
      matterId: 'matter-1',
      sanitizedDocumentId: 'sanitized-1',
      providerId: 'mock-v1',
      status: 'COMPLETED',
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2
    }
    const second = { ...first, id: 'ai-2', createdAt: 3, startedAt: 3, finishedAt: 4 }
    store.records.set('ai-1', {
      ...first,
      requestCipher: encrypt(Buffer.from('request'), persistenceKey, aiExecutionRequestContext('ai-1')),
      responseCipher: encrypt(Buffer.from('response one'), persistenceKey, aiExecutionResponseContext('ai-1'))
    })
    store.records.set('ai-2', {
      ...second,
      requestCipher: encrypt(Buffer.from('request'), persistenceKey, aiExecutionRequestContext('ai-2')),
      responseCipher: store.records.get('ai-1')!.responseCipher!
    })

    expect(() => executions.findLatest('sanitized-1')).toThrowError(
      expect.objectContaining({ code: 'AI_RESPONSE_DECRYPTION_FAILED' })
    )
  })

  it('requires an immutable persisted Sanitized Document source', async () => {
    const store = new MemoryAiExecutionStore(undefined)
    const { executions } = service({ store })

    await expect(executions.execute('missing')).rejects.toEqual(
      expect.objectContaining({ code: 'SANITIZED_DOCUMENT_NOT_AVAILABLE' })
    )
    expect(store.records.size).toBe(0)
  })

  it('fails closed before persistence when the sanitized source loses integrity', async () => {
    const store = new MemoryAiExecutionStore(source())
    vi.spyOn(store, 'findSource').mockImplementation(() => {
      throw new Error('mapping mismatch with protected value')
    })
    const { executions, provider } = service({ store })

    await expect(executions.execute('sanitized-1')).rejects.toMatchObject({
      code: 'AI_SOURCE_INTEGRITY_FAILURE'
    })
    expect(provider.execute).not.toHaveBeenCalled()
    expect(store.records.size).toBe(0)
  })
})
