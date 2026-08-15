import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { initializeRuntime, resolvePythonRuntime } from './runtime'

describe('desktop runtime', () => {
  const directories: string[] = []
  const previousPythonCommand = process.env.ALIASAI_PYTHON_COMMAND
  const previousWorkerPath = process.env.ALIASAI_NATIVE_WORKER_PATH

  afterEach(async () => {
    for (const name of ['ALIASAI_PYTHON_COMMAND', 'ALIASAI_NATIVE_WORKER_PATH'] as const) {
      const previous = name === 'ALIASAI_PYTHON_COMMAND' ? previousPythonCommand : previousWorkerPath
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
