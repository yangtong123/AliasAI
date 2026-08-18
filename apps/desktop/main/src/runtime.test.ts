import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeRuntime, resolveDocumentWorker, resolvePythonRuntime } from './runtime'

describe('desktop runtime', () => {
  const directories: string[] = []
  const previousPythonCommand = process.env.ALIASAI_PYTHON_COMMAND
  const previousWorkerPath = process.env.ALIASAI_NATIVE_WORKER_PATH
  const previousOcrWorkerPath = process.env.ALIASAI_OCR_WORKER_PATH

  afterEach(async () => {
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

  it('initializes the full runtime against a temp user data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-runtime-'))
    directories.push(directory)
    // Env overrides keep the runtime hermetic: no Python spawn at init time.
    process.env.ALIASAI_PYTHON_COMMAND = 'python3'
    process.env.ALIASAI_NATIVE_WORKER_PATH = resolve(process.cwd(), 'python/document_parser/native_worker.py')

    const runtime = await initializeRuntime(
      { getPath: () => directory },
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
})
