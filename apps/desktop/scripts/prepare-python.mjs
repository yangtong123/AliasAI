#!/usr/bin/env node
/**
 * Provisions the Python runtime and document-worker sources that ship inside
 * the packaged app as extraResources (`python-runtime/`, `python-workers/`).
 *
 * The runtime is a pinned python-build-standalone (install_only_stripped)
 * CPython; requirements install with --require-hashes from the committed
 * python-requirements.lock, so a packaged build never depends on the
 * developer's .venv, system Python, or index drift.
 *
 * A single global stamp (arch, archive checksum, lock checksum, worker
 * source checksum) guards the shared build/ output: a cache hit requires the
 * stamp to match exactly, so switching architectures or editing worker
 * sources always reprovisions. Provisioning happens in a staging directory
 * that is swapped into place atomically only after every step succeeded.
 *
 * Usage: node scripts/prepare-python.mjs [--arch arm64|x64]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(dirname(desktopRoot))
const buildRoot = join(desktopRoot, 'build')
const cacheRoot = join(buildRoot, 'cache')
const runtimeRoot = join(buildRoot, 'python-runtime')
const workersRoot = join(buildRoot, 'python-workers')
const lockPath = join(desktopRoot, 'python-requirements.lock')

/** Pinned python-build-standalone release; sha256 values come from the release's SHA256SUMS. */
const PYTHON_BUILD_STANDALONE = {
  release: '20260814',
  python: '3.12.14',
  base: 'https://github.com/astral-sh/python-build-standalone/releases/download',
  archives: {
    arm64: {
      name: 'cpython-3.12.14+20260814-aarch64-apple-darwin-install_only_stripped.tar.gz',
      sha256: 'dd5b76ab11451a4a4367c17c61d944dded56b425396b07f102922a7ebef7d55f'
    },
    x64: {
      name: 'cpython-3.12.14+20260814-x86_64-apple-darwin-install_only_stripped.tar.gz',
      sha256: 'aec265e3cddaccdb2a3d783331596351b24d4a63c97af0a38f75f643c9451de9'
    }
  }
}

/** Worker sources bundled with the app; everything else (tests, mock/OCR workers) stays out. */
const WORKER_FILES = ['native_worker.py', 'native_pdf.py', 'protocol.py']

/**
 * The runtime ships interpreters only: pip's and pdfminer's console scripts
 * (pip, dumppdf, pdf2txt, ...) embed the build machine's absolute path in
 * their shebangs and are never invoked by the app.
 */
const KEEP_BIN_ENTRIES = new Set(['python', 'python3', 'python3.12'])

function resolveArchitecture(raw) {
  const flag = raw.findIndex((argument) => argument === '--arch')
  if (flag !== -1 && raw[flag + 1] === 'arm64') return 'arm64'
  if (flag !== -1 && raw[flag + 1] === 'x64') return 'x64'
  if (process.platform !== 'darwin') {
    throw new Error(`Packaging the Python runtime only supports macOS (got ${process.platform})`)
  }
  if (flag !== -1) throw new Error('--arch must be arm64 or x64')
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

async function sha256(data) {
  const hash = createHash('sha256')
  hash.update(data)
  return hash.digest('hex')
}

async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info : undefined
  } catch {
    return undefined
  }
}

async function download(url, destination) {
  // curl is more robust than fetch against GitHub's release CDN (proxy and
  // keep-alive quirks) and is present on every macOS and CI runner.
  const result = spawnSync(
    'curl',
    ['-fSL', '--retry', '3', '--connect-timeout', '30', '-o', destination, url],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) throw new Error(`Downloading ${url} failed`)
}

