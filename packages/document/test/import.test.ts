import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentImportError, detectMimeType, inspectDocumentSource } from '../src/index'

describe('document source inspection', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('hashes a synthetic source without modifying it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-document-'))
    temporaryDirectories.push(directory)
    const source = join(directory, 'synthetic.pdf')
    const original = Buffer.from('synthetic document bytes')
    await writeFile(source, original)

    const result = await inspectDocumentSource(source)

    expect(result).toMatchObject({
      sourcePath: source,
      originalName: 'synthetic.pdf',
      mimeType: 'application/pdf',
      byteSize: original.length
    })
    expect(result.fileHash).toBe(createHash('sha256').update(original).digest('hex'))
    expect(await readFile(source)).toEqual(original)
  })

  it('maps the supported source extensions and leaves unknown formats generic', () => {
    expect(detectMimeType('scan.TIFF')).toBe('image/tiff')
    expect(detectMimeType('unknown.bin')).toBe('application/octet-stream')
  })

  it('wraps filesystem failures without exposing the absolute source path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aliasai-document-'))
    temporaryDirectories.push(directory)
    const source = join(directory, 'confidential-client-name.pdf')

    const error = await inspectDocumentSource(source).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DocumentImportError)
    expect(String(error)).toBe('DocumentImportError: unable to inspect document source')
    expect(String(error)).not.toContain(source)
    expect(String(error)).not.toContain('confidential-client-name.pdf')
  })
})
