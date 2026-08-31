import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSummaryDTO } from '@aliasai/application'
import { renderInEnglish } from '../test-utils'
import { AnalysisStatus } from './AnalysisStatus'

describe('AnalysisStatus', () => {
  beforeEach(() => {})

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const runningJob: JobSummaryDTO = { id: 'job-running', type: 'PARSE', status: 'RUNNING', progress: 0.5, createdAt: 1 }

  it.each([
    ['IMPORTED', 'Waiting to analyze…'],
    ['PARSING', 'Reading the document…'],
    ['PARSED', 'Detecting sensitive information…'],
    ['DETECTING', 'Detecting sensitive information…'],
    ['DETECTED', 'Sorting out people and organizations…'],
    ['RESOLVING', 'Sorting out people and organizations…']
  ] as const)('renders the friendly progress copy for %s', (parseStatus, expected) => {
    renderInEnglish(
      <AnalysisStatus parseStatus={parseStatus} jobs={[]} onRetry={() => {}} />
    )
    expect(screen.getByText(expected)).toBeDefined()
    // No stage buttons or retry affordance while work runs.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Run |Retry /)).toBeNull()
  })

  it('renders a completion headline once analyzed', () => {
    for (const parseStatus of ['READY', 'SANITIZED'] as const) {
      const { unmount } = renderInEnglish(
        <AnalysisStatus parseStatus={parseStatus} jobs={[]} onRetry={() => {}} />
      )
      expect(screen.getByText('Analysis complete')).toBeDefined()
      unmount()
    }
  })

  it('exposes exactly one retry action on an analysis-owned failure and delegates scheduling', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    renderInEnglish(
      <AnalysisStatus
        parseStatus="FAILED"
        jobs={[{ id: 'job-resolve-5', type: 'RESOLVE', status: 'FAILED', progress: 0.2, createdAt: 5 }]}
        onRetry={onRetry}
      />
    )

    expect(screen.getByText('Analysis did not finish, please retry')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Analyze again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('disables retry while analysis is already underway', () => {
    renderInEnglish(
      <AnalysisStatus
        parseStatus="FAILED"
        jobs={[{ id: 'job-detect-2', type: 'DETECT', status: 'FAILED', progress: 0, createdAt: 2 }]}
        analysisPending
        onRetry={() => {}}
      />
    )
    expect((screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('retries the parse origin even without any failed job evidence', () => {
    renderInEnglish(
      <AnalysisStatus parseStatus="FAILED" jobs={[]} onRetry={() => {}} />
    )
    expect(screen.getByRole('button', { name: 'Analyze again' })).toBeDefined()
  })

  it('leaves sanitization failures to the preview workflow without a retry button', () => {
    renderInEnglish(
      <AnalysisStatus
        parseStatus="FAILED"
        jobs={[{ id: 'job-sanitize-9', type: 'SANITIZE', status: 'FAILED', progress: 0.9, createdAt: 9 }]}
        onRetry={() => {}}
      />
    )

    expect(screen.getByText(/Sanitization failed/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Analyze again' })).toBeNull()
  })

  it('keeps exactly one usable retry action after a scheduling failure', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    renderInEnglish(
      <AnalysisStatus
        parseStatus="IMPORTED"
        jobs={[]}
        scheduleError="Automatic analysis could not start. Reopen this document to try again."
        onRetry={onRetry}
      />
    )

    const retry = screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement
    // The activity window was released with the failure, so retry stays live.
    expect(retry.disabled).toBe(false)
    await user.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    // No phantom progress hint is shown alongside the failure.
    expect(screen.queryByText(/reads the document/i)).toBeNull()
  })

  it('disables the retry action only while work is genuinely underway', () => {
    renderInEnglish(
      <AnalysisStatus
        parseStatus="FAILED"
        jobs={[{ id: 'job-resolve-4', type: 'RESOLVE', status: 'FAILED', progress: 0.2, createdAt: 4 }]}
        analysisPending
        onRetry={() => {}}
      />
    )
    expect((screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    renderInEnglish(
      <AnalysisStatus
        parseStatus="FAILED"
        jobs={[{ id: 'job-resolve-4', type: 'RESOLVE', status: 'FAILED', progress: 0.2, createdAt: 4 }]}
        onRetry={() => {}}
      />
    )
    expect((screen.getByRole('button', { name: 'Analyze again' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows numeric job progress as a bar but never raw job details', () => {
    const { container } = renderInEnglish(
      <AnalysisStatus parseStatus="PARSING" jobs={[runningJob]} onRetry={() => {}} />
    )
    expect(container.querySelector('progress')).not.toBeNull()
    expect(screen.queryByText('PARSE')).toBeNull()
    expect(screen.queryByText(/RUNNING/)).toBeNull()
  })
})
