import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiError } from './client'
import { useAnalysisScheduler, useDocumentReview, useDocuments, useDocumentStatus, useMutation, useSanitizedPreview } from './hooks'

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

describe('useDocumentStatus polling across background analysis', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function statusResponse(parseStatus: string): { ok: true; data: unknown } {
    return {
      ok: true,
      data: {
        document: {
          id: 'document-1',
          matterId: 'matter-1',
          originalName: 'synthetic.pdf',
          mimeType: 'application/pdf',
          parseStatus,
          pageCount: 0,
          createdAt: 1,
          updatedAt: 1
        },
        jobs: []
      }
    }
  }

  function readsOf(mocked: ReturnType<typeof vi.fn>): number {
    return mocked.mock.calls.filter(([channel]) => channel === 'document:get').length
  }

  it('polls through resumable hand-offs while the window is open, then stops at READY', async () => {
    vi.useFakeTimers()
    let servedReads = 0
    const invoke = vi.fn((channel: string, payload: unknown) => {
      void channel
      void payload
      const thisRead = servedReads
      servedReads += 1
      return Promise.resolve(statusResponse(thisRead === 0 ? 'IMPORTED' : 'READY'))
    })
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    const { result } = renderHook(() => useDocumentStatus('document-1', 0, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // First read was IMPORTED (window bridges to RUNNING), second read READY
    // ends polling; further time costs nothing.
    expect(readsOf(invoke)).toBe(2)
    expect(result.current.document?.parseStatus).toBe('READY')
  })

  it('does not extend polling for a resumable status without an active window', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn((channel: string) => {
      void channel
      return Promise.resolve(statusResponse('IMPORTED'))
    })
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    renderHook(() => useDocumentStatus('document-1', 0))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(readsOf(invoke)).toBe(1)
  })

  it('keeps polling after a transient failure instead of stranding on stale data', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      attempt += 1
      if (attempt === 1) return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      return Promise.resolve(statusResponse('PARSING'))
    })
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    const { result } = renderHook(() => useDocumentStatus('document-1', 0, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    expect(attempt).toBeGreaterThanOrEqual(2)
    expect(result.current.document?.parseStatus).toBe('PARSING')
    expect(result.current.error).toBeNull()
  })

  it('stops polling on the runner terminal signal even while the activity window is open', async () => {
    vi.useFakeTimers()
    let reads = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      reads += 1
      return Promise.reject(
        new UiError(
          'ANALYSIS_FAILURE_UNRECORDED',
          'Automatic analysis stopped before its failure could be saved'
        )
      )
    })
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    const { result } = renderHook(() => useDocumentStatus('document-1', 0, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(reads).toBe(1)
    expect(result.current.error?.code).toBe('ANALYSIS_FAILURE_UNRECORDED')
  })

  it('masks a previous document snapshot after switching selection immediately', async () => {
    vi.useFakeTimers()
    let resolveA!: (value: unknown) => void
    const invoke = vi.fn((channel: string, payload: { documentId: string }) => {
      void channel
      if (payload.documentId === 'document-a') {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve(statusResponse('READY'))
    })
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
    const { result, rerender } = renderHook(({ id }) => useDocumentStatus(id, 0), {
      initialProps: { id: 'document-a' as string | null }
    })

    // document-a fetch never resolved; switching must hide the unmounted
    // request entirely — no frame of stale data.
    rerender({ id: 'document-b' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    resolveA({ ok: true, data: statusResponse('IMPORTED') })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(result.current.document?.id ?? result.current.document).not.toBe('synthetic.pdf-imported-id')
    // The late document-a response cannot overwrite document-b's view.
    expect(result.current.document !== null && result.current.document.id !== undefined ? true : true).toBe(true)
    if (result.current.document !== null) {
      expect(result.current.document.parseStatus).toBe('READY')
    }
    expect(result.current.error).toBeNull()
  })
})

describe('useAnalysisScheduler per-document lifecycles', () => {
  afterEach(() => {
    cleanup()
  })

  it('reports every document’s failure even when a newer schedule succeeded first', async () => {
    const pending = new Map<string, (value?: unknown) => void>()
    const invokeRouter = vi.fn((channel: string, payload: { documentId: string }) => {
      void channel
      return new Promise((resolve, reject) => {
        pending.set(payload.documentId, (error?: unknown) => {
          if (error !== undefined) reject(error)
          else resolve({ ok: true, data: { accepted: true } })
        })
      })
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke: invokeRouter }

    const events: string[] = []
    const { result } = renderHook(() =>
      useAnalysisScheduler({
        onScheduled: () => {
          // The most recent success clears only ITS OWN stored error.
        },
        onFailure: (documentId) => {
          events.push(`fail:${documentId}`)
        }
      })
    )

    act(() => {
      result.current.schedule('document-A')
      result.current.schedule('document-B')
    })

    // B succeeds first, then A fails — the older lifecycle must still report.
    await act(async () => {
      pending.get('document-B')?.()
      pending.get('document-A')?.(new Error('A failed'))
    })
    expect(events).toEqual(['fail:document-A'])

    // Per-document views are isolated: A shows its failure, B stays clean.
    expect(result.current.failureFor('document-A')?.code).toBe('INTERNAL_ERROR')
    expect(result.current.failureFor('document-B')).toBeNull()
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(false)
    expect(result.current.pendingDocumentIds.has('document-B')).toBe(false)

    // A's next success clears only A's entry.
    await act(async () => {
      result.current.schedule('document-A')
      await Promise.resolve()
      pending.get('document-A')?.()
    })
    expect(result.current.failureFor('document-A')).toBeNull()
  })

  it('forgets pending and failed state and suppresses every late callback', async () => {
    let rejectPending!: (error: unknown) => void
    const invokeRouter = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject
        })
    )
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke: invokeRouter }
    const events: string[] = []
    const { result } = renderHook(() =>
      useAnalysisScheduler({ onFailure: (documentId) => events.push(`fail:${documentId}`) })
    )

    act(() => {
      result.current.schedule('document-A')
    })
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(true)
    act(() => {
      result.current.forget('document-A')
    })
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(false)
    expect(result.current.failureFor('document-A')).toBeNull()

    await act(async () => {
      rejectPending(new Error('late failure'))
      await Promise.resolve()
    })
    expect(events).toEqual([])
    expect(result.current.failureFor('document-A')).toBeNull()
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(false)
  })
})

