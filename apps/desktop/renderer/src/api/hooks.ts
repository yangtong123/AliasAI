import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocumentReviewDTO,
  DocumentSummaryDTO,
  JobSummaryDTO,
  MatterSummaryDTO,
  SanitizedPreview,
  WorkspaceTrashDTO
} from '@aliasai/application'
import type { AliasAiInvokeMap } from '../../../main/src/ipc/contract'
import { invoke, UiError } from './client'

/** Provider status as the renderer may see it: never contains the API key itself. */
export type AiProviderStatus = AliasAiInvokeMap['aiProvider:getStatus']['response']

export function useMatters(refreshKey = 0): {
  readonly matters: readonly MatterSummaryDTO[]
  readonly loaded: boolean
  readonly error: UiError | null
} {
  const [matters, setMatters] = useState<readonly MatterSummaryDTO[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    let active = true
    setLoaded(false)
    setError(null)
    invoke('matter:list', {})
      .then((result) => {
        if (active) {
          setMatters(result)
          setLoaded(true)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(failure instanceof UiError ? failure : null)
          setLoaded(true)
        }
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  return { matters, loaded, error }
}

/**
 * Matter-scoped document list with stale-while-revalidate reads. Entries are
 * tagged with their matter id and masked at RETURN time: switching Matters
 * can never paint one frame of the previous Matter's document names, an
 * in-flight refetch never blanks the current list, a superseded request is
 * invalidated by its own cleanup, and any stale error clears on the next
 * successful load.
 */
export function useDocuments(
  matterId: string | null,
  refreshKey: number
): {
  readonly documents: readonly DocumentSummaryDTO[]
  readonly loaded: boolean
  readonly error: UiError | null
  /** Number of completed list loads for the CURRENT matter; callers use it to tell a settled snapshot from one that predates a selection. */
  readonly loadEpoch: number
} {
  const [entry, setEntry] = useState<{
    id: string | null
    documents: readonly DocumentSummaryDTO[]
    error: UiError | null
    loadEpoch: number
  }>({ id: null, documents: [], error: null, loadEpoch: 0 })

  useEffect(() => {
    if (matterId === null) {
      setEntry({ id: null, documents: [], error: null, loadEpoch: 0 })
      return
    }
    let active = true
    invoke('document:list', { matterId })
      .then((result) => {
        if (active) setEntry((previous) => ({ id: matterId, documents: result, error: null, loadEpoch: previous.loadEpoch + 1 }))
      })
      .catch((failure: unknown) => {
        if (active) {
          const error = failure instanceof UiError ? failure : null
          // A first load has nothing to preserve; a refresh of the same
          // matter keeps its rows visible under the transient error.
          setEntry((previous) =>
            previous.id === matterId
              ? { ...previous, error }
              : { id: matterId, documents: [], error, loadEpoch: 0 }
          )
        }
      })
    return () => {
      active = false
    }
  }, [matterId, refreshKey])

  const current = entry.id === matterId && matterId !== null ? entry : null
  return {
    documents: current?.documents ?? [],
    loaded: current !== null,
    error: current?.error ?? null,
    loadEpoch: current?.loadEpoch ?? 0
  }
}

const IN_FLIGHT_STATUSES = new Set(['PARSING', 'DETECTING', 'RESOLVING', 'SANITIZING'])
/**
 * Resumable pre-analysis statuses: while the caller reports an active
 * analysis window these are pollable too — stage-to-stage gaps and retry
 * hand-offs spend time in IMPORTED/PARSED/DETECTED, and an explicit retry is
 * followed through its stale pre-attempt FAILED revision until a new revision
 * or a forward stage transition is observed.
 */
const AWAITING_ANALYSIS_STATUSES = new Set(['IMPORTED', 'PARSED', 'DETECTED', 'FAILED'])
const POLL_INTERVAL_MS = 1000
/** How many times a very first, status-less read retries before giving up. */
const FIRST_READ_RETRY_LIMIT = 3
/** Bounded retries for terminal result reads (review/preview) after a transient failure. */
const LOAD_RETRY_LIMIT = 2
const LOAD_RETRY_INTERVAL_MS = 500
const UNRECORDED_ANALYSIS_FAILURE = 'ANALYSIS_FAILURE_UNRECORDED'

interface DocumentStatusEntry {
  /** Which document this entry belongs to; the hook masks anything older. */
  readonly id: string | null
  readonly document: DocumentSummaryDTO | null
  readonly jobs: readonly JobSummaryDTO[]
  readonly error: UiError | null
}

const EMPTY_STATUS_ENTRY: DocumentStatusEntry = { id: null, document: null, jobs: [], error: null }

/**
 * Polls a document's status while a pipeline stage (or the caller-declared
 * analysis window) keeps it busy. Implementation notes that the previous
 * tick-based version got wrong:
 *
 * - Every completion RESCHEDULES the next poll from its own result, so a
 *   transient `document:get` failure can never strand the loop on stale data.
 * - Results are tagged with the requested document id and the return value
 *   masks anything older: switching Documents cannot paint one frame of the
 *   previous document's sensitive content.
 * - A successful read clears a previous transient error.
 * - The analysis-window flag re-arms the loop when membership appears after
 *   the first observation (a flip alone never costs a request).
 */
export function useDocumentStatus(
  documentId: string | null,
  refreshKey: number,
  analysisPendingForDocument = false
): {
  readonly document: DocumentSummaryDTO | null
  readonly jobs: readonly JobSummaryDTO[]
  readonly error: UiError | null
} {
  const [entry, setEntry] = useState<DocumentStatusEntry>(EMPTY_STATUS_ENTRY)
  // Render-time mirror so a rebuilt polling effect can seed from the last
  // known status of THIS document without an extra render cycle.
  const entryRef = useRef(entry)
  entryRef.current = entry

  useEffect(() => {
    if (documentId === null) {
      setEntry(EMPTY_STATUS_ENTRY)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Bounded retries for a first read that fails before ANY status is known.
    let firstReadAttempts = 0
    // Last SUCCESSFUL parse status for THIS document; retries after transient
    // failures reschedule from it exactly like the success path does, so a
    // main-process-started PARSING document keeps polling even when the
    // renderer's activity window knows nothing about it. Seeded from the
    // previous entry for the SAME document so an effect rebuild (refreshKey
    // bump, remount) does not lose the busy signal on its first failed read.
    let lastKnownParseStatus: string | undefined = entryRef.current.id === documentId
      ? entryRef.current.document?.parseStatus
      : undefined

    const stillBusy = (parseStatus: string): boolean =>
      IN_FLIGHT_STATUSES.has(parseStatus) ||
      (analysisPendingForDocument && AWAITING_ANALYSIS_STATUSES.has(parseStatus))

    const scheduleNext = (parseStatus: string): void => {
      lastKnownParseStatus = parseStatus
      if (!stillBusy(parseStatus)) return
      timer = setTimeout(() => {
        void run()
      }, POLL_INTERVAL_MS)
    }

    const run = async (): Promise<void> => {
      try {
        const result = await invoke('document:get', { documentId })
        if (cancelled) return
        setEntry({ id: documentId, document: result.document, jobs: result.jobs, error: null })
        scheduleNext(result.document.parseStatus)
      } catch (failure) {
        if (cancelled) return
        const error = failure instanceof UiError ? failure : null
        setEntry((previous) => ({
          // Keep the last known document visible through transient failures,
          // masked to THIS document only.
          ...(previous.id === documentId ? previous : EMPTY_STATUS_ENTRY),
          id: documentId,
          error
        }))
        // The main-process runner reached a terminal failure that could not be
        // persisted. It is process-local but authoritative for this attempt:
        // stop polling so App can release the activity window and expose retry.
        if (error?.code === UNRECORDED_ANALYSIS_FAILURE) return
        // Reschedule from the previously observed status; with NOTHING known
        // yet (cold start, no cached entry, no window) give the very first
        // read a few bounded retries — the main process may already be
        // analyzing while the renderer has no activity window for it.
        if (lastKnownParseStatus !== undefined) {
          scheduleNext(lastKnownParseStatus)
        } else {
          firstReadAttempts += 1
          const keepTrying = analysisPendingForDocument || firstReadAttempts <= FIRST_READ_RETRY_LIMIT
          if (keepTrying) {
            timer = setTimeout(() => {
              void run()
            }, POLL_INTERVAL_MS)
          }
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [documentId, refreshKey, analysisPendingForDocument])

  const current = entry.id === documentId ? entry : EMPTY_STATUS_ENTRY
  return { document: current.document, jobs: current.jobs, error: current.error }
}

/**
 * Per-document scheduling bookkeeping. Every invocation owns its own lifecycle:
 * an older document's failure callback ALWAYS runs even if a newer document was
 * scheduled in parallel — stale global "latest invocation wins" tracking used to
 * swallow exactly those cleanups and strand activity windows.
 */
export interface AnalysisScheduleFailure {
  readonly documentId: string
  readonly error: UiError
}

export function useAnalysisScheduler(handlers: {
  /** Accepted (or deduped as already-running): main process owns progress now. */
  readonly onScheduled?: () => void
  /** Invoked once PER failing document, unconditionally (see note above). */
  readonly onFailure?: (documentId: string, error: UiError) => void
}): {
  /** Schedules analysis for one document; outcomes surface via handlers/state. */
  readonly schedule: (targetId: string) => void
  /** Documents whose schedule request is currently in flight. */
  readonly pendingDocumentIds: ReadonlySet<string>
  /** Latest error per document, cleared by that document's next success. */
  readonly failureFor: (documentId: string | null | undefined) => UiError | null
  /** Clears one document and invalidates every result still in flight for it. */
  readonly forget: (documentId: string) => void
} {
  const [pendingSequences, setPendingSequences] = useState<ReadonlyMap<string, number>>(new Map())
  const [failures, setFailures] = useState<ReadonlyMap<string, UiError>>(new Map())
  const sequenceCounter = useRef(0)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  // Latest sequence PER DOCUMENT; guards every same-document side effect so
  // out-of-order completion of two schedules for one document can neither
  // install a stale failure over a newer success nor clear a fresh failure
  // with a stale success. Cross-document lifecycles stay fully independent.
  const latestSequenceRef = useRef(new Map<string, number>())

  const schedule = useCallback((targetId: string): void => {
    const sequence = ++sequenceCounter.current
    latestSequenceRef.current.set(targetId, sequence)
    setPendingSequences((previous) => {
      const next = new Map(previous)
      next.set(targetId, sequence)
      return next
    })
    invoke('document:analyze', { documentId: targetId })
      .then(() => {
        if (latestSequenceRef.current.get(targetId) !== sequence) return
        handlersRef.current.onScheduled?.()
        setFailures((previous) => {
          if (!previous.has(targetId)) return previous
          const next = new Map(previous)
          next.delete(targetId)
          return next
        })
      })
      .catch((cause: unknown) => {
        const error =
          cause instanceof UiError ? cause : new UiError('INTERNAL_ERROR', 'An internal error occurred')
        if (latestSequenceRef.current.get(targetId) !== sequence) return
        // Unconditional across DOCUMENTS (each has its own sequence); a newer
        // same-document attempt suppresses only its own superseded outcomes.
        handlersRef.current.onFailure?.(targetId, error)
        setFailures((previous) => {
          const next = new Map(previous)
          next.set(targetId, error)
          return next
        })
      })
      .finally(() => {
        setPendingSequences((previous) => {
          // Only the owning invocation retires its own pending marker.
          if (previous.get(targetId) !== sequence) return previous
          const next = new Map(previous)
          next.delete(targetId)
          return next
        })
      })
  }, [])

  const pendingDocumentIds = new Set(pendingSequences.keys())
  const failureFor = useCallback(
    (documentId: string | null | undefined): UiError | null =>
      documentId === null || documentId === undefined ? null : (failures.get(documentId) ?? null),
    [failures]
  )

  const forget = useCallback((documentId: string): void => {
    // A tombstone sequence makes every already-issued then/catch/finally stale;
    // simply deleting the key would let those callbacks repopulate state.
    latestSequenceRef.current.set(documentId, ++sequenceCounter.current)
    setPendingSequences((previous) => {
      if (!previous.has(documentId)) return previous
      const next = new Map(previous)
      next.delete(documentId)
      return next
    })
    setFailures((previous) => {
      if (!previous.has(documentId)) return previous
      const next = new Map(previous)
      next.delete(documentId)
      return next
    })
  }, [])

  return { schedule, pendingDocumentIds, failureFor, forget }
}

/**
 * Loads the document review read model. Refreshes for the SAME document
 * happen in place — the previously loaded review stays rendered until the
 * new one arrives so an in-flight refresh can never unmount open editors.
 * Results are tagged with the requested id: switching Documents cannot show
 * even one frame of the previous document's decrypted mention text.
 */
export function useDocumentReview(
  documentId: string | null,
  refreshKey: number
): { readonly review: DocumentReviewDTO | null; readonly error: UiError | null } {
  const [entry, setEntry] = useState<{ id: string | null; review: DocumentReviewDTO | null; error: UiError | null }>({
    id: null,
    review: null,
    error: null
  })

  useEffect(() => {
    if (documentId === null) {
      setEntry({ id: null, review: null, error: null })
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const load = (): void => {
      invoke('review:getDocument', { documentId })
        .then((result) => {
          if (active) setEntry({ id: documentId, review: result, error: null })
        })
        .catch((failure: unknown) => {
          if (!active) return
          // A transient failure of the one-and-only terminal-result read
          // would strand an empty result panel (the terminal revision never
          // re-triggers a refresh), so retry a few times before surfacing.
          attempts += 1
          if (attempts <= LOAD_RETRY_LIMIT) {
            timer = setTimeout(load, LOAD_RETRY_INTERVAL_MS)
            return
          }
          const error = failure instanceof UiError ? failure : null
          // In-place refresh for the same document keeps the old review;
          // a first load has nothing to preserve.
          setEntry((previous) =>
            previous.id === documentId ? { ...previous, error } : { id: documentId, review: null, error }
          )
        })
    }
    load()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [documentId, refreshKey])

  const current = entry.id === documentId ? entry : null
  return { review: current?.review ?? null, error: current?.error ?? null }
}

export function useSanitizedPreview(
  documentId: string | null,
  refreshKey: number
): { readonly preview: SanitizedPreview | null; readonly error: UiError | null } {
  const [entry, setEntry] = useState<{ id: string | null; preview: SanitizedPreview | null; error: UiError | null }>({
    id: null,
    preview: null,
    error: null
  })

  useEffect(() => {
    if (documentId === null) {
      setEntry({ id: null, preview: null, error: null })
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const load = (): void => {
      invoke('preview:get', { documentId })
        .then((result) => {
          if (active) setEntry({ id: documentId, preview: result, error: null })
        })
        .catch((failure: unknown) => {
          if (!active) return
          attempts += 1
          if (attempts <= LOAD_RETRY_LIMIT) {
            timer = setTimeout(load, LOAD_RETRY_INTERVAL_MS)
            return
          }
          const error = failure instanceof UiError ? failure : null
          setEntry((previous) =>
            previous.id === documentId ? { ...previous, error } : { id: documentId, preview: null, error }
          )
        })
    }
    load()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [documentId, refreshKey])

  const current = entry.id === documentId ? entry : null
  return { preview: current?.preview ?? null, error: current?.error ?? null }
}

/** Dedicated trash read path: deleted Matters and individually trashed Documents. */
export function useTrash(refreshKey = 0): {
  readonly trash: WorkspaceTrashDTO | null
  readonly loaded: boolean
  readonly error: UiError | null
} {
  const [trash, setTrash] = useState<WorkspaceTrashDTO | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    let active = true
    setLoaded(false)
    setError(null)
    invoke('trash:list', {})
      .then((result) => {
        if (active) {
          setTrash(result)
          setLoaded(true)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(failure instanceof UiError ? failure : null)
          setLoaded(true)
        }
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  return { trash, loaded, error }
}

/** Loads the non-sensitive provider configuration (key presence only). */
export function useAiProviderStatus(refreshKey = 0): {
  readonly status: AiProviderStatus | null
  readonly error: UiError | null
} {
  const [status, setStatus] = useState<AiProviderStatus | null>(null)
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    setStatus(null)
    setError(null)
    let active = true
    invoke('aiProvider:getStatus', {})
      .then((result) => {
        if (active) setStatus(result)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof UiError ? failure : null)
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  return { status, error }
}

/**
 * Wraps a mutation with in-flight and error state; never throws to callers.
 * The shared state belongs to the most recent invocation only: when a new run
 * starts, a superseded invocation can neither clear its pending flag nor
 * install its error, so an older policy's late failure never surfaces under a
 * newer one that is still in flight.
 */
export function useMutation<Arguments extends unknown[], Result>(
  action: (...args: Arguments) => Promise<Result>
): {
  readonly run: (...args: Arguments) => Promise<Result | null>
  readonly pending: boolean
  readonly error: UiError | null
} {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<UiError | null>(null)
  const latestInvocationRef = useRef(0)

  const run = useCallback(
    async (...args: Arguments): Promise<Result | null> => {
      const invocation = ++latestInvocationRef.current
      setPending(true)
      setError(null)
      try {
        return await action(...args)
      } catch (failure) {
        if (invocation === latestInvocationRef.current) {
          setError(failure instanceof UiError ? failure : new UiError('INTERNAL_ERROR', 'An internal error occurred'))
        }
        return null
      } finally {
        if (invocation === latestInvocationRef.current) setPending(false)
      }
    },
    [action]
  )

  return { run, pending, error }
}
