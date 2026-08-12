import type { ProcessDocumentRequest, WorkerTerminalEvent } from './protocol'
import type { PythonWorkerClient, WorkerEventHandler } from './worker-client'

/**
 * Adapts a protocol worker to the application DocumentProcessor port. The
 * application service sees only Protocol v1 and this stable parser label.
 */
export class PythonWorkerDocumentProcessor {
  constructor(
    readonly parserType: string,
    private readonly client: PythonWorkerClient
  ) {
    if (parserType.trim().length === 0) throw new Error('parserType must not be empty')
  }

  processDocument(request: ProcessDocumentRequest, onEvent: WorkerEventHandler): Promise<WorkerTerminalEvent> {
    this.client.start()
    return this.client.processDocument(request, onEvent)
  }

  stop(): void {
    this.client.stop()
  }
}
