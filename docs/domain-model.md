# AliasAI Domain Model v1

## Overview

The V1 domain model intentionally uses industry-neutral concepts. Legal workflows are the first policy/use-case layer, not hard-coded domain structure.

Core objects:

- Matter
- Document
- DocumentPage
- DocumentBlock
- Mention
- Entity
- EntityAlias
- ProtectedValue
- EntityRelationship
- ResolutionCandidate
- ResolutionEvidence
- EntityConstraint
- ResolutionEvent
- ProcessingJob

## Matter

A privacy-isolated project/case space.

Rules:

- Every Document belongs to one Matter.
- Every Entity belongs to one Matter.
- No Entity is globally shared across Matters.
- Tokens/fingerprints are Matter-scoped.

Suggested fields:

```ts
interface Matter {
  id: string
  status: 'ACTIVE' | 'ARCHIVED' | 'DELETED'
  createdAt: number
  updatedAt: number
}
```

The persisted name is encrypted infrastructure data and need not exist in the pure Domain object as plaintext.

## Document

One imported user file.

```ts
type DocumentParseStatus =
  | 'IMPORTED'
  | 'PARSING'
  | 'PARSED'
  | 'DETECTING'
  | 'DETECTED'
  | 'RESOLVING'
  | 'READY'
  | 'SANITIZED'
  | 'FAILED'

interface Document {
  id: string
  matterId: string
  fileHash: string
  mimeType: string
  pageCount?: number
  parserType?: string
  parseStatus: DocumentParseStatus
  createdAt: number
  updatedAt: number
}
```

## DocumentPage

One logical page in a Document.

```ts
interface DocumentPage {
  id: string
  documentId: string
  pageNo: number
  originalWidth: number
  originalHeight: number
  rotation: number
  sourceType: 'NATIVE' | 'RASTER' | 'MIXED'
}
```

## Normalized Bounding Box

All persisted page coordinates use page-relative values in `[0, 1]`.

```ts
interface NormalizedBBox {
  x: number
  y: number
  width: number
  height: number
}
```

## DocumentBlock

A normalized unit produced by native document parsing or OCR.

```ts
type BlockType = 'TEXT' | 'TABLE' | 'IMAGE'
type BlockSource = 'NATIVE' | 'OCR'

interface DocumentBlock {
  id: string
  documentId: string
  pageId: string
  blockType: BlockType
  bbox: NormalizedBBox
  source: BlockSource
  confidence?: number
  readingOrder: number
}
```

The persisted block text is encrypted. Parser/OCR produces Blocks and never creates Entities.

## Mention

A detected sensitive/entity occurrence inside a Document.

```ts
type MentionType =
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

type MentionStrength = 'EXPLICIT' | 'PARTIAL' | 'REFERENCE'
type MentionDetector = 'REGEX' | 'NER' | 'DICTIONARY' | 'USER' | 'FUSION'
type MentionReviewStatus = 'UNREVIEWED' | 'CONFIRMED' | 'REJECTED'

interface Mention {
  id: string
  matterId: string
  documentId: string
  pageId: string
  blockId: string
  type: MentionType
  strength: MentionStrength
  startOffset: number
  endOffset: number
  bbox?: NormalizedBBox
  detector: MentionDetector
  confidence: number
  reviewStatus: MentionReviewStatus
  entityId?: string
  protectedValueId?: string
  createdAt: number
}
```

Rules:

- A Mention may exist without an Entity.
- At most one current Entity assignment per Mention.
- Reference mentions should not automatically create canonical Entities without sufficient evidence.

## Entity

One real-world subject inside one Matter.

```ts
type EntityType = 'PERSON' | 'ORGANIZATION'
type EntityStatus = 'ACTIVE' | 'MERGED' | 'DELETED'

interface Entity {
  id: string
  matterId: string
  type: EntityType
  publicToken: string
  status: EntityStatus
  mergedIntoEntityId?: string
  resolutionConfidence?: number
  createdAt: number
  updatedAt: number
}
```

Rules:

- Entity does not store a plaintext real name.
- Public Token is immutable.
- A merged Entity remains addressable and redirects to a canonical Entity.

## EntityAlias

Human-readable pseudonym used for AI reasoning.

```ts
type AliasType = 'PRIMARY' | 'GENERIC' | 'ROLE'

interface EntityAlias {
  id: string
  matterId: string
  entityId: string
  alias: string
  aliasType: AliasType
  role?: string
  isPrimary: boolean
  createdAt: number
}
```

Rules:

- Alias may change over time.
- Public Token is the restoration anchor, not Alias.
- Aliases must be unique inside a Matter.

## ProtectedValue

