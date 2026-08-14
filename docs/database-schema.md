# AliasAI Database Schema v1

## General Rules

- Database: SQLite
- ORM/migrations: Drizzle
- Internal IDs: UUIDv7 stored as `TEXT`
- Timestamps: Unix milliseconds stored as `INTEGER`
- Real sensitive values: encrypted before persistence
- Exact-match lookup for protected values: Matter-scoped HMAC fingerprint
- Page coordinates: normalized `[0,1]`

V1 uses one SQLite database. Process/database separation may be introduced later without changing the domain contracts.

## Tables

### matters

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| name_cipher | BLOB | NOT NULL |
| status | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

Allowed status: `ACTIVE`, `ARCHIVED`, `DELETED`.

### documents

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| original_name_cipher | BLOB | NOT NULL |
| source_path_cipher | BLOB | nullable |
| file_hash | TEXT | NOT NULL |
| mime_type | TEXT | NOT NULL |
| parser_type | TEXT | nullable |
| page_count | INTEGER | nullable |
| parse_status | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

Unique: `(matter_id, file_hash)`.

Indexes:

- `idx_documents_matter(matter_id)`

### document_pages

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| document_id | TEXT | FK documents(id), NOT NULL |
| page_no | INTEGER | NOT NULL |
| original_width | REAL | NOT NULL |
| original_height | REAL | NOT NULL |
| rotation | INTEGER | NOT NULL DEFAULT 0 |
| source_type | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |

Unique: `(document_id, page_no)`.

### document_blocks

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| document_id | TEXT | FK documents(id), NOT NULL |
| page_id | TEXT | FK document_pages(id), NOT NULL |
| block_type | TEXT | NOT NULL |
| text_cipher | BLOB | NOT NULL |
| source | TEXT | NOT NULL |
| confidence | REAL | nullable |
| x | REAL | NOT NULL |
| y | REAL | NOT NULL |
| width | REAL | NOT NULL |
| height | REAL | NOT NULL |
| reading_order | INTEGER | NOT NULL |
| created_at | INTEGER | NOT NULL |

Checks: `x`, `y`, `width`, `height` in `[0,1]`.

Index:

- `idx_blocks_page_order(page_id, reading_order)`

Block text is encrypted in the application layer before repository insertion. The V1
authenticated context is `<block-id>:documentBlock.text`, preventing ciphertext from
being moved between Block rows without authentication failure.

The Document processing repository commits the complete Page/Block model and the final
`documents.parse_status = 'PARSED'` update in one SQLite transaction. A failed commit
must not leave partial Pages or Blocks; the application subsequently records the
Document as `FAILED`.

Once a Document Model exists, a downstream detection failure does not make it
eligible for parsing again. The latest `DETECT` ProcessingJob distinguishes a
detection retry from a parser retry while retaining the encrypted Pages and Blocks.

### mentions

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| document_id | TEXT | FK documents(id), NOT NULL |
| page_id | TEXT | FK document_pages(id), NOT NULL |
| block_id | TEXT | FK document_blocks(id), NOT NULL |
| entity_id | TEXT | FK entities(id), nullable |
| protected_value_id | TEXT | FK protected_values(id), nullable |
| mention_type | TEXT | NOT NULL |
| mention_strength | TEXT | NOT NULL |
| text_cipher | BLOB | NOT NULL |
| fingerprint | BLOB | nullable |
| start_offset | INTEGER | NOT NULL |
| end_offset | INTEGER | NOT NULL |
| x | REAL | nullable |
| y | REAL | nullable |
| width | REAL | nullable |
| height | REAL | nullable |
| detector | TEXT | NOT NULL |
| confidence | REAL | NOT NULL |
| review_status | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |

Indexes:

- `idx_mentions_document(document_id)`
- `idx_mentions_matter_type(matter_id, mention_type)`
- `idx_mentions_entity(entity_id)`
- `idx_mentions_protected_value(protected_value_id)`

Mention text uses the authenticated encryption context
`<mention-id>:mention.text`. Privacy detection reads encrypted Blocks only after an
atomic `PARSED -> DETECTING` transition. It then atomically inserts the full Mention
batch, completes its ProcessingJob, and changes the Document to `DETECTED`. Boundary
triggers continue to enforce matching Matter, Document, Page, and Block ownership.
Detection never sets `entity_id` or `protected_value_id`.

