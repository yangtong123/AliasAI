import { createHash } from 'node:crypto'
import { basename, extname, resolve } from 'node:path'
import { open, type FileHandle } from 'node:fs/promises'

export class DocumentImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentImportError'
  }
}

export interface ImportedDocumentSource {
  /** Absolute local path. This value must be encrypted before persistence. */
  readonly sourcePath: string
  /** Original local file name. This value must be encrypted before persistence. */
  readonly originalName: string
  readonly fileHash: string
  readonly mimeType: string
  readonly byteSize: number
}

/**
 * Reads a source file without moving, modifying, or copying it. It deliberately
 * does not parse pages or invoke OCR.
 */
export async function inspectDocumentSource(filePath: string): Promise<ImportedDocumentSource> {
  let source: FileHandle | undefined
  try {
    const sourcePath = resolve(filePath)
    source = await open(sourcePath, 'r')
    const file = await source.stat()
    if (!file.isFile()) {
      throw new DocumentImportError('document source must be a regular file')
    }

    return {
      sourcePath,
      originalName: basename(sourcePath),
      fileHash: await sha256File(source),
      mimeType: detectMimeType(sourcePath),
      byteSize: file.size
    }
  } catch (error) {
    if (error instanceof DocumentImportError) throw error
    throw new DocumentImportError('unable to inspect document source')
  } finally {
    if (source !== undefined) {
      try {
        await source.close()
      } catch {
        // The read result is already complete; never leak the source path from a close error.
      }
    }
  }
}

export function detectMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.pdf':
      return 'application/pdf'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.doc':
      return 'application/msword'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    default:
      return 'application/octet-stream'
  }
}

async function sha256File(source: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0

  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) return hash.digest('hex')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}
