import { describe, expect, it } from 'vitest'
import { DocumentAnalysisRunner } from './document-analysis-runner'

function deferredAnalysis(): {
  runner: DocumentAnalysisRunner
  next: (documentId: string) => Promise<void>
  settleAll: () => Promise<void>
} {
  const resolvers = new Map<string, () => void>()
  const promises = new Map<string, Promise<unknown>>()
  const analysis = {
    analyze: (documentId: string) => {
      const run = new Promise<{ documentId: string; status: 'COMPLETE' }>((resolve) => {
        resolvers.set(documentId, () => resolve({ documentId, status: 'COMPLETE' }))
      })
      promises.set(documentId, run)
      return run
    }
  }
  const runner = new DocumentAnalysisRunner(analysis)
  return {
    runner,
    next: async (documentId) => {
      const release = resolvers.get(documentId)
      if (release === undefined) throw new Error(`no pending run for ${documentId}`)
      release()
      await promises.get(documentId)
    },
    settleAll: () => runner.drain()
  }
}

describe('DocumentAnalysisRunner', () => {
  it('returns before the background run completes', async () => {
    const harness = deferredAnalysis()
    expect(harness.runner.start('document-1')).toBe(true)
    expect(harness.runner.activeCount).toBe(1)
    await harness.next('document-1')
    expect(harness.runner.activeCount).toBe(0)
  })

  it('coalesces duplicate starts for one Document into a single active run', async () => {
    const harness = deferredAnalysis()
    expect(harness.runner.start('document-1')).toBe(true)
    expect(harness.runner.start('document-1')).toBe(false)
    expect(harness.runner.activeCount).toBe(1)
    await harness.next('document-1')
  })

  it('lets different Documents run independently and frees their slots in finally', async () => {
    const harness = deferredAnalysis()
    expect(harness.runner.start('document-1')).toBe(true)
    expect(harness.runner.start('document-2')).toBe(true)
    expect(harness.runner.activeCount).toBe(2)
    await harness.next('document-1')
    expect(harness.runner.activeCount).toBe(1)
    // The freed slot can start again — an explicit retry after failure.
    expect(harness.runner.start('document-1')).toBe(true)
    await harness.next('document-2')
    await harness.next('document-1')
    expect(harness.runner.activeCount).toBe(0)
  })

  it('observes rejected background runs instead of leaving them unhandled', async () => {
    const failing = new DocumentAnalysisRunner(
      { analyze: async () => Promise.reject(new Error('synthetic analysis failure')) },
      (id, error) => {
        expect(id).toBe('document-x')
        expect(error).toBeInstanceOf(Error)
      }
    )
    expect(failing.start('document-x')).toBe(true)
    await failing.drain()
    // A settled failed run can be retried with a fresh start.
    const retryHarness = deferredAnalysis()
    expect(retryHarness.runner.start('document-x')).toBe(true)
    await retryHarness.next('document-x')
  })

  it('survives an observer that throws while handling the rejection', async () => {
    const throwingObserver = new DocumentAnalysisRunner(
      { analyze: () => Promise.reject(new Error('synthetic')) },
      () => {
        throw new Error('observer exploded')
      }
    )
    throwingObserver.start('document-y')
    await throwingObserver.drain()
    expect(throwingObserver.activeCount).toBe(0)
  })

  it('retains only an unrecorded terminal failure until the next accepted attempt', async () => {
    let attempts = 0
    const runner = new DocumentAnalysisRunner({
      analyze: async (documentId) => {
        attempts += 1
        if (attempts === 1) {
          throw Object.assign(new Error('synthetic sink failure'), { code: 'ANALYSIS_FAILURE_UNRECORDED' })
        }
        return { documentId, status: 'COMPLETE' as const }
      }
    })

    expect(runner.start('document-z')).toBe(true)
    await runner.drain()
    expect(runner.failureFor('document-z')).toMatchObject({ code: 'ANALYSIS_FAILURE_UNRECORDED', revision: 1 })

    // Starting a real retry clears the process-local terminal signal before
    // the new run settles; a successful retry leaves it cleared.
    expect(runner.start('document-z')).toBe(true)
    expect(runner.failureFor('document-z')).toBeUndefined()
    await runner.drain()
    expect(runner.failureFor('document-z')).toBeUndefined()
  })

  it('does not shadow a normally persisted stage failure with process-local state', async () => {
    const runner = new DocumentAnalysisRunner({
      analyze: async () => {
        throw Object.assign(new Error('persisted stage failure'), { code: 'DETECTION_FAILED' })
      }
    })
    runner.start('document-persisted')
    await runner.drain()
    expect(runner.failureFor('document-persisted')).toBeUndefined()
  })

  it('refuses starts after close and reports drain completion for active runs', async () => {
    const harness = deferredAnalysis()
    harness.runner.start('document-1')
    harness.runner.close()
    expect(harness.runner.start('document-2')).toBe(false)
    expect(harness.runner.start('document-1')).toBe(false)
    expect(harness.runner.isActive('document-1')).toBe(true)
    await harness.next('document-1')
    harness.runner.close()
    expect(harness.runner.start('document-3')).toBe(false)
  })
})