The V1 rule-detection workflow leaves `fingerprint` null. Entity Resolution backfills
it while resolving: the Mention text is decrypted transiently, normalized with the
type-specific rules of the entity-resolution package, and fingerprinted as
`HMAC-SHA256(matter_search_key, normalized_value)`. The Matter search key is derived
per Matter from the application search key (`HMAC-SHA256(search_key,
"matter-search:<matter-id>")`); the persistence key must not be reused as the search
key. Entity Resolution writes `fingerprint` and `protected_value_id` together with any
`entity_id` assignment in its atomic completion transaction.

### entities

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| entity_type | TEXT | NOT NULL |
| public_token | TEXT | NOT NULL |
| status | TEXT | NOT NULL |
| merged_into_entity_id | TEXT | self FK entities(id), nullable |
| resolution_confidence | REAL | nullable |
| created_at | INTEGER | NOT NULL |
| updated_at | INTEGER | NOT NULL |

Unique: `(matter_id, public_token)`.

Indexes:

- `idx_entities_matter_type(matter_id, entity_type)`
- `idx_entities_merged_into(merged_into_entity_id)`

Merged entities are never physically deleted merely because of a merge.

### entity_aliases

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| entity_id | TEXT | FK entities(id), NOT NULL |
| alias | TEXT | NOT NULL |
| alias_type | TEXT | NOT NULL |
| role | TEXT | nullable |
| is_primary | INTEGER | NOT NULL DEFAULT 0 |
| created_at | INTEGER | NOT NULL |

Unique: `(matter_id, alias)`.

Partial unique index: one primary alias per Entity:

```sql
CREATE UNIQUE INDEX idx_alias_primary
ON entity_aliases(entity_id)
WHERE is_primary = 1;
```

### protected_values

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| value_type | TEXT | NOT NULL |
| value_cipher | BLOB | NOT NULL |
| fingerprint | BLOB | NOT NULL |
| public_token | TEXT | nullable |
| restore_policy | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |

Unique: `(matter_id, value_type, fingerprint)`.

Index:

- `idx_protected_values_lookup(matter_id, value_type, fingerprint)`

Fingerprint definition:

```text
HMAC-SHA256(matter_search_key, normalized_value)
```

Do not use plain SHA-256 of the real value.

### entity_protected_values

Many-to-many link because a value is not guaranteed unique to one Entity.

| Column | Type | Constraints |
|---|---|---|
| entity_id | TEXT | FK entities(id), NOT NULL |
| protected_value_id | TEXT | FK protected_values(id), NOT NULL |
| relationship_type | TEXT | NOT NULL |
| confidence | REAL | NOT NULL |
| is_primary | INTEGER | NOT NULL DEFAULT 0 |
| created_at | INTEGER | NOT NULL |

Primary key: `(entity_id, protected_value_id)`.

### entity_relationships

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| source_entity_id | TEXT | FK entities(id), NOT NULL |
| relation_type | TEXT | NOT NULL |
| target_entity_id | TEXT | FK entities(id), NOT NULL |
| confidence | REAL | NOT NULL |
| source_document_id | TEXT | FK documents(id), nullable |
| source_mention_id | TEXT | FK mentions(id), nullable |
| created_at | INTEGER | NOT NULL |

Indexes:

- `idx_entity_relationships_source(source_entity_id, relation_type)`
- `idx_entity_relationships_target(target_entity_id, relation_type)`

### resolution_candidates

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| mention_id | TEXT | FK mentions(id), NOT NULL |
| candidate_entity_id | TEXT | FK entities(id), NOT NULL |
| score | REAL | NOT NULL |
| state | TEXT | NOT NULL |
| algorithm_version | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |
| resolved_at | INTEGER | nullable |

Unique: `(mention_id, candidate_entity_id)`.

Entity Resolution persists every scored candidate with its evidence in the same
transaction that completes the `RESOLVE` ProcessingJob. Score and state are validated
by the repository and domain layers; `algorithm_version` identifies the scoring rule
set (V1: `er-v1`).

### resolution_evidence

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| candidate_id | TEXT | FK resolution_candidates(id), NOT NULL |
| evidence_type | TEXT | NOT NULL |
| weight | REAL | NOT NULL |
| score | REAL | NOT NULL |
| details_cipher | BLOB | nullable |
| created_at | INTEGER | NOT NULL |

Index:

- `idx_resolution_evidence_candidate(candidate_id)`

### entity_constraints

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| entity_a_id | TEXT | FK entities(id), NOT NULL |
| entity_b_id | TEXT | FK entities(id), NOT NULL |
| constraint_type | TEXT | NOT NULL |
| reason | TEXT | NOT NULL |
| source | TEXT | NOT NULL |
| created_at | INTEGER | NOT NULL |

