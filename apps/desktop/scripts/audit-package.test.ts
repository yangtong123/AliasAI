import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const auditScript = fileURLToPath(new URL('./audit-package.mjs', import.meta.url))
const repositoryRoot = resolve(dirname(auditScript), '../../..')
const temporaryDirectories: string[] = []

interface AuditResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('package audit CLI', () => {
  it('accepts a relative app path containing an in-bundle Python symlink', async () => {
    const fixture = await createBundleFixture()

    const result = await runAudit(['AliasAI.app'], fixture.directory)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('package audit passed')
    expect(result.stderr).toBe('')
  })

  it('rejects an absolute symlink target even when the required-file probe follows it', async () => {
    const fixture = await createBundleFixture()
    await rm(fixture.pythonLink)
    await symlink('/bin/sh', fixture.pythonLink)

    const result = await runAudit([fixture.appBundle], fixture.directory)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('FORBIDDEN symlink escapes the bundle')
    expect(result.stderr).toContain('python-runtime/bin/python3 -> /bin/sh')
  })

  it('rejects a relative symlink that escapes the bundle', async () => {
    const fixture = await createBundleFixture()
    const outside = join(fixture.directory, 'outside-python')
    await writeFile(outside, 'not bundled')
    await rm(fixture.pythonLink)
    await symlink(relative(dirname(fixture.pythonLink), outside), fixture.pythonLink)

    const result = await runAudit([fixture.appBundle], fixture.directory)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('FORBIDDEN symlink escapes the bundle')
  })

  it('records the app root and rejects a root permission change', async () => {
    const fixture = await createBundleFixture()
    const manifest = join(fixture.directory, 'manifest.txt')
    const recorded = await runAudit(['--record-manifest', manifest, fixture.appBundle], fixture.directory)
    expect(recorded.exitCode).toBe(0)
    expect(await readFile(manifest, 'utf8')).toMatch(/^d 00040755 - \.$/m)

    await chmod(fixture.appBundle, 0o700)
    const checked = await runAudit(['--check-manifest', manifest, fixture.appBundle], fixture.directory)

    expect(checked.exitCode).toBe(1)
    expect(checked.stderr).toContain('manifest entry changed or removed: d 00040755 - .')
    expect(checked.stderr).toContain('manifest entry changed or added: d 00040700 - .')
  })

  it('rejects an empty directory added after the manifest was recorded', async () => {
    const fixture = await createBundleFixture()
    const manifest = join(fixture.directory, 'manifest.txt')
    expect((await runAudit(['--record-manifest', manifest, fixture.appBundle], fixture.directory)).exitCode).toBe(0)

    await mkdir(join(fixture.appBundle, 'Contents/Resources/empty-after-self-test'))
    const checked = await runAudit(['--check-manifest', manifest, fixture.appBundle], fixture.directory)

    expect(checked.exitCode).toBe(1)
    expect(checked.stderr).toContain('manifest file count changed')
    expect(checked.stderr).toContain('empty-after-self-test')
  })

  it('rejects the actual repository path embedded in a text asset', async () => {
    const fixture = await createBundleFixture()
    await writeFile(join(fixture.appBundle, 'Contents/Resources/config.txt'), `buildRoot=${repositoryRoot}`)

    const result = await runAudit([fixture.appBundle], fixture.directory)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`FORBIDDEN repository path leak (${repositoryRoot})`)
  })
})

async function createBundleFixture(): Promise<{
  readonly directory: string
  readonly appBundle: string
  readonly pythonLink: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'aliasai-package-audit-'))
  temporaryDirectories.push(directory)
  const appBundle = join(directory, 'AliasAI.app')
  const resources = join(appBundle, 'Contents/Resources')
  const pythonBin = join(resources, 'python-runtime/bin')
  const worker = join(resources, 'python-workers/document_parser')
  const nativeBinding = join(resources, 'app.asar.unpacked/node_modules/better-sqlite3/build/Release')
  const drizzle = join(resources, 'app.asar.unpacked/dist/main/drizzle')
  await Promise.all([
    mkdir(join(appBundle, 'Contents/MacOS'), { recursive: true }),
    mkdir(pythonBin, { recursive: true }),
    mkdir(worker, { recursive: true }),
    mkdir(nativeBinding, { recursive: true }),
    mkdir(drizzle, { recursive: true })
  ])
  await Promise.all([
    writeFile(join(appBundle, 'Contents/MacOS/AliasAI'), 'synthetic executable'),
    writeFile(join(appBundle, 'Contents/Info.plist'), '<plist></plist>'),
    writeFile(join(resources, 'app.asar'), 'synthetic asar'),
    writeFile(join(pythonBin, 'python3.12'), 'synthetic python'),
    writeFile(join(worker, 'native_worker.py'), '# synthetic worker'),
    writeFile(join(worker, 'native_pdf.py'), '# synthetic parser'),
    writeFile(join(worker, 'protocol.py'), '# synthetic protocol'),
    writeFile(join(nativeBinding, 'darwin-arm64.node'), 'synthetic native binding'),
    writeFile(join(drizzle, '0000_synthetic.sql'), 'SELECT 1;')
  ])
  const pythonLink = join(pythonBin, 'python3')
  await symlink('python3.12', pythonLink)
  await chmod(appBundle, 0o755)
  return { directory, appBundle, pythonLink }
}

function runAudit(arguments_: readonly string[], cwd: string): Promise<AuditResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [auditScript, ...arguments_], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolveResult({
        exitCode: typeof error?.code === 'number' ? error.code : error === null ? 0 : 1,
        stdout,
        stderr
      })
    })
  })
}
