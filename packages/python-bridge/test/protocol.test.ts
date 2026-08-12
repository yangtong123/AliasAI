import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PythonWorkerClient,
  normalizedBBoxSchema,
  parseWorkerEvent,
  processDocumentRequestSchema,
  type ProcessDocumentRequest,
  type WorkerEvent
} from '../src/index'

function processDocumentRequest(jobId = 'job-1', documentId = 'document-1'): ProcessDocumentRequest {
  return {
    protocolVersion: 1,
    type: 'process_document',
    jobId,
    documentId,
    filePath: '/synthetic/private/source.pdf',
    options: {
      preferNativeText: true,
      enableOcr: false,
      enableLayoutAnalysis: false,
      pageStart: 1,
      pageEnd: null
    }
  }
}

function inlinePythonWorker(script: string, onEvent?: (event: WorkerEvent) => void | Promise<void>): PythonWorkerClient {
  return new PythonWorkerClient({
    command: 'python3',
    args: ['-u', '-c', script],
    ...(onEvent === undefined ? {} : { onEvent })
  })
}

describe('Python worker Protocol v1', () => {
  let worker: PythonWorkerClient | undefined

  afterEach(() => {
    worker?.stop()
  })

  it('rejects an unknown protocol version at the TypeScript boundary', () => {
    expect(() => parseWorkerEvent({ protocolVersion: 2, type: 'started', jobId: 'job-1', documentId: 'doc-1' })).toThrow()
  })

  it('rejects boolean and inverted page ranges at the TypeScript boundary', () => {
    const request = processDocumentRequest()
    const optionsWithoutPageEnd = {
      preferNativeText: request.options.preferNativeText,
      enableOcr: request.options.enableOcr,
      enableLayoutAnalysis: request.options.enableLayoutAnalysis,
      pageStart: request.options.pageStart
    }

    expect(() =>
      processDocumentRequestSchema.parse({ ...request, options: { ...request.options, pageStart: true } })
    ).toThrow()
    expect(() =>
      processDocumentRequestSchema.parse({ ...request, options: { ...request.options, pageEnd: true } })
    ).toThrow()
    expect(() =>
      processDocumentRequestSchema.parse({ ...request, options: { ...request.options, pageStart: 5, pageEnd: 4 } })
    ).toThrow('pageEnd must be greater than or equal to pageStart')
    expect(() => processDocumentRequestSchema.parse({ ...request, options: optionsWithoutPageEnd })).toThrow()
  })

  it('rejects normalized boxes that extend beyond the page', () => {
    expect(normalizedBBoxSchema.parse({ x: 0.2, y: 0.1, width: 0.8, height: 0.9 })).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.8,
      height: 0.9
    })
    expect(() => normalizedBBoxSchema.parse({ x: 0.8, y: 0.1, width: 0.3, height: 0.2 })).toThrow(
      'bbox.x + bbox.width must not exceed 1'
    )
    expect(() => normalizedBBoxSchema.parse({ x: 0.1, y: 0.8, width: 0.2, height: 0.3 })).toThrow(
      'bbox.y + bbox.height must not exceed 1'
    )
  })

  it('runs the JSON Lines mock-worker contract without leaking the local file path into events', async () => {
    const events: object[] = []
    worker = new PythonWorkerClient({
      command: 'python3',
      args: [resolve(process.cwd(), 'python/document_parser/mock_worker.py')],
      onEvent: (event) => {
        events.push(event)
      }
    })
    worker.start()

    await expect(
      worker.processDocument(processDocumentRequest())
    ).resolves.toMatchObject({ type: 'completed', processedPages: 1 })

    expect(events.map((event) => JSON.stringify(event)).join('\n')).not.toContain('/synthetic/private/source.pdf')
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'started',
      'progress',
      'page_result',
      'completed'
    ])
  })

  it('cancels a mock-worker job cooperatively and receives a terminal event', async () => {
    worker = new PythonWorkerClient({
      command: 'python3',
      args: [resolve(process.cwd(), 'python/document_parser/mock_worker.py')],
      onEvent: (event) => {
        if (event.type === 'started') worker?.cancelJob(event.jobId)
      }
    })
    worker.start()

    await expect(worker.processDocument(processDocumentRequest('cancel-job'))).resolves.toMatchObject({
      type: 'cancelled',
      jobId: 'cancel-job',
      documentId: 'document-1',
      lastCompletedPage: 0
    })
  })

  it('drains worker stderr so operational logs cannot block protocol progress', async () => {
    worker = inlinePythonWorker(`
import json
import sys

request = json.loads(sys.stdin.readline())
sys.stderr.write("x" * (2 * 1024 * 1024))
sys.stderr.flush()
print(json.dumps({
    "protocolVersion": 1,
    "type": "completed",
    "jobId": request["jobId"],
    "documentId": request["documentId"],
    "pageCount": 0,
    "processedPages": 0,
}), flush=True)
`)
    worker.start()

    await expect(worker.processDocument(processDocumentRequest())).resolves.toMatchObject({ type: 'completed' })
  })

  it('terminates a worker that emits invalid stdout and can safely start a replacement', async () => {
    worker = inlinePythonWorker(`
import sys
import time

sys.stdin.readline()
print("sensitive invalid protocol text", flush=True)
time.sleep(30)
`)
    worker.start()

    await expect(worker.processDocument(processDocumentRequest('job-1'))).rejects.toThrow(
      'Python worker emitted an invalid protocol message'
    )

    worker.start()
    await expect(worker.processDocument(processDocumentRequest('job-2'))).rejects.toThrow(
      'Python worker emitted an invalid protocol message'
    )
  })

  it('terminates the worker and rejects pending work when an event callback fails', async () => {
    worker = inlinePythonWorker(
      `
import json
import sys
import time

request = json.loads(sys.stdin.readline())
print(json.dumps({
    "protocolVersion": 1,
    "type": "started",
    "jobId": request["jobId"],
    "documentId": request["documentId"],
}), flush=True)
time.sleep(30)
`,
      async () => {
        throw new Error('sensitive callback failure')
      }
    )
    worker.start()

    await expect(worker.processDocument(processDocumentRequest())).rejects.toThrow('Python worker event handler failed')
  })

  it('rejects a terminal event whose document does not match the pending job', async () => {
    worker = inlinePythonWorker(`
import json
import sys

request = json.loads(sys.stdin.readline())
print(json.dumps({
    "protocolVersion": 1,
    "type": "completed",
    "jobId": request["jobId"],
    "documentId": "different-document",
    "pageCount": 0,
    "processedPages": 0,
}), flush=True)
`)
    worker.start()

    await expect(worker.processDocument(processDocumentRequest())).rejects.toThrow(
      'Python worker emitted an event for the wrong document'
    )
  })

  it('terminates a worker before dispatching an event for an unknown job', async () => {
    const events: WorkerEvent[] = []
    worker = inlinePythonWorker(
      `
import json
import sys

request = json.loads(sys.stdin.readline())
print(json.dumps({
    "protocolVersion": 1,
    "type": "page_result",
    "jobId": "rogue-job",
    "documentId": request["documentId"],
    "page": {
        "pageNo": 1,
        "originalWidth": 100,
        "originalHeight": 100,
        "rotation": 0,
        "sourceType": "NATIVE",
        "blocks": [],
    },
}), flush=True)
`,
      (event) => {
        events.push(event)
      }
    )
    worker.start()

    await expect(worker.processDocument(processDocumentRequest())).rejects.toThrow(
      'Python worker emitted an event for an unknown job'
    )
    expect(events).toEqual([])
  })

  it('does not let a stopped child close over a newly started worker', async () => {
    worker = inlinePythonWorker(`
import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    time.sleep(0.2)
    print(json.dumps({
        "protocolVersion": 1,
        "type": "completed",
        "jobId": request["jobId"],
        "documentId": request["documentId"],
        "pageCount": 0,
        "processedPages": 0,
    }), flush=True)
`)
    worker.start()
    const stoppedJob = worker.processDocument(processDocumentRequest('stopped-job')).catch((error: unknown) => error)

    worker.stop()
    worker.start()

    await expect(stoppedJob).resolves.toBeInstanceOf(Error)
    await expect(worker.processDocument(processDocumentRequest('replacement-job'))).resolves.toMatchObject({
      type: 'completed',
      jobId: 'replacement-job'
    })
  })
})
