import {
  constantTimeEqual,
  decrypt,
  deriveMatterSearchKey,
  encrypt,
  fingerprintNormalizedValue,
  generateProtectedValueToken,
  generatePublicToken,
  generateSyntheticAlias,
  generateUuidV7
} from '@aliasai/crypto'
import type {
  Document,
  Entity,
  EntityConstraint,
  EntityType,
  Mention,
  MentionType,
  ProcessingJob,
  ProtectedValueType
} from '@aliasai/domain'
import type {
  BegunEntityResolution,
  CreateEntityWithPrimaryAliasAndEventInput,
  CreateProtectedValueInput,
  CreateResolutionCandidateInput,
  CreateResolutionEventInput,
  EntityProtectedValueSummary,
  EntityRepository,
  EntityResolutionRepository,
  LinkEntityProtectedValueInput,
  ProtectedValueRepository,
  ResolutionMentionSource,
  ResolutionMentionUpdate
} from '@aliasai/database'
import {
  RESOLUTION_ALGORITHM_VERSION,
  isValidNormalizedValue,
  mentionTypeToProtectedValueType,
  normalizeMentionValue,
  proposeResolution,
  scoreCandidate,
  type ResolutionCandidateInput,
  type ResolutionDecision,
  type ScoredCandidate
} from '@aliasai/entity-resolution'
import type { ApplicationKeys } from './index'
import { mentionTextContext, privacyDetectionErrorContext } from './privacy-detection'

export type EntityResolutionIdFactory = (timestamp: number) => string

export interface EntityResolutionDecision {
  readonly mentionId: string
  readonly decision: ResolutionDecision
  readonly candidateEntityId?: string
}

export interface EntityResolutionRunResult {
  readonly document: Document
  readonly job: ProcessingJob
  readonly decisions: readonly EntityResolutionDecision[]
  readonly reused: boolean
}

export class EntityResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'EntityResolutionError'
  }
}

export function protectedValueContext(protectedValueId: string): Buffer {
  return Buffer.from(`${protectedValueId}:protectedValue.value`)
}

export function resolutionEventContext(eventId: string): Buffer {
  return Buffer.from(`${eventId}:resolutionEvent.payload`)
}

const IDENTIFIER_MENTION_TYPES = new Set<MentionType>(['PHONE', 'EMAIL', 'ID_CARD', 'BANK_ACCOUNT', 'ADDRESS'])

interface PlannedProtectedValue {
  readonly id: string
  readonly existed: boolean
  readonly input?: CreateProtectedValueInput
}

interface MentionWorkItem {
  readonly mention: ResolutionMentionSource
  readonly normalized?: string
  readonly protectedValueType?: ProtectedValueType
  readonly fingerprint?: Buffer
  readonly protectedValue?: PlannedProtectedValue
}

interface ScoredEntityCandidate {
  readonly input: ResolutionCandidateInput
  readonly scored: ScoredCandidate
}

/** USER Must-Link/Cannot-Link constraints are stored in canonical (sorted) pair order. */
function hasUserConstraint(
  constraints: readonly EntityConstraint[],
  type: EntityConstraint['type'],
  firstId: string,
  secondId: string
): boolean {
  const [entityAId, entityBId] = firstId < secondId ? [firstId, secondId] : [secondId, firstId]
  return constraints.some(
    (constraint) =>
      constraint.source === 'USER' &&
      constraint.type === type &&
      constraint.entityAId === entityAId &&
      constraint.entityBId === entityBId
  )
}

function toCandidateInput(entity: Entity, scored: ScoredCandidate): ResolutionCandidateInput {
  return {
    entity,
    score: scored.score,
    ...(scored.hardRule === undefined ? {} : { hardRule: scored.hardRule }),
    evidence: scored.evidence.map((item) => item.type)
  }
}

/**
 * Orchestrates Mention -> ProtectedValue -> ResolutionProposal -> Entity for a
 * detected Document and owns the RESOLVING -> READY/FAILED transition. Mention
 * plaintext is decrypted transiently for normalization and fingerprinting only;
 * event payloads carry decision metadata, never plaintext.
 */
export class EntityResolutionService {
  readonly #searchKey: Buffer

