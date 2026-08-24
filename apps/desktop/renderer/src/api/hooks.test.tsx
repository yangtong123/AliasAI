import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UiError } from './client'
import { useMutation } from './hooks'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** An action whose n-th invocation returns the n-th deferred response. */
function queueResponses(responses: readonly Deferred<string>[]): () => Promise<string> {
  let call = 0
  return () => {
    const response = responses[Math.min(call, responses.length - 1)]!
    call += 1
    return response.promise
  }
}

describe('useMutation invocation isolation', () => {
  afterEach(() => {
    cleanup()
  })

  it('ignores a superseded invocation that fails while a newer one is pending', async () => {
    const older = deferred<string>()
    const newer = deferred<string>()
    const { result } = renderHook(() => useMutation(queueResponses([older, newer])))

    let olderRun: Promise<string | null> = Promise.resolve(null)
    let newerRun: Promise<string | null> = Promise.resolve(null)
    await act(async () => {
      olderRun = result.current.run()
      newerRun = result.current.run()
    })
    expect(result.current.pending).toBe(true)
    expect(result.current.error).toBeNull()

    await act(async () => {
      older.reject(new UiError('AI_PROVIDER_FAILURE', 'older failure'))
      await olderRun
    })
    expect(result.current.error).toBeNull()
    expect(result.current.pending).toBe(true)

    await act(async () => {
      newer.resolve('newer result')
      await expect(newerRun).resolves.toBe('newer result')
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('lets the newest invocation own the error state over an older success', async () => {
    const older = deferred<string>()
    const newer = deferred<string>()
    const { result } = renderHook(() => useMutation(queueResponses([older, newer])))

    let olderRun: Promise<string | null> = Promise.resolve(null)
    let newerRun: Promise<string | null> = Promise.resolve(null)
    await act(async () => {
      olderRun = result.current.run()
      newerRun = result.current.run()
    })

    await act(async () => {
      newer.reject(new UiError('AI_PROVIDER_FAILURE', 'newer failure'))
      await newerRun
    })
    expect(result.current.error?.message).toBe('newer failure')

    await act(async () => {
      older.resolve('older result')
      await olderRun
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error?.message).toBe('newer failure')
  })

  it('still reports the error of a single unmatched invocation', async () => {
    const { result } = renderHook(() =>
      useMutation(() => Promise.reject(new UiError('AI_PROVIDER_FAILURE', 'only failure')))
    )

    let outcome: string | null = 'unset'
    await act(async () => {
      outcome = await result.current.run()
    })
    expect(outcome).toBeNull()
    expect(result.current.pending).toBe(false)
    expect(result.current.error?.message).toBe('only failure')
  })
})
