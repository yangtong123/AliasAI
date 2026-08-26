import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiExecutionError, ReviewQueryError } from '@aliasai/application'
import { initializeRuntime, type AliasAiRuntime } from '../runtime'
import { createHandlerRegistry, type HandlerRegistry } from './handlers'
import { ALIASAI_CHANNELS } from './contract'
import { registerIpcHandlers } from './register'
import { IpcValidationError, requireEnum, requireId, requireText } from './validate'
import { toIpcResult } from './errors'

describe('IPC validation', () => {
  it('rejects non-identifier values without echoing them', () => {
    for (const bad of ['', ' ', 'a'.repeat(65), 42, null, undefined, 'line\nbreak']) {
      expect(() => requireId(bad, 'documentId')).toThrow(IpcValidationError)
    }
    const thrown = (() => {
      try {
        // Rejected for the control character, not for being a path.
        requireId('\n/tmp/private-client.pdf', 'documentId')
      } catch (error) {
        return error as IpcValidationError
      }
    })()
    expect(thrown !== undefined).toBe(true)
    if (thrown === undefined) return
    expect(thrown.message).not.toContain('/tmp/private-client.pdf')
    expect(requireId('document-1', 'documentId')).toBe('document-1')
  })

  it('rejects unsupported enum values', () => {
    expect(() => requireEnum('WILDCARD', ['PERSON', 'ORGANIZATION'], 'entityType')).toThrow(IpcValidationError)
    expect(requireEnum('PERSON', ['PERSON', 'ORGANIZATION'], 'entityType')).toBe('PERSON')
  })

  it('rejects empty or oversized text', () => {
    expect(() => requireText('', 'name', 10)).toThrow(IpcValidationError)
    expect(() => requireText('a'.repeat(11), 'name', 10)).toThrow(IpcValidationError)
    expect(requireText('Synthetic', 'name', 10)).toBe('Synthetic')
  })
})

describe('IPC error sanitization', () => {
  it('surfaces codes of known service errors but never their causes', async () => {
    const cause = new Error('ENOENT: no such file /Users/someone/private-client.pdf 13800138000')
    const result = await toIpcResult(() => {
      throw new ReviewQueryError('DOCUMENT_NOT_FOUND', 'Document was not found', { cause })
    })

    expect(result).toEqual({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document was not found' } })
  })

  it('collapses unknown errors to a generic internal error', async () => {
    const result = await toIpcResult(() => {
      throw new TypeError("Cannot read '/Users/someone/Desktop/private.docx' of undefined 110101199003077774")
    })

    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } })
    expect(JSON.stringify(result)).not.toContain('private.docx')
    expect(JSON.stringify(result)).not.toContain('110101199003077774')
  })

  it('surfaces static AI execution errors without their sensitive cause', async () => {
    const result = await toIpcResult(() => {
      throw new AiExecutionError('OUTBOUND_LEAK_DETECTED', 'AI request failed privacy verification', {
        cause: new Error('张伟 /private/client.pdf')
      })
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'OUTBOUND_LEAK_DETECTED', message: 'AI request failed privacy verification' }
    })
    expect(JSON.stringify(result)).not.toContain('张伟')
    expect(JSON.stringify(result)).not.toContain('client.pdf')
  })

  it('returns data on success', async () => {
    expect(await toIpcResult(() => 42)).toEqual({ ok: true, data: 42 })
  })
})

