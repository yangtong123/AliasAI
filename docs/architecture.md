# AliasAI Architecture v1

## Product Goal

AliasAI protects sensitive local documents before they are sent to external AI systems while preserving semantic continuity.

Instead of only redacting data, AliasAI creates stable Matter-scoped pseudonyms and public tokens, for example:

- `张伟` -> `原告甲〔@N-8K3F7A2B〕` (the value-level restoration token)
- `深圳星河科技有限公司` -> `A公司〔@G-Q92KD8F1〕`

AI operates on the pseudonymized representation. Returned AI content is rehydrated locally using the value-level restoration token and Mapping Vault; the Entity token (`@P-...`/`@O-...`) is only an identity anchor.

## V1 Runtime Architecture

```text
Electron Desktop
|
|-- Renderer (React + TypeScript)
|   |-- document review UI
|   |-- entity review UI
|   `-- no direct Node/database/filesystem access
|
|-- Preload
|   `-- narrow contextBridge APIs
|
`-- Main Process (Node.js + TypeScript)
    |-- application services
    |-- matter/document/entity services
    |-- SQLite/Drizzle
    |-- field encryption
    |-- entity resolution
    |-- pseudonymization
    |-- rehydration
    |-- AI provider integration
    `-- Python worker orchestration
             |
             `-- Python Document/ML Engine
                 |-- document parsing
                 |-- PaddleOCR
                 |-- OpenCV
                 `-- NER
```

V1 intentionally keeps privacy core and AI network access inside the same Electron main process to reduce implementation complexity. Module boundaries must still prevent AI provider code from depending on Mapping Vault internals.

## Review UI V1 (Step 9)

The desktop review workflow is the first operable local loop: create a Matter,
import a PDF, run parse → detect → resolve, review mentions, and generate the
sanitized preview with a local rehydration demo (no AI provider yet).

Layering and boundary rules:

- **Application read model** (`packages/application/src/review-read.ts`,
  `review-operations.ts`, `sanitized-preview.ts`): DTOs carry decrypted display
  text (matter/document names, block text, mention text) by design, but never
  ciphers, keys, or file paths. Decision status is derived at read time from the
  latest assignment event's actor (AUTO_LINKED vs USER_ASSIGNED) plus candidate
  state (NEEDS_REVIEW/UNRESOLVED). Preview blockers mirror the sanitization
  fail-closed predicates exactly. Confirming an assignment writes a USER
  ENTITY_CONFIRMED event and marks the Mention CONFIRMED; reassignment resets
  the Mention to UNREVIEWED so a later confirmation always binds to the
  current Entity, and confirming the same assignment twice records exactly
  one event. Creating an Entity from a Mention commits the Entity, its
  creation event, and the assignment in one transaction.
- **IPC** (`apps/desktop/main/src/ipc/`): a pure handler registry (no Electron
  imports) validates every payload with field-level errors and funnels all
  failures through a single sanitizing envelope — known service errors surface
  their code and static message; everything else collapses to INTERNAL_ERROR,
  so paths, stacks, and plaintext inside raw errors never cross the boundary.
- **Preload**: exactly one bridge function (`invoke(channel, payload)`) gated
  by a channel allowlist that a drift test keeps in sync with the registered
  handlers. Preload keeps zero workspace imports.
- **Renderer**: type-only imports from `@aliasai/application` (erased at
  build); polls document status while a pipeline stage is in flight; review
  mutations are disabled once a document is SANITIZED because the artifact is
  one-shot — and the repository enforces the same rule inside the mutation
  transaction (assign/reassign/confirm/create-and-assign all reject mentions
  whose Document is SANITIZING or SANITIZED), so a direct IPC call cannot
  desynchronize the review state from the persisted artifact.

Key bootstrap: main generates the persistence and search keys on first run and
persists them via Electron `safeStorage` (OS keychain) in `userData`. The
window and IPC handlers are created only after the keys and database are ready.
When `safeStorage` is unavailable the app fails closed; `ALIASAI_ALLOW_PLAINTEXT_KEYS=1`
is a documented development fallback.

Known V1 limitations (deliberate):

- The Python worker resolves from `ALIASAI_PYTHON_COMMAND` /
  `ALIASAI_NATIVE_WORKER_PATH` or the repository `.venv`; packaged-app
  (`asar`) resolution needs `extraResources` and is not implemented.
- The OCR worker (`python/ocr/ocr_worker.py`) is opt-in via
  `ALIASAI_OCR_WORKER_PATH` and requires the optional `ocr` Python extras
  (PaddleOCR, pypdfium2, OpenCV, numpy). Without it, a document containing
  raster pages fails closed with `UNSUPPORTED_DOCUMENT` instead of being
  marked PARSED with unparsed content.
- MIXED pages emit only their native text layer; image regions on mixed pages
  are not OCRed in V1.
- Job progress is polled by the renderer; push events are a V2 concern.

## Data Layers

AliasAI separates data into four logical layers.

### Layer 1: Raw Document

Original user file. Never overwrite it.

### Layer 2: Document Model

Normalized representation produced from native parsing or OCR:

- Document
- Page
- Block
- normalized bounding boxes
- reading order
- source/confidence metadata

### Layer 3: Identity Model

Privacy/identity interpretation:

- Mention
- Entity
- ProtectedValue
- Alias
- EntityRelationship
- ResolutionCandidate
- ResolutionEvidence
- ResolutionEvent

