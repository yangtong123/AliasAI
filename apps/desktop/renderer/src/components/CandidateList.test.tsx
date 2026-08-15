import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidateDTO } from '@aliasai/application'
import { CandidateList } from './CandidateList'

const candidate = (overrides: Partial<CandidateDTO> = {}): CandidateDTO => ({
  candidateId: 'candidate-1',
  entity: {
    id: 'entity-1',
    publicToken: '@P-entity-1',
    type: 'PERSON',
    status: 'ACTIVE',
    primaryAlias: 'Holder One',
    createdAt: 1
  },
  score: 90,
  state: 'PENDING',
  algorithmVersion: 'er-v1',
  evidence: [{ evidenceType: 'SHARED_PROTECTED_VALUE', weight: 40, score: 40 }],
  ...overrides
})

describe('CandidateList', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the empty-state hint without candidates', () => {
    render(<CandidateList mentionId="mention-1" candidates={[]} onApplied={() => {}} />)

    expect(screen.getByText(/No candidates/i)).toBeDefined()
  })

  it('renders score, state, and evidence and accepts a pending candidate', async () => {
    const onApplied = vi.fn()
    invoke.mockResolvedValueOnce({ ok: true, data: {} })
    const user = userEvent.setup()

    render(<CandidateList mentionId="mention-1" candidates={[candidate()]} onApplied={onApplied} />)

    expect(screen.getByText(/score 90/)).toBeDefined()
    expect(screen.getByText(/SHARED_PROTECTED_VALUE \(weight 40, score 40\)/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Accept' }))

    expect(invoke).toHaveBeenCalledWith('review:assign', { mentionId: 'mention-1', entityId: 'entity-1' })
    expect(onApplied).toHaveBeenCalled()
  })

  it('offers no accept button for resolved candidates', () => {
    render(<CandidateList mentionId="mention-1" candidates={[candidate({ state: 'REJECTED' })]} onApplied={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })
})
