import { describe, expect, it } from 'vitest'
import { proposeResolution, scoreCandidate } from '../src/index'
import type { ResolutionCandidateInput, ScoredCandidate } from '../src/index'
import type { Entity, MentionType } from '@aliasai/domain'

const entity = (id: string, type: Entity['type'] = 'PERSON'): Entity => ({
  id,
  matterId: 'matter-1',
  type,
  publicToken: `@P-${id}`,
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1
})

const candidate = (scored: ScoredCandidate, target: Entity): ResolutionCandidateInput => ({
  entity: target,
  score: scored.score,
  ...(scored.hardRule === undefined ? {} : { hardRule: scored.hardRule }),
  evidence: scored.evidence.map((item) => item.type)
})

describe('proposeResolution with identifier and metadata mentions', () => {
  it('auto-links an ID_CARD mention on a single hard Must-Link candidate of any Entity type', () => {
    const scored = scoreCandidate('ID_CARD', {
      sharesProtectedValue: true,
      conflictsProtectedValue: false,
      nameExactMatch: false,
      userCannotLink: false,
      userMustLink: false
    })
    expect(
      proposeResolution(
        { id: 'mention-1', matterId: 'matter-1', type: 'ID_CARD', strength: 'EXPLICIT' },
        [candidate(scored, entity('1', 'PERSON'))]
      )
    ).toMatchObject({ decision: 'AUTO_LINK', candidateEntityId: '1' })
  })

  it('keeps an identifier mention UNRESOLVED instead of NEW_ENTITY on weak soft evidence', () => {
    const scored = scoreCandidate('PHONE', {
      sharesProtectedValue: true,
      conflictsProtectedValue: false,
      nameExactMatch: false,
      userCannotLink: false,
      userMustLink: false
    })
    expect(scored.score).toBe(40)
    const proposal = proposeResolution(
      { id: 'mention-1', matterId: 'matter-1', type: 'PHONE', strength: 'EXPLICIT' },
      [candidate(scored, entity('1', 'ORGANIZATION'))]
    )
    // 40 < 65 and identifier mentions can never create Entities.
    expect(proposal.decision).toBe('UNRESOLVED')
    expect(proposal.candidateEntityId).toBeUndefined()
  })

  it('never creates or links an Entity for metadata mention types', () => {
    const metadataTypes: readonly MentionType[] = ['CASE_NUMBER', 'CONTRACT_NUMBER', 'COURT', 'LAWYER', 'JUDGE']
    for (const type of metadataTypes) {
      expect(
        proposeResolution(
          { id: 'mention-1', matterId: 'matter-1', type, strength: 'EXPLICIT' },
          [{ entity: entity('1'), score: 100, hardRule: 'MUST_LINK', evidence: ['SAME_ID_CARD'] }]
        )
      ).toMatchObject({ decision: 'UNRESOLVED', rankedCandidates: [] })
      expect(proposeResolution({ id: 'mention-2', matterId: 'matter-1', type, strength: 'EXPLICIT' }, [])).toMatchObject({
        decision: 'UNRESOLVED'
      })
    }
  })

  it('never auto-links a PERSON mention on NAME_EXACT evidence alone', () => {
    const scored = scoreCandidate('PERSON', {
      sharesProtectedValue: false,
      conflictsProtectedValue: false,
      nameExactMatch: true,
      userCannotLink: false,
      userMustLink: false
    })
    expect(scored.score).toBe(25)
    const proposal = proposeResolution(
      { id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' },
      [candidate(scored, entity('1'))]
    )
    // A scored candidate below the review threshold is ambiguity: the mention
    // goes to REVIEW and is never silently linked or duplicated into a new Entity.
    expect(proposal.decision).toBe('REVIEW')
    expect(proposal.candidateEntityId).toBe('1')
  })

  it('only proposes NEW_ENTITY when no eligible candidate exists', () => {
    const scored = scoreCandidate('PERSON', {
      sharesProtectedValue: false,
      conflictsProtectedValue: false,
      nameExactMatch: true,
      userCannotLink: false,
      userMustLink: false
    })
    expect(
      proposeResolution({ id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' }, [])
    ).toMatchObject({ decision: 'NEW_ENTITY' })
    // A candidate rejected by a hard Cannot-Link does not block creation.
    expect(
      proposeResolution({ id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' }, [
        { entity: entity('1'), score: scored.score, hardRule: 'CANNOT_LINK', evidence: scored.evidence.map((item) => item.type) }
      ])
    ).toMatchObject({ decision: 'NEW_ENTITY' })
  })
})
