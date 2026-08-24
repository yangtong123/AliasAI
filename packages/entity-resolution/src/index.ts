import type { Entity, EntityType, MentionStrength, MentionType } from '@aliasai/domain'

export {
  BANK_ACCOUNT_MAX_DIGITS,
  BANK_ACCOUNT_MIN_DIGITS,
  MIN_DIGIT_EQUIVALENCE_LENGTH,
  NUMBER_GROUP_SEPARATOR_CHARS,
  PHONE_MAX_DIGITS,
  dropMainlandCountryPrefix,
  foldDecimalDigits,
  isValidNormalizedValue,
  mentionTypeToProtectedValueType,
  normalizeMentionValue,
  normalizeProtectedValue
} from './normalization'

export type ResolutionDecision = 'AUTO_LINK' | 'REVIEW' | 'NEW_ENTITY' | 'UNRESOLVED'
export type HardRule = 'MUST_LINK' | 'CANNOT_LINK'

/** Version marker for the decision/scoring algorithm; bump on any behavioral change. */
export const RESOLUTION_ALGORITHM_VERSION = 'er-v1'

export interface ResolutionMention {
  readonly id: string
  readonly matterId: string
  readonly type: MentionType
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

export interface CandidateEvidenceScore {
  readonly type: string
  readonly weight: number
  readonly score: number
}

export interface ScoredCandidate {
  readonly score: number
  readonly hardRule?: HardRule
  readonly evidence: readonly CandidateEvidenceScore[]
}

export interface CandidateScoringInput {
  /** True when the mention's normalized-value fingerprint matches a ProtectedValue already linked to the candidate entity (same ProtectedValueType as the mention). */
  readonly sharesProtectedValue: boolean
  /** True when the candidate entity holds an ID_CARD ProtectedValue with a DIFFERENT fingerprint than the document context (hard conflict). */
  readonly conflictsProtectedValue: boolean
  /** True when the mention's normalized value exactly equals the candidate entity's normalized primary alias. */
  readonly nameExactMatch: boolean
  /** True when a USER CANNOT_LINK constraint exists between the candidate entity and the entity referenced by the mention's shared ProtectedValue. */
  readonly userCannotLink: boolean
  /** True when a USER MUST_LINK constraint exists between the candidate entity and another entity referenced by the mention's shared ProtectedValue. */
  readonly userMustLink: boolean
}

const IDENTIFIER_EVIDENCE: Readonly<Partial<Record<MentionType, string>>> = {
  PHONE: 'SAME_PHONE',
  EMAIL: 'SAME_EMAIL',
  BANK_ACCOUNT: 'SAME_BANK_ACCOUNT'
}

/**
 * Pure weighted-evidence scorer. Hard rules follow the documented evaluation
 * order — explicit user Cannot-Link, then hard identity conflict, then
 * Must-Link — and every hard rule overrides all soft signals. Hard rules are
 * exclusive.
 */
export function scoreCandidate(mentionType: MentionType, input: CandidateScoringInput): ScoredCandidate {
  if (input.userCannotLink) {
    return {
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'USER_CANNOT_LINK', weight: 0, score: 0 }]
    }
  }
  // A conflicting validated ID_CARD is a hard conflict: it overrides every
  // Must-Link and every soft signal such as an exact name match.
  if (input.conflictsProtectedValue && (mentionType === 'ID_CARD' || mentionType === 'PERSON' || mentionType === 'ORGANIZATION')) {
    return {
      score: 0,
      hardRule: 'CANNOT_LINK',
      evidence: [{ type: 'CONFLICTING_ID_CARD', weight: 0, score: 0 }]
    }
  }
  if (input.userMustLink) {
    return {
      score: 40,
      hardRule: 'MUST_LINK',
      evidence: [{ type: 'USER_MUST_LINK', weight: 40, score: 40 }]
    }
  }
  if (mentionType === 'ID_CARD' && input.sharesProtectedValue) {
    return {
      score: 40,
      hardRule: 'MUST_LINK',
      evidence: [{ type: 'SAME_ID_CARD', weight: 40, score: 40 }]
    }
  }

  const evidence: CandidateEvidenceScore[] = []
  const identifierEvidence = IDENTIFIER_EVIDENCE[mentionType]
  if (identifierEvidence !== undefined && input.sharesProtectedValue) {
    evidence.push({ type: identifierEvidence, weight: 40, score: 40 })
  }
  if ((mentionType === 'PERSON' || mentionType === 'ORGANIZATION') && input.nameExactMatch) {
    evidence.push({ type: 'NAME_EXACT', weight: 25, score: 25 })
  }
  return { score: evidence.reduce((total, item) => total + item.score, 0), evidence }
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
    return result(mention.id, mayCreateEntity(mention) ? 'NEW_ENTITY' : 'UNRESOLVED', undefined, 'all candidates Cannot-Link', rankedCandidates)
  }

  const eligible = rankedCandidates.filter((candidate) => candidate.hardRule !== 'CANNOT_LINK')
  const top = eligible[0]
  const runnerUp = eligible[1]
  if (top === undefined) return result(mention.id, mayCreateEntity(mention) ? 'NEW_ENTITY' : 'UNRESOLVED', undefined, 'no candidate', rankedCandidates)

  const margin = top.score - (runnerUp?.score ?? 0)
  const mayAutoLink = mention.type !== 'PERSON' && top.score >= 90 && margin >= 15
  if (mayAutoLink) return result(mention.id, 'AUTO_LINK', top, 'score and margin threshold met', rankedCandidates)
  if (top.score >= 65) return result(mention.id, 'REVIEW', top, 'ambiguous or PERSON candidate requires review', rankedCandidates)
  // A scored candidate below the review threshold is ambiguity, not evidence of
  // absence: never auto-create a duplicate Entity while a candidate exists.
  if (mayCreateEntity(mention)) {
    return result(mention.id, 'REVIEW', top, 'scored candidate below the review threshold', rankedCandidates)
  }
  return result(mention.id, 'UNRESOLVED', undefined, 'insufficient evidence', rankedCandidates)
}

/**
 * A new Entity may only be created from a PERSON/ORGANIZATION mention with
 * EXPLICIT or PARTIAL strength; identifier and metadata mentions stay
 * UNRESOLVED instead of spawning Entities.
 */
function mayCreateEntity(mention: ResolutionMention): boolean {
  return (mention.type === 'PERSON' || mention.type === 'ORGANIZATION') && mention.strength !== 'REFERENCE'
}

/**
 * PERSON/ORGANIZATION mentions only match same-type Entities; identifier
 * mentions (PHONE, EMAIL, ID_CARD, BANK_ACCOUNT, ADDRESS) may attach to any
 * Entity type; metadata mentions never match an Entity directly.
 */
function isCompatibleEntityType(mentionType: MentionType, entityType: EntityType): boolean {
  switch (mentionType) {
    case 'PERSON':
      return entityType === 'PERSON'
    case 'ORGANIZATION':
      return entityType === 'ORGANIZATION'
    case 'PHONE':
    case 'EMAIL':
    case 'ID_CARD':
    case 'BANK_ACCOUNT':
    case 'ADDRESS':
      return true
    case 'CASE_NUMBER':
    case 'CONTRACT_NUMBER':
    case 'COURT':
    case 'LAWYER':
    case 'JUDGE':
      return false
  }
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
      !isCompatibleEntityType(mention.type, candidate.entity.type) ||
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
