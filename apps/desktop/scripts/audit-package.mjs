#!/usr/bin/env node
/**
 * Audits a packaged AliasAI.app for accidental inclusions and required
 * pieces, and can prove the bundle is byte-identical across a run:
 *
 *   node scripts/audit-package.mjs [app-path]                      # rule audit
 *   node scripts/audit-package.mjs --record-manifest <file> [...]   # audit + write manifest
 *   node scripts/audit-package.mjs --check-manifest <file> [...]    # audit + compare manifest
 *
 * The manifest records every file's relative path, type, permissions, and
 * SHA-256 (symlinks record their target). A strict comparison afterwards
 * fails on any added, removed, modified, or re-permissioned entry, so a
 * passing check proves a run (for example the packaged self-test) did not
 * mutate the bundle at all — not merely that it still satisfies the rules.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, lstat, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(dirname(desktopRoot))
const releaseRoot = join(desktopRoot, 'release')

const FORBIDDEN_NAMES = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.py$/,
  /(^|\.)mock_worker\.py$/,
  /\.tsx?$/,
  /\.map$/,
  /\.pyc$/,
  /^\.env(\..*)?$/,
  /\.(db|sqlite|sqlite3)$/,
  /^aliasai\.keys$/,
  /\.(pem|key)$/,
  /^pnpm-workspace\.yaml$/,
  /^pnpm-lock\.yaml$/,
  /^\.DS_Store$/
]
const FORBIDDEN_SEGMENTS = new Set(['.venv', 'tests', '__pycache__', '.pytest_cache', 'coverage', '.git'])
const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.py', '.txt', '.plist'])
/** Inline source maps embed full sources; standalone .map files are also banned. */
const INLINE_SOURCE_MAP = 'sourceMappingURL=data:'
/**
 * Absolute-path leaks: the actual repository checkout this was built from,
 * common CI workspace locations, and the usual developer checkout roots.
 * Matched as plain substrings (no regex metacharacters assumed).
 */
const FORBIDDEN_PATH_STRINGS = [
  repositoryRoot,
  '/Users/runner/work',
  '/home/runner/work'
]
const FORBIDDEN_PATH_PATTERN = /\/Users\/[a-z]+\/(develop|src|work|projects|code|dev)\//

const REQUIRED = [
  'Contents/MacOS/AliasAI',
  'Contents/Info.plist',
  'Contents/Resources/app.asar',
  'Contents/Resources/python-runtime/bin/python3',
  'Contents/Resources/python-workers/document_parser/native_worker.py',
  'Contents/Resources/python-workers/document_parser/native_pdf.py',
  'Contents/Resources/python-workers/document_parser/protocol.py'
]

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Flat list of every directory (including the root), file, and symlink. */
async function collectEntries(root) {
  const entries = [{ relativePath: '.', type: 'd', mode: (await stat(root)).mode }]
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        // Directories are manifest entries too: a new empty directory or a
        // permission change must fail the strict comparison.
        const info = await stat(path)
        entries.push({ relativePath: relative(root, path), type: 'd', mode: info.mode })
        queue.push(path)
      } else if (entry.isFile()) {
        const info = await stat(path)
        entries.push({ relativePath: relative(root, path), type: 'f', mode: info.mode, path })
      } else if (entry.isSymbolicLink()) {
        entries.push({ relativePath: relative(root, path), type: 'l', mode: 0, path, target: await readlink(path) })
      }
    }
  }
  entries.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1))
  return entries
}

/**
 * A symlink is only legal when it resolves inside the bundle: absolute
 * targets and chains escaping the .app would pass every other check (the
 * REQUIRED probes follow links) while shipping a binary that only works on
 * the build machine — python3 -> /bin/sh must fail here.
 */
async function assertSymlinkContained(root, entry, violations) {
  const lexical = resolve(dirname(entry.path), entry.target)
  if (isAbsolute(entry.target) || !lexical.startsWith(`${root}${sep}`)) {
    violations.push(`symlink escapes the bundle: ${entry.relativePath} -> ${entry.target}`)
    return
  }
  let real
  try {
    real = await realpath(entry.path)
  } catch {
    violations.push(`broken symlink: ${entry.relativePath} -> ${entry.target}`)
    return
  }
  const realRoot = await realpath(root)
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
    violations.push(`symlink resolves outside the bundle: ${entry.relativePath} -> ${entry.target}`)
  }
}

function manifestLine(entry, digest) {
  if (entry.type === 'l') return `l 00000000 symlink->${entry.target} ${entry.relativePath}`
  if (entry.type === 'd') return `d ${entry.mode.toString(8).padStart(8, '0')} - ${entry.relativePath}`
  return `f ${entry.mode.toString(8).padStart(8, '0')} ${digest} ${entry.relativePath}`
}

function scanTextForViolations(text, relativePath, violations) {
  if (text.includes(INLINE_SOURCE_MAP)) violations.push(`inline source map: ${relativePath}`)
  for (const forbidden of FORBIDDEN_PATH_STRINGS) {
    if (text.includes(forbidden)) violations.push(`repository path leak (${forbidden}): ${relativePath}`)
  }
  if (FORBIDDEN_PATH_PATTERN.test(text)) violations.push(`repository path leak (pattern): ${relativePath}`)
}

/**
 * Upstream wheels ship SBOM provenance under .dist-info/sboms/ that
 * legitimately references the VENDOR's own CI workspace (for example
 * cryptography's /Users/runner/work/... build paths). Those artifacts are
 * covered by the requirements-lock hashes, so they are exempt from
 * path-leak scanning — our own build paths never appear there.
 */
