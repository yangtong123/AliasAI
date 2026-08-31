import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PythonWorkerDocumentProcessor } from '@aliasai/python-bridge'
import {
  PythonRuntimeError,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  initializeRuntime,
  resolveDocumentWorker,
  resolvePackagedPythonResources,
  resolvePythonRuntime
} from './runtime'

describe('desktop runtime', () => {
  const directories: string[] = []
  const previousPythonCommand = process.env.ALIASAI_PYTHON_COMMAND
  const previousWorkerPath = process.env.ALIASAI_NATIVE_WORKER_PATH
  const previousOcrWorkerPath = process.env.ALIASAI_OCR_WORKER_PATH

  afterEach(async () => {
    vi.useRealTimers()
    const previousValues = {
      ALIASAI_PYTHON_COMMAND: previousPythonCommand,
      ALIASAI_NATIVE_WORKER_PATH: previousWorkerPath,
      ALIASAI_OCR_WORKER_PATH: previousOcrWorkerPath
    } as const
    for (const name of Object.keys(previousValues) as (keyof typeof previousValues)[]) {
      const previous = previousValues[name]
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('resolves the python worker from env overrides', () => {
    process.env.ALIASAI_PYTHON_COMMAND = '/synthetic/python'
    process.env.ALIASAI_NATIVE_WORKER_PATH = '/synthetic/worker.py'

    expect(resolvePythonRuntime()).toEqual({ command: '/synthetic/python', args: ['/synthetic/worker.py'] })
  })

  it('finds the repository virtual environment by default', () => {
    delete process.env.ALIASAI_PYTHON_COMMAND
    delete process.env.ALIASAI_NATIVE_WORKER_PATH

    const runtime = resolvePythonRuntime()
    const virtualEnvironmentPython = join(process.cwd(), '.venv/bin/python')
    if (existsSync(virtualEnvironmentPython)) {
      expect(runtime.command).toBe(virtualEnvironmentPython)
    } else {
      expect(runtime.command).toBe('python3')
    }
  })

  it('resolves the worker and venv when cwd is the desktop package', () => {
    delete process.env.ALIASAI_PYTHON_COMMAND
    delete process.env.ALIASAI_NATIVE_WORKER_PATH

    const repoRoot = process.cwd()
    const originalCwd = process.cwd()
    try {
      process.chdir(join(repoRoot, 'apps', 'desktop'))
      const runtime = resolvePythonRuntime()
      const virtualEnvironmentPython = join(repoRoot, '.venv', 'bin', 'python')
      expect(runtime.command).toBe(existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3')
      expect(runtime.args).toEqual([resolve(repoRoot, 'python/document_parser/native_worker.py')])
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('resolves the OCR worker when ALIASAI_OCR_WORKER_PATH is set', () => {
    process.env.ALIASAI_PYTHON_COMMAND = '/synthetic/python'
    process.env.ALIASAI_OCR_WORKER_PATH = '/synthetic/ocr_worker.py'

    expect(resolveDocumentWorker()).toEqual({
      command: '/synthetic/python',
      args: ['/synthetic/ocr_worker.py'],
      parserType: 'OCR_PDF',
      enableOcr: true
    })
  })

  it('falls back to the native worker when ALIASAI_OCR_WORKER_PATH is unset', () => {
    delete process.env.ALIASAI_OCR_WORKER_PATH
    process.env.ALIASAI_PYTHON_COMMAND = '/synthetic/python'
    process.env.ALIASAI_NATIVE_WORKER_PATH = '/synthetic/worker.py'

    expect(resolveDocumentWorker()).toEqual({
      command: '/synthetic/python',
      args: ['/synthetic/worker.py'],
      parserType: 'NATIVE_PDF',
      enableOcr: false
    })
  })

  it('resolves the bundled python runtime for packaged installs', async () => {
    delete process.env.ALIASAI_PYTHON_COMMAND
    delete process.env.ALIASAI_NATIVE_WORKER_PATH
    const resources = await mkdtemp(join(tmpdir(), 'aliasai-resources-'))
    directories.push(resources)
    await mkdir(join(resources, 'python-runtime', 'bin'), { recursive: true })
    await mkdir(join(resources, 'python-workers', 'document_parser'), { recursive: true })
    const pythonCommand = join(resources, 'python-runtime', 'bin', 'python3')
    const nativeWorkerPath = join(resources, 'python-workers', 'document_parser', 'native_worker.py')
    await writeFile(pythonCommand, '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(nativeWorkerPath, '# synthetic worker\n')

    expect(resolvePackagedPythonResources(resources)).toEqual({ pythonCommand, nativeWorkerPath })
    expect(resolvePythonRuntime(resources)).toEqual({ command: pythonCommand, args: [nativeWorkerPath] })
    expect(resolveDocumentWorker(resources)).toEqual({
      command: pythonCommand,
      args: [nativeWorkerPath],
      parserType: 'NATIVE_PDF',
      enableOcr: false
    })
  })

  it('prefers env overrides over bundled packaged resources', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'aliasai-resources-'))
    directories.push(resources)
    await mkdir(join(resources, 'python-runtime', 'bin'), { recursive: true })
    await mkdir(join(resources, 'python-workers', 'document_parser'), { recursive: true })
    await writeFile(join(resources, 'python-runtime', 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(join(resources, 'python-workers', 'document_parser', 'native_worker.py'), '# synthetic\n')
    process.env.ALIASAI_PYTHON_COMMAND = '/synthetic/python'
    process.env.ALIASAI_NATIVE_WORKER_PATH = '/synthetic/worker.py'

    expect(resolvePythonRuntime(resources)).toEqual({ command: '/synthetic/python', args: ['/synthetic/worker.py'] })
  })

  it('fails closed for incomplete packaged resources even inside the repository', async () => {
    delete process.env.ALIASAI_PYTHON_COMMAND
    delete process.env.ALIASAI_NATIVE_WORKER_PATH
    const resources = await mkdtemp(join(tmpdir(), 'aliasai-resources-'))
    directories.push(resources)
    await mkdir(join(resources, 'python-runtime', 'bin'), { recursive: true })
    await writeFile(join(resources, 'python-runtime', 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
    // The worker script is missing: a packaged install must fail closed
    // instead of quietly falling back to the repository checkout.
    expect(resolvePackagedPythonResources(resources)).toBeUndefined()
    expect(() => resolvePythonRuntime(resources)).toThrow(PythonRuntimeError)
    expect(() => resolvePythonRuntime(resources)).toThrow(/bundled Python runtime is missing/)
  })

  it('uses the bundled interpreter for the OCR worker in packaged installs', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'aliasai-resources-'))
    directories.push(resources)
    await mkdir(join(resources, 'python-runtime', 'bin'), { recursive: true })
    await mkdir(join(resources, 'python-workers', 'document_parser'), { recursive: true })
    const pythonCommand = join(resources, 'python-runtime', 'bin', 'python3')
    await writeFile(pythonCommand, '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(
      join(resources, 'python-workers', 'document_parser', 'native_worker.py'),
      '# synthetic worker\n'
    )
    delete process.env.ALIASAI_PYTHON_COMMAND
    process.env.ALIASAI_OCR_WORKER_PATH = '/synthetic/ocr_worker.py'

    expect(resolveDocumentWorker(resources)).toEqual({
      command: pythonCommand,
      args: ['/synthetic/ocr_worker.py'],
      parserType: 'OCR_PDF',
      enableOcr: true
    })
  })

  it('initializes the full runtime against a temp user data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-runtime-'))
    directories.push(directory)
    // Env overrides keep the runtime hermetic: no Python spawn at init time.
    process.env.ALIASAI_PYTHON_COMMAND = 'python3'
    process.env.ALIASAI_NATIVE_WORKER_PATH = resolve(process.cwd(), 'python/document_parser/native_worker.py')

    const runtime = await initializeRuntime(
      { getPath: () => directory, isPackaged: false },
      {
        isEncryptionAvailable: () => true,
        encryptString: (plainText: string) => Buffer.from(`encrypted:${plainText}`),
        decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace('encrypted:', '')
      }
    )
    expect(runtime.keys.persistenceKey.length).toBe(32)
    expect(runtime.services.matters).toBeDefined()
    expect(runtime.services.reviewQuery).toBeDefined()
    expect(runtime.services.preview).toBeDefined()
    // A service round trip proves the database and keys are wired end to end.
    const matter = runtime.services.matters.create('Synthetic Runtime Matter')
    expect(runtime.services.reviewQuery.listMatters().map((item) => item.name)).toContain('Synthetic Runtime Matter')
    void matter
    runtime.close()
  })

  it('shutdown() awaits an in-flight IPC operation and refuses late ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-runtime-ipc-drain-'))
    directories.push(directory)
    process.env.ALIASAI_PYTHON_COMMAND = 'python3'
    process.env.ALIASAI_NATIVE_WORKER_PATH = resolve(process.cwd(), 'python/document_parser/native_worker.py')

    const runtime = await initializeRuntime(
      { getPath: () => directory, isPackaged: false },
      {
        isEncryptionAvailable: () => true,
        encryptString: (plainText: string) => Buffer.from(`encrypted:${plainText}`),
        decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace('encrypted:', '')
      }
    )
    const { createHandlerRegistry } = await import('./ipc/handlers')
    const registry = createHandlerRegistry(runtime, {
      pickPdf: async () => null,
      copyText: () => undefined,
      saveText: async () => false
    })

    // A diagnostic-channel operation gated like a slow worker/network call.
    // Its completion WRITES to the database (captured outside the promise
    // chain) and must land while SQLite is still open.
    let releaseOperation!: () => void
    const gate = new Promise<void>((release) => {
      releaseOperation = release
    })
    let inFlightWrite: { ok: boolean } | undefined
    vi.spyOn(runtime.services.processing, 'process').mockImplementation((documentId: string) =>
      gate.then(() => {
        try {
          runtime.services.matters.create('Written During IPC Drain')
          inFlightWrite = { ok: true }
        } catch {
          inFlightWrite = { ok: false }
        }
        return { id: documentId } as never
      })
    )

    const pending = registry['document:process']({ documentId: 'document-ipc-drain' })
    expect(runtime.ipcOperations.activeCount).toBe(1)

    const shutdownPromise = runtime.shutdown()
    // While draining, NEW operations fail fast with the coded envelope.
    expect(await registry['matter:list']({})).toEqual({
      ok: false,
      error: { code: 'APP_SHUTTING_DOWN', message: 'The application is shutting down' }
    })

    releaseOperation()
    await pending
    await shutdownPromise

    // The in-flight write succeeded (SQLite was still open), the tracker is
    // closed and drained, and the database is closed for direct reads.
    expect(inFlightWrite).toEqual({ ok: true })
    expect(runtime.ipcOperations.closed).toBe(true)
    expect(runtime.ipcOperations.activeCount).toBe(0)
    expect(() => runtime.services.reviewQuery.listMatters()).toThrow()

    // AFTER shutdown completed, IPC still answers with the stable envelope
    // instead of touching the closed database or rejecting raw.
    expect(await registry['matter:list']({})).toEqual({
      ok: false,
      error: { code: 'APP_SHUTTING_DOWN', message: 'The application is shutting down' }
    })
  })

  it('shutdown() awaits active analysis runs before closing SQLite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-runtime-shutdown-'))
    directories.push(directory)
    process.env.ALIASAI_PYTHON_COMMAND = 'python3'
    process.env.ALIASAI_NATIVE_WORKER_PATH = resolve(process.cwd(), 'python/document_parser/native_worker.py')

    const runtime = await initializeRuntime(
      { getPath: () => directory, isPackaged: false },
      {
        isEncryptionAvailable: () => true,
        encryptString: (plainText: string) => Buffer.from(`encrypted:${plainText}`),
        decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace('encrypted:', '')
      }
    )
    const stopWorker = vi.spyOn(PythonWorkerDocumentProcessor.prototype, 'stop')
    const cancelAi = vi.spyOn(runtime.services.ai, 'cancelActive')

    // A deliberately deferred fake analysis run: shutdown must keep SQLite
    // open until the run finished. The in-run write result is captured in a
    // flag OUTSIDE the runner's promise chain — the runner observes and
    // swallows rejections, so the test must read the flag directly instead of
    // trusting drain()/shutdown() completion.
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    let inRunWrite: { ok: boolean } | undefined
    const analyzeSpy = vi.spyOn(runtime.services.analysis, 'analyze').mockImplementation((documentId: string) =>
      gate.then(() => {
        try {
          runtime.services.matters.create('Written During Shutdown Drain')
          inRunWrite = { ok: true }
        } catch {
          inRunWrite = { ok: false }
        }
        return { documentId, status: 'ALREADY_COMPLETE' as const }
      })
    )
    expect(runtime.analysisRunner.start('document-shutdown-order')).toBe(true)
    expect(analyzeSpy).not.toHaveBeenCalledTimes(0)

    const shutdownPromise = runtime.shutdown()
    release()
    await shutdownPromise

    // The write genuinely succeeded while shutdown was draining, proving
    // SQLite stayed open until the run settled.
    expect(inRunWrite).toEqual({ ok: true })

    // The database is CLOSED by now — a direct repository read must fail
    // fast; without this, a silently skipped sqlite.close() would still pass.
    expect(() => runtime.services.reviewQuery.listMatters()).toThrow()

    // Idempotent second shutdown must not throw or resurrect anything.
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    expect(stopWorker).toHaveBeenCalledTimes(1)
    expect(cancelAi).toHaveBeenCalledTimes(1)
  })

  it('closes after the shutdown deadline when an IPC host operation never settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-runtime-shutdown-deadline-'))
    directories.push(directory)
    process.env.ALIASAI_PYTHON_COMMAND = 'python3'
    process.env.ALIASAI_NATIVE_WORKER_PATH = resolve(process.cwd(), 'python/document_parser/native_worker.py')
    const runtime = await initializeRuntime(
      { getPath: () => directory, isPackaged: false },
      {
        isEncryptionAvailable: () => true,
        encryptString: (plainText: string) => Buffer.from(`encrypted:${plainText}`),
        decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace('encrypted:', '')
      }
    )
    const { createHandlerRegistry } = await import('./ipc/handlers')
    const registry = createHandlerRegistry(runtime, {
      pickPdf: () => new Promise<string | null>(() => undefined),
      copyText: () => undefined,
      saveText: async () => false
    })
    vi.useFakeTimers()
    void registry['document:pickAndImport']({ matterId: 'matter-never' })
    expect(runtime.ipcOperations.activeCount).toBe(1)

    const shutdown = runtime.shutdown()
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_TIMEOUT_MS)
    await expect(shutdown).resolves.toBeUndefined()
    expect(() => runtime.services.reviewQuery.listMatters()).toThrow()
    vi.useRealTimers()
  })
})

import { vi } from 'vitest'
