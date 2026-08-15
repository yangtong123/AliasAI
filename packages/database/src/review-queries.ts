import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type {
  BlockType,
  Document,
  EntityStatus,
  MatterStatus,
  Mention,
  MentionType,
  ProcessingJob,
  ResolutionCandidate,
  ResolutionEvidence
} from '@aliasai/domain'
import { assertDocumentBlock, assertMention, assertProcessingJob } from '@aliasai/domain'
import type { AliasAiDatabase } from './client'
import { toMention, toProcessingJob } from './repositories'
import {
  documentBlocks,
  documentPages,
  documents,
  entities,
  entityAliases,
  matters,
  mentions,
  processingJobs,
  protectedValues,
  resolutionCandidates,
  resolutionEvents,
  resolutionEvidence
} from './schema'

export interface MatterListItem {
  readonly id: string
  readonly status: MatterStatus
  readonly nameCipher: Buffer
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DocumentListItem {
  readonly document: Document
  readonly originalNameCipher: Buffer
}

/** A Block joined with its page number, carrying encrypted text for display decryption. */
export interface ReviewBlockSource {
  readonly id: string
  readonly documentId: string
  readonly pageId: string
  readonly pageNo: number
  readonly blockType: BlockType
  readonly textCipher: Buffer
  readonly readingOrder: number
}

/** A Mention carrying its encrypted text for display decryption. */
export interface ReviewMentionSource extends Mention {
  readonly textCipher: Buffer
}

export interface CandidateWithEvidence extends ResolutionCandidate {
  readonly evidence: readonly ResolutionEvidence[]
}

/** The Mention/entity/token join sanitization gates on, mirrored from its begin() predicate. */
export interface SanitizationReadinessMention {
  readonly mentionId: string
  readonly mentionType: MentionType
  readonly entityId: string | null
  readonly entityStatus: EntityStatus | null
  readonly entityPrimaryAlias: string | null
  readonly protectedValuePublicToken: string | null
}

/**
 * Read-only queries backing the review UI. Nothing here mutates state or enters
 * a job transaction; every cipher stays opaque and is decrypted by the
 * application layer for display only.
 */
export class ReviewQueryRepository {
  constructor(private readonly db: AliasAiDatabase) {}

  listMatters(): readonly MatterListItem[] {
    return this.db
      .select()
      .from(matters)
      .orderBy(asc(matters.createdAt), asc(matters.id))
      .all()
      .map((row) => ({
        id: row.id,
        status: row.status,
        nameCipher: row.nameCipher,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }))
  }

  listDocumentsByMatter(matterId: string): readonly DocumentListItem[] {
    const documentRows = this.db
      .select()
      .from(documents)
      .where(eq(documents.matterId, matterId))
      .orderBy(asc(documents.createdAt), asc(documents.id))
      .all()
    return documentRows.map((row) => ({
      document: {
        id: row.id,
        matterId: row.matterId,
        fileHash: row.fileHash,
        mimeType: row.mimeType,
        ...(row.pageCount === null ? {} : { pageCount: row.pageCount }),
        ...(row.parserType === null ? {} : { parserType: row.parserType }),
        parseStatus: row.parseStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      originalNameCipher: row.originalNameCipher
    }))
  }

  findReviewBlocks(documentId: string): readonly ReviewBlockSource[] {
    return this.db
      .select({ block: documentBlocks, pageNo: documentPages.pageNo })
      .from(documentBlocks)
      .innerJoin(documentPages, eq(documentPages.id, documentBlocks.pageId))
      .where(eq(documentBlocks.documentId, documentId))
      .orderBy(asc(documentPages.pageNo), asc(documentBlocks.readingOrder), asc(documentBlocks.id))
      .all()
      .map(({ block, pageNo }) => {
        assertDocumentBlock({
          id: block.id,
          documentId: block.documentId,
          pageId: block.pageId,
          blockType: block.blockType,
          bbox: { x: block.x, y: block.y, width: block.width, height: block.height },
          source: block.source,
          ...(block.confidence === null ? {} : { confidence: block.confidence }),
          readingOrder: block.readingOrder
        })
        return {
          id: block.id,
          documentId: block.documentId,
          pageId: block.pageId,
          pageNo,
          blockType: block.blockType,
          textCipher: block.textCipher,
          readingOrder: block.readingOrder
        }
      })
  }

  findReviewMentions(documentId: string): readonly ReviewMentionSource[] {
    return this.db
      .select({ mention: mentions })
      .from(mentions)
      .innerJoin(documentBlocks, eq(documentBlocks.id, mentions.blockId))
      .innerJoin(documentPages, eq(documentPages.id, mentions.pageId))
      .where(eq(mentions.documentId, documentId))
      .orderBy(
        asc(documentPages.pageNo),
        asc(documentBlocks.readingOrder),
        asc(mentions.startOffset),
        asc(mentions.id)
      )
      .all()
      .map(({ mention }) => ({ ...toMention(mention), textCipher: mention.textCipher }))
  }

  findCandidatesForMentions(mentionIds: readonly string[]): readonly CandidateWithEvidence[] {
    if (mentionIds.length === 0) return []
    const candidateRows = this.db
      .select()
      .from(resolutionCandidates)
      .where(inArray(resolutionCandidates.mentionId, [...mentionIds]))
      .orderBy(desc(resolutionCandidates.score), asc(resolutionCandidates.id))
      .all()
    if (candidateRows.length === 0) return []
    const evidenceRows = this.db
      .select()
      .from(resolutionEvidence)
      .where(
        inArray(
          resolutionEvidence.candidateId,
          candidateRows.map((row) => row.id)
        )
      )
      .orderBy(asc(resolutionEvidence.id))
      .all()
    const evidenceByCandidate = new Map<string, ResolutionEvidence[]>()
    for (const row of evidenceRows) {
      const evidence: ResolutionEvidence = {
        id: row.id,
        candidateId: row.candidateId,
        evidenceType: row.evidenceType,
        weight: row.weight,
        score: row.score,
        createdAt: row.createdAt
      }
      const list = evidenceByCandidate.get(row.candidateId)
      if (list === undefined) evidenceByCandidate.set(row.candidateId, [evidence])
      else list.push(evidence)
    }
    return candidateRows.map((row) => ({
      id: row.id,
      mentionId: row.mentionId,
      candidateEntityId: row.candidateEntityId,
      score: row.score,
      state: row.state,
      algorithmVersion: row.algorithmVersion,
      createdAt: row.createdAt,
      ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
      evidence: evidenceByCandidate.get(row.id) ?? []
    }))
  }

  findLatestJobs(documentId: string): readonly ProcessingJob[] {
    const rows = this.db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.documentId, documentId))
      .orderBy(desc(processingJobs.createdAt), desc(processingJobs.id))
      .all()
    const latestByType = new Map<string, ReturnType<typeof toProcessingJob>>()
    for (const row of rows) {
      if (!latestByType.has(row.jobType)) latestByType.set(row.jobType, toProcessingJob(row))
    }
    return [...latestByType.values()].map((job) => {
      assertProcessingJob(job)
      return job
    })
  }

