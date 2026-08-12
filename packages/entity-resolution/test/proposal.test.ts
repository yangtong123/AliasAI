import { describe, expect, it } from 'vitest'
import { proposeResolution } from '../src/index'
import type { Entity } from '@aliasai/domain'

const entity = (id: string, type: Entity['type'] = 'PERSON'): Entity => ({
  id,
  matterId: 'matter-1',
  type,
  publicToken: `@P-${id}`,
  status: 'ACTIVE',
  createdAt: 1,
  updatedAt: 1
})

describe('entity-resolution proposals', () => {
  it('never auto-links a PERSON on an exact-name-like soft score alone', () => {
    expect(proposeResolution({ id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' }, [{ entity: entity('1'), score: 100, evidence: ['NAME_EXACT'] }])).toMatchObject({ decision: 'REVIEW' })
  })

  it('honours Must-Link before soft score and leaves weak references unresolved', () => {
    expect(proposeResolution({ id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' }, [{ entity: entity('1'), score: 1, hardRule: 'MUST_LINK', evidence: ['SAME_ID_CARD'] }])).toMatchObject({ decision: 'AUTO_LINK', candidateEntityId: '1' })
    expect(proposeResolution({ id: 'mention-2', matterId: 'matter-1', type: 'PERSON', strength: 'REFERENCE' }, [])).toMatchObject({ decision: 'UNRESOLVED' })
  })

  it('never proposes a candidate with a different Entity type', () => {
    expect(
      proposeResolution(
        { id: 'mention-1', matterId: 'matter-1', type: 'ORGANIZATION', strength: 'EXPLICIT' },
        [{ entity: entity('1', 'PERSON'), score: 100, hardRule: 'MUST_LINK', evidence: ['BAD_INPUT'] }]
      )
    ).toMatchObject({ decision: 'NEW_ENTITY', rankedCandidates: [] })
  })

  it('sends conflicting Must-Link rules to review instead of choosing one', () => {
    expect(
      proposeResolution(
        { id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' },
        [
          { entity: entity('1'), score: 90, hardRule: 'MUST_LINK', evidence: ['SAME_ID_CARD'] },
          { entity: entity('2'), score: 80, hardRule: 'MUST_LINK', evidence: ['USER_CONSTRAINT'] }
        ]
      )
    ).toMatchObject({ decision: 'REVIEW', reason: 'conflicting hard Must-Link candidates' })
  })

  it('lets Cannot-Link override a duplicate Must-Link for the same Entity', () => {
    expect(
      proposeResolution(
        { id: 'mention-1', matterId: 'matter-1', type: 'PERSON', strength: 'EXPLICIT' },
        [
          { entity: entity('1'), score: 100, hardRule: 'MUST_LINK', evidence: ['SAME_ID_CARD'] },
          { entity: entity('1'), score: 1, hardRule: 'CANNOT_LINK', evidence: ['USER_CONSTRAINT'] }
        ]
      )
    ).toMatchObject({
      decision: 'NEW_ENTITY',
      rankedCandidates: [{ hardRule: 'CANNOT_LINK', evidence: ['SAME_ID_CARD', 'USER_CONSTRAINT'] }]
    })
  })
})
