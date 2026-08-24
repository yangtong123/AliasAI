# AliasAI

Local-first, privacy-preserving AI workspace. The V1 workflow runs locally from PDF parsing and privacy detection through entity review, immutable sanitization, privacy-checked Mock AI execution, encrypted response persistence, and local rehydration.

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

Install the Python parser and test dependencies with `python3 -m pip install -e '.[dev]'`. Native PDF text parsing is implemented locally with the MIT-licensed `pdfminer.six`. An OCR worker for scanned PDFs (PaddleOCR + pypdfium2 rendering + optional OpenCV preprocessing) is available via the optional `ocr` extra (`python3 -m pip install -e '.[ocr]'`) and the `ALIASAI_OCR_WORKER_PATH` desktop setting. NER and real network AI providers remain intentionally out of scope; V1 uses the replaceable local `MockAiProvider`.

## Package boundaries

- `apps/desktop`: sandboxed Electron main process, narrow preload bridge, and React renderer shell.
- `packages/domain`: pure TypeScript domain types and invariant guards; no persistence or plaintext protected values.
- `packages/database`: SQLite/Drizzle schema, migration, integrity guards, and initial repositories.
- `packages/crypto`: versioned AES-256-GCM envelopes and Matter-scoped HMAC fingerprints; OS keychain-protected key storage lives in the desktop main process (`safeStorage`).
- `packages/document`: non-destructive local source inspection and SHA-256 file fingerprints.
- `packages/privacy-detection`: pluggable, plaintext-free location proposals with deterministic high-precision V1 rules.
- `packages/entity-resolution`: type-specific value normalization, deterministic `er-v1` evidence scoring, and an explainable rule-first proposal gate; it never applies identity mutations.
- `packages/pseudonymization`: offset-based sanitized text formatting without raw global replacement, plus type-level default restore policies.
- `packages/rehydration`: Public Token-anchored local restoration.
- `packages/ai`: vendor-neutral provider port, local Mock provider, and fail-closed outbound privacy scanner.
- `packages/python-bridge`: validated JSON Lines Protocol v1 client with mock, native-PDF, and OCR worker contract tests.
- `packages/application`: encrypted Matter/document workflows, engine-independent Document processing, transactional Privacy Detection and Entity Resolution, fail-closed Pseudonymization, provider-independent AI execution, and policy-filtered local Rehydration.
- `python/document_parser`: native PDF text extraction plus a protocol mock; parser output contains pages and normalized text blocks only.
- `python/ocr`, `python/image_processing`: scanned-PDF path — pypdfium2 rendering, optional OpenCV preprocessing, PaddleOCR engine adapter, and a Protocol v1 OCR worker; heavy dependencies are lazily imported extras.
- `python/ner`: replaceable package boundary; no NER implementation exists yet.

No sensitive document, key, database, or generated runtime data should be committed.

`PrivacyDetectionService` decrypts one persisted Block at a time, runs the replaceable
V1 detector, encrypts Mention text, and atomically persists unassigned Mentions with
the DETECT ProcessingJob and Document state. Successful calls are idempotent;
failures retain no partial Mentions and can be retried. End-to-end tests exercise a
real synthetic PDF through the native Python Worker into encrypted Blocks and
encrypted Mentions. NER remains outside this implementation.

`EntityResolutionService` continues the chain: it decrypts each Mention transiently,
normalizes and fingerprints its value with a Matter-derived HMAC search key, creates
or reuses the encrypted ProtectedValue, scores candidates with the deterministic
`er-v1` evidence rules, and atomically commits assignments, candidates, evidence, and
append-only ResolutionEvents with the RESOLVE ProcessingJob. Hard Cannot-Link rules
override all scoring, PERSON Mentions never auto-link on soft score alone, and
low-confidence cases persist pending candidates for review instead of guessing.

`AIExecutionService` accepts only an already persisted `SanitizedDocument`. It
decrypts its sanitized Blocks locally, verifies restoration tokens and scans for
ProtectedValue plaintext and internal identifiers, then passes one `content` string
to the configured provider. Requests, sanitized responses, and code-only failures
are AES-GCM encrypted under row- and field-specific AAD. Mapping Vault data never
crosses the provider or renderer boundary; provider responses are rehydrated locally.
