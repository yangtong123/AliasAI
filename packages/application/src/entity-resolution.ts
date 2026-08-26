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
  EntityAlias,
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
  extractLabeledContextLinks,
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
import { documentBlockTextContext } from './document-processing'
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

/**
 * An Alias becomes the visible replacement text in sanitized artifacts, so it
 * must be checked against every ProtectedValue class in the Matter — not just
 * the current Mention or Entity. A pseudonym that spells out another party's
 * real name, phone, or address is a leak even when it belongs to a different
 * Entity.
 */
const ALIAS_SAFETY_MENTION_TYPES: readonly MentionType[] = [
  'PERSON',
  'ORGANIZATION',
  'PHONE',
  'EMAIL',
  'ID_CARD',
  'BANK_ACCOUNT',
  'ADDRESS'
]

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

      // Build high-precision ownership evidence from the encrypted source blocks.
      // Only Mention ids are retained; decrypted block plaintext is discarded
      // before candidate scoring begins.
      const contextSubjectByMentionId = new Map<string, string>()
      const mentionsByBlockId = new Map<string, ResolutionMentionSource[]>()
      for (const mention of begun.mentions) {
        const grouped = mentionsByBlockId.get(mention.blockId) ?? []
        grouped.push(mention)
        mentionsByBlockId.set(mention.blockId, grouped)
      }
      for (const block of begun.blocks) {
        const blockMentions = mentionsByBlockId.get(block.id)
        if (blockMentions === undefined || blockMentions.length < 2) continue
        let plaintextBytes: Buffer
        try {
          plaintextBytes = decrypt(block.textCipher, this.keys.persistenceKey, documentBlockTextContext(block.id))
        } catch (error) {
          throw new EntityResolutionError('BLOCK_DECRYPTION_FAILED', 'Document block could not be decrypted for entity resolution', {
            cause: error
          })
        }
        let links
        try {
          links = extractLabeledContextLinks(
            plaintextBytes.toString('utf8'),
            blockMentions.map((mention) => ({
              id: mention.id,
              type: mention.type,
              startOffset: mention.startOffset,
              endOffset: mention.endOffset
            }))
          )
        } finally {
          plaintextBytes.fill(0)
        }
        for (const link of links) contextSubjectByMentionId.set(link.mentionId, link.subjectMentionId)
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
      const resolvedEntityByMentionId = new Map<string, Entity>()
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
          const assignedEntity = this.entities.findById(mention.entityId)
          if (assignedEntity !== undefined && assignedEntity.matterId === mention.matterId && assignedEntity.status === 'ACTIVE') {
            resolvedEntityByMentionId.set(mention.id, assignedEntity)
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

        const contextSubjectId = contextSubjectByMentionId.get(mention.id)
        const contextEntity = contextSubjectId === undefined ? undefined : resolvedEntityByMentionId.get(contextSubjectId)
        if (contextEntity !== undefined) {
          const labeled = scoreCandidate(mention.type, {
            sharesProtectedValue: false,
            conflictsProtectedValue: false,
            nameExactMatch: false,
            userCannotLink: false,
            userMustLink: false,
            sameLabeledFieldGroup: true
          })
          const existing = scoredCandidates.find((candidate) => candidate.input.entity.id === contextEntity.id)
          if (existing === undefined) {
            scoredCandidates.push({ input: toCandidateInput(contextEntity, labeled), scored: labeled })
          } else if (!existing.scored.evidence.some((item) => item.type === 'SAME_LABELED_FIELD_GROUP')) {
            // Explicit labeled-field context must reinforce an already-scored
            // candidate (e.g. one found via a shared ProtectedValue) instead of
            // being dropped: evidence is additive, so the decision gate and the
            // stored explanation both see it.
            const merged: ScoredCandidate = {
              score: existing.scored.score + labeled.score,
              evidence: [...existing.scored.evidence, ...labeled.evidence],
              ...(existing.scored.hardRule === undefined ? {} : { hardRule: existing.scored.hardRule })
            }
            scoredCandidates[scoredCandidates.indexOf(existing)] = {
              input: toCandidateInput(contextEntity, merged),
              scored: merged
            }
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
          const winning = scoredCandidates.find((candidate) => candidate.input.entity.id === entityId)?.input.entity
          if (winning !== undefined) resolvedEntityByMentionId.set(mention.id, winning)
        } else if (proposal.decision === 'NEW_ENTITY') {
          const entityType: EntityType = mention.type === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON'
          const created = this.planNewEntity(mention.matterId, entityType, transientCiphers)
          entitiesToCreate.push(created)
          entityId = created.entity.id
          links.push(this.planLink(mention.matterId, entityId, work.protectedValue.id))
          events.push(this.planAssignmentEvent(mention, entityId, 'NEW_ENTITY', transientCiphers))
          resolvedEntityByMentionId.set(mention.id, created.entity)
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

  /** Records a USER confirmation of a Mention's current assignment. */
  confirm(mentionId: string): Mention {
    try {
      const mention = this.resolution.findMentionById(mentionId)
      if (mention === undefined) throw new Error('Mention was not found')
      const createdAt = this.now()
      const eventId = this.generateId(createdAt)
      const payloadBytes = Buffer.from(JSON.stringify({ entityId: mention.entityId ?? null }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.confirmMention({
          mentionId,
          event: {
            id: eventId,
            matterId: mention.matterId,
            type: 'ENTITY_CONFIRMED',
            ...(mention.entityId === undefined ? {} : { entityId: mention.entityId }),
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
      throw new EntityResolutionError('CONFIRMATION_FAILED', 'Mention confirmation failed', { cause: error })
    }
  }

  /**
   * Rejects an Alias whose normalized form matches any ProtectedValue in the
   * Matter under any value class. The check is matter-wide because the Alias is
   * published verbatim inside sanitized artifacts: spelling out another party's
   * real name or phone as this Entity's Alias leaks it even though it belongs
   * to a different Entity.
   */
  #assertAliasIsSafeForMatter(matterId: string, alias: string, message: string): void {
    const matterKey = deriveMatterSearchKey(this.#searchKey, matterId)
    try {
      for (const type of ALIAS_SAFETY_MENTION_TYPES) {
        const protectedValueType = mentionTypeToProtectedValueType(type)
        if (protectedValueType === undefined) continue
        const normalized = normalizeMentionValue(type, alias)
        if (!isValidNormalizedValue(type, normalized)) continue
        const fingerprint = fingerprintNormalizedValue(matterKey, normalized)
        try {
          if (this.protectedValues.findByFingerprint(matterId, protectedValueType, fingerprint) !== undefined) {
            throw new EntityResolutionError('UNSAFE_ALIAS', message)
          }
        } finally {
          fingerprint.fill(0)
        }
      }
    } finally {
      matterKey.fill(0)
    }
  }

  /** Creates a USER-actor Entity and assigns the Mention to it in a single transaction. */
  createEntityWithAssignment(
    mentionId: string,
    input: { readonly primaryAlias: string; readonly entityType: EntityType },
    splitFromEntityId?: string
  ): { readonly entity: Entity; readonly primaryAlias: EntityAlias; readonly mention: Mention } {
    if (input.primaryAlias.trim().length === 0) throw new Error('Primary alias must not be empty')
    try {
      const mention = this.resolution.findMentionById(mentionId)
      if (mention === undefined) throw new Error('Mention was not found')
      let mentionBytes: Buffer
      try {
        mentionBytes = decrypt(mention.textCipher, this.keys.persistenceKey, mentionTextContext(mention.id))
      } catch (error) {
        throw new EntityResolutionError('MENTION_DECRYPTION_FAILED', 'Mention text could not be decrypted', { cause: error })
      }
      try {
        if (mentionBytes.toString('utf8').trim().toLocaleLowerCase() === input.primaryAlias.trim().toLocaleLowerCase()) {
          throw new EntityResolutionError(
            'UNSAFE_ALIAS',
            'The alias replaces this text in sanitized documents, so it must be a pseudonym (for example "Party A"), not the real value'
          )
        }
      } finally {
        mentionBytes.fill(0)
      }
      this.#assertAliasIsSafeForMatter(
        mention.matterId,
        input.primaryAlias,
        'That alias matches a real protected value in this Matter; use a pseudonym such as "Party A" instead'
      )
      const createdAt = this.now()
      const entity: Entity = {
        id: this.generateId(createdAt),
        matterId: mention.matterId,
        type: input.entityType,
        publicToken: generatePublicToken(input.entityType),
        status: 'ACTIVE',
        createdAt,
        updatedAt: createdAt
      }
      const primaryAlias: EntityAlias = {
        id: this.generateId(createdAt),
        matterId: mention.matterId,
        entityId: entity.id,
        alias: input.primaryAlias,
        aliasType: 'PRIMARY',
        isPrimary: true,
        createdAt
      }
      const creationEventId = this.generateId(createdAt)
      const creationPayloadBytes = Buffer.from('{}', 'utf8')
      let creationPayloadCipher: Buffer
      try {
        creationPayloadCipher = encrypt(creationPayloadBytes, this.keys.persistenceKey, resolutionEventContext(creationEventId))
      } finally {
        creationPayloadBytes.fill(0)
      }
      const assignmentEventId = this.generateId(createdAt)
      const assignmentPayloadBytes = Buffer.from(JSON.stringify({ entityId: entity.id }), 'utf8')
      let assignmentPayloadCipher: Buffer
      try {
        assignmentPayloadCipher = encrypt(
          assignmentPayloadBytes,
          this.keys.persistenceKey,
          resolutionEventContext(assignmentEventId)
        )
      } finally {
        assignmentPayloadBytes.fill(0)
      }
      const splitEventId = splitFromEntityId === undefined ? undefined : this.generateId(createdAt)
      let splitPayloadCipher: Buffer | undefined
      if (splitEventId !== undefined) {
        const splitPayloadBytes = Buffer.from(JSON.stringify({ sourceEntityId: splitFromEntityId }), 'utf8')
        try {
          splitPayloadCipher = encrypt(splitPayloadBytes, this.keys.persistenceKey, resolutionEventContext(splitEventId))
        } finally {
          splitPayloadBytes.fill(0)
        }
      }
      try {
        return this.resolution.createEntityWithAssignment({
          entity,
          primaryAlias,
          creationEvent: {
            id: creationEventId,
            matterId: mention.matterId,
            type: 'ENTITY_CREATED',
            entityId: entity.id,
            actor: 'USER',
            payloadCipher: creationPayloadCipher,
            createdAt
          },
          mentionId,
          resolvedAt: createdAt,
          assignmentEvent: {
            id: assignmentEventId,
            matterId: mention.matterId,
            type: mention.entityId === undefined ? 'MENTION_ASSIGNED' : 'MENTION_REASSIGNED',
            entityId: entity.id,
            mentionId,
            actor: 'USER',
            payloadCipher: assignmentPayloadCipher,
            createdAt
          },
          ...(splitEventId === undefined || splitPayloadCipher === undefined
            ? {}
            : {
                splitEvent: {
                  id: splitEventId,
                  matterId: mention.matterId,
                  type: 'ENTITY_SPLIT' as const,
                  entityId: entity.id,
                  mentionId,
                  actor: 'USER' as const,
                  payloadCipher: splitPayloadCipher,
                  createdAt
                }
              })
        })
      } finally {
        creationPayloadCipher.fill(0)
        assignmentPayloadCipher.fill(0)
        splitPayloadCipher?.fill(0)
      }
    } catch (error) {
      if (error instanceof EntityResolutionError) throw error
      throw new EntityResolutionError('ASSIGNMENT_FAILED', 'Entity creation and assignment failed', { cause: error })
    }
  }

  renameEntity(entityId: string, primaryAlias: string): EntityAlias {
    const alias = primaryAlias.trim()
    if (alias.length === 0) throw new EntityResolutionError('RENAME_FAILED', 'Primary alias must not be empty')
    try {
      const entity = this.entities.findById(entityId)
      if (entity === undefined || entity.status !== 'ACTIVE') throw new Error('Active Entity was not found')
      this.#assertAliasIsSafeForMatter(
        entity.matterId,
        alias,
        'The alias replaces real values in sanitized documents, so it must not match any real name, phone, address, or other protected value in this Matter; use a pseudonym such as "Party A"'
      )
      const createdAt = this.now()
      const aliasId = this.generateId(createdAt)
      const eventId = this.generateId(createdAt)
      const payloadBytes = Buffer.from(JSON.stringify({ aliasId }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.renameEntity({
          entityId,
          alias: {
            id: aliasId,
            matterId: entity.matterId,
            entityId,
            alias,
            aliasType: 'PRIMARY',
            isPrimary: true,
            createdAt
          },
          event: {
            id: eventId,
            matterId: entity.matterId,
            type: 'ENTITY_RENAMED',
            entityId,
            actor: 'USER',
            payloadCipher,
            createdAt
          },
          updatedAt: createdAt
        })
      } finally {
        payloadCipher.fill(0)
      }
    } catch (error) {
      if (error instanceof EntityResolutionError) throw error
      throw new EntityResolutionError('RENAME_FAILED', 'Entity could not be renamed', { cause: error })
    }
  }

  reject(mentionId: string): Mention {
    try {
      const mention = this.resolution.findMentionById(mentionId)
      if (mention === undefined) throw new Error('Mention was not found')
      const createdAt = this.now()
      const eventId = this.generateId(createdAt)
      const payloadBytes = Buffer.from(JSON.stringify({ previousEntityId: mention.entityId ?? null }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.rejectMention({
          mentionId,
          resolvedAt: createdAt,
          event: {
            id: eventId,
            matterId: mention.matterId,
            type: 'MENTION_REJECTED',
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
      throw new EntityResolutionError('REJECTION_FAILED', 'Mention could not be rejected', { cause: error })
    }
  }

  merge(sourceEntityId: string, targetEntityId: string): Entity {
    try {
      const source = this.entities.findById(sourceEntityId)
      const target = this.entities.findById(targetEntityId)
      if (source === undefined || target === undefined || source.matterId !== target.matterId) {
        throw new Error('Entities were not found in one Matter')
      }
      const createdAt = this.now()
      const eventId = this.generateId(createdAt)
      const payloadBytes = Buffer.from(JSON.stringify({ targetEntityId }), 'utf8')
      let payloadCipher: Buffer
      try {
        payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
      } finally {
        payloadBytes.fill(0)
      }
      try {
        return this.resolution.mergeEntities({
          sourceEntityId,
          targetEntityId,
          event: {
            id: eventId,
            matterId: source.matterId,
            type: 'ENTITY_MERGED',
            entityId: sourceEntityId,
            actor: 'USER',
            payloadCipher,
            createdAt
          },
          updatedAt: createdAt
        })
      } finally {
        payloadCipher.fill(0)
      }
    } catch (error) {
      throw new EntityResolutionError('MERGE_FAILED', 'Entities could not be merged', { cause: error })
    }
  }

  splitMention(mentionId: string, primaryAlias: string): { readonly entity: Entity; readonly mention: Mention } {
    const mention = this.resolution.findMentionById(mentionId)
    if (mention?.entityId === undefined) throw new EntityResolutionError('SPLIT_FAILED', 'Assigned Mention was not found')
    const source = this.entities.findById(mention.entityId)
    if (source === undefined || source.status !== 'ACTIVE') throw new EntityResolutionError('SPLIT_FAILED', 'Source Entity is not active')
    try {
      const result = this.createEntityWithAssignment(mentionId, { primaryAlias, entityType: source.type }, source.id)
      return { entity: result.entity, mention: result.mention }
    } catch (error) {
      if (error instanceof EntityResolutionError) throw error
      throw new EntityResolutionError('SPLIT_FAILED', 'Mention could not be split into a new Entity', { cause: error })
    }
  }

  createManualMention(input: {
    readonly blockId: string
    readonly type: MentionType
    readonly startOffset: number
    readonly endOffset: number
  }): Mention {
    const protectedValueType = mentionTypeToProtectedValueType(input.type)
    if (protectedValueType === undefined) {
      throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Mention type cannot be protected in V1')
    }
    const block = this.resolution.findManualMentionBlock(input.blockId)
    if (block === undefined) throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Document Block was not found')
    let blockBytes: Buffer
    try {
      blockBytes = decrypt(block.textCipher, this.keys.persistenceKey, documentBlockTextContext(block.id))
    } catch (error) {
      throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Document Block could not be decrypted', { cause: error })
    }
    let text: string
    try {
      text = blockBytes.toString('utf8')
    } finally {
      blockBytes.fill(0)
    }
    if (
      !Number.isSafeInteger(input.startOffset) || !Number.isSafeInteger(input.endOffset) ||
      input.startOffset < 0 || input.endOffset <= input.startOffset || input.endOffset > text.length
    ) {
      throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Mention offsets are outside the Document Block')
    }
    const mentionText = text.slice(input.startOffset, input.endOffset)
    const normalized = normalizeMentionValue(input.type, mentionText)
    if (!isValidNormalizedValue(input.type, normalized)) {
      throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Selected text is not valid for the Mention type')
    }
    const matterKey = deriveMatterSearchKey(this.#searchKey, block.matterId)
    let fingerprint: Buffer
    try {
      fingerprint = fingerprintNormalizedValue(matterKey, normalized)
    } finally {
      matterKey.fill(0)
    }
    const existing = this.protectedValues.findByFingerprint(block.matterId, protectedValueType, fingerprint)
    const createdAt = this.now()
    const mentionId = this.generateId(createdAt)
    const protectedValueId = existing?.id ?? this.generateId(createdAt)
    const publicToken = existing?.publicToken ?? generateProtectedValueToken(protectedValueType)
    const textBytes = Buffer.from(mentionText, 'utf8')
    let textCipher: Buffer
    try {
      textCipher = encrypt(textBytes, this.keys.persistenceKey, mentionTextContext(mentionId))
    } finally {
      textBytes.fill(0)
    }
    let valueCipher: Buffer | undefined
    if (existing === undefined) {
      const valueBytes = Buffer.from(mentionText, 'utf8')
      try {
        valueCipher = encrypt(valueBytes, this.keys.persistenceKey, protectedValueContext(protectedValueId))
      } finally {
        valueBytes.fill(0)
      }
    }
    const eventId = this.generateId(createdAt)
    const payloadBytes = Buffer.from(JSON.stringify({ blockId: block.id, type: input.type, startOffset: input.startOffset, endOffset: input.endOffset }), 'utf8')
    let payloadCipher: Buffer
    try {
      payloadCipher = encrypt(payloadBytes, this.keys.persistenceKey, resolutionEventContext(eventId))
    } finally {
      payloadBytes.fill(0)
    }
    try {
      return this.resolution.createManualMention({
        mention: {
          id: mentionId,
          matterId: block.matterId,
          documentId: block.documentId,
          pageId: block.pageId,
          blockId: block.id,
          protectedValueId,
          type: input.type,
          strength: 'EXPLICIT',
          startOffset: input.startOffset,
          endOffset: input.endOffset,
          detector: 'USER',
          confidence: 1,
          reviewStatus: 'UNREVIEWED',
          createdAt
        },
        textCipher,
        fingerprint,
        ...(existing === undefined
          ? {
              protectedValue: {
                id: protectedValueId,
                matterId: block.matterId,
                type: protectedValueType,
                valueCipher: valueCipher!,
                fingerprint,
                publicToken,
                restorePolicy: 'ALWAYS_RESTORE' as const,
                createdAt
              }
            }
          : existing.publicToken === undefined
            ? { protectedValueTokenBackfill: { id: existing.id, publicToken } }
            : {}),
        event: {
          id: eventId,
          matterId: block.matterId,
          type: 'MENTION_CREATED',
          mentionId,
          actor: 'USER',
          payloadCipher,
          createdAt
        }
      })
    } catch (error) {
      throw new EntityResolutionError('MANUAL_MENTION_FAILED', 'Manual Mention could not be created', { cause: error })
    } finally {
      textCipher.fill(0)
      valueCipher?.fill(0)
      payloadCipher.fill(0)
      fingerprint.fill(0)
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
