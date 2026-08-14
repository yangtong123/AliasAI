import { describe, expect, it } from 'vitest'
import { RESOLUTION_ALGORITHM_VERSION, scoreCandidate } from '../src/index'
import type { CandidateScoringInput } from '../src/index'

const input = (overrides: Partial<CandidateScoringInput> = {}): CandidateScoringInput => ({
  sharesProtectedValue: false,
  conflictsProtectedValue: false,
  nameExactMatch: false,
  userCannotLink: false,
  userMustLink: false,
  ...overrides
})

describe('RESOLUTION_ALGORITHM_VERSION', () => {
  it('is pinned to er-v1', () => {
    expect(RESOLUTION_ALGORITHM_VERSION).toBe('er-v1')
  })
})

describe('scoreCandidate', () => {
  it('lets a user Cannot-Link override every other signal, including a shared ID card', () => {
    expect(
      scoreCandidate('ID_CARD', input({ userCannotLink: true, sharesProtectedValue: true, nameExactMatch: true }))
    ).toEqual({
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'USER_CANNOT_LINK', weight: 0, score: 0 }]
    })
  })

  it('hard Must-Links on a USER_MUST_LINK constraint, evaluated right after user Cannot-Link', () => {
    expect(scoreCandidate('PHONE', input({ userMustLink: true, sharesProtectedValue: true }))).toEqual({
      score: 40,
      hardRule: 'MUST_LINK',
      evidence: [{ type: 'USER_MUST_LINK', weight: 40, score: 40 }]
    })
    // USER_MUST_LINK wins over the ID_CARD hard rule and any soft signal.
    expect(
      scoreCandidate('ID_CARD', input({ userMustLink: true, sharesProtectedValue: true, nameExactMatch: true }))
    ).toEqual({
      score: 40,
      hardRule: 'MUST_LINK',
      evidence: [{ type: 'USER_MUST_LINK', weight: 40, score: 40 }]
    })
  })

  it('lets a user Cannot-Link still win when both user constraints apply', () => {
    expect(
      scoreCandidate('PHONE', input({ userCannotLink: true, userMustLink: true, sharesProtectedValue: true }))
    ).toEqual({
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'USER_CANNOT_LINK', weight: 0, score: 0 }]
    })
  })

  it('lets a hard identity conflict override a user Must-Link', () => {
    expect(
      scoreCandidate('PERSON', input({ userMustLink: true, conflictsProtectedValue: true, nameExactMatch: true }))
    ).toEqual({
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'CONFLICTING_ID_CARD', weight: 0, score: 0 }]
    })
  })

  it('hard Must-Links an ID_CARD mention sharing a ProtectedValue', () => {
    expect(scoreCandidate('ID_CARD', input({ sharesProtectedValue: true }))).toEqual({
      score: 40,
      hardRule: 'MUST_LINK',
      evidence: [{ type: 'SAME_ID_CARD', weight: 40, score: 40 }]
    })
  })

  it('hard Cannot-Links an ID_CARD mention conflicting with a ProtectedValue', () => {
    expect(scoreCandidate('ID_CARD', input({ conflictsProtectedValue: true }))).toEqual({
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'CONFLICTING_ID_CARD', weight: 0, score: 0 }]
    })
  })

  it('hard Cannot-Links a same-name PERSON or ORGANIZATION candidate with a conflicting ID card', () => {
    for (const mentionType of ['PERSON', 'ORGANIZATION'] as const) {
      expect(scoreCandidate(mentionType, input({ conflictsProtectedValue: true, nameExactMatch: true }))).toEqual({
        score: 0,
        hardRule: 'CANNOT_LINK',
        evidence: [{ type: 'CONFLICTING_ID_CARD', weight: 0, score: 0 }]
      })
    }
  })

  it('scores shared phone, email, and bank account values without a hard rule', () => {
    const cases = [
      ['PHONE', 'SAME_PHONE'],
      ['EMAIL', 'SAME_EMAIL'],
      ['BANK_ACCOUNT', 'SAME_BANK_ACCOUNT']
    ] as const
    for (const [mentionType, evidenceType] of cases) {
      expect(scoreCandidate(mentionType, input({ sharesProtectedValue: true }))).toEqual({
        score: 40,
        evidence: [{ type: evidenceType, weight: 40, score: 40 }]
      })
    }
  })

  it('scores an exact name match for PERSON and ORGANIZATION without a hard rule', () => {
    for (const mentionType of ['PERSON', 'ORGANIZATION'] as const) {
      expect(scoreCandidate(mentionType, input({ nameExactMatch: true }))).toEqual({
        score: 25,
        evidence: [{ type: 'NAME_EXACT', weight: 25, score: 25 }]
      })
    }
  })

  it('accumulates name evidence with identifier evidence when both apply', () => {
    expect(scoreCandidate('PERSON', input({ nameExactMatch: true, sharesProtectedValue: true }))).toEqual({
      score: 25,
      evidence: [{ type: 'NAME_EXACT', weight: 25, score: 25 }]
    })
  })

  it('returns zero with empty evidence when nothing applies', () => {
    expect(scoreCandidate('PERSON', input())).toEqual({ score: 0, evidence: [] })
    expect(scoreCandidate('PHONE', input())).toEqual({ score: 0, evidence: [] })
    expect(scoreCandidate('COURT', input({ sharesProtectedValue: true, nameExactMatch: true }))).toEqual({
      score: 0,
      evidence: []
    })
  })
})
