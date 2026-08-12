import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  cancelJobRequestSchema,
  type ProcessDocumentRequest,
  processDocumentRequestSchema,
  type WorkerEvent,
  type WorkerTerminalEvent,
  parseWorkerEvent
} from './protocol'

export interface PythonWorkerClientOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly onEvent?: (event: WorkerEvent) => void | Promise<void>
}

interface PendingJob {
  readonly documentId: string
  readonly resolve: (event: WorkerTerminalEvent) => void
  readonly reject: (error: Error) => void
}

export class PythonWorkerClient {
  private readonly pendingJobs = new Map<string, PendingJob>()
  private child: ReturnType<typeof spawn> | undefined

  constructor(private readonly options: PythonWorkerClientOptions) {}

  start(): void {
    if (this.child !== undefined) return

    const child = spawn(this.options.command, [...this.options.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const output = createInterface({ input: child.stdout })
    let eventQueue = Promise.resolve()
    output.on('line', (line) => {
      eventQueue = eventQueue
        .then(() => this.handleStdoutLine(child, line))
        .catch(() => this.failChild(child, new Error('Python worker protocol handling failed')))
    })
    child.stderr.resume()
    child.stdin.on('error', (error) => this.failChild(child, error))
    child.stdout.on('error', (error) => this.failChild(child, error))
    child.on('error', (error) => this.failChild(child, error))
    child.on('close', (code) => {
      void eventQueue.then(() => {
        if (this.child !== child) return
        this.child = undefined
        if (this.pendingJobs.size > 0) {
          this.failAll(new Error(`Python worker exited before completing jobs (code ${code ?? 'unknown'})`))
        }
      })
    })
  }

  processDocument(request: ProcessDocumentRequest): Promise<WorkerTerminalEvent> {
    return this.sendAndWait(processDocumentRequestSchema.parse(request))
  }

  cancelJob(jobId: string): void {
    this.write(cancelJobRequestSchema.parse({ protocolVersion: 1, type: 'cancel_job', jobId }))
  }

  stop(): void {
    const child = this.child
    if (child === undefined) return

    this.child = undefined
    this.failAll(new Error('Python worker stopped before completing jobs'))
    child.kill()
  }

  private sendAndWait(request: ProcessDocumentRequest): Promise<WorkerTerminalEvent> {
    if (this.pendingJobs.has(request.jobId)) {
      throw new Error(`A Python worker job is already pending for ${request.jobId}`)
    }

    return new Promise<WorkerTerminalEvent>((resolve, reject) => {
      this.pendingJobs.set(request.jobId, { documentId: request.documentId, resolve, reject })
      try {
        this.write(request)
      } catch (error) {
        this.pendingJobs.delete(request.jobId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(message: object): void {
    const input = this.child?.stdin
    if (input?.writable !== true) {
      throw new Error('Python worker is not running; call start() before sending a job')
    }
    input.write(`${JSON.stringify(message)}\n`)
  }

  private async handleStdoutLine(child: ReturnType<typeof spawn>, line: string): Promise<void> {
    if (this.child !== child) return

    let event: WorkerEvent
    try {
      event = parseWorkerEvent(JSON.parse(line) as unknown)
    } catch {
      this.failChild(child, new Error('Python worker emitted an invalid protocol message'))
      return
    }

    const pending = this.pendingJobs.get(event.jobId)
    if (pending === undefined) {
      this.failChild(child, new Error('Python worker emitted an event for an unknown job'))
      return
    }
    if (pending.documentId !== event.documentId) {
      this.failChild(child, new Error('Python worker emitted an event for the wrong document'))
      return
    }

    try {
      await this.options.onEvent?.(event)
    } catch {
      this.failChild(child, new Error('Python worker event handler failed'))
      return
    }

    if (this.child !== child) return
    if (event.type === 'completed' || event.type === 'cancelled' || event.type === 'error') {
      this.pendingJobs.delete(event.jobId)
      pending.resolve(event)
    }
  }

  private failChild(child: ReturnType<typeof spawn>, error: Error): void {
    if (this.child !== child) return
    this.child = undefined
    this.failAll(error)
    child.kill()
  }

  private failAll(error: Error): void {
    for (const pending of this.pendingJobs.values()) pending.reject(error)
    this.pendingJobs.clear()
  }
}