describe('IPC handler registry', () => {
  const directories: string[] = []
  let runtime: AliasAiRuntime
  let registry: HandlerRegistry
  const copyText = vi.fn()
  const saveText = vi.fn(async () => true)
  const host = { pickPdf: async () => '/synthetic/path.pdf', copyText, saveText }

  beforeEach(async () => {
    copyText.mockReset()
    saveText.mockClear()
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-ipc-'))
    directories.push(directory)
    runtime = await initializeRuntime(
      { getPath: () => directory, isPackaged: false },
      {
        isEncryptionAvailable: () => true,
        encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`),
        decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace('enc:', '')
      }
    )
    registry = createHandlerRegistry(runtime, host)
  })

  afterEach(async () => {
    runtime.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('covers exactly the contract channels', () => {
    expect([...Object.keys(registry)].sort()).toEqual([...ALIASAI_CHANNELS].sort())
  })

  it('creates and lists matters through the registry', async () => {
    const created = await registry['matter:create']({ name: 'Synthetic IPC Matter' })
    expect(created.ok).toBe(true)
    const listed = await registry['matter:list']({})
    expect(listed.ok && listed.data.map((matter) => matter.name)).toContain('Synthetic IPC Matter')
  })

  it('trashes and restores a Matter through the lifecycle channels', async () => {
    const created = await registry['matter:create']({ name: 'Synthetic Trash Matter' })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(await registry['matter:trash']({ matterId: created.data.id })).toEqual({ ok: true, data: { changed: true } })
    const listedWhileTrashed = await registry['matter:list']({})
    expect(listedWhileTrashed.ok && listedWhileTrashed.data).toHaveLength(0)
    const trash = await registry['trash:list']({})
    expect(trash.ok && trash.data.matters.map((matter) => matter.name)).toEqual(['Synthetic Trash Matter'])
    expect(JSON.stringify(trash)).not.toContain('cipher')

    expect(await registry['matter:restore']({ matterId: created.data.id })).toEqual({ ok: true, data: { changed: true } })
    const restored = await registry['matter:list']({})
    expect(restored.ok && restored.data.map((matter) => matter.id)).toContain(created.data.id)
    const emptied = await registry['trash:list']({})
    expect(emptied.ok && emptied.data.matters).toHaveLength(0)
  })

  it('trashes and restores a Document through the lifecycle channels', async () => {
    const trashDocument = vi.spyOn(runtime.services.lifecycle, 'trashDocument').mockReturnValue({ changed: true })
    const restoreDocument = vi.spyOn(runtime.services.lifecycle, 'restoreDocument').mockReturnValue({ changed: true })

    expect(await registry['document:trash']({ documentId: 'document-trash-1' })).toEqual({
      ok: true,
      data: { changed: true }
    })
    expect(trashDocument).toHaveBeenCalledWith('document-trash-1')
    expect(await registry['document:restore']({ documentId: 'document-trash-1' })).toEqual({
      ok: true,
      data: { changed: true }
    })
    expect(restoreDocument).toHaveBeenCalledWith('document-trash-1')
  })

  it('validates lifecycle payloads and keeps application error codes in the envelope', async () => {
    expect(await registry['matter:trash']({})).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await registry['matter:restore']({ matterId: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await registry['document:trash']({ documentId: 42 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await registry['document:restore']({ extra: 'field' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await registry['trash:list']({ unexpected: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })

    expect(await registry['matter:trash']({ matterId: 'missing-matter' })).toEqual({
      ok: false,
      error: { code: 'MATTER_NOT_AVAILABLE', message: 'Matter is not available' }
    })
    expect(await registry['document:trash']({ documentId: 'missing-document' })).toEqual({
      ok: false,
      error: { code: 'DOCUMENT_NOT_AVAILABLE', message: 'Document is not available' }
    })
  })

  it('keeps the selected filesystem path in main while importing', async () => {
    const matter = await registry['matter:create']({ name: 'Synthetic Import Matter' })
    expect(matter.ok).toBe(true)
    if (!matter.ok) return
    const imported = vi.spyOn(runtime.services.importDocs, 'importFromPath').mockResolvedValue({
      id: 'document-imported',
      matterId: matter.data.id,
      fileHash: 'synthetic-hash',
      mimeType: 'application/pdf',
      parseStatus: 'IMPORTED',
      createdAt: 1,
      updatedAt: 1
    })
    vi.spyOn(runtime.services.reviewQuery, 'listDocuments').mockReturnValue([
      {
        id: 'document-imported',
        matterId: matter.data.id,
        originalName: 'synthetic.pdf',
        mimeType: 'application/pdf',
        parseStatus: 'IMPORTED',
        pageCount: undefined,
        createdAt: 1,
        updatedAt: 1
      }
    ])

    expect(await registry['document:pickAndImport']({ matterId: matter.data.id })).toMatchObject({
      ok: true,
      data: { id: 'document-imported' }
    })
    expect(imported).toHaveBeenCalledWith(matter.data.id, '/synthetic/path.pdf')
  })

  it('validates payloads with field-level errors', async () => {
    const result = await registry['matter:create']({ name: '' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    if (!result.ok) {
      expect(result.error.message).toContain('name')
    }

    const badDocument = await registry['review:getDocument']({ documentId: 'x'.repeat(100) })
    expect(badDocument.ok).toBe(false)
  })

  it('returns a safe not-found for unknown documents', async () => {
    const result = await registry['review:getDocument']({ documentId: 'missing-document' })

    expect(result).toEqual({ ok: false, error: { code: 'DOCUMENT_NOT_FOUND', message: 'Document was not found' } })
  })

  it('validates the narrow AI channels without exposing provider internals', async () => {
    expect(await registry['ai:latest']({ sanitizedDocumentId: 'missing-sanitized' })).toEqual({
      ok: true,
      data: null
    })
    expect(await registry['ai:execute']({ sanitizedDocumentId: 'missing-sanitized' })).toEqual({
      ok: false,
      error: {
        code: 'SANITIZED_DOCUMENT_NOT_AVAILABLE',
        message: 'Sanitized Document is not available for AI'
      }
    })
  })

  it('reports the AI provider status without ever containing a key', async () => {
    const status = await registry['aiProvider:getStatus']({})
    expect(status).toEqual({
      ok: true,
      data: { provider: 'mock', openai: null, configErrorCode: null }
    })

    const saved = await registry['aiProvider:save']({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: 'sk-synthetic-ipc-key'
    })
    expect(saved).toEqual({
      ok: true,
      data: {
        provider: 'openai-compatible',
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: true },
        configErrorCode: null
      }
    })
    expect(JSON.stringify(saved)).not.toContain('sk-synthetic-ipc-key')

    expect(await registry['aiProvider:clear']({})).toEqual({
      ok: true,
      data: { provider: 'mock', openai: null, configErrorCode: null }
    })
  })

  it('validates provider save payloads and rejects an unsafe base URL', async () => {
    expect(await registry['aiProvider:save']({ provider: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(
      await registry['aiProvider:save']({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' })
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const rejected = await registry['aiProvider:save']({
      provider: 'openai-compatible',
      baseUrl: 'http://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: 'sk-synthetic'
    })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'PROVIDER_CONFIG_INVALID' } })
    // The stored configuration is unchanged after a rejected save.
    expect(await registry['aiProvider:getStatus']({})).toEqual({
      ok: true,
      data: { provider: 'mock', openai: null, configErrorCode: null }
    })
  })

  it('requires a complete configuration before testing the connection', async () => {
    const result = await registry['aiProvider:testConnection']({})
    expect(result).toMatchObject({ ok: false, error: { code: 'AI_PROVIDER_NOT_CONFIGURED' } })
  })

  it('cancels zero executions when none are active', async () => {
    expect(await registry['ai:cancel']({})).toEqual({ ok: true, data: { cancelled: 0 } })
  })

  it('reloads a completed AI result in main before copying or exporting it', async () => {
    const getCompleted = vi.spyOn(runtime.services.ai, 'getCompleted').mockReturnValue({
      id: 'ai-1',
      sanitizedDocumentId: 'sanitized-1',
      providerId: 'mock-v1',
      status: 'COMPLETED',
      sanitizedResponse: 'Synthetic sanitized response',
      rehydratedResponse: 'Synthetic restored response',
      unresolvedTokens: [],
      createdAt: 1,
      finishedAt: 2
    })

    expect(
      await registry['ai:copyResult']({
        executionId: 'ai-1',
        variant: 'REHYDRATED',
        includeRestoreOnRequest: true
      })
    ).toEqual({ ok: true, data: { copied: true } })
    expect(copyText).toHaveBeenCalledWith('Synthetic restored response')
    expect(getCompleted).toHaveBeenCalledWith('ai-1', true)

    expect(await registry['ai:exportResult']({ executionId: 'ai-1', variant: 'SANITIZED' })).toEqual({
      ok: true,
      data: { saved: true }
    })
    expect(saveText).toHaveBeenCalledWith('AliasAI-sanitized-response.txt', 'Synthetic sanitized response')
  })

  it('reloads a sanitized document in main before copying or exporting it', async () => {
    const getSanitizedText = vi
      .spyOn(runtime.services.preview, 'getSanitizedText')
      .mockReturnValue('Synthetic sanitized document')

    expect(
      await registry['preview:copySanitized']({ documentId: 'document-1', sanitizedDocumentId: 'sanitized-1' })
    ).toEqual({ ok: true, data: { copied: true } })
    expect(copyText).toHaveBeenCalledWith('Synthetic sanitized document')

    expect(
      await registry['preview:exportSanitized']({ documentId: 'document-1', sanitizedDocumentId: 'sanitized-1' })
    ).toEqual({ ok: true, data: { saved: true } })
    expect(saveText).toHaveBeenCalledWith('AliasAI-sanitized-document.txt', 'Synthetic sanitized document')
    expect(getSanitizedText).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid AI result delivery variants before touching the clipboard or filesystem', async () => {
    const result = await registry['ai:copyResult']({ executionId: 'ai-1', variant: 'RAW_DATABASE_VALUE' })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(copyText).not.toHaveBeenCalled()
    expect(saveText).not.toHaveBeenCalled()
  })

  it('registers every channel on a fake ipcMain with the aliasai prefix', () => {
    const registered = new Map<string, (event: unknown, payload: unknown) => unknown>()
    registerIpcHandlers(registry, {
      handle: (channel, listener) => registered.set(channel, listener)
    })

    const expected = [...ALIASAI_CHANNELS].sort().map((channel) => `aliasai:${channel}`)
    expect([...registered.keys()].sort()).toEqual(expected)
  })

  it('stays in sync with the preload channel allowlist', async () => {
    const { CHANNELS } = await import('../../../preload/src/channels')

    expect([...CHANNELS].sort()).toEqual([...ALIASAI_CHANNELS].sort())
  })
})
