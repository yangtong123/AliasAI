# AliasAI Architecture v1

## Product Goal

AliasAI protects sensitive local documents before they are sent to external AI systems while preserving semantic continuity.

Instead of only redacting data, AliasAI creates stable Matter-scoped pseudonyms and public tokens, for example:

- `张伟` -> `原告甲〔@P-8K3F7A〕`
- `深圳星河科技有限公司` -> `A公司〔@O-Q92KD8〕`

AI operates on the pseudonymized representation. Returned AI content is rehydrated locally using the stable Public Token and Mapping Vault.

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

OCR and NER can implement the existing parser/detector ports later without changing
the persistence workflow.

## Key Architectural Decisions

### Matter is the privacy boundary

All Entities and mappings are scoped to one Matter. The same real person in two Matters receives unrelated Entity IDs, Public Tokens, aliases, and fingerprints.

### Mention and Entity are separate

A Mention means a sensitive occurrence in a document. An Entity means a real-world subject. Multiple Mentions may resolve to one Entity.

### Public Token and Alias are separate

- Public Token: stable restoration identity, immutable, machine-oriented.
- Alias: human-readable label for AI reasoning, mutable.

Example:

```text
Entity ID: 019c...
Public Token: @P-8K3F7A
Primary Alias: 原告甲
```

### Parser/OCR is infrastructure

OCR/parser produces a Document Model only. It has no authority to create or merge Entities.

`DocumentProcessingService` depends on a Protocol v1 `DocumentProcessor` port rather
than a concrete native parser or OCR library. The first adapter launches the native PDF
worker; a future OCR adapter can satisfy the same port without changing application
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
-> 原告甲〔@P001〕
-> AI
-> @P001
-> 张伟
```

with correct handling of:

1. repeated Mentions of the same person,
2. two different people with the same name,
3. Entity merge with historic token preservation,
4. incorrect merge followed by split/reassignment.
