# Workspace Trash and Document Replacement Development Plan

Status: Milestones 1 and 2 implemented (2026-08-26)
Last updated: 2026-08-26

## Goal

Add recoverable deletion for Matters and Documents so users can remove incorrect
or obsolete workspace data without breaking audit history, pseudonymization
tokens, or local rehydration. A deleted Document must no longer prevent the same
source file from being imported again.

The work is split into two milestones:

1. Recoverable trash, restore, and same-file re-import.
2. One-step Document replacement with explicit version lineage.

Milestone 1 resolves the current dirty-data problem. Milestone 2 improves the
replacement workflow after the lifecycle foundation is stable.

## Current behavior and root cause

The Domain already defines the Matter statuses `ACTIVE`, `ARCHIVED`, and
`DELETED`, but no application service or repository operation changes a Matter
to or from `DELETED`. Documents have no lifecycle state at all.

Document import is deduplicated by content rather than file name:

- `documents` has a unique index on `(matter_id, file_hash)`.
- `DocumentImportService.importFromPath()` returns the existing Document when it
  finds the same hash in the Matter.
- Matter and Document list queries do not filter deleted data because Document
  deletion does not exist and Matter deletion is not implemented.

Consequences:

- A bad import cannot be removed from the normal workspace.
- The same source file cannot be imported as a fresh Document.
- Users cannot restore an accidentally removed item because there is no trash.
- Physical deletion would conflict with append-only audit and sanitization data.

## Product semantics

```text
Normal workspace
  |-- trash Document ------> Document trash -- restore --> Normal workspace
  |                              `-- import same file --> New active Document
  |
  `-- trash Matter --------> Matter trash --- restore --> Original Matter and Documents
```

The following rules are part of Milestone 1:

1. "Delete" in the user interface means move to trash, not physical deletion.
2. Trashing a Matter hides the Matter and all of its contents from the normal
   workspace without changing each child row.
3. Restoring a Matter makes its existing contents visible again.
4. A Document trashed before its Matter was trashed remains trashed after the
   Matter is restored.
5. File names are display metadata and never participate in uniqueness checks.
6. A same-name file with different contents can be imported normally.
7. An active Document with the same file hash is reused, preserving current
   idempotent import behavior.
8. A matching Document that exists only in trash does not block import. Import
   creates a new active Document with a new ID.
9. Restoring a trashed Document fails with an actionable conflict if another
   active Document in the Matter already has the same file hash.
10. A Matter or Document with running work cannot be trashed. The operation
    fails with a coded, recoverable error.
11. Trash and restore operations are idempotent and do not create duplicate
    audit events for no-op requests.
12. Trash does not alter Entity IDs, Public Tokens, ProtectedValues,
    sanitization mappings, sanitized artifacts, or AI execution history.

## Non-goals for Milestone 1

Milestone 1 does not include:

- Permanent physical deletion.
- Automatic trash retention or scheduled cleanup.
- Matter-level cryptographic key destruction.
- Copying Entity assignments from an old Document to a replacement.
- A version graph or `DOCUMENT_REPLACED` event.
- Cloud synchronization or multi-user deletion semantics.

Permanent deletion is a separate security project. The current database uses
append-only audit, sanitized artifact, mapping, and AI execution records. Purging
them safely requires a retention policy and preferably Matter-scoped data keys so
the application can perform deliberate cryptographic erasure without weakening
other Matters.

## Milestone 1 architecture

### State model

Matter lifecycle uses the existing `Matter.status`:

```text
ACTIVE   -- trash --> DELETED -- restore --> ACTIVE
ARCHIVED -- trash --> DELETED -- restore --> ACTIVE
```

Restoring to `ACTIVE` is intentional for V1. Archive restoration semantics can
be added later when Matter archiving has a user-facing workflow.

Document lifecycle uses a nullable deletion timestamp rather than overloading
the parsing state machine:

```text
deletedAt = undefined -- trash --> deletedAt = timestamp
deletedAt = timestamp -- restore --> deletedAt = undefined
```

`DocumentParseStatus` continues to describe parsing, detection, resolution, and
sanitization only. This keeps lifecycle state independent from processing state.

### Data flow

```text
Renderer action
    |
    v
Narrow IPC channel
    |
    v
WorkspaceLifecycleService
    |
    v
WorkspaceLifecycleRepository transaction
    |-- validate current state and Matter scope
    |-- reject running ProcessingJob or AiExecution
    |-- update Matter.status or Document.deletedAt
    `-- append WorkspaceEvent
