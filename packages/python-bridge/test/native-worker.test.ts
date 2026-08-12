import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PythonWorkerClient, type WorkerEvent } from '../src/index'

function createSyntheticPdf(path: string): void {
  const content = 'BT /F1 11 Tf 24 84 Td (Synthetic native text) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${value}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  writeFileSync(path, output, 'ascii')
}

describe('native PDF worker integration', () => {
  const virtualEnvironmentPython = resolve(process.cwd(), '.venv/bin/python')
  const pythonCommand = existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python3'
  const temporaryDirectories: string[] = []
  let worker: PythonWorkerClient | undefined

  afterEach(() => {
    worker?.stop()
    worker = undefined
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('streams a native PDF as schema-validated Protocol v1 page results', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aliasai-native-worker-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'synthetic.pdf')
    createSyntheticPdf(sourcePath)

    const events: WorkerEvent[] = []
    worker = new PythonWorkerClient({
      command: pythonCommand,
      args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')],
      onEvent: (event) => {
        events.push(event)
      }
    })
    worker.start()

    await expect(
      worker.processDocument({
        protocolVersion: 1,
        type: 'process_document',
        jobId: 'native-job-1',
        documentId: 'native-document-1',
        filePath: sourcePath,
        options: {
          preferNativeText: true,
          enableOcr: false,
          enableLayoutAnalysis: false,
          pageStart: 1,
          pageEnd: null
        }
      })
    ).resolves.toMatchObject({ type: 'completed', pageCount: 1, processedPages: 1 })

    const pageResult = events.find((event) => event.type === 'page_result')
    expect(pageResult).toMatchObject({
      type: 'page_result',
      documentId: 'native-document-1',
      page: {
        pageNo: 1,
        originalWidth: 240,
        originalHeight: 120,
        rotation: 0,
        sourceType: 'NATIVE',
        blocks: [
          {
            localId: 'page-1-block-1',
            blockType: 'TEXT',
            text: 'Synthetic native text',
            source: 'NATIVE',
            readingOrder: 0
          }
        ]
      }
    })
    expect(JSON.stringify(events)).not.toContain(sourcePath)
  })

  it('returns a safe terminal error when the source file is unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aliasai-native-worker-missing-'))
    temporaryDirectories.push(directory)
    const sourcePath = join(directory, 'private-client-name.pdf')
    worker = new PythonWorkerClient({
      command: pythonCommand,
      args: [resolve(process.cwd(), 'python/document_parser/native_worker.py')]
    })
    worker.start()

    await expect(
      worker.processDocument({
        protocolVersion: 1,
        type: 'process_document',
        jobId: 'native-job-missing',
        documentId: 'native-document-missing',
        filePath: sourcePath,
        options: {
          preferNativeText: true,
          enableOcr: false,
          enableLayoutAnalysis: false,
          pageStart: 1,
          pageEnd: null
        }
      })
    ).resolves.toMatchObject({
      type: 'error',
      code: 'FILE_NOT_FOUND',
      message: 'Document file was not found',
      retryable: false
    })
  })
})
