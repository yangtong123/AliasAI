# AliasAI

Local-first, privacy-preserving AI workspace. This repository contains the tested V1 foundation: a sandboxed Electron/React desktop shell, pure domain contracts, encrypted SQLite persistence, local document inspection, an engine-independent native PDF processing service, and an encrypted Privacy Detection application workflow.

## Development

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm test:python
pnpm build
```

Install the Python parser and test dependencies with `python3 -m pip install -e '.[dev]'`. Native PDF text parsing is implemented locally with the MIT-licensed `pdfminer.six`. OCR, NER, pseudonymization policy, and AI provider integrations remain intentionally out of scope.

## Package boundaries

- `apps/desktop`: sandboxed Electron main process, narrow preload bridge, and React renderer shell.
- `packages/domain`: pure TypeScript domain types and invariant guards; no persistence or plaintext protected values.
- `packages/database`: SQLite/Drizzle schema, migration, integrity guards, and initial repositories.
- `packages/crypto`: versioned AES-256-GCM envelopes and Matter-scoped HMAC fingerprints; key storage is deferred to the desktop application layer.
- `packages/document`: non-destructive local source inspection and SHA-256 file fingerprints.
- `packages/privacy-detection`: pluggable, plaintext-free location proposals with deterministic high-precision V1 rules.
- `packages/entity-resolution`: type-specific value normalization, deterministic `er-v1` evidence scoring, and an explainable rule-first proposal gate; it never applies identity mutations.
- `packages/pseudonymization`: offset-based sanitized text formatting without raw global replacement, plus type-level default restore policies.
- `packages/rehydration`: Public Token-anchored local restoration.
- `packages/ai`: reserved sanitized provider boundary; no provider integration exists yet.
- `packages/python-bridge`: validated JSON Lines Protocol v1 client with mock and native-PDF worker contract tests.
- `packages/application`: encrypted Matter/document workflows, engine-independent Document processing, transactional Privacy Detection, Entity Resolution with ProtectedValue fingerprints, fail-closed Pseudonymization with an encrypted Mapping Vault, and policy-filtered local Rehydration.
- `python/document_parser`: native PDF text extraction plus a protocol mock; parser output contains pages and normalized text blocks only.
- `python/ocr`, `python/ner`, `python/image_processing`: replaceable package boundaries; no OCR or ML implementation exists yet.

No sensitive document, key, database, or generated runtime data should be committed.

`PrivacyDetectionService` decrypts one persisted Block at a time, runs the replaceable
V1 detector, encrypts Mention text, and atomically persists unassigned Mentions with
the DETECT ProcessingJob and Document state. Successful calls are idempotent;
failures retain no partial Mentions and can be retried. End-to-end tests exercise a
real synthetic PDF through the native Python Worker into encrypted Blocks and
encrypted Mentions. NER, OCR, and AI remain outside this implementation.

`EntityResolutionService` continues the chain: it decrypts each Mention transiently,
normalizes and fingerprints its value with a Matter-derived HMAC search key, creates
or reuses the encrypted ProtectedValue, scores candidates with the deterministic
`er-v1` evidence rules, and atomically commits assignments, candidates, evidence, and
append-only ResolutionEvents with the RESOLVE ProcessingJob. Hard Cannot-Link rules
override all scoring, PERSON Mentions never auto-link on soft score alone, and
low-confidence cases persist pending candidates for review instead of guessing.