function isThirdPartyProvenance(relativePath) {
  return relativePath.startsWith('Contents/Resources/python-runtime/') && relativePath.includes('.dist-info/sboms/')
}

async function findAppBundle(explicit) {
  // Always hand back an absolute path: symlink containment compares the
  // resolved link target against this root by prefix, and a relative root
  // would misjudge every legitimate in-bundle link as an escape.
  if (explicit !== undefined) return resolve(explicit)
  const candidates = ['mac-arm64', 'mac', 'mac-x64']
    .map((name) => join(releaseRoot, name, 'AliasAI.app'))
    .filter((path) => existsSync(path))
  if (candidates.length === 0) {
    throw new Error('No AliasAI.app found under release/; pass the .app path explicitly')
  }
  return resolve(candidates[0])
}

function parseArguments(raw) {
  const positional = []
  let recordManifest
  let checkManifest
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '--record-manifest') recordManifest = raw[(index += 1)]
    else if (raw[index] === '--check-manifest') checkManifest = raw[(index += 1)]
    else positional.push(raw[index])
  }
  return { positional, recordManifest, checkManifest }
}

async function main() {
  const { positional, recordManifest, checkManifest } = parseArguments(process.argv.slice(2))
  const appBundle = await findAppBundle(positional[0])
  const violations = []
  const missing = []

  for (const required of REQUIRED) {
    if (!(await isFile(join(appBundle, required)))) missing.push(required)
  }

  const entries = await collectEntries(appBundle)
  let sawNativeBinding = false
  let sawDrizzleSql = false
  const manifest = []
  for (const entry of entries) {
    const { relativePath } = entry
    const segments = relativePath.split('/')
    const base = segments[segments.length - 1]
    // The bundled Python runtime legitimately ships compiled bytecode caches.
    const insidePythonRuntime = relativePath.startsWith('Contents/Resources/python-runtime/')
    if (!insidePythonRuntime && segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      violations.push(`forbidden directory segment: ${relativePath}`)
    }
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(base)) && !(insidePythonRuntime && /\.pyc$/.test(base))) {
      violations.push(`forbidden file name: ${relativePath}`)
    }
    if (relativePath.includes('node_modules/better-sqlite3') && base.endsWith('.node') && base.startsWith('darwin-')) {
      sawNativeBinding = true
    }
    if (relativePath.includes('drizzle') && base.endsWith('.sql')) sawDrizzleSql = true

    if (entry.type === 'd') {
      manifest.push(manifestLine(entry))
      continue
    }
    if (entry.type === 'l') {
      await assertSymlinkContained(appBundle, entry, violations)
      manifest.push(manifestLine(entry))
      continue
    }
    const bytes = await readFile(entry.path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    manifest.push(manifestLine(entry, digest))

    const info = await lstat(entry.path)
    if (info.size <= 2 * 1024 * 1024) {
      const extension = base.slice(base.lastIndexOf('.'))
      if (TEXT_EXTENSIONS.has(extension)) {
        const text = bytes.toString('utf8')
        if (!isThirdPartyProvenance(relativePath)) {
          scanTextForViolations(text, relativePath, violations)
        } else if (text.includes(INLINE_SOURCE_MAP)) {
          violations.push(`inline source map: ${relativePath}`)
        }
      }
    }
  }
  if (!sawNativeBinding) missing.push('node_modules/better-sqlite3 darwin native binding')
  if (!sawDrizzleSql) missing.push('**/drizzle/*.sql (database migrations)')

  // The asar archive is one binary file the walk above cannot classify; scan
  // it directly for embedded inline source maps and path leaks.
  const asarPath = join(appBundle, 'Contents/Resources/app.asar')
  if (await isFile(asarPath)) {
    const asar = await readFile(asarPath)
    scanTextForViolations(asar.toString('latin1'), 'app.asar', violations)
  }

  if (recordManifest !== undefined) {
    await writeFile(recordManifest, `${manifest.join('\n')}\n`)
  }
  if (checkManifest !== undefined) {
    const previous = (await readFile(checkManifest, 'utf8')).split('\n').filter((line) => line.length > 0)
    const current = manifest
    if (previous.length !== current.length) {
      violations.push(`manifest file count changed: ${previous.length} -> ${current.length}`)
    }
    const before = new Set(previous)
    const after = new Set(current)
    for (const line of before) if (!after.has(line)) violations.push(`manifest entry changed or removed: ${line}`)
    for (const line of after) if (!before.has(line)) violations.push(`manifest entry changed or added: ${line}`)
  }

  for (const violation of violations.slice(0, 50)) console.error(`FORBIDDEN ${violation}`)
  if (violations.length > 50) console.error(`... and ${violations.length - 50} more`)
  for (const entry of missing) console.error(`MISSING   ${entry}`)
  if (violations.length > 0 || missing.length > 0) {
    console.error(`package audit failed: ${violations.length} forbidden, ${missing.length} missing`)
    process.exit(1)
  }
  const manifestSuffix =
    recordManifest !== undefined
      ? `, manifest written (${manifest.length} entries)`
      : checkManifest !== undefined
        ? `, manifest verified (${manifest.length} entries)`
        : ''
  console.log(`package audit passed: ${manifest.length} files in ${appBundle}${manifestSuffix}`)
}

await main()