```

Normal read paths must exclude trashed records. Dedicated trash read paths return
only trashed records. Historical rows remain available to local rehydration and
audit code through internal ID-based repository methods.

## Domain changes

Update `packages/domain/src/types.ts`:

```ts
interface Document {
  // Existing fields omitted.
  readonly deletedAt?: number
}

type WorkspaceEventType =
  | 'MATTER_TRASHED'
  | 'MATTER_RESTORED'
  | 'DOCUMENT_TRASHED'
  | 'DOCUMENT_RESTORED'

interface WorkspaceEvent {
  readonly id: string
  readonly matterId: string
  readonly documentId?: string
  readonly type: WorkspaceEventType
  readonly actor: 'USER'
  readonly createdAt: number
}
```

Add invariants:

- `deletedAt`, when present, is a non-negative safe integer.
- `deletedAt` cannot precede `Document.createdAt`.
- Matter events do not contain `documentId`.
- Document events contain `documentId`.
- Workspace lifecycle events are always user-authored in V1.

Do not add workspace lifecycle events to `ResolutionEventType`. Resolution events
explain identity decisions; workspace events explain container lifecycle changes.

## Database migration

Create Drizzle migration `0006` and its snapshot metadata.

### Documents

Add:

```sql
deleted_at INTEGER NULL
```

Add a check that `deleted_at` is null or greater than or equal to `created_at`.

Replace the current unique index:

```sql
DROP INDEX uq_documents_matter_file_hash;

CREATE UNIQUE INDEX uq_documents_active_matter_file_hash
ON documents (matter_id, file_hash)
WHERE deleted_at IS NULL;
```

Add a listing index:

```sql
CREATE INDEX idx_documents_matter_deleted
ON documents (matter_id, deleted_at);
```

Every existing Document upgrades with `deleted_at = NULL`.

### Workspace events

Add an append-only `workspace_events` table:

| Column | Type | Constraints |
|---|---|---|
| id | TEXT | primary key |
| matter_id | TEXT | Matter foreign key, not null |
| document_id | TEXT | Document foreign key, nullable |
| event_type | TEXT | allowed workspace event type, not null |
| actor | TEXT | `USER`, not null |
| created_at | INTEGER | not null |

Add checks that event type and `document_id` agree. Add indexes on
`(matter_id, created_at)` and `(document_id, created_at)`. Add triggers rejecting
all updates and deletes, matching the existing append-only audit pattern.

Update `docs/database-schema.md` after the migration is implemented.

## Persistence layer

Add `WorkspaceLifecycleRepository` with atomic operations:

```ts
trashMatter(matterId, event): { changed: boolean }
restoreMatter(matterId, event): { changed: boolean }
trashDocument(documentId, event): { changed: boolean }
restoreDocument(documentId, event): { changed: boolean }
listTrash(): WorkspaceTrashSource
```

Each mutation runs in one SQLite transaction.

### Trashing a Matter

1. Load the Matter.
2. Return `changed: false` if it is already `DELETED`.
3. Reject the operation if any child Document has a `PENDING` or `RUNNING`
   `ProcessingJob` or a `RUNNING` `AiExecution`.
4. Update Matter status to `DELETED` and set `updatedAt`.
5. Insert `MATTER_TRASHED`.
6. Do not update child Documents, Entities, Mentions, or mappings.

### Restoring a Matter

1. Load the Matter.
2. Return `changed: false` unless it is `DELETED`.
3. Set status to `ACTIVE` and update `updatedAt`.
4. Insert `MATTER_RESTORED`.

### Trashing a Document

1. Load the Document and its parent Matter.
2. Reject missing or cross-scope data.
3. Return `changed: false` if `deletedAt` is already set.
4. Reject the operation when the Document has running work.
5. Set `deletedAt` and `updatedAt` to the operation timestamp.
6. Insert `DOCUMENT_TRASHED`.

### Restoring a Document

1. Load the Document and parent Matter.
2. Return `changed: false` if the Document is already active.
3. Reject restore while the parent Matter is `DELETED`.
4. Check for an active `(matterId, fileHash)` conflict before updating.
5. Clear `deletedAt` and update `updatedAt`.
6. Insert `DOCUMENT_RESTORED`.
7. Convert a concurrent partial-index collision into `RESTORE_CONFLICT` and roll
   back the event and state change.

### Query changes

Change existing normal read methods to return only available data:

- `ReviewQueryRepository.listMatters()` excludes `DELETED` Matters.
- `ReviewQueryRepository.listDocumentsByMatter()` returns no data for a deleted
  Matter and excludes Documents with `deletedAt`.
- `DocumentRepository.findByMatterAndFileHash()` searches active Documents only.
- User-facing `get`, processing, detection, resolution, sanitization, preview,
  and AI start paths reject trashed Documents and deleted Matters.

Keep explicitly named internal historical read methods for rehydration and audit.
Do not make one ambiguous `findById()` sometimes filter and sometimes retain
deleted data.

## Application layer

Add `WorkspaceLifecycleService` to generate IDs and timestamps, validate event
scope, map repository failures to coded application errors, and expose trash DTOs.

Recommended error codes:

| Code | User action |
|---|---|
| `MATTER_NOT_AVAILABLE` | Select or restore an available Matter |
| `DOCUMENT_NOT_AVAILABLE` | Select or restore an available Document |
| `DOCUMENT_BUSY` | Wait for processing or AI execution to finish |
| `RESTORE_CONFLICT` | Keep the active copy, or trash it before restoring the old copy |
| `TRASH_OPERATION_FAILED` | Retry; no partial lifecycle state was committed |

Update `DocumentImportService.importFromPath()`:

```text
inspect source
  |-- active same hash exists --> return existing Document
  |-- only trashed match exists --> create new active Document and new ID
  `-- no match exists ----------> create new active Document and new ID
```

