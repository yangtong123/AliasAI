import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInEnglish } from '../test-utils'
import { PipelineControls } from './PipelineControls'

describe('PipelineControls', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('gates the next stage button by parse status', () => {
    const { rerender } = renderInEnglish(
      <PipelineControls documentId="document-1" parseStatus="PARSED" jobs={[]} onChanged={() => {}} />
    )
    expect(screen.getByRole('button', { name: 'Run Detect' })).toBeDefined()

    rerender(<PipelineControls documentId="document-1" parseStatus="READY" jobs={[]} onChanged={() => {}} />)
    expect(screen.getByText(/Pipeline idle/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Run/ })).toBeNull()

    rerender(<PipelineControls documentId="document-1" parseStatus="IMPORTED" jobs={[]} onChanged={() => {}} />)
    expect(screen.getByRole('button', { name: 'Run Parse' })).toBeDefined()
  })

  it.each([
    ['DETECT', 'Retry Detect'],
    ['RESOLVE', 'Retry Resolve']
  ] as const)('retries the failed downstream %s stage instead of incorrectly reparsing', (type, label) => {
    renderInEnglish(
      <PipelineControls
        documentId="document-1"
        parseStatus="FAILED"
        jobs={[{ type, status: 'FAILED', progress: 0.5, createdAt: 10 }]}
        onChanged={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: label })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Retry Parse' })).toBeNull()
  })

  it('leaves a failed sanitization retry to the preview workflow', () => {
    renderInEnglish(
      <PipelineControls
        documentId="document-1"
        parseStatus="FAILED"
        jobs={[{ type: 'SANITIZE', status: 'FAILED', progress: 0.5, createdAt: 10 }]}
        onChanged={() => {}}
      />
    )

    expect(screen.getByText('Pipeline idle')).toBeDefined()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  })

  it('retries parsing when FAILED has no downstream job', () => {
    renderInEnglish(<PipelineControls documentId="document-1" parseStatus="FAILED" jobs={[]} onChanged={() => {}} />)

    expect(screen.getByRole('button', { name: 'Retry Parse' })).toBeDefined()
  })

  it('runs the gated stage and reports the running job progress', async () => {
    invoke.mockResolvedValueOnce({ ok: true, data: { document: {}, jobs: [] } })
    const onChanged = vi.fn()
    const user = userEvent.setup()

    renderInEnglish(
      <PipelineControls
        documentId="document-1"
        parseStatus="DETECTED"
        jobs={[{ type: 'RESOLVE', status: 'RUNNING', progress: 0.5, createdAt: 1 }]}
        onChanged={onChanged}
      />
    )

    expect(screen.getByText(/Resolve: 50%/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Run Resolve' }))
    expect(invoke).toHaveBeenCalledWith('document:resolve', { documentId: 'document-1' })
    expect(onChanged).toHaveBeenCalled()
  })
})
