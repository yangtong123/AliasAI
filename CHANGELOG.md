# Changelog

## Unreleased

- Automatic analysis with a result-first review (导入即分析): importing or
  one-step replacing a PDF now schedules the full parse → privacy detection →
  entity resolution pipeline automatically in the Electron main process and
  returns the new Document summary immediately, so the workspace selects the
  new Document and shows friendly progress — 等待分析… / 正在读取文档… /
  正在识别敏感信息… / 正在整理人物和机构关系… / 分析完成 — instead of three
  manual stage buttons. The orchestration composes the existing audited
  services (no new transactions, no schema change), re-reads persisted status
  between stages, deduplicates concurrent starts per Document in-process
  (`document:analyze` + background runner), resumes interrupted
  IMPORTED/PARSED/DETECTED Documents once on selection, exposes exactly one
  重新分析 action for an analysis-owned failure attributed by persisted job
  evidence, leaves sanitization failures to the preview workflow, drains
  active runs on graceful quit, and never auto-retries in a loop.
- Result-first review UI: the review page leads with a plain-language outcome
  summary (发现 N 处敏感信息，X 处已处理，Y 处需要确认) built from mutually
  exclusive Mention decision buckets; each selected item shows its detected
  text, friendly type, result state (已自动处理/需要确认/已手工修改/不是敏感信息),
  ownership as 属于：<化名>, one-line guidance, and state-appropriate actions
  (确认归属 opens the existing correction controls). Detector confidence,
  strength, candidate scores, and raw enums move behind 技术详情; create/
  assign, rename, merge/split, constraints, and the Entity/token list stay
  reachable behind 高级身份管理; missed detections collapse into one 补充标记
  entry. All copy ships in Simplified Chinese and English.
- Compact document actions: the two inline list buttons become one ⋯ overflow
  menu per row (`aria-haspopup="menu"`, `menu`/`menuitem`, accessible name,
  single-open, Escape/outside-
  click close with focus returned), so long filenames and statuses are never
  obscured; trash/replace keep their explicit confirmations rendered below the
  row at full sidebar width.
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
  show a lineage marker in the workspace list. Lineage is linear (replacing a
  restored old version fails with `LINEAGE_CONFLICT` instead of forking the
  version chain) and every replacement event is trigger-checked against the
  replacement's recorded lineage, so the append-only audit trail can never
  contradict the real version history.
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