Import into a `DELETED` Matter fails with `MATTER_NOT_AVAILABLE`.

Register the lifecycle service in `apps/desktop/main/src/runtime.ts`.

## IPC changes

Add these channels to the main contract and preload allowlist:

```text
trash:list
matter:trash
matter:restore
document:trash
document:restore
```

Requests contain only validated IDs. Mutation responses return
`{ changed: boolean }`. `trash:list` returns decrypted display names but no
ciphers, source paths, fingerprints, mappings, or keys.

Update:

- `apps/desktop/main/src/ipc/contract.ts`
- `apps/desktop/main/src/ipc/handlers.ts`
- `apps/desktop/main/src/ipc/validate.ts` where needed
- `apps/desktop/preload/src/channels.ts`
- IPC contract and channel-drift tests

## Renderer changes

Add a `TrashView` reachable from the application header.

### Matter and Document lists

- Add a per-item trash button with an unambiguous accessible label.
- Keep item selection and trash actions as separate controls.
- Require confirmation before trashing.
- Matter confirmation text states that all Matter contents will disappear from
  the normal workspace and remain recoverable.
- Document confirmation text states that the Document remains recoverable.
- Disable conflicting actions while a lifecycle mutation is pending.

### Trash view

Display:

- Deleted Matters with name and deletion time.
- Individually deleted Documents grouped under their non-deleted Matter.
- A restore action for every item.
- Empty-state and recoverable error messages.

Do not list every child Document of a deleted Matter separately. Restoring the
Matter restores visibility of its child tree and avoids duplicate entries.

### Selection cleanup

When the selected Matter or Document is trashed:

- Clear the selected Matter, Document, Mention, review, and preview state as
  appropriate.
- Remove stale `aliasai.lastMatterId` and `aliasai.lastDocumentId` values.
- Refresh normal and trash lists.
- Do not render one frame of stale Document content after the mutation succeeds.

Add Simplified Chinese and English labels, confirmation text, empty states, and
error messages.

## Milestone 1 test plan

### Domain tests

- Accept a Document without `deletedAt`.
- Accept a valid `deletedAt`.
- Reject negative, unsafe, or pre-creation deletion timestamps.
- Reject workspace events with an invalid target shape.

### Migration and schema tests

- Upgrade the existing schema with all Documents active.
- Preserve Document names, encrypted paths, parse state, and file hashes.
- Permit a new active Document with the same hash as a trashed Document.
- Reject two active Documents with the same Matter and hash.
- Reject update and delete operations against `workspace_events`.

### Repository tests

- Trash and restore a Document atomically with one event per real transition.
- Repeated trash and restore calls are no-ops without duplicate events.
- Restore conflict rolls back state and event creation.
- Trash and restore a Matter without rewriting child rows.
- An individually trashed Document remains trashed after Matter restore.
- Running processing work blocks Document and Matter trash.
- Running AI work blocks Document and Matter trash.
- Cross-Matter and missing-ID mutations fail closed.

### Application tests

- Importing the same active file still reuses the existing Document.
- Importing the same file after trash creates a new ID.
- A same-name file with different content imports successfully.
- Import into a deleted Matter fails.
- Normal lists exclude trash and trash lists contain it.
- Rehydration still works after trash and after restore.