async function extract(archive, directory) {
  const result = spawnSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Extracting ${archive} failed`)
}

function runPython(python, arguments_) {
  const result = spawnSync(python, arguments_, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`python ${arguments_.join(' ')} failed`)
}

/** Stamp over every input that the shared build/ output depends on. */
async function stampContents(arch, pin) {
  const lockData = await readFile(lockPath)
  const workers = await Promise.all(
    WORKER_FILES.map(async (file) => `${file}:${await sha256(await readFile(join(repositoryRoot, 'python', 'document_parser', file)))}`)
  )
  // The provisioning recipe itself counts too: changing pip flags, pruning
  // rules, or the assembly flow must invalidate an existing cache.
  const recipe = await sha256(await readFile(fileURLToPath(import.meta.url)))
  return [
    `arch=${arch}`,
    `archive=${pin.sha256}`,
    `lock=${await sha256(lockData)}`,
    `workers=${workers.join(',')}`,
    `recipe=${recipe}`
  ].join('\n')
}

async function provision(staging, archivePath) {
  await extract(archivePath, staging)
  // install_only archives extract a single top-level "python/" directory.
  const runtime = join(staging, 'python')
  if (!existsSync(runtime)) throw new Error('Archive layout changed: no python/ directory')
  const pythonCommand = join(runtime, 'bin', 'python3')

  // Wheel hashes are verified by pip itself; nothing installs without a match.
  runPython(pythonCommand, [
    '-m',
    'pip',
    'install',
    '--no-cache-dir',
    '--disable-pip-version-check',
    '--require-hashes',
    '-r',
    lockPath
  ])

  // Strip every bin entry except the interpreters: console scripts carry
  // the build machine's absolute paths and would leak them into the app.
  for (const entry of await readdir(join(runtime, 'bin'))) {
    if (KEEP_BIN_ENTRIES.has(entry)) continue
    await rm(join(runtime, 'bin', entry), { recursive: true, force: true })
  }
  // The app never installs packages at runtime; dropping pip (and its
  // vendored CA bundle) keeps the bundle lean and path-clean.
  const sitePackages = join(runtime, 'lib', `python${PYTHON_BUILD_STANDALONE.python.slice(0, 4)}`, 'site-packages')
  for (const entry of await readdir(sitePackages)) {
    if (entry === 'pip' || /^pip-.*\.dist-info$/.test(entry) || /^setuptools/.test(entry) || /^wheel/.test(entry)) {
      await rm(join(sitePackages, entry), { recursive: true, force: true })
    }
  }

  const workers = join(staging, 'python-workers', 'document_parser')
  await mkdir(workers, { recursive: true })
  for (const file of WORKER_FILES) {
    const source = join(repositoryRoot, 'python', 'document_parser', file)
    if (!existsSync(source)) throw new Error(`Worker source missing: ${source}`)
    await writeFile(join(workers, file), await readFile(source))
  }
  return { runtime, workers: join(staging, 'python-workers') }
}

/** Swaps staged directories into build/ so a failed run never leaves mixed output. */
async function swapIntoPlace(stagedRuntime, stagedWorkers) {
  await mkdir(buildRoot, { recursive: true })
  const retired = []
  for (const [staged, target] of [
    [stagedRuntime, runtimeRoot],
    [stagedWorkers, workersRoot]
  ]) {
    if (existsSync(target)) {
      const trash = `${target}.retired`
      await rm(trash, { recursive: true, force: true })
      await rename(target, trash)
      retired.push(trash)
    }
    await rename(staged, target)
  }
  for (const trash of retired) await rm(trash, { recursive: true, force: true })
}

async function main() {
  const arch = resolveArchitecture(process.argv.slice(2))
  const pin = PYTHON_BUILD_STANDALONE.archives[arch]
  const stampPath = join(buildRoot, 'python.stamp')
  const stamp = await stampContents(arch, pin)
  const stampUnchanged = (await isFile(stampPath)) !== undefined && (await readFile(stampPath, 'utf8')) === stamp
  if (
    stampUnchanged &&
    existsSync(join(runtimeRoot, 'bin', 'python3')) &&
    existsSync(join(workersRoot, 'document_parser', 'native_worker.py'))
  ) {
    console.log(`python runtime (${arch}) already provisioned`)
    return
  }

  await mkdir(cacheRoot, { recursive: true })
  const archivePath = join(cacheRoot, pin.name)
  if ((await isFile(archivePath)) !== undefined && (await sha256(await readFile(archivePath))) !== pin.sha256) {
    await rm(archivePath, { force: true })
  }
  if ((await isFile(archivePath)) === undefined) {
    const url = `${PYTHON_BUILD_STANDALONE.base}/${PYTHON_BUILD_STANDALONE.release}/${pin.name}`
    console.log(`downloading ${url}`)
    await download(url, archivePath)
  }
  if ((await sha256(await readFile(archivePath))) !== pin.sha256) {
    throw new Error(`Checksum mismatch for ${pin.name}`)
  }

  // Staging stays inside build/ (same volume) so the final swap is atomic.
  const staging = await mkdtemp(join(buildRoot, 'python-staging-'))
  try {
    const staged = await provision(staging, archivePath)
    await swapIntoPlace(staged.runtime, staged.workers)
    await writeFile(stampPath, stamp)
    console.log(`python runtime (${arch}) ready: ${runtimeRoot}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

await main()
