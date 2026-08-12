# AliasAI

Local-first, privacy-preserving AI workspace. This repository contains the tested V1 foundation: a sandboxed Electron/React desktop shell, pure domain contracts, encrypted SQLite persistence, local document inspection, and a native PDF parser that streams the normalized Document Model over the local Python worker protocol.

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
- `packages/privacy-detection`: deterministic regex-based Block-to-Mention proposals using synthetic tests.
- `packages/entity-resolution`: explainable, rule-first proposal gate; it never applies identity mutations.
- `packages/pseudonymization`: offset-based sanitized text formatting without raw global replacement.
- `packages/rehydration`: Public Token-anchored local restoration.
- `packages/ai`: reserved sanitized provider boundary; no provider integration exists yet.
- `packages/python-bridge`: validated JSON Lines Protocol v1 client with mock and native-PDF worker contract tests.
- `packages/application`: encrypted Matter/document workflows and atomic Entity creation orchestration.
- `python/document_parser`: native PDF text extraction plus a protocol mock; parser output contains pages and normalized text blocks only.
- `python/ocr`, `python/ner`, `python/image_processing`: replaceable package boundaries; no OCR or ML implementation exists yet.

No sensitive document, key, database, or generated runtime data should be committed.
