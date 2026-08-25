# AliasAI Agent Instructions

## Project

AliasAI is a local-first privacy-preserving AI workspace.

The first use case is legal documents. The domain model must remain industry-neutral so the same identity/privacy layer can later support finance, healthcare, consulting, and enterprise workflows.

Core flow:

Document -> Block -> Mention -> Entity Resolution -> Entity -> Pseudonymization -> AI -> Rehydration

## V1 Tech Stack

- Desktop: Electron
- Frontend: React + TypeScript
- Core application logic: Node.js + TypeScript
- OCR / NER / document ML: Python
- Database: SQLite
- ORM / migrations: Drizzle
- OCR: PaddleOCR
- Image processing: OpenCV
- Tests: Vitest for TypeScript, pytest for Python

## Package Boundaries

The repository is expected to evolve toward this structure:

- `apps/desktop/main`: Electron main process
- `apps/desktop/preload`: narrow IPC bridge
- `apps/desktop/renderer`: React UI
- `packages/domain`: pure TypeScript domain types and invariants
- `packages/database`: SQLite/Drizzle persistence
- `packages/crypto`: encryption, fingerprints, key handling
- `packages/document`: document import and normalized document model
- `packages/privacy-detection`: Block -> Mention proposals
- `packages/entity-resolution`: Mention -> ResolutionProposal
- `packages/pseudonymization`: real-world mention -> sanitized representation
- `packages/rehydration`: sanitized AI result -> restored local result
- `packages/ai`: AI provider calls using sanitized content only
- `packages/python-bridge`: local process protocol for Python workers
- `packages/application`: use cases and transaction orchestration
- `python/document_parser`: PDF/image/document parsing
- `python/ocr`: OCR adapters
- `python/ner`: entity detection models
- `python/image_processing`: image preprocessing

## Domain Invariants

These rules are V1 architecture constraints. Do not silently violate or redefine them.

1. Every Entity belongs to exactly one Matter.
2. Entities are never shared across Matters.
3. A Document belongs to one Matter.
4. Document parsing/OCR produces Blocks, never Entities.
5. Privacy detection produces Mentions, never Entities.
6. A Mention may exist without an Entity assignment.
7. A Mention may point to at most one canonical Entity at a time.
8. Entity Resolution produces proposals; application services apply decisions.
9. Public Tokens are immutable after creation.
10. Aliases may change; Public Tokens may not.
11. Entity merge never physically deletes the merged Entity.
12. Merged Entities preserve a redirect to their canonical Entity.
13. Protected values must not be persisted as plaintext.
14. Rehydration prefers value-level restoration tokens over aliases.
15. Merge, split, assign, reassign, confirm, and constraint changes create ResolutionEvents.
16. OCR/parser code must not write directly to application database tables.

## Entity Resolution Principles

- Precision over recall.
- Prefer false splits over false merges.
- Exact name equality alone must never auto-link PERSON entities.
- Hard Cannot-Link rules override all soft scores and model output.
- Hard Must-Link rules are evaluated before soft scoring.
- Auto-link decisions consider both top candidate score and margin over the second-best candidate.
- Weak/reference mentions should not create new canonical entities without sufficient evidence.
- Low-confidence or ambiguous cases produce review proposals instead of guessing.
- Resolution decisions must be explainable through stored evidence.

## OCR Principles

- Native text extraction takes priority over OCR when a reliable text layer exists.
- OCR output must preserve page and bounding-box coordinates.
- Persist page-relative normalized coordinates in the range `[0, 1]`.
- OCR is optimized for sensitive-region recall, not character accuracy alone.
- Original source files are never overwritten.
- OCR results should be cached by document fingerprint so entity review does not rerun OCR unnecessarily.
- Python workers return protocol-defined document models and do not own application persistence.

## Pseudonymization Principles

- Internal Entity ID, Entity Public Token, value-level restoration token, and human-readable Alias are separate concepts.
- Entity Public Tokens and ProtectedValue restoration tokens are Matter-scoped and randomly generated; do not derive either from real identity values.
- Example sanitized form: `原告甲〔@N-8K3F7A2B〕`.
- Alias exists for readability; the ProtectedValue restoration token is the stable rehydration anchor, while the Entity Public Token is an identity anchor.
- Sanitization works from Mention -> Entity -> replacement policy, not raw string replacement.
- Different protected-value types may have different restore policies.

## Security Rules for V1

- Never commit real client documents, client identifiers, production keys, or real legal matter data.
- Tests and fixtures must use synthetic identities.
- Never log decrypted ProtectedValue contents.
- Never expose encryption keys through renderer IPC.
- AI provider API keys are stored only in the main process, encrypted with Electron `safeStorage` in `userData/aliasai.ai-provider.json` — never in SQLite, logs, or audit events. The stored key is never returned to the renderer (status exposes only configured/not-configured); a newly typed key crosses IPC only in the explicit save/test request.
- Electron renderer must not have direct access to filesystem, SQLite, child_process, or unrestricted Node.js APIs.
- Use Electron preload/contextBridge with narrow APIs.
- Schema changes require migrations.

V1 intentionally does not require separate OS processes for Mapping Vault and AI networking. Keep module interfaces separate so later process isolation remains possible.

## Development Rules

- Prefer small, reviewable changes.
- Read `AGENTS.md` and relevant files under `docs/` before implementing architecture-sensitive changes.
- Do not introduce a production dependency without explaining its purpose.
- Run typecheck, lint, and relevant tests after changes.
- Do not weaken tests merely to make new code pass.
- Do not silently change Domain invariants.
- Architectural changes require updating the relevant document under `docs/`.
- When requirements conflict with a documented invariant, stop implementation and report the conflict with options.

## Initial Development Sequence

1. Repository/workspace bootstrap only.
2. Pure TypeScript Domain Model.
3. SQLite/Drizzle schema and repositories.
4. TypeScript <-> Python OCR Protocol v1 with a mock worker.
5. Real document parsing/OCR adapter.
6. Privacy detection.
7. Entity Resolution V1.
8. Pseudonymization and rehydration.
9. Review UI.
10. AI integration and leak verification.

Do not skip directly to complex ML, vector databases, graph databases, multi-user/cloud architecture, or enterprise process isolation in V1 unless explicitly requested.
