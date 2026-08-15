import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')
const packageRoot = dirname(fileURLToPath(import.meta.url))

/**
 * Bundles the main process and all workspace TS sources into one CJS file so
 * `electron .` runs without a TypeScript loader. import.meta.url is mapped to
 * the bundle's real location (the database client locates the Drizzle
 * migrations folder relative to it), and the migrations are copied next to the
 * bundle so runtime resolution matches.
 */
async function copyMigrations() {
  const target = resolve(packageRoot, '../dist/main/drizzle')
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(resolve(packageRoot, '../../../packages/database/drizzle'), target, { recursive: true })
}

const options = {
  entryPoints: ['main/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/main/index.cjs',
  external: ['electron', 'better-sqlite3'],
  banner: {
    js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;'
  },
  define: {
    'import.meta.url': '__import_meta_url'
  },
  sourcemap: 'inline',
  logLevel: 'info'
}

if (watch) {
  const watchContext = await context(options)
  await watchContext.watch()
} else {
  await build(options)
}
await copyMigrations()
