import { describe, expect, it, vi } from 'vitest'
import { decrypt, generateKey } from '@aliasai/crypto'
import type { RecoverInterruptedWorkInput } from '@aliasai/database'
import {
  StartupRecoveryService,
  aiExecutionErrorContext,
  privacyDetectionErrorContext
} from '../src'

describe('StartupRecoveryService', () => {
  it('encrypts code-only interruption failures and uses a monotonic recovery timestamp', () => {
    const persistenceKey = generateKey()
    let submitted: RecoverInterruptedWorkInput | undefined
    const recover = vi.fn((input: RecoverInterruptedWorkInput) => {
      submitted = {
        ...input,
        processingJobs: input.processingJobs.map((row) => ({ ...row, errorCipher: Buffer.from(row.errorCipher) })),
        aiExecutions: input.aiExecutions.map((row) => ({ ...row, errorCipher: Buffer.from(row.errorCipher) }))
      }
      return { processingJobs: 1, aiExecutions: 1, documents: 2 }
    })
    const service = new StartupRecoveryService(
      {
        findInterrupted: () => ({
          processingJobs: [{ id: 'job-1', startedAt: 80 }],
          aiExecutions: [{ id: 'ai-1', startedAt: 90 }],
          documents: [
            { id: 'document-1', updatedAt: 75 },
            { id: 'document-2', updatedAt: 100 }
          ]
        }),
        recover
      },
      { persistenceKey },
      () => 50
    )

    expect(service.recover()).toEqual({ processingJobs: 1, aiExecutions: 1, documents: 2 })
    expect(submitted?.finishedAt).toBe(100)
    expect(
      decrypt(submitted!.processingJobs[0]!.errorCipher, persistenceKey, privacyDetectionErrorContext('job-1')).toString('utf8')
    ).toBe('{"code":"INTERRUPTED"}')
    expect(
      decrypt(submitted!.aiExecutions[0]!.errorCipher, persistenceKey, aiExecutionErrorContext('ai-1')).toString('utf8')
    ).toBe('{"code":"INTERRUPTED"}')
  })

  it('does not open a recovery transaction when no interrupted work exists', () => {
    const recover = vi.fn()
    const service = new StartupRecoveryService(
      {
        findInterrupted: () => ({ processingJobs: [], aiExecutions: [], documents: [] }),
        recover
      },
      { persistenceKey: generateKey() }
    )

    expect(service.recover()).toEqual({ processingJobs: 0, aiExecutions: 0, documents: 0 })
    expect(recover).not.toHaveBeenCalled()
  })
})