### Layer 4: Sanitized Representation

Content safe enough to send to an AI provider according to the selected policy.

## Processing Pipeline

```text
Import Document
    |
    v
Document Router
    |-- reliable native text -> native parser
    `-- raster/scanned content -> OCR
    |
    v
Document Pages + Blocks
    |
    v
Privacy Detection
    |
    v
Mention Proposals
    |
    v
Entity Resolution
    |-- auto-link
    |-- human review
    `-- new entity
    |
    v
Entity + ProtectedValue + Alias + Public Token
    |
    v
Pseudonymization
    |
    v
Sanitized Document/Text
    |
    v
AI Provider
    |
    v
Sanitized AI Result
    |
    v
Rehydration
    |
    v
Local Real-Identity Result
```

Privacy Detection is an application-owned orchestration boundary. A replaceable
detector receives one transient decrypted Block and returns location/type proposals
scoped to that exact Matter, Document, Page, and Block. V1 uses deterministic regex
rules for high-precision structured identifiers. The detector cannot persist and
does not create Entities; the application validates offsets, encrypts Mention text,
and commits the complete Mention batch with its DETECT ProcessingJob transaction.

The current native-PDF path is therefore:

```text
Native PDF Worker -> encrypted Document Blocks -> PrivacyDetector
                  -> encrypted unassigned Mentions -> SQLite
```

The OCR worker satisfies the same parser port for scanned documents
(`ALIASAI_OCR_WORKER_PATH`); NER can implement the detector port later without
changing the persistence workflow.

The sanitization path continues:

```text
READY Document -> PseudonymizationService (fail-closed per Block)
              -> encrypted Sanitized Blocks + Mapping Vault -> SQLite
Mapping Vault  -> RehydrationService (Public Token anchored, policy-filtered)
              -> local real-identity text
```

Pseudonymization is fail-closed: any Mention without a resolved Entity and a
restoration token aborts the SANITIZE job, so no sendable artifact can be produced
from partially resolved input. The Mapping Vault stores only pseudonym metadata
(restoration token, alias, effective restore policy); real values stay encrypted
and are resolved lazily during local rehydration.

## Key Architectural Decisions

### Matter is the privacy boundary

All Entities and mappings are scoped to one Matter. The same real person in two Matters receives unrelated Entity IDs, Public Tokens, aliases, and fingerprints.

### Mention and Entity are separate

A Mention means a sensitive occurrence in a document. An Entity means a real-world subject. Multiple Mentions may resolve to one Entity.

### Public Token, restoration token, and Alias are separate

- Entity Public Token: stable Matter-scoped, immutable Entity identity.
- Restoration token: value-level Matter-scoped, immutable. Each ProtectedValue of
  an Entity (name, ID card, email, bank account) carries its own token, so one
  Entity restores several distinct values under distinct policies. Rehydration
  anchors on this value-level token, not the Entity Public Token.
- Alias: human-readable label for AI reasoning, mutable.

Example:

```text
Entity ID: 019c...
Entity Public Token: @P-8K3F7A
Primary Alias: 原告甲
Name restoration token: @N-…
ID-card restoration token: @I-…
```

### Parser/OCR is infrastructure

OCR/parser produces a Document Model only. It has no authority to create or merge Entities.

`DocumentProcessingService` depends on a Protocol v1 `DocumentProcessor` port rather
than a concrete native parser or OCR library. The default adapter launches the native
PDF worker; the OCR worker (`python/ocr/ocr_worker.py`, selected via
`ALIASAI_OCR_WORKER_PATH`) satisfies the same port without changing application
or persistence logic.

Worker `page_result` plaintext is encrypted by the application as soon as it crosses
the protocol boundary. The application retains encrypted persistence inputs until a
valid full-document `completed` event arrives, then atomically inserts all Pages and
Blocks and changes the Document from `PARSING` to `PARSED`. Worker, validation, or
database failures leave no partial Document Model and transition the Document to
`FAILED`.

Before dispatch and again before commit, the application verifies that the source file
still matches the SHA-256 fingerprint captured at import. A changed source is never
persisted under the original Document identity.

### Resolution is proposal-driven

Entity Resolution produces explainable proposals. Application services own mutations and event recording.

### Merge is redirect-based

Merged Entity records remain addressable so historic Public Tokens and historic AI output continue to resolve.

## Coordinate System

Persist page-relative normalized coordinates:

```text
x, y, width, height in [0, 1]
```

Adapters convert to/from:

- PDF points
- OCR raster pixels
- renderer pixels
- export/redaction coordinates

Do not persist multiple competing coordinate systems as authoritative values.

## V1 Non-Goals

Do not introduce these before the core loop is validated:

- vector database
- graph database
- cloud synchronization
- multi-user collaboration
- enterprise IAM/RBAC
- distributed services
- cross-Matter global identity
- custom OCR training
- Transformer-based Entity Resolution
- complex VLM-first OCR
- mandatory Rust security core

## Validation Target

The first meaningful product milestone is a stable loop:

```text
PDF
-> Block
-> Mention
-> Entity
-> 原告甲〔@N-F4A21C9E〕
-> AI
-> @N-F4A21C9E
-> 张伟
```

with correct handling of:

1. repeated Mentions of the same person,
2. two different people with the same name,
3. Entity merge with historic token preservation,
4. incorrect merge followed by split/reassignment.