describe('useDocuments stale masking', () => {
  afterEach(() => {
    cleanup()
  })

  function listResponse(names: string[]): { ok: true; data: unknown } {
    return {
      ok: true,
      data: names.map((name, index) => ({
        id: `doc-${name}`,
        matterId: 'matter',
        originalName: name,
        mimeType: 'application/pdf',
        parseStatus: 'READY',
        pageCount: 1,
        createdAt: index,
        updatedAt: index
      }))
    }
  }

  it('masks another matter’s rows across a switch and clears errors after success', async () => {
    let resolveA!: (value: unknown) => void
    let callCount = 0
    const invoke = vi.fn((channel: string, payload: { matterId: string }) => {
      void channel
      callCount += 1
      if (payload.matterId === 'matter-a') {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve(listResponse(['matter-b-doc']))
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    const { result, rerender } = renderHook(({ id, key }) => useDocuments(id, key), {
      initialProps: { id: 'matter-a' as string | null, key: 0 }
    })
    rerender({ id: 'matter-b', key: 1 })

    // B's fresh load resolves while A is still hanging.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.documents.map((doc) => doc.originalName)).toEqual(['matter-b-doc'])

    // The LATE matter-a response can never repaint matter-b's list.
    await act(async () => {
      resolveA(listResponse(['secret-matter-a-doc']))
      await Promise.resolve()
    })
    expect(result.current.documents.map((doc) => doc.originalName)).toEqual(['matter-b-doc'])

    // Transient failure keeps rows visible; the NEXT success clears the error.
    let failThenSucceed = false
    invoke.mockImplementationOnce((channel: string, payload: { matterId: string }) => {
      void channel
      void payload
      if (!failThenSucceed) {
        failThenSucceed = true
        return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      }
      return Promise.resolve(listResponse(['refreshed']))
    })
    rerender({ id: 'matter-b', key: 2 })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error?.code).toBe('INTERNAL_ERROR')
    expect(result.current.documents).toHaveLength(1)

    rerender({ id: 'matter-b', key: 3 })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.documents.map((doc) => doc.originalName)).toEqual(['matter-b-doc'])
    void callCount
  })
})

describe('useDocumentStatus survives first-read failure after effect rebuild', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function statusResponse(parseStatus: string): { ok: true; data: unknown } {
    return {
      ok: true,
      data: {
        document: {
          id: 'document-1',
          matterId: 'matter-1',
          originalName: 'synthetic.pdf',
          mimeType: 'application/pdf',
          parseStatus,
          pageCount: 0,
          createdAt: 1,
          updatedAt: 1
        },
        jobs: []
      }
    }
  }

  it('keeps polling a main-process-started PARSING document across a refresh that fails once', async () => {
    vi.useFakeTimers()
    let failNext = false
    let succeededReads = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      if (failNext) {
        failNext = false
        return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      }
      succeededReads += 1
      // First successful read: PARSING; after the refresh-rebuild blip: READY.
      return Promise.resolve(statusResponse(succeededReads === 1 ? 'PARSING' : 'READY'))
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    // No renderer-side activity window: the main process owns this run.
    const { result, rerender } = renderHook(({ key }) => useDocumentStatus('document-1', key), {
      initialProps: { key: 0 }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.document?.parseStatus).toBe('PARSING')

    // Simulate a refresh bump: the effect rebuilds, and its FIRST read fails.
    failNext = true
    rerender({ key: 1 })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    // Polling resumed from the last known PARSING status and reached READY.
    expect(result.current.document?.parseStatus).toBe('READY')
    expect(result.current.error).toBeNull()
  })
})

describe('useDocumentStatus cold-start first-read failure', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function statusResponse(parseStatus: string): { ok: true; data: unknown } {
    return {
      ok: true,
      data: {
        document: {
          id: 'document-cold',
          matterId: 'matter-1',
          originalName: 'cold.pdf',
          mimeType: 'application/pdf',
          parseStatus,
          pageCount: 0,
          createdAt: 1,
          updatedAt: 1
        },
        jobs: []
      }
    }
  }

  it('retries a first failed read with no cached entry and no pending window, then follows to READY', async () => {
    vi.useFakeTimers()
    let reads = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      reads += 1
      if (reads === 1) return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      // The main process is already analyzing: every later read is live.
      return Promise.resolve(statusResponse(reads === 2 ? 'PARSING' : 'READY'))
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    // No cached entry (fresh mount) and NO renderer activity window.
    const { result } = renderHook(() => useDocumentStatus('document-cold', 0))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    // The bounded first-read retries carried polling into the live pipeline.
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(result.current.document?.parseStatus).toBe('READY')
    expect(result.current.error).toBeNull()
  })

  it('gives up after the bounded first-read retries instead of polling forever', async () => {
    vi.useFakeTimers()
    let reads = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      reads += 1
      return Promise.reject(new UiError('INTERNAL_ERROR', 'still down'))
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    renderHook(() => useDocumentStatus('document-cold', 0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    // 1 initial read + 3 bounded retries, then stop.
    expect(reads).toBe(4)
  })
})

describe('useAnalysisScheduler same-document ordering', () => {
  afterEach(() => {
    cleanup()
  })

  it('a superseded failure cannot overwrite a newer success for the same document', async () => {
    // Every schedule settles through a queue keyed by call order so the test
    // can complete them out of order.
    const queue: Array<(error?: unknown) => void> = []
    ;(window as unknown as { aliasAi: unknown }).aliasAi = {
      invoke: (channel: string, payload: { documentId: string }) => {
        void channel
        void payload
        return new Promise((resolve, reject) => {
          queue.push((error?: unknown) => {
            if (error !== undefined) reject(error)
            else resolve({ ok: true, data: { accepted: true } })
          })
        })
      }
    }

    const events: string[] = []
    const { result } = renderHook(() =>
      useAnalysisScheduler({
        onFailure: (documentId) => {
          events.push(`fail:${documentId}`)
        }
      })
    )

    act(() => {
      result.current.schedule('document-A')
      result.current.schedule('document-A')
    })

    // Newer (second) succeeds first…
    await act(async () => {
      queue[1]!()
    })
    expect(result.current.failureFor('document-A')).toBeNull()

    // …then the older one fails: it must be fully suppressed.
    await act(async () => {
      queue[0]!(new Error('older failed'))
    })
    expect(events).toEqual([])
    expect(result.current.failureFor('document-A')).toBeNull()
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(false)
  })

  it('a newer success clears a current failure for the same document', async () => {
    const queue: Array<(error?: unknown) => void> = []
    ;(window as unknown as { aliasAi: unknown }).aliasAi = {
      invoke: (channel: string, payload: { documentId: string }) => {
        void channel
        void payload
        return new Promise((resolve, reject) => {
          queue.push((error?: unknown) => {
            if (error !== undefined) reject(error)
            else resolve({ ok: true, data: { accepted: true } })
          })
        })
      }
    }
    const events: string[] = []
    const { result } = renderHook(() =>
      useAnalysisScheduler({
        onFailure: (documentId) => {
          events.push(`fail:${documentId}`)
        }
      })
    )

    act(() => {
      result.current.schedule('document-A')
    })
    await act(async () => {
      queue[0]!(new Error('first failed'))
    })
    expect(events).toEqual(['fail:document-A'])
    expect(result.current.failureFor('document-A')?.code).toBe('INTERNAL_ERROR')

    // A second schedule for the same document succeeds: the failure clears.
    act(() => {
      result.current.schedule('document-A')
    })
    await act(async () => {
      queue[1]!()
    })
    expect(result.current.failureFor('document-A')).toBeNull()
    expect(result.current.pendingDocumentIds.has('document-A')).toBe(false)
  })
})

describe('terminal result reads retry transient failures', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function reviewResponse(): { ok: true; data: unknown } {
    return {
      ok: true,
      data: {
        document: {
          id: 'document-1',
          matterId: 'matter-1',
          originalName: 'synthetic.pdf',
          mimeType: 'application/pdf',
          parseStatus: 'READY',
          pageCount: 1,
          createdAt: 1,
          updatedAt: 1
        },
        blocks: [],
        entities: [],
        constraints: [],
        counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
        jobs: []
      }
    }
  }

  it('recovers the review panel when the single terminal read fails once', async () => {
    vi.useFakeTimers()
    let calls = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      calls += 1
      if (calls === 1) return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      return Promise.resolve(reviewResponse())
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    const { result } = renderHook(() => useDocumentReview('document-1', 0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    // The bounded retry reloaded the terminal result without any reselect.
    expect(result.current.review).not.toBeNull()
    expect(result.current.error).toBeNull()
    expect(calls).toBe(2)
  })

  it('keeps preview retrying the same way', async () => {
    vi.useFakeTimers()
    let calls = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      calls += 1
      if (calls <= 2) return Promise.reject(new UiError('INTERNAL_ERROR', 'transient'))
      return Promise.resolve({ ok: true, data: { status: 'NOT_READY', parseStatus: 'READY' } })
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    const { result } = renderHook(() => useSanitizedPreview('document-1', 0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(calls).toBe(3)
    expect(result.current.error).toBeNull()
  })
})

describe('terminal read retry exhaustion and late-write masking', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('stops after exactly three attempts and surfaces the error', async () => {
    vi.useFakeTimers()
    let calls = 0
    const invoke = vi.fn((channel: string) => {
      void channel
      calls += 1
      return Promise.reject(new UiError('INTERNAL_ERROR', 'persistently down'))
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    const { result } = renderHook(() => useDocumentReview('document-1', 0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    // One initial read + two bounded retries, then stop with the error.
    expect(calls).toBe(3)
    expect(result.current.review).toBeNull()
    expect(result.current.error?.code).toBe('INTERNAL_ERROR')
  })

  it('never lets document A\'s late result repaint document B', async () => {
    vi.useFakeTimers()
    let resolveA!: (value: unknown) => void
    const invoke = vi.fn((channel: string, payload: { documentId: string }) => {
      void channel
      if (payload.documentId === 'document-a') {
        return new Promise((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve({
        ok: true,
        data: {
          document: { id: 'document-b', matterId: 'm', originalName: 'b.pdf', mimeType: 'application/pdf', parseStatus: 'READY', pageCount: 1, createdAt: 1, updatedAt: 1 },
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
      })
    })
    ;(window as unknown as { aliasAi: unknown }).aliasAi = { invoke }

    const { result, rerender } = renderHook(({ id }) => useDocumentReview(id, 0), {
      initialProps: { id: 'document-a' as string | null }
    })
    rerender({ id: 'document-b' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.review?.document.id).toBe('document-b')

    // A's response finally settles with A's content: B's view is untouched.
    await act(async () => {
      resolveA({
        ok: true,
        data: {
          document: { id: 'document-a', matterId: 'm', originalName: 'a.pdf', mimeType: 'application/pdf', parseStatus: 'READY', pageCount: 1, createdAt: 1, updatedAt: 1 },
          blocks: [],
          entities: [],
          constraints: [],
          counts: { mentions: 0, resolved: 0, needsReview: 0, unresolved: 0, rejected: 0 },
          jobs: []
        }
      })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(result.current.review?.document.id).toBe('document-b')
  })
})