  findSanitizationReadiness(documentId: string): readonly SanitizationReadinessMention[] {
    return this.db
      .select({
        mentionId: mentions.id,
        mentionType: mentions.mentionType,
        entityId: entities.id,
        entityStatus: entities.status,
        entityPrimaryAlias: entityAliases.alias,
        protectedValuePublicToken: protectedValues.publicToken
      })
      .from(mentions)
      .leftJoin(entities, eq(entities.id, mentions.entityId))
      .leftJoin(entityAliases, and(eq(entityAliases.entityId, mentions.entityId), eq(entityAliases.isPrimary, true)))
      .leftJoin(protectedValues, eq(protectedValues.id, mentions.protectedValueId))
      .where(eq(mentions.documentId, documentId))
      .orderBy(asc(mentions.startOffset), asc(mentions.id))
      .all()
      .map((row) => ({
        mentionId: row.mentionId,
        mentionType: row.mentionType,
        entityId: row.entityId,
        entityStatus: row.entityStatus,
        entityPrimaryAlias: row.entityPrimaryAlias,
        protectedValuePublicToken: row.protectedValuePublicToken
      }))
  }

  /** Used by review display paths that need a single mention's current shape. */
  findMentionById(mentionId: string): ReviewMentionSource | undefined {
    const row = this.db.select().from(mentions).where(eq(mentions.id, mentionId)).get()
    if (row === undefined) return undefined
    const mention = toMention(row)
    assertMention(mention)
    return { ...mention, textCipher: row.textCipher }
  }

  /**
   * The actor of the latest assignment event per mention ('SYSTEM' | 'USER'),
   * distinguishing auto-links from user decisions in the review read model.
   */
  findLatestAssignmentActors(mentionIds: readonly string[]): ReadonlyMap<string, 'SYSTEM' | 'USER'> {
    if (mentionIds.length === 0) return new Map()
    const rows = this.db
      .select({ mentionId: resolutionEvents.mentionId, actor: resolutionEvents.actor, createdAt: resolutionEvents.createdAt, id: resolutionEvents.id })
      .from(resolutionEvents)
      .where(
        and(
          inArray(resolutionEvents.mentionId, [...mentionIds]),
          inArray(resolutionEvents.eventType, ['MENTION_ASSIGNED', 'MENTION_REASSIGNED'])
        )
      )
      .orderBy(desc(resolutionEvents.createdAt), desc(resolutionEvents.id))
      .all()
    const actorByMention = new Map<string, 'SYSTEM' | 'USER'>()
    for (const row of rows) {
      if (row.mentionId !== null && !actorByMention.has(row.mentionId)) actorByMention.set(row.mentionId, row.actor)
    }
    return actorByMention
  }
}