V1 application code must canonicalize pair ordering before insert so `(A,B)` and `(B,A)` cannot duplicate semantically.

Recommended unique: `(matter_id, entity_a_id, entity_b_id, constraint_type)`.

### resolution_events

Append-only identity history.

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| matter_id | TEXT | FK matters(id), NOT NULL |
| event_type | TEXT | NOT NULL |
| entity_id | TEXT | FK entities(id), nullable |
| mention_id | TEXT | FK mentions(id), nullable |
| actor | TEXT | NOT NULL |
| payload_cipher | BLOB | NOT NULL |
| created_at | INTEGER | NOT NULL |

Indexes:

- `idx_resolution_events_matter_time(matter_id, created_at)`
- `idx_resolution_events_entity(entity_id)`
- `idx_resolution_events_mention(mention_id)`

### processing_jobs

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| document_id | TEXT | FK documents(id), NOT NULL |
| job_type | TEXT | NOT NULL |
| status | TEXT | NOT NULL |
| progress | REAL | NOT NULL DEFAULT 0 |
| checkpoint | TEXT | nullable |
| error_cipher | BLOB | nullable |
| created_at | INTEGER | NOT NULL |
| started_at | INTEGER | nullable |
| finished_at | INTEGER | nullable |

Indexes:

- `idx_processing_jobs_document(document_id)`
- `idx_processing_jobs_status(status)`

ProcessingJob type, status, progress, timestamps, and encrypted-error presence are
checked by SQLite. A running `DETECT` or `RESOLVE` job has `started_at` and no
terminal timestamp; a completed job has progress `1`; a failed job has `finished_at`
and a non-null encrypted error. Detection checkpoints are non-sensitive block counts
only; resolution checkpoints are non-sensitive mention counts only.

Entity Resolution owns the `DETECTED -> RESOLVING -> READY` transition. `begin`
accepts a `DETECTED` Document, or a `FAILED` one whose latest `RESOLVE` job failed
(detection failures retain the model and retry detection instead). Completing the
job, inserting auto-created Entities with their primary alias and `ENTITY_CREATED`
event, upserting ProtectedValues by `(matter_id, value_type, fingerprint)`, backfilling
Mention fingerprints and assignments, inserting candidates with evidence and
ResolutionEvents, and setting the Document to `READY` happen in one transaction. A
`READY` Document's resolution is idempotent and reused on repeat calls.

Completion events are bound to the actual mutations: the stored Mention assignment
dictates the required event (`null -> E` needs exactly one SYSTEM
`MENTION_ASSIGNED`, `E1 -> E2` needs exactly one SYSTEM `MENTION_REASSIGNED`,
`E1 -> E1` forbids an event, and clearing an assignment is rejected outright).
Constraints are likewise bound: both Entities must exist, be active, and belong to
the constraint Matter, and the audit event must reference the canonical pair.

The error payload uses authenticated context
`<job-id>:processingJob.error` and stores only a stable application error code.

ResolutionEvent payloads use authenticated context
`<event-id>:resolutionEvent.payload` and store only decision metadata (decision,
candidate entity id, algorithm version), never plaintext protected values.
ProtectedValue ciphertext uses `<protected-value-id>:protectedValue.value`.

## Encryption Envelope

Encrypted BLOB fields should use one versioned binary envelope instead of separate schema columns for nonce/tag/ciphertext.

Logical envelope:

```text
version | algorithm | nonce | ciphertext | authentication tag
```

V1 encryption target: AES-256-GCM.

## Important Consistency Rules

1. All entity/mapping lookups must include Matter scope.
2. A Mention assigned to an Entity must have matching `matter_id`.
3. An Entity merge must preserve the source Entity and source Public Token.
4. Alias uniqueness is Matter-local.
5. Protected value exact-match uniqueness is Matter-local and value-type-local.
6. ResolutionEvents are append-only at both the application and SQLite boundaries.
7. Raw plaintext sensitive fields must not be persisted in auxiliary debug tables.
8. Parser/OCR worker state belongs to ProcessingJob/Document Model, not Entity tables.

## Migration Policy

- Every schema change requires a Drizzle migration.
- Do not perform ad-hoc `ALTER TABLE` from business services.
- Migration changes that affect Domain invariants must update `docs/domain-model.md` and `AGENTS.md` when applicable.