### IPC tests

- Every new channel validates its payload.
- Main and preload allowlists remain identical.
- Application error codes survive the IPC error envelope.
- Trash DTOs contain plaintext display names only where the existing renderer
  read boundary already permits them.

### Renderer tests

- Trash confirmation, cancellation, success, and failure.
- Restore success, busy state, and conflict message.
- Empty trash state.
- Trashing the selected item clears selection and local storage.
- Rapid repeated clicks do not create duplicate requests.
- Simplified Chinese and English labels render through the i18n API.

### End-to-end acceptance flow

```text
create Matter
  -> import PDF
  -> parse, detect, resolve, and sanitize
  -> trash Document
  -> verify it disappears from the workspace
  -> import the identical PDF
  -> verify a new Document ID is created
  -> verify the old Document remains in trash
  -> trash the new Document
  -> restore the old Document
  -> verify its original sanitized artifact can still rehydrate locally
```

Add a second end-to-end flow for Matter trash and restore, including a Document
that was individually trashed before the Matter operation.

## Milestone 1 acceptance criteria

Milestone 1 is complete only when all of the following are true:

- [ ] Users can trash a Document from the normal workspace.
- [ ] Users can trash a Matter from the normal workspace.
- [ ] Trashed items disappear immediately from normal lists.
- [ ] Users can inspect and restore items from a trash view.
- [ ] Restoring a Matter reveals its previous child data unchanged.
- [ ] The identical PDF can be imported after its previous Document is trashed.
- [ ] The new import receives a new Document ID.
- [ ] Same-name files are never rejected solely because of their name.
- [ ] Active duplicate imports remain idempotent.
- [ ] Restore conflicts produce an actionable message and no partial writes.
- [ ] Running work prevents trash without corrupting jobs or Documents.
- [ ] Every real trash and restore transition creates one append-only event.
- [ ] Existing pseudonymization and rehydration behavior remains intact.
- [ ] Migration upgrade tests pass from the current schema.
- [ ] Typecheck, lint, TypeScript tests, Python tests, and production build pass.

## Milestone 2: one-step Document replacement

Implement Milestone 2 only after Milestone 1 has shipped and its lifecycle rules
are stable.

### Behavior

Add a "Replace Document" action that lets a user pick a PDF and atomically:

1. Trash the current active Document.
2. Create the replacement as a new active Document.
3. Record that the new Document supersedes the old Document.
4. Append a `DOCUMENT_REPLACED` workspace event linking both IDs.

File inspection and hashing occur before the database transaction. The old
Document is not trashed if inspection, validation, or creation fails.

### Data model

Add a nullable self-reference such as `documents.supersedes_document_id`, or a
small Document-version relation if later requirements need branching histories.
Prefer the self-reference for V1 because replacement is linear and single-user.

### Safety rules

- A replacement never reuses the old Document ID.
- A replacement never copies Mentions, Entity assignments, processing jobs,
  sanitized artifacts, or AI executions.
- Existing Entity data remains Matter-scoped and can be proposed again through
  normal resolution.
- Replacement is blocked while the old Document has running work.
- A failed replacement leaves the old Document active.

### Milestone 2 acceptance criteria

- [x] Users can replace an active Document in one interaction.
- [x] The old Document appears in trash.
- [x] The new Document is active and has a new ID.
- [x] Version lineage is queryable and audited.
- [x] Replacement failure leaves the old Document unchanged.
- [x] No old Mention offsets or sanitized artifacts are attached to the new file.

## Delivery sequence

Implement as small commits in this order:

1. `docs: define workspace trash lifecycle semantics`
2. `feat(database): add recoverable document lifecycle`
3. `feat(application): add workspace trash operations`
4. `feat(ipc): expose trash and restore actions`
5. `feat(renderer): add trash actions and trash view`
6. `test: cover trash restore and same-file reimport`
7. `docs: update lifecycle architecture and acceptance guide`

After every implementation step, run the relevant focused tests. Before merging
Milestone 1, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
.venv/bin/python -m pytest
pnpm build
```

## Documentation updates during implementation

Update these documents in the same change that implements the behavior:

- `docs/domain-model.md`: Matter and Document lifecycle semantics.
- `docs/database-schema.md`: `deleted_at`, partial unique index, and workspace
  event table.
- `docs/architecture.md`: read filtering, lifecycle transaction boundary, and
  historical rehydration access.
- `docs/rc1-acceptance.md`: trash, restore, and same-file re-import workflow.

Do not describe permanent deletion as supported until its key and retention
design has been implemented and tested.