Encrypted sensitive value associated with one or more Entities.

```ts
type ProtectedValueType =
  | 'PERSON_NAME'
  | 'ORG_NAME'
  | 'PHONE'
  | 'EMAIL'
  | 'ID_CARD'
  | 'BANK_ACCOUNT'
  | 'ADDRESS'

type RestorePolicy =
  | 'ALWAYS_RESTORE'
  | 'RESTORE_ON_REQUEST'
  | 'NEVER_RESTORE'

interface ProtectedValue {
  id: string
  matterId: string
  type: ProtectedValueType
  publicToken?: string
  restorePolicy: RestorePolicy
  createdAt: number
}
```

Persistence owns encrypted value/fingerprint details.

A ProtectedValue may be associated with multiple Entities because real-world values are not guaranteed unique (for example a shared phone number or identical names).

## EntityRelationship

Matter-local relationship edge.

```ts
interface EntityRelationship {
  id: string
  matterId: string
  sourceEntityId: string
  relationshipType: string
  targetEntityId: string
  confidence: number
  sourceDocumentId?: string
  sourceMentionId?: string
  createdAt: number
}
```

V1 stores these in SQLite; no graph database is required.

## ResolutionCandidate

Candidate link between one Mention and an existing Entity.

```ts
type ResolutionCandidateState = 'PENDING' | 'ACCEPTED' | 'REJECTED'

interface ResolutionCandidate {
  id: string
  mentionId: string
  candidateEntityId: string
  score: number
  state: ResolutionCandidateState
  algorithmVersion: string
  createdAt: number
  resolvedAt?: number
}
```

## ResolutionEvidence

Explainable evidence supporting or contradicting a ResolutionCandidate.

```ts
interface ResolutionEvidence {
  id: string
  candidateId: string
  evidenceType: string
  weight: number
  score: number
  createdAt: number
}
```

Example evidence types:

- `SAME_ID_CARD`
- `CONFLICTING_ID_CARD`
- `SAME_PHONE`
- `NAME_EXACT`
- `NAME_OCR_SIMILAR`
- `SAME_ORGANIZATION`
- `ROLE_COMPATIBLE`

## EntityConstraint

Hard relationship rule between Entities.

```ts
type EntityConstraintType = 'MUST_LINK' | 'CANNOT_LINK'
type ConstraintSource = 'SYSTEM' | 'USER'

interface EntityConstraint {
  id: string
  matterId: string
  entityAId: string
  entityBId: string
  type: EntityConstraintType
  reason: string
  source: ConstraintSource
  createdAt: number
}
```

Cannot-Link overrides all soft scoring/model results.

## ResolutionEvent

Append-only history of identity mutations.

```ts
type ResolutionEventType =
  | 'ENTITY_CREATED'
  | 'MENTION_ASSIGNED'
  | 'MENTION_REASSIGNED'
  | 'ENTITY_MERGED'
  | 'ENTITY_SPLIT'
  | 'ENTITY_CONFIRMED'
  | 'CONSTRAINT_CREATED'

type ResolutionActor = 'SYSTEM' | 'USER'

interface ResolutionEvent {
  id: string
  matterId: string
  type: ResolutionEventType
  entityId?: string
  mentionId?: string
  actor: ResolutionActor
  createdAt: number
}
```

The event payload is persisted encrypted by infrastructure.

## ProcessingJob

Long-running local work item.

```ts
type ProcessingJobType = 'PARSE' | 'OCR' | 'DETECT' | 'RESOLVE' | 'SANITIZE' | 'VERIFY'
type ProcessingJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

interface ProcessingJob {
  id: string
  documentId: string
  type: ProcessingJobType
  status: ProcessingJobStatus
  progress: number
  checkpoint?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}
```

OCR/page processing should be resumable via job checkpoints and persisted page results.

## Critical Examples

### Repeated person mention

```text
M1 "张伟"      -> E1
M2 "张先生"    -> E1
M3 "原告"      -> E1
E1 alias        = 原告甲
E1 public token = @P-X7M2K9
```

### Same name, different people

```text
E1: 张伟 + ID_CARD A
E2: 张伟 + ID_CARD B
```

`ID_CARD A != ID_CARD B` produces a hard Cannot-Link.

### Merge

```text
E2.status = MERGED
E2.mergedIntoEntityId = E1
```

`E2.publicToken` remains valid forever and resolves through E1.

### Rehydration

AI text:

```text
原告甲〔@P-X7M2K9〕应进一步证明签约权限。
```

Resolution:

```text
@P-X7M2K9 -> E1 -> primary PERSON_NAME -> 张伟
```

Restored text:

```text
张伟应进一步证明签约权限。
```