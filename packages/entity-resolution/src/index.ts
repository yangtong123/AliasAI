import type { Entity, EntityType, MentionStrength } from '@aliasai/domain'

export type ResolutionDecision = 'AUTO_LINK' | 'REVIEW' | 'NEW_ENTITY' | 'UNRESOLVED'
export type HardRule = 'MUST_LINK' | 'CANNOT_LINK'

export interface ResolutionMention {
  readonly id: string
  readonly matterId: string
  readonly type: EntityType
  readonly strength: MentionStrength
}

export interface ResolutionCandidateInput {
  readonly entity: Entity
  readonly score: number
  readonly hardRule?: HardRule
  readonly evidence: readonly string[]
}

export interface ResolutionProposal {
  readonly mentionId: string
  readonly decision: ResolutionDecision
  readonly candidateEntityId?: string
  readonly reason: string
  readonly rankedCandidates: readonly ResolutionCandidateInput[]
}

/**
 * Rule-first, explainable V1 decision gate. It produces proposals only; no
 * entity or mention mutation occurs here.
 */
export function proposeResolution(
  mention: ResolutionMention,
  candidates: readonly ResolutionCandidateInput[]
): ResolutionProposal {
  const rankedCandidates = normalizeCandidates(mention, candidates)
  const cannotLink = rankedCandidates.filter((candidate) => candidate.hardRule === 'CANNOT_LINK')
  const mustLink = rankedCandidates.filter((candidate) => candidate.hardRule === 'MUST_LINK')
  if (mustLink.length === 1) {
    return result(mention.id, 'AUTO_LINK', mustLink[0]!, 'hard Must-Link', rankedCandidates)
  }
  if (mustLink.length > 1) {
    return result(mention.id, 'REVIEW', mustLink[0], 'conflicting hard Must-Link candidates', rankedCandidates)
  }
  if (cannotLink.length === rankedCandidates.length && rankedCandidates.length > 0) {
    return result(mention.id, mention.strength === 'REFERENCE' ? 'UNRESOLVED' : 'NEW_ENTITY', undefined, 'all candidates Cannot-Link', rankedCandidates)
  }

  const eligible = rankedCandidates.filter((candidate) => candidate.hardRule !== 'CANNOT_LINK')
  const top = eligible[0]
  const runnerUp = eligible[1]
  if (top === undefined) return result(mention.id, mention.strength === 'REFERENCE' ? 'UNRESOLVED' : 'NEW_ENTITY', undefined, 'no candidate', rankedCandidates)

  const margin = top.score - (runnerUp?.score ?? 0)
  const mayAutoLink = mention.type !== 'PERSON' && top.score >= 90 && margin >= 15
  if (mayAutoLink) return result(mention.id, 'AUTO_LINK', top, 'score and margin threshold met', rankedCandidates)
  if (top.score >= 65) return result(mention.id, 'REVIEW', top, 'ambiguous or PERSON candidate requires review', rankedCandidates)
  return result(
    mention.id,
    mention.strength === 'REFERENCE' ? 'UNRESOLVED' : 'NEW_ENTITY',
    undefined,
    'insufficient evidence',
    rankedCandidates
  )
}

/** Collapses duplicate inputs so a Cannot-Link always wins for that Entity. */
function normalizeCandidates(
  mention: ResolutionMention,
  candidates: readonly ResolutionCandidateInput[]
): ResolutionCandidateInput[] {
  const byEntity = new Map<string, ResolutionCandidateInput>()
  for (const candidate of candidates) {
    if (
      candidate.entity.matterId !== mention.matterId ||
      candidate.entity.type !== mention.type ||
      candidate.entity.status !== 'ACTIVE' ||
      !Number.isFinite(candidate.score)
    ) {
      continue
    }

    const previous = byEntity.get(candidate.entity.id)
    if (previous === undefined) {
      byEntity.set(candidate.entity.id, candidate)
      continue
    }

    const hardRule =
      previous.hardRule === 'CANNOT_LINK' || candidate.hardRule === 'CANNOT_LINK'
        ? 'CANNOT_LINK'
        : previous.hardRule === 'MUST_LINK' || candidate.hardRule === 'MUST_LINK'
          ? 'MUST_LINK'
          : undefined
    byEntity.set(candidate.entity.id, {
      entity: previous.entity,
      score: Math.max(previous.score, candidate.score),
      ...(hardRule === undefined ? {} : { hardRule }),
      evidence: [...new Set([...previous.evidence, ...candidate.evidence])]
    })
  }

  return [...byEntity.values()].sort((left, right) => right.score - left.score)
}

function result(
  mentionId: string,
  decision: ResolutionDecision,
  candidate: ResolutionCandidateInput | undefined,
  reason: string,
  rankedCandidates: readonly ResolutionCandidateInput[]
): ResolutionProposal {
  return {
    mentionId,
    decision,
    ...(candidate === undefined ? {} : { candidateEntityId: candidate.entity.id }),
    reason,
    rankedCandidates
  }
}
