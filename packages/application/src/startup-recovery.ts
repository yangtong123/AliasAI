import { encrypt } from '@aliasai/crypto'
import type { StartupRecoveryRepository } from '@aliasai/database'
import type { ApplicationKeys } from './index'
import { aiExecutionErrorContext } from './ai-execution'
import { privacyDetectionErrorContext } from './privacy-detection'

type RecoveryStore = Pick<StartupRecoveryRepository, 'findInterrupted' | 'recover'>

export interface StartupRecoveryResult {
  readonly processingJobs: number
  readonly aiExecutions: number
  readonly documents: number
}

export class StartupRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StartupRecoveryError'
  }
}

/**
 * Runs before IPC/window creation. Work left RUNNING by a prior process cannot
 * still be executing, so it is failed with encrypted code-only diagnostics
 * and its Document becomes retryable instead of polling forever.
 */
export class StartupRecoveryService {
  constructor(
    private readonly recovery: RecoveryStore,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now
  ) {}

  recover(): StartupRecoveryResult {
    let interrupted: ReturnType<RecoveryStore['findInterrupted']>
    try {
      interrupted = this.recovery.findInterrupted()
    } catch (error) {
      throw new StartupRecoveryError('Interrupted work could not be inspected', { cause: error })
    }
    if (
      interrupted.processingJobs.length === 0 &&
      interrupted.aiExecutions.length === 0 &&
      interrupted.documents.length === 0
    ) {
      return { processingJobs: 0, aiExecutions: 0, documents: 0 }
    }

    const finishedAt = Math.max(
      this.now(),
      ...interrupted.processingJobs.map((job) => job.startedAt),
      ...interrupted.aiExecutions.map((execution) => execution.startedAt),
      ...interrupted.documents.map((document) => document.updatedAt)
    )
    const jobErrors = interrupted.processingJobs.map((job) => ({
      id: job.id,
      errorCipher: encryptRecoveryCode(job.id, 'processing', this.keys.persistenceKey)
    }))
    const aiErrors = interrupted.aiExecutions.map((execution) => ({
      id: execution.id,
      errorCipher: encryptRecoveryCode(execution.id, 'ai', this.keys.persistenceKey)
    }))
    try {
      return this.recovery.recover({ finishedAt, processingJobs: jobErrors, aiExecutions: aiErrors })
    } catch (error) {
      throw new StartupRecoveryError('Interrupted work could not be recovered', { cause: error })
    } finally {
      for (const row of [...jobErrors, ...aiErrors]) row.errorCipher.fill(0)
    }
  }
}

function encryptRecoveryCode(id: string, kind: 'processing' | 'ai', persistenceKey: Buffer): Buffer {
  const payload = Buffer.from('{"code":"INTERRUPTED"}', 'utf8')
  try {
    return encrypt(
      payload,
      persistenceKey,
      kind === 'processing' ? privacyDetectionErrorContext(id) : aiExecutionErrorContext(id)
    )
  } finally {
    payload.fill(0)
  }
}
