# Changelog

## Unreleased

- One-step Document replacement (用新 PDF 替换… / Replace with new PDF…):
  picking a replacement file atomically trashes the old Document, creates the
  replacement as a new active Document recording `supersedes_document_id`
  lineage, and appends one audited `DOCUMENT_REPLACED` event linking both IDs.
  Nothing is copied from the old Document (no mentions, review decisions,
  jobs, sanitized artifacts, or AI executions), Matter-scoped identity data
  keeps serving normal resolution for the replacement, the old artifact still
  rehydrates locally from Trash, and any failure — running work, a file that
  duplicates another active Document, an unreadable source, or a cancelled
  picker — leaves the old Document exactly as it was. Replacement documents
  show a lineage marker in the workspace list.
- Recoverable trash for Matters and Documents: per-item trash buttons with
  confirmation on the workspace lists, a dedicated Trash view with restore
  actions, and idempotent append-only `workspace_events` audit. Trashing never
  alters Entity IDs, Public Tokens, ProtectedValues, mappings, sanitized
  artifacts, or AI execution history; a Document trashed before its Matter
  stays trashed after the Matter is restored.
- Same-file re-import after trash: document uniqueness is now a partial index
  on `(matter_id, file_hash)` over active Documents only, so a trashed copy
  never blocks importing the identical file as a new Document with a new ID;
  active duplicate imports remain idempotent and file names never participate
  in uniqueness.
- Running work blocks trash with a coded `DOCUMENT_BUSY` error — including a
  Document mid-parse (native PDF parsing has no ProcessingJob row) — and
  parsing, import, and review writes all re-validate lifecycle state inside
  their write transactions, so a Matter trashed mid-inspection cannot gain a
  hidden Document, a Document trashed mid-parse cannot receive Pages/Blocks,
  and stale renderer IDs cannot mutate trashed data or append resolution
  events. Restoring over an active same-hash Document fails atomically with
  `RESTORE_CONFLICT` and no partial writes.
- Normal lists and the processing/detection/resolution/sanitization/preview/AI
  start paths exclude trashed Documents and deleted Matters; historical reads
  for local rehydration and audit remain available through explicitly named
  internal repository methods.
- Add a real OpenAI-compatible AI provider behind the existing narrow provider
  port (chat completions, HTTPS-or-loopback only, no redirects, bounded
  120s timeout, cooperative cancellation, 5 MiB response ceiling, strict
  response validation) while keeping the offline Mock selectable.
- Provider Settings page (Chinese/English): base URL, model name, API key,
  connection test, clear; the API key is stored encrypted with the OS keychain
  (`safeStorage`) and never enters SQLite or logs. The stored key is never
  returned to the renderer — the settings UI only shows
  configured/not-configured — and a newly typed key crosses IPC only in the
  explicit save or test request. A stored-but-unusable
  configuration fails closed instead of silently falling back to Mock.
- User cancellation of in-flight AI executions (`AI_CANCELLED` fails closed
  with no partial records); restart-safe provider configuration persisted in
  `aliasai.ai-provider.json` under `userData`.
- New packaged acceptance gate `--provider-self-test`: the full user chain
  dispatched through the real HTTP provider against an in-process loopback
  fake endpoint (no external network or account), including transport-level
  leak assertions and restart recovery of the keychain-wrapped key.
- Single-instance desktop mode (`requestSingleInstanceLock`) so provider
  configuration mutations stay serialized within one main process; settings
  operations (save/test/clear) are mutually exclusive in the UI and the whole
  form locks while any is in flight.
- Settings copy corrected: the API key is sent to the user-configured endpoint
  via the Authorization header and never enters logs or the database (it does
  leave the machine to that endpoint — the previous "never leaves this
  machine" wording was wrong).

## 1.0.0-rc.1

- Complete local PDF → privacy detection → entity review → sanitization →
  Mock AI → local rehydration workflow.
- Encrypted SQLite persistence, Matter-scoped identity model, immutable
  restoration tokens, outbound privacy leak verification, and code-only
  failure records.
- Explicit sanitized/restored copy and text export with main-process reloads.
- Simplified Chinese default UI with persistent Chinese/English language
  switching and localized domain states, blockers, and errors.
- Crash recovery for interrupted processing and AI executions, stage-specific
  retries, duplicate-import idempotency, and renderer restart selection.
- Self-contained unsigned macOS arm64/x64 packages with pinned Python runtime,
  package-content/manifest auditing, service acceptance, and real Electron UI
  acceptance tests.
