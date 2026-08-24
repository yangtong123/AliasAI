import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocumentReviewDTO,
  DocumentSummaryDTO,
  JobSummaryDTO,
  MatterSummaryDTO,
  SanitizedPreview
} from '@aliasai/application'
import { invoke, UiError } from './client'

export function useMatters(): { readonly matters: readonly MatterSummaryDTO[]; readonly error: UiError | null } {
  const [matters, setMatters] = useState<readonly MatterSummaryDTO[]>([])
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    let active = true
    invoke('matter:list', {})
      .then((result) => {
        if (active) setMatters(result)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof UiError ? failure : null)
      })
    return () => {
      active = false
    }
  }, [])

  return { matters, error }
}

const IN_FLIGHT_STATUSES = new Set(['PARSING', 'DETECTING', 'RESOLVING', 'SANITIZING'])
const POLL_INTERVAL_MS = 1000

/**
 * Polls a document's status while a pipeline stage is in flight and stops at
 * any terminal status; `refreshKey` lets callers force an immediate re-poll.
 */
export function useDocumentStatus(
  documentId: string | null,
  refreshKey: number
): {
  readonly document: DocumentSummaryDTO | null
  readonly jobs: readonly JobSummaryDTO[]
  readonly error: UiError | null
} {
  const [document, setDocument] = useState<DocumentSummaryDTO | null>(null)
  const [jobs, setJobs] = useState<readonly JobSummaryDTO[]>([])
  const [error, setError] = useState<UiError | null>(null)
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (document !== null && IN_FLIGHT_STATUSES.has(document.parseStatus)) {
      timer.current = setTimeout(() => setTick((value) => value + 1), POLL_INTERVAL_MS)
    }
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [document])

  useEffect(() => {
    if (documentId === null) return
    let active = true
    invoke('document:get', { documentId })
      .then((result) => {
        if (active) {
          setDocument(result.document)
          setJobs(result.jobs)
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof UiError ? failure : null)
      })
    return () => {
      active = false
    }
  }, [documentId, refreshKey, tick])

  return { document, jobs, error }
}

export function useDocumentReview(
  documentId: string | null,
  refreshKey: number
): { readonly review: DocumentReviewDTO | null; readonly error: UiError | null } {
  const [review, setReview] = useState<DocumentReviewDTO | null>(null)
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    if (documentId === null) return
    let active = true
    invoke('review:getDocument', { documentId })
      .then((result) => {
        if (active) setReview(result)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof UiError ? failure : null)
      })
    return () => {
      active = false
    }
  }, [documentId, refreshKey])

  return { review, error }
}

export function useSanitizedPreview(
  documentId: string | null,
  refreshKey: number
): { readonly preview: SanitizedPreview | null; readonly error: UiError | null } {
  const [preview, setPreview] = useState<SanitizedPreview | null>(null)
  const [error, setError] = useState<UiError | null>(null)

  useEffect(() => {
    if (documentId === null) return
    let active = true
    invoke('preview:get', { documentId })
      .then((result) => {
        if (active) setPreview(result)
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof UiError ? failure : null)
      })
    return () => {
      active = false
    }
  }, [documentId, refreshKey])

  return { preview, error }
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