  constructor(
    private readonly resolution: EntityResolutionRepository,
    private readonly protectedValues: ProtectedValueRepository,
    private readonly entities: EntityRepository,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: EntityResolutionIdFactory = generateUuidV7
  ) {
    const searchKey = keys.searchKey
    if (searchKey === undefined || searchKey.length !== 32 || constantTimeEqual(searchKey, keys.persistenceKey)) {
      throw new EntityResolutionError(
        'SEARCH_KEY_UNAVAILABLE',
        'Entity resolution requires a distinct 32-byte search key'
      )
    }
    this.#searchKey = searchKey
  }

  async resolve(documentId: string): Promise<EntityResolutionRunResult> {
    const completed = this.resolution.findCompleted(documentId)
    if (completed !== undefined) return { ...completed, decisions: [], reused: true }

    const startedAt = this.now()
    const jobId = this.generateId(startedAt)
    let begun: BegunEntityResolution
    try {
      begun = this.resolution.begin({ documentId, jobId, startedAt })
    } catch (error) {
      throw new EntityResolutionError('RESOLUTION_NOT_AVAILABLE', 'Document could not enter entity resolution', {
        cause: error
      })
    }

    const transientCiphers: Buffer[] = []
    const matterSearchKeys = new Map<string, Buffer>()
    try {
      // Pass 1: decrypt each Mention transiently, normalize, fingerprint, and
      // plan ProtectedValue reuse/creation before any candidate is scored.
      const workItems: MentionWorkItem[] = []
      const plannedProtectedValues = new Map<string, PlannedProtectedValue>()
      const documentFingerprints = new Map<ProtectedValueType, Set<string>>()
      const protectedValueTokenBackfills: { readonly id: string; readonly publicToken: string }[] = []
      const usedProtectedValueTokens = new Set<string>()
      const nextProtectedValueToken = (type: ProtectedValueType): string => {
        let token = generateProtectedValueToken(type)
        while (usedProtectedValueTokens.has(token)) token = generateProtectedValueToken(type)
        usedProtectedValueTokens.add(token)
        return token
      }
      for (const mention of begun.mentions) {
        let plaintextBytes: Buffer
        try {
          plaintextBytes = decrypt(mention.textCipher, this.keys.persistenceKey, mentionTextContext(mention.id))
        } catch (error) {
          throw new EntityResolutionError('MENTION_DECRYPTION_FAILED', 'Mention text could not be decrypted', {
            cause: error
          })
        }
        let text: string
        try {
          text = plaintextBytes.toString('utf8')
        } finally {
          plaintextBytes.fill(0)
        }

        const protectedValueType = mentionTypeToProtectedValueType(mention.type)
        if (protectedValueType === undefined) {
          // Metadata mentions never produce ProtectedValues or resolution candidates.
          workItems.push({ mention })
          continue
        }

        const normalized = normalizeMentionValue(mention.type, text)
        if (!isValidNormalizedValue(mention.type, normalized)) {
          // Invalid normalized values never produce fingerprints, ProtectedValues,
          // or candidates; like metadata mentions they resolve to UNRESOLVED.
          workItems.push({ mention })
          continue
        }
        let matterSearchKey = matterSearchKeys.get(mention.matterId)
        if (matterSearchKey === undefined) {
          matterSearchKey = deriveMatterSearchKey(this.#searchKey, mention.matterId)
          matterSearchKeys.set(mention.matterId, matterSearchKey)
        }
        const fingerprint = fingerprintNormalizedValue(matterSearchKey, normalized)
        let typeFingerprints = documentFingerprints.get(protectedValueType)
        if (typeFingerprints === undefined) {
          typeFingerprints = new Set()
          documentFingerprints.set(protectedValueType, typeFingerprints)
        }
        typeFingerprints.add(fingerprint.toString('hex'))

        const planKey = `${protectedValueType}:${fingerprint.toString('hex')}`
        let protectedValue = plannedProtectedValues.get(planKey)
        if (protectedValue === undefined) {
          const existing = this.protectedValues.findByFingerprint(mention.matterId, protectedValueType, fingerprint)
          if (existing === undefined) {
            const createdAt = this.now()
            const id = this.generateId(createdAt)
            const valueBytes = Buffer.from(text, 'utf8')
            let valueCipher: Buffer
            try {
              valueCipher = encrypt(valueBytes, this.keys.persistenceKey, protectedValueContext(id))
            } finally {
              valueBytes.fill(0)
            }
            transientCiphers.push(valueCipher)
            protectedValue = {
              id,
              existed: false,
              input: {
                id,
                matterId: mention.matterId,
                type: protectedValueType,
                valueCipher,
                fingerprint,
                publicToken: nextProtectedValueToken(protectedValueType),
                restorePolicy: 'ALWAYS_RESTORE',
                createdAt
              }
            }
          } else if (existing.publicToken === undefined) {
            // A value created before restoration tokens existed is reused but
            // backfilled atomically so sanitization never fails closed on it.
            protectedValueTokenBackfills.push({ id: existing.id, publicToken: nextProtectedValueToken(protectedValueType) })
            protectedValue = { id: existing.id, existed: true }
          } else {
            protectedValue = { id: existing.id, existed: true }
          }
          plannedProtectedValues.set(planKey, protectedValue)
        }
        workItems.push({ mention, normalized, protectedValueType, fingerprint, protectedValue })
      }

      // Matter-scoped reference data is loaded lazily, once per Matter.
      const constraintsByMatter = new Map<string, readonly EntityConstraint[]>()
      const loadConstraints = (matterId: string): readonly EntityConstraint[] => {
        let constraints = constraintsByMatter.get(matterId)
        if (constraints === undefined) {
          constraints = this.resolution.findConstraints(matterId)
          constraintsByMatter.set(matterId, constraints)
        }
        return constraints
      }
      const primaryAliasesByMatter = new Map<string, Map<string, string>>()
      const loadPrimaryAliases = (matterId: string): Map<string, string> => {
        let aliases = primaryAliasesByMatter.get(matterId)
        if (aliases === undefined) {
          aliases = new Map()
          for (const alias of this.entities.findAliases(matterId)) {
            if (alias.isPrimary && !aliases.has(alias.entityId)) aliases.set(alias.entityId, alias.alias)
          }
          primaryAliasesByMatter.set(matterId, aliases)
        }
        return aliases
      }
      const entitiesByMatterAndType = new Map<string, readonly Entity[]>()
      const loadEntities = (matterId: string, type: EntityType): readonly Entity[] => {
        const cacheKey = `${matterId}:${type}`
        let found = entitiesByMatterAndType.get(cacheKey)
        if (found === undefined) {
          found = this.entities.findByMatterAndType(matterId, type)
          entitiesByMatterAndType.set(cacheKey, found)
        }
        return found
      }
      const protectedValuesByEntity = new Map<string, readonly EntityProtectedValueSummary[]>()
      const loadEntityProtectedValues = (matterId: string, entityId: string): readonly EntityProtectedValueSummary[] => {
        let found = protectedValuesByEntity.get(entityId)
        if (found === undefined) {
          found = this.protectedValues.findEntityProtectedValues(matterId, entityId)
          protectedValuesByEntity.set(entityId, found)
        }
        return found
      }

      // Pass 2: score candidates and propose a decision per Mention, now that
      // every document-level fingerprint (e.g. ID_CARD conflicts) is known.
      const decisions: EntityResolutionDecision[] = []
      const entitiesToCreate: CreateEntityWithPrimaryAliasAndEventInput[] = []
      const links: LinkEntityProtectedValueInput[] = []
      const mentionUpdates: ResolutionMentionUpdate[] = []
      const candidates: CreateResolutionCandidateInput[] = []
      const resolvedCandidateIds = new Set<string>()
      const events: CreateResolutionEventInput[] = []
      for (const [index, work] of workItems.entries()) {
        const { mention } = work
        if (mention.entityId !== undefined) {
          // A Mention assigned before resolution (e.g. a user decision) is never
          // rewritten: backfill its fingerprint/ProtectedValue and link the value
          // to the confirmed Entity (idempotently) so later fingerprint lookups
          // find it — no candidates, no events, no decision.
          if (work.fingerprint !== undefined && work.protectedValue !== undefined) {
            links.push(this.planLink(mention.matterId, mention.entityId, work.protectedValue.id))
            mentionUpdates.push({
              id: mention.id,
              fingerprint: work.fingerprint,
              protectedValueId: work.protectedValue.id,
              entityId: mention.entityId
            })
          }
          this.resolution.updateProgress(jobId, index + 1, workItems.length)
          continue
        }
        if (work.protectedValueType === undefined || work.protectedValue === undefined) {
          decisions.push({ mentionId: mention.id, decision: 'UNRESOLVED' })
          if (mention.fingerprint !== null) {
            mentionUpdates.push({ id: mention.id, fingerprint: null, protectedValueId: null, entityId: null })
          }
          this.resolution.updateProgress(jobId, index + 1, workItems.length)
          continue
        }

        const scoredCandidates: ScoredEntityCandidate[] = []
        if (IDENTIFIER_MENTION_TYPES.has(mention.type)) {
          // Identifier mentions match only through a shared ProtectedValue.
          if (work.protectedValue.existed) {
            const linked = this.protectedValues.findEntitiesByProtectedValue(mention.matterId, work.protectedValue.id)
            const constraints = loadConstraints(mention.matterId)
            for (const entity of linked) {
              const userCannotLink = linked.some(
                (other) => other.id !== entity.id && hasUserConstraint(constraints, 'CANNOT_LINK', entity.id, other.id)
              )
              const userMustLink = linked.some(
                (other) => other.id !== entity.id && hasUserConstraint(constraints, 'MUST_LINK', entity.id, other.id)
              )
              const scored = scoreCandidate(mention.type, {
                sharesProtectedValue: true,
                conflictsProtectedValue: false,
                nameExactMatch: false,
                userCannotLink,
                userMustLink
              })
              scoredCandidates.push({ input: toCandidateInput(entity, scored), scored })
            }
          }
        } else {
          // PERSON/ORGANIZATION mentions match on normalized primary alias equality, or
          // on holding a name-type ProtectedValue with the same fingerprint (an
          // auto-created Entity has a synthetic alias but keeps its name ProtectedValue).
          const entityType: EntityType = mention.type === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON'
          const primaryAliases = loadPrimaryAliases(mention.matterId)
          const idCardFingerprints = documentFingerprints.get('ID_CARD') ?? new Set<string>()
          const mentionFingerprintHex = work.fingerprint?.toString('hex')
          const matched: Array<{ entity: Entity; conflictsProtectedValue: boolean }> = []
          for (const entity of loadEntities(mention.matterId, entityType)) {
            const entityValues = loadEntityProtectedValues(mention.matterId, entity.id)
            const primaryAlias = primaryAliases.get(entity.id)
            const nameExactMatch =
              (primaryAlias !== undefined && normalizeMentionValue(mention.type, primaryAlias) === work.normalized) ||
              entityValues.some(
                (value) =>
                  value.type === work.protectedValueType && value.fingerprint.toString('hex') === mentionFingerprintHex
              )
            if (!nameExactMatch) continue
            // Absence of evidence is not contradictory evidence: a conflict can
            // only exist when the current document actually contains an ID_CARD
            // fingerprint. (V1 uses any document-level ID_CARD; associating the
            // identifier with this specific person is context-extraction work.)
            const entityIdCards = entityValues.filter((value) => value.type === 'ID_CARD')
            const conflictsProtectedValue =
              idCardFingerprints.size > 0 &&
              entityIdCards.some((value) => !idCardFingerprints.has(value.fingerprint.toString('hex')))
            matched.push({ entity, conflictsProtectedValue })
          }
          // A USER Must-Link between two name candidates asserts they are the same
          // real-world Entity: escalate both to hard Must-Link so the decision gate
          // routes the ambiguity to REVIEW instead of guessing. A USER Cannot-Link
          // between name candidates carries no anchor tying the Mention to either
          // party, so it must not eliminate candidates here (eliminating both would
          // force a wrong NEW_ENTITY); it only applies in the anchored identifier branch.
          const constraints = loadConstraints(mention.matterId)
          for (const candidate of matched) {
            const userMustLink = matched.some(
              (other) =>
                other.entity.id !== candidate.entity.id &&
                hasUserConstraint(constraints, 'MUST_LINK', candidate.entity.id, other.entity.id)
            )
            const scored = scoreCandidate(mention.type, {
              sharesProtectedValue: false,
              conflictsProtectedValue: candidate.conflictsProtectedValue,
              nameExactMatch: true,
              userCannotLink: false,
              userMustLink
            })
            scoredCandidates.push({ input: toCandidateInput(candidate.entity, scored), scored })
          }
        }

        const proposal = proposeResolution(
          mention,
          scoredCandidates.map((candidate) => candidate.input)
        )
        const scoredByEntityId = new Map(
          scoredCandidates.map((candidate) => [candidate.input.entity.id, candidate.scored])
        )

        let entityId: string | null = null
        if (proposal.decision === 'AUTO_LINK') {
          entityId = proposal.candidateEntityId ?? null
          if (entityId === null) {
            throw new EntityResolutionError('RESOLUTION_FAILED', 'Auto-link decision lacked a winning candidate')
          }
          links.push(this.planLink(mention.matterId, entityId, work.protectedValue.id))
          events.push(this.planAssignmentEvent(mention, entityId, 'AUTO_LINK', transientCiphers))
        } else if (proposal.decision === 'NEW_ENTITY') {
          const entityType: EntityType = mention.type === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON'
          const created = this.planNewEntity(mention.matterId, entityType, transientCiphers)
          entitiesToCreate.push(created)
          entityId = created.entity.id
          links.push(this.planLink(mention.matterId, entityId, work.protectedValue.id))
          events.push(this.planAssignmentEvent(mention, entityId, 'NEW_ENTITY', transientCiphers))
        }
        decisions.push({
          mentionId: mention.id,
          decision: proposal.decision,
          ...(entityId === null
            ? proposal.candidateEntityId === undefined
              ? {}
              : { candidateEntityId: proposal.candidateEntityId }
            : { candidateEntityId: entityId })
        })
        mentionUpdates.push({
          id: mention.id,
          fingerprint: work.fingerprint ?? null,
          protectedValueId: work.protectedValue.id,
          entityId
        })

        for (const ranked of proposal.rankedCandidates) {
          const state =
            proposal.decision === 'AUTO_LINK'
              ? ranked.entity.id === proposal.candidateEntityId
                ? 'ACCEPTED'
                : 'REJECTED'
              : proposal.decision === 'NEW_ENTITY'
                ? 'REJECTED'
                : 'PENDING'
          const createdAt = this.now()
          const candidateId = this.generateId(createdAt)
          if (state !== 'PENDING') resolvedCandidateIds.add(candidateId)
          candidates.push({
            id: candidateId,
            mentionId: mention.id,
            candidateEntityId: ranked.entity.id,
            score: ranked.score,
            state,
            algorithmVersion: RESOLUTION_ALGORITHM_VERSION,
            createdAt,
            evidence: (scoredByEntityId.get(ranked.entity.id)?.evidence ?? []).map((item) => ({
              id: this.generateId(this.now()),
              evidenceType: item.type,
              weight: item.weight,
              score: item.score,
              createdAt
            }))
          })
        }
        this.resolution.updateProgress(jobId, index + 1, workItems.length)
      }

      const finishedAt = this.now()
      const result = this.resolution.complete({
        documentId,
        jobId,
        entitiesToCreate,
        protectedValues: [...plannedProtectedValues.values()].flatMap((planned) =>
          planned.input === undefined ? [] : [planned.input]
        ),
        protectedValueTokenBackfills,
        entityProtectedValueLinks: links,
        mentionUpdates,
        candidates: candidates.map((candidate) =>
          resolvedCandidateIds.has(candidate.id) ? { ...candidate, resolvedAt: finishedAt } : candidate
        ),
        events,
        finishedAt
      })
      return { ...result, decisions, reused: false }
    } catch (error) {
      const failure =
        error instanceof EntityResolutionError
          ? error
          : new EntityResolutionError('RESOLUTION_FAILED', 'Entity resolution failed')
      try {
        const errorBytes = Buffer.from(JSON.stringify({ code: failure.code }), 'utf8')
        let errorCipher: Buffer
        try {
          errorCipher = encrypt(errorBytes, this.keys.persistenceKey, privacyDetectionErrorContext(jobId))
        } finally {
          errorBytes.fill(0)
        }
        try {
          this.resolution.fail(documentId, jobId, errorCipher, this.now())
        } finally {
          errorCipher.fill(0)
        }
      } catch (stateError) {
        throw new EntityResolutionError(
          'PERSISTENCE_FAILURE',
          'Entity resolution failed and its state could not be finalized',
          { cause: new AggregateError([failure, stateError]) }
        )
      }
      throw failure
    } finally {
      for (const cipher of transientCiphers) cipher.fill(0)
      for (const matterSearchKey of matterSearchKeys.values()) matterSearchKey.fill(0)
    }
  }

  /** Applies a USER assignment decision for a single Mention. */
  assign(mentionId: string, entityId: string): Mention {
    try {
      const mention = this.resolution.findMentionById(mentionId)
      if (mention === undefined) throw new Error('Mention was not found')
      const createdAt = this.now()
      const eventId = this.generateId(createdAt)
      const payloadBytes = Buffer.from(JSON.stringify({ entityId }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.assignMention({
          mentionId,
          entityId,
          resolvedAt: createdAt,
          event: {
            id: eventId,
            matterId: mention.matterId,
            type: mention.entityId === undefined ? 'MENTION_ASSIGNED' : 'MENTION_REASSIGNED',
            entityId,
            mentionId,
            actor: 'USER',
            payloadCipher,
            createdAt
          }
        })
      } finally {
        payloadCipher.fill(0)
      }
    } catch (error) {
      throw new EntityResolutionError('ASSIGNMENT_FAILED', 'Mention assignment failed', { cause: error })
    }
  }

  /** Records a USER Must-Link/Cannot-Link constraint between two Entities. */
  addConstraint(
    matterId: string,
    entityAId: string,
    entityBId: string,
    type: 'MUST_LINK' | 'CANNOT_LINK',
    reason: string
  ): EntityConstraint {
    try {
      const createdAt = this.now()
      const constraint: EntityConstraint = {
        id: this.generateId(createdAt),
        matterId,
        entityAId,
        entityBId,
        type,
        reason,
        source: 'USER',
        createdAt
      }
      const eventId = this.generateId(this.now())
      // Reference the canonical (lexicographically first) constrained Entity so the
      // event stays structurally bound to the persisted pair.
      const canonicalEntityId = entityAId < entityBId ? entityAId : entityBId
      const payloadBytes = Buffer.from(JSON.stringify({ entityAId, entityBId, constraintType: type }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.addConstraint({
          constraint,
          event: {
            id: eventId,
            matterId,
            type: 'CONSTRAINT_CREATED',
            entityId: canonicalEntityId,
            actor: 'USER',
            payloadCipher,
            createdAt
          }
        })
      } finally {
        payloadCipher.fill(0)
      }
    } catch (error) {
      throw new EntityResolutionError('CONSTRAINT_FAILED', 'Entity constraint could not be recorded', { cause: error })
    }
  }

  private planLink(matterId: string, entityId: string, protectedValueId: string): LinkEntityProtectedValueInput {
    const createdAt = this.now()
    return {
      id: this.generateId(createdAt),
      matterId,
      entityId,
      protectedValueId,
      relationshipType: 'OWNER',
      confidence: 1,
      isPrimary: true,
      createdAt
    }
  }

  private planAssignmentEvent(
    mention: ResolutionMentionSource,
    entityId: string,
    decision: ResolutionDecision,
    transientCiphers: Buffer[]
  ): CreateResolutionEventInput {
    const createdAt = this.now()
    const id = this.generateId(createdAt)
    const payloadBytes = Buffer.from(
      JSON.stringify({ decision, candidateEntityId: entityId, algorithmVersion: RESOLUTION_ALGORITHM_VERSION }),
      'utf8'
    )
    let payloadCipher: Buffer
    try {
      payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(id))
    } finally {
      payloadBytes.fill(0)
    }
    transientCiphers.push(payloadCipher)
    return {
      id,
      matterId: mention.matterId,
      type: 'MENTION_ASSIGNED',
      entityId,
      mentionId: mention.id,
      actor: 'SYSTEM',
      payloadCipher,
      createdAt
    }
  }

  private planNewEntity(
    matterId: string,
    type: EntityType,
    transientCiphers: Buffer[]
  ): CreateEntityWithPrimaryAliasAndEventInput {
    const createdAt = this.now()
    const entityId = this.generateId(createdAt)
    const publicToken = generatePublicToken(type)
    const eventId = this.generateId(this.now())
    const payloadBytes = Buffer.from(JSON.stringify({ algorithmVersion: RESOLUTION_ALGORITHM_VERSION }), 'utf8')
    let payloadCipher: Buffer
    try {
      payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
    } finally {
      payloadBytes.fill(0)
    }
    transientCiphers.push(payloadCipher)
    return {
      entity: { id: entityId, matterId, type, publicToken, status: 'ACTIVE', createdAt, updatedAt: createdAt },
      primaryAlias: {
        id: this.generateId(this.now()),
        matterId,
        entityId,
        // The primary alias is synthetic and readable: a Matter-scoped type label
        // plus a 64-bit random suffix. It embeds neither the Public Token (an
        // identity anchor) nor the internal Entity ID (which would leak a stable
        // outbound identifier and its creation timestamp); the random suffix keeps
        // it unique under the Matter-wide alias index.
        alias: generateSyntheticAlias(type),
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt
      },
      event: {
        id: eventId,
        matterId,
        type: 'ENTITY_CREATED',
        entityId,
        actor: 'SYSTEM',
        payloadCipher,
        createdAt
      }
    }
  }
}
