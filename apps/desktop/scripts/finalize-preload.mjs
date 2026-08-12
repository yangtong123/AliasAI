import { copyFile } from 'node:fs/promises'
import { URL } from 'node:url'

const compiledPreload = new URL('../dist/preload/index.js', import.meta.url)
const sandboxedPreload = new URL('../dist/preload/index.cjs', import.meta.url)

await copyFile(compiledPreload, sandboxedPreload)
