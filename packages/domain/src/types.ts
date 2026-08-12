/**
 * Pure, persistence-agnostic contracts for AliasAI's identity model.
 *
 * Sensitive plaintext and encrypted persistence fields intentionally do not
 * belong here. They are infrastructure concerns owned by later packages.
 */

export type MatterStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED'

export interface Matter {
  readonly id: string
  readonly status: MatterStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export type DocumentParseStatus =
  | 'IMPORTED'
  | 'PARSING'
  | 'PARSED'
  | 'DETECTING'
  | 'DETECTED'
  | 'RESOLVING'
  | 'READY'
  | 'SANITIZED'
  | 'FAILED'

export interface Document {
  readonly id: string
  readonly matterId: string
  readonly fileHash: string
  readonly mimeType: string
  readonly pageCount?: number
  readonly parserType?: string
  readonly parseStatus: DocumentParseStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export type PageSourceType = 'NATIVE' | 'RASTER' | 'MIXED'

export interface DocumentPage {
  readonly id: string
  readonly documentId: string
  readonly pageNo: number
  readonly originalWidth: number
  readonly originalHeight: number
  readonly rotation: number
  readonly sourceType: PageSourceType
}

/** Persisted page-relative rectangle in [0, 1] whose full extent remains on-page. */
export interface NormalizedBBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type BlockType = 'TEXT' | 'TABLE' | 'IMAGE'
export type BlockSource = 'NATIVE' | 'OCR'

export interface DocumentBlock {
  readonly id: string
  readonly documentId: string
  readonly pageId: string
  readonly blockType: BlockType
  readonly bbox: NormalizedBBox
  readonly source: BlockSource
  readonly confidence?: number
  readonly readingOrder: number
}

export type MentionType =
  | 'PERSON'
  | 'ORGANIZATION'
  | 'PHONE'
  | 'EMAIL'
  | 'ID_CARD'
  | 'BANK_ACCOUNT'
  | 'ADDRESS'
  | 'CASE_NUMBER'
  | 'CONTRACT_NUMBER'
  | 'COURT'
  | 'LAWYER'
  | 'JUDGE'

export type MentionStrength = 'EXPLICIT' | 'PARTIAL' | 'REFERENCE'
export type MentionDetector = 'REGEX' | 'NER' | 'DICTIONARY' | 'USER' | 'FUSION'
export type MentionReviewStatus = 'UNREVIEWED' | 'CONFIRMED' | 'REJECTED'

export interface Mention {
  readonly id: string
  readonly matterId: string
  readonly documentId: string
  readonly pageId: string
  readonly blockId: string
  readonly type: MentionType
  readonly strength: MentionStrength
  readonly startOffset: number
  readonly endOffset: number
  readonly bbox?: NormalizedBBox
  readonly detector: MentionDetector
  readonly confidence: number
  readonly reviewStatus: MentionReviewStatus
  readonly entityId?: string
  readonly protectedValueId?: string
  readonly createdAt: number
}

export type EntityType = 'PERSON' | 'ORGANIZATION'
export type EntityStatus = 'ACTIVE' | 'MERGED' | 'DELETED'

export interface Entity {
  readonly id: string
  readonly matterId: string
  readonly type: EntityType
  /** Matter-scoped, stable restoration anchor. Never derived from identity data. */
  readonly publicToken: string
  readonly status: EntityStatus
  readonly mergedIntoEntityId?: string
  readonly resolutionConfidence?: number
  readonly createdAt: number
  readonly updatedAt: number
}

export type AliasType = 'PRIMARY' | 'GENERIC' | 'ROLE'

export interface EntityAlias {
  readonly id: string
  readonly matterId: string
  readonly entityId: string
  readonly alias: string
  readonly aliasType: AliasType
  readonly role?: string
  readonly isPrimary: boolean
  readonly createdAt: number
}

export type ProtectedValueType =
  | 'PERSON_NAME'
  | 'ORG_NAME'
  | 'PHONE'
  | 'EMAIL'
  | 'ID_CARD'
  | 'BANK_ACCOUNT'
  | 'ADDRESS'

export type RestorePolicy = 'ALWAYS_RESTORE' | 'RESTORE_ON_REQUEST' | 'NEVER_RESTORE'

export interface ProtectedValue {
  readonly id: string
  readonly matterId: string
  readonly type: ProtectedValueType
  readonly publicToken?: string
  readonly restorePolicy: RestorePolicy
  readonly createdAt: number
}

export interface EntityRelationship {
  readonly id: string
  readonly matterId: string
  readonly sourceEntityId: string
  readonly relationshipType: string
  readonly targetEntityId: string
  readonly confidence: number
  readonly sourceDocumentId?: string
  readonly sourceMentionId?: string
  readonly createdAt: number
}

export type ResolutionCandidateState = 'PENDING' | 'ACCEPTED' | 'REJECTED'

export interface ResolutionCandidate {
  readonly id: string
  readonly mentionId: string
  readonly candidateEntityId: string
  readonly score: number
  readonly state: ResolutionCandidateState
  readonly algorithmVersion: string
  readonly createdAt: number
  readonly resolvedAt?: number
}

export interface ResolutionEvidence {
  readonly id: string
  readonly candidateId: string
  readonly evidenceType: string
  readonly weight: number
  readonly score: number
  readonly createdAt: number
}

export type EntityConstraintType = 'MUST_LINK' | 'CANNOT_LINK'
export type ConstraintSource = 'SYSTEM' | 'USER'

export interface EntityConstraint {
  readonly id: string
  readonly matterId: string
  readonly entityAId: string
  readonly entityBId: string
  readonly type: EntityConstraintType
  readonly reason: string
  readonly source: ConstraintSource
  readonly createdAt: number
}

export type ResolutionEventType =
  | 'ENTITY_CREATED'
  | 'MENTION_ASSIGNED'
  | 'MENTION_REASSIGNED'
  | 'ENTITY_MERGED'
  | 'ENTITY_SPLIT'
  | 'ENTITY_CONFIRMED'
  | 'CONSTRAINT_CREATED'

export type ResolutionActor = 'SYSTEM' | 'USER'

export interface ResolutionEvent {
  readonly id: string
  readonly matterId: string
  readonly type: ResolutionEventType
  readonly entityId?: string
  readonly mentionId?: string
  readonly actor: ResolutionActor
  readonly createdAt: number
}

export type ProcessingJobType = 'PARSE' | 'OCR' | 'DETECT' | 'RESOLVE' | 'SANITIZE' | 'VERIFY'
export type ProcessingJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export interface ProcessingJob {
  readonly id: string
  readonly documentId: string
  readonly type: ProcessingJobType
  readonly status: ProcessingJobStatus
  readonly progress: number
  readonly checkpoint?: string
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
}
