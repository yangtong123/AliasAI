import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReviewQueryError } from '@aliasai/application'
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

  it('returns data on success', async () => {
    expect(await toIpcResult(() => 42)).toEqual({ ok: true, data: 42 })
  })
})

describe('IPC handler registry', () => {
  const directories: string[] = []
  let runtime: AliasAiRuntime
  let registry: HandlerRegistry
  const host = { pickPdf: async () => '/synthetic/path.pdf' }

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-ipc-'))
    directories.push(directory)
    runtime = await initializeRuntime(
      { getPath: () => directory },
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
