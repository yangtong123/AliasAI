import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Electron's sandboxed preload cannot require sibling files. Bundle the
// allowlist and bridge into one CommonJS artifact rather than merely renaming
// TypeScript's multi-file CommonJS output.
await build({
  entryPoints: [resolve(desktopRoot, 'preload/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: resolve(desktopRoot, 'dist/preload/index.cjs'),
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info'
})
