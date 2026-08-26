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
- AiExecution

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

Initial parsing state transitions are:

```text
IMPORTED -> PARSING -> PARSED
                 `-> FAILED -> PARSING
```

Only the application service changes parsing state. Parser/OCR workers return Protocol
v1 data and never persist or update the Document directly. A successful transition to
`PARSED` requires a complete, contiguous page sequence and an atomic Page/Block commit.

Privacy detection extends the state machine without coupling the application to a
specific detection engine:

```text
PARSED -> DETECTING -> DETECTED
                   `-> FAILED -> DETECTING
```

A `FAILED` Document is retried according to its latest `ProcessingJob`: parsing
failures may retry parsing, while detection failures retain the persisted Document
Model and may retry detection. A completed detection is idempotent and reuses its
existing Mention set rather than creating duplicate jobs or Mentions.

Entity resolution extends the state machine to the end of the local pipeline:

```text
DETECTED -> RESOLVING -> READY
                     `-> FAILED -> RESOLVING
```

Resolution decrypts each Mention transiently, normalizes and fingerprints its value,
creates or reuses the Matter-scoped ProtectedValue, scores candidates with the
`er-v2` evidence rules, including explicit same-labeled-field-group context, and applies the decision atomically: `AUTO_LINK` assigns the
Mention to the candidate Entity (`MENTION_ASSIGNED`, actor SYSTEM), `NEW_ENTITY`
creates an Entity with a random Public Token and a synthetic primary alias that never
contains Mention plaintext, `REVIEW` persists pending candidates for human review,
and `UNRESOLVED` leaves the Mention assigned to its ProtectedValue only. A `READY`
Document's resolution is idempotent. Manual assign/reassign, rename, reject,
manual Mention creation, merge, split, and Must-Link/Cannot-Link constraints are
application operations that append corresponding ResolutionEvents in the same
transaction as the mutation.

Pseudonymization completes the local pipeline:

```text
READY -> SANITIZING -> SANITIZED
                    `-> FAILED -> SANITIZING
```

Sanitization decrypts each Block transiently in reading order and replaces every accepted
Mention range with `Alias〔@Token〕`, working strictly from
Mention -> ProtectedValue restoration token plus an Entity primary Alias when a
reliable owner exists — never raw string replacement. Entity-less values use a
type-level alias and do not create fake canonical Entities. The restoration token is value-level and Matter-scoped: each
ProtectedValue of an Entity (name, ID card, email, bank account) carries its own
token, so one Entity holds several distinct restoration anchors under different
policies. The workflow is fail-closed for overlapping, out-of-range, unsupported,
or tokenless Mentions and invalid Entity assignments. Explicitly rejected false
positives are omitted. The sanitized
Block texts are persisted encrypted; the Mapping Vault records, per Mention, only
non-sensitive replacement metadata (restoration token, alias used, effective
restore policy). The effective restore policy is type-level: names and addresses
`ALWAYS_RESTORE`, phone/email/ID card `RESTORE_ON_REQUEST`, bank account
`NEVER_RESTORE`. A `SANITIZED` Document's artifact is immutable and reused
idempotently.

Rehydration is a local read-only operation over the Mapping Vault: the value-level
restoration token is the lookup anchor, aliases only identify the wrapped span,
values below the caller's requested policy level stay pseudonymized, and unknown
or tampered tokens remain verbatim and are reported for manual review.

## AiExecution

One provider invocation over one immutable persisted SanitizedDocument. Request,
response, and error fields are encrypted persistence concerns and do not belong in
the pure domain object.

```ts
type AiExecutionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED'

interface AiExecution {
  id: string
  matterId: string
  sanitizedDocumentId: string
  providerId: string
  status: AiExecutionStatus
  createdAt: number
  startedAt: number
  finishedAt?: number
}
```

Lifecycle:

```text
RUNNING -> COMPLETED
       `-> FAILED
```

An execution cannot change provider, Matter, source artifact, request, or start
timestamps after insert and permits exactly one terminal transition. A COMPLETED
row has one encrypted sanitized response; a FAILED row has one encrypted code-only
error payload. Rehydration is deliberately not part of persisted provider output:
it is recomputed locally from the immutable sanitized response and Mapping Vault.

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

All persisted page coordinates use page-relative values in `[0, 1]`, with
`x + width <= 1` and `y + height <= 1` so the full rectangle remains on-page.

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
V1 block encryption binds the ciphertext to the application-generated Block ID with
AES-GCM additional authenticated data; worker-local block IDs are never database IDs.

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
- Privacy detectors return Matter/Document/Page/Block-scoped location proposals; they do not return or persist plaintext.
- The application validates proposal boundaries, slices transient Block text, and encrypts each Mention before persistence.
- Detection-created Mentions begin `UNREVIEWED` and unassigned to Entity or ProtectedValue records.
- Overlapping V1 rule proposals are resolved deterministically with the earliest, longest proposal winning.
- Mention offsets use JavaScript UTF-16 code units, matching `RegExp` match indexes and `String.slice`. Any future Python NER adapter must convert Unicode code-point offsets at the application boundary before producing proposals.
- V1 discards lower-priority overlapping rule proposals. Before mixed rule/NER evaluation is introduced, the proposal contract should retain rejected overlap evidence so detector recall remains measurable.

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
- Generated Public Tokens use at least 64 bits of cryptographic randomness and never encode identity data.
- A merged Entity remains addressable and redirects to an active Entity in the same Matter.
- Redirects must never form a cycle; restoration follows any historic redirect chain to its active canonical Entity.

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
- The Entity Public Token is the identity anchor, not Alias; rehydration anchors
  on the ProtectedValue restoration token instead.
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

V1 privacy detection persists a `DETECT` job before reading Blocks. Progress
checkpoints contain only block counts (for example `2/5`), never IDs or plaintext.
Completing the job, inserting all Mentions, and setting the Document to `DETECTED`
happen in one transaction. On failure no proposed Mention is committed; the job and
Document are finalized as `FAILED`, with a code-only encrypted error payload.

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

`E2.publicToken` remains valid forever and resolves through E1. Pending
resolution candidates scored against E2 are redirected to E1, or closed as
REJECTED when E1 already proposes for the same Mention, so no ghost candidate
survives the merge. Hard Must-Link/Cannot-Link constraints follow the identity
as well: rules binding E2 to a third Entity are rewritten onto E1 (collapsing
duplicates, dropping the E1-E2 pair that would become self-referential), and a
merge that would create contradictory hard rules on E1 is refused and rolled
back. The ENTITY_MERGED event is the audit anchor for these substitutions.

### Rehydration

AI text:

```text
原告甲〔@N-X7M2K9F3〕应进一步证明签约权限。
```

Resolution:

```text
@N-X7M2K9F3 -> Mapping Vault -> PERSON_NAME ProtectedValue -> 张伟
```

Restored text:

```text
张伟应进一步证明签约权限。
```

Rehydration resolves both wrapped and bare Public Tokens. For wrapped output,
the local mapping also supplies current and historic aliases so only the exact
`Alias〔@TOKEN〕` span is replaced; an unknown token or unexpectedly edited
alias remains visible for review rather than consuming surrounding AI text.
