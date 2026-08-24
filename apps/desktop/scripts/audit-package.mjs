#!/usr/bin/env node
/**
 * Audits a packaged AliasAI.app for accidental inclusions and required
 * pieces. Run against the unpacked electron-builder `dir` target:
 *
 *   node scripts/audit-package.mjs [path-to-AliasAI.app]
 *
 * Fails (exit 1) when a forbidden file is found or a required file is
 * missing. Forbidden entries cover test code, dev config, databases, keys,
 * fixtures, source maps, and repository-local paths.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const releaseRoot = join(desktopRoot, 'release')

const FORBIDDEN_NAMES = [
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.py$/,
  /(^|\.)mock_worker\.py$/,
  /\.tsx?$/,
  /\.jsx?\.map$/,
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
const REPO_PATH_PATTERN = /develop\/project|Users\/[a-z]+\/develop/i

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

async function walk(root) {
  const entries = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile()) entries.push(path)
    }
  }
  return entries
}

async function findAppBundle(explicit) {
  if (explicit !== undefined) return explicit
  const candidates = ['mac-arm64', 'mac', 'mac-x64']
    .map((name) => join(releaseRoot, name, 'AliasAI.app'))
    .filter((path) => existsSync(path))
  if (candidates.length === 0) {
    throw new Error('No AliasAI.app found under release/; pass the .app path explicitly')
  }
  return candidates[0]
}

async function main() {
  const appBundle = await findAppBundle(process.argv[2])
  const violations = []
  const missing = []

  for (const required of REQUIRED) {
    if (!(await isFile(join(appBundle, required)))) missing.push(required)
  }

  const files = await walk(appBundle)
  let sawNativeBinding = false
  let sawDrizzleSql = false
  for (const file of files) {
    const relativePath = relative(appBundle, file)
    const segments = relativePath.split('/')
    const base = segments[segments.length - 1]
    // The bundled Python runtime legitimately ships compiled bytecode caches.
    const insidePythonRuntime = relativePath.startsWith('Contents/Resources/python-runtime/')
    if (!insidePythonRuntime && segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      violations.push(`forbidden directory segment: ${relativePath}`)
    }
    if (
      FORBIDDEN_NAMES.some((pattern) => pattern.test(base)) &&
      !(insidePythonRuntime && /\.pyc$/.test(base))
    ) {
      violations.push(`forbidden file name: ${relativePath}`)
    }
    if (
      relativePath.includes('node_modules/better-sqlite3') &&
      base.endsWith('.node') &&
      (base.startsWith('darwin-') || base === 'better_sqlite3.node')
    ) {
      sawNativeBinding = true
    }
    if (relativePath.includes('drizzle') && base.endsWith('.sql')) sawDrizzleSql = true

    const info = await stat(file)
    if (info.size <= 2 * 1024 * 1024) {
      const extension = base.slice(base.lastIndexOf('.'))
      if (TEXT_EXTENSIONS.has(extension)) {
        const text = await readFile(file, 'utf8')
        if (REPO_PATH_PATTERN.test(text)) violations.push(`repository path leak: ${relativePath}`)
      }
    }
  }
  if (!sawNativeBinding) missing.push('node_modules/better-sqlite3 darwin native binding')
  if (!sawDrizzleSql) missing.push('**/drizzle/*.sql (database migrations)')

  for (const violation of violations) console.error(`FORBIDDEN ${violation}`)
  for (const entry of missing) console.error(`MISSING   ${entry}`)
  if (violations.length > 0 || missing.length > 0) {
    console.error(`package audit failed: ${violations.length} forbidden, ${missing.length} missing`)
    process.exit(1)
  }
  console.log(`package audit passed: ${files.length} files in ${appBundle}`)
}

await main()
