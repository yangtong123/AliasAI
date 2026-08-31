# Automatic Analysis and Result-First Review Development Plan

Status: Proposed
Last updated: 2026-08-27

## Purpose

This document is the implementation specification for the next AliasAI desktop
workflow change. It addresses three observed usability problems:

1. Long inline Document actions obscure the Document list.
2. Importing a PDF stops at `IMPORTED` and requires the user to run parsing,
   privacy detection, and entity resolution manually.
3. The default review panel exposes internal identity-resolution concepts before
   the user has a reason to edit them.

The intended product experience is:

```text
Import PDF
    |
    v
AliasAI automatically reads and analyzes it
    |
    v
Show the completed result and the few items needing attention
    |
    v
User edits only when the automatic result is wrong
```

The user must not have to understand the pipeline or create Entities to obtain a
first result. Entity creation remains an application responsibility during the
automatic resolution stage. Existing expert operations remain available for
correction and audit, but they are not the default interface.

## Fixed implementation decisions

The following decisions are part of this milestone. Implementers should not
silently choose different behavior.

1. Automatic analysis runs through `READY`: parse, privacy detection, and entity
   resolution. It does not automatically generate a sanitized artifact, call an
   AI provider, or rehydrate an AI response.
2. Import and replacement return to the renderer immediately after the new
   Document is persisted. Analysis continues in the Electron main process.
3. A newly imported or replacement Document is selected automatically so the
   user sees its progress and result.
4. The renderer removes the three manual stage buttons from the normal flow. A
   single retry action retries the correct failed stage.
5. The existing stage-specific IPC channels are retained for diagnostics and
   compatibility during this milestone, but production renderer components must
   stop calling them directly.
6. Existing review operations and audit events are preserved. Technical Entity,
   candidate, merge, split, and constraint controls are collapsed behind an
   advanced editor rather than deleted.
7. Manual correction behavior is not redesigned beyond the result-first shell in
   this milestone. A later interaction review will decide the final correction
   editor.
8. No database migration is expected. Persisted `Document.parseStatus`,
   `ProcessingJob`, Mention, Entity, and ResolutionEvent records remain the
   source of truth.

## Terminology shown to users

Domain terminology remains unchanged in TypeScript, SQLite, and audit records.
Only renderer copy changes.

| Internal term | Default user-facing wording |
|---|---|
| Parse / privacy detection / entity resolution | Reading and analyzing |
| Mention | Sensitive information item |
| Entity | Person or organization |
| Entity assignment | Belongs to |
| Candidate entity | Possible owner |
| Unresolved | Needs confirmation |
| Rejected Mention | Not sensitive information |
| Must-Link / Cannot-Link | Advanced identity rule |

Do not rename domain types solely to match UI copy. The distinction between a
Mention and an Entity remains necessary for auditability, pseudonymization, and
rehydration.

## Scope

### Included

- Compact Document action menu that cannot cover the Document name or status.
- Automatic parse -> detect -> resolve orchestration after import and replace.
- Idempotent background scheduling and a single user-facing retry action.
- Friendly progress, completion, failure, and attention-needed states.
- Automatic selection of imported and replacement Documents.
- Result-first review layout with technical controls hidden by default.
- Collapsed entry points for missed-detection marking and advanced identity
  editing.
- Unit, IPC, renderer, end-to-end, and packaged UI self-test updates.
- Chinese and English copy for every new state and action.

### Not included

- Changes to entity-resolution scoring, thresholds, or Domain invariants.
- Automatic sanitization or automatic AI execution.
- Physical deletion, retention policies, or key destruction.
- A new OCR engine, privacy detector, or Entity model.
- Removal of audit events or existing correction capabilities.
- A final redesign of merge, split, rename, and identity-constraint interaction.
- Cloud synchronization or multi-user task scheduling.

## Current behavior and root cause

### Manual pipeline

`document:pickAndImport` persists the Document and returns a summary. The
renderer then displays `PipelineControls`, whose stage table calls:

```text
document:process -> document:detect -> document:resolve
```

The three application services already own the correct state transitions and
transaction boundaries, but no service composes them into one user operation.
The UI therefore leaks an implementation pipeline to the user.

### Confusing review panel

`DocumentReviewPage` renders the selected Mention beside `MentionDetail` and
`EntityPanel`. The default detail view includes detector confidence, strength,
candidate scores, Entity creation, assignment, split, merge, and Cannot-Link
rules. These are useful diagnostic and correction capabilities, but they do not
answer the user's first questions:

- What did AliasAI find?
- What did it decide?
- Does anything require my attention?
- How can I correct an obviously wrong result?

### Obscured Document actions

`DocumentList` places two long buttons beside each Document in a 280-pixel
sidebar. `.item-row` and `.item-actions` are both horizontal flex containers,
so the filename, status, replacement action, and trash action compete for the
same width.

## Target user flow

```text
1. User selects a Matter and imports a PDF.
2. The new Document is selected immediately.
3. The content area displays "正在读取文档" without stage buttons.
4. AliasAI automatically parses, detects sensitive information, and resolves
   identities.
5. The content area updates to a result summary:
      "分析完成：发现 8 处敏感信息，6 处已自动处理，2 处需要确认。"
6. The first item needing confirmation is selected. If none need confirmation,
   the first detected item may be selected without implying user action is
   required.
7. Each selected item shows AliasAI's result in plain language.
8. The user takes no action when the result is acceptable. They open "修改结果"
   or "不是敏感信息" only when necessary.
9. Technical identity tools remain closed under "高级身份管理".
```

Opening an older `IMPORTED`, `PARSED`, or `DETECTED` Document must also schedule
automatic analysis. A persisted `FAILED` Document shows the explicit retry
action so reopening it cannot create an automatic failure loop. This prevents
documents created by an older AliasAI version from remaining stuck behind
removed buttons.

## User interface specification

### 1. Document list actions

Replace the two always-visible action buttons with one compact overflow button:

```text
+--------------------------------+
| 房屋租赁合同.pdf        已分析  ⋯ |
+--------------------------------+
```

The menu contains:

- `用新 PDF 替换…`
- `移入回收站`

Requirements:

- Use a real `<button>` with `aria-haspopup="menu"` and an accessible name such
  as `房屋租赁合同.pdf 的更多操作`.
- Use `role="menu"` for the action surface and `role="menuitem"` for each
  action; the declared semantics and keyboard model must agree.
- Only one menu may be open at a time.
- Escape, outside click, selection, and Document change close the menu.
- Focus returns to the overflow button after Escape or cancellation.
- The destructive action keeps its existing confirmation. Render confirmation
  below the row at full sidebar width, not inside the filename row.
- The filename/status cell uses `min-width: 0`; the action cell never shrinks.
- Long filenames wrap at a sensible boundary or use ellipsis with a `title`.
- The same component supports keyboard and pointer operation.
- Do not change trash, restore, replacement, lineage, or audit semantics.

Suggested component boundary:

```text
DocumentList
  `-- DocumentActionMenu
        |-- replacement action
        `-- trash action and confirmation
```

Likely files:

- `apps/desktop/renderer/src/components/DocumentList.tsx`
- `apps/desktop/renderer/src/styles.css`
- `apps/desktop/renderer/src/i18n.tsx`
- corresponding renderer tests

### 2. Analysis status replaces pipeline controls

Replace `PipelineControls` in `App.tsx` with an `AnalysisStatus` component. It
shows one product-level state, not the three internal stages.

| Condition | Chinese example | Primary action |
|---|---|---|
| Scheduled or `IMPORTED` | `等待分析…` | none |
| `PARSING` | `正在读取文档…` | none |
| `PARSED` or `DETECTING` | `正在识别敏感信息…` | none |
| `DETECTED` or `RESOLVING` | `正在整理人物和机构关系…` | none |
| `READY` or `SANITIZED` | `分析完成` | none |
| Retryable `FAILED` | `分析未完成，请重试` | `重新分析` |

If a running job has numeric progress, it may be shown as a progress bar. Do not
show raw job type, enum value, worker path, detector name, or error stack.

While the Document is not ready, render the status panel and a short explanatory
placeholder. Do not render an empty review panel that says there is no result.

### 3. Result summary

When the Document reaches `READY` or `SANITIZED`, show:

```text
分析完成
发现 8 处敏感信息，6 处已处理，2 处需要确认。
```

Derive the summary from the mutually exclusive `MentionDecisionStatus` value of
each Mention:

- `found = mentions`
- `handled = AUTO_LINKED + USER_ASSIGNED`
- `notSensitive = rejected`
- `needsAttention = needsReview + unresolved`

The buckets must reconcile as
`found = handled + notSensitive + needsAttention`. If `notSensitive` is nonzero,
append copy such as `另有 1 处已标记为非敏感信息`; otherwise omit that clause.
If the buckets do not reconcile, treat it as a read-model bug and fix the
projection instead of hiding the mismatch in UI copy.

The existing `resolved` count is based on `assignedEntity !== null` and is not a
strong enough contract for this summary if a Mention can also have a pending
candidate. Keep it for compatibility if needed, but add a mutually exclusive
read-model count or compute the summary from the Mention DTOs.

Do not imply that every detected item must be confirmed. An automatic result is
the normal result. `NEEDS_REVIEW` and `UNRESOLVED` are the only statuses that
receive a prominent attention treatment.

### 4. Result-first detail panel

The default panel for a selected item contains only:

1. Detected text.
2. Friendly information type, for example `机构名称`, `电话号码`, or `身份证号`.
3. Result state: `已自动处理`, `需要确认`, `已手工修改`, or `不是敏感信息`.
4. For an assigned person/organization, `属于：原告甲` or the existing primary
   alias. Do not label this field `实体`.
5. One sentence of guidance.
6. Actions appropriate to the state.

Default actions:

- `修改结果` opens the existing assignment/candidate controls in an inline
  editor for the selected item.
- `不是敏感信息` calls the existing reject operation after confirmation.
- `恢复为敏感信息` is not introduced in this milestone unless the existing
  reject/re-mark workflow can support it without new Domain semantics.
- A `NEEDS_REVIEW` or `UNRESOLVED` item may display `确认归属` as the primary
  action; it opens the same correction editor.

The following fields are hidden from the default view and may appear only in a
collapsed `技术详情` section:

- Detector identifier.
- Confidence number.
- Mention strength.
- Candidate score and margin.
- Raw review-status enum.

The following controls are hidden under `高级身份管理`:

- Create Entity and assign.
- Rename Entity.
- Merge and split.
- Must-Link and Cannot-Link constraints.
- Full Entity list and Public Tokens.

Existing component logic may be reused inside the collapsed sections. Do not
delete IPC channels, repository operations, or event-writing paths merely
because the controls are no longer always visible.

### 5. Missed detections

The manual Mention form currently occupies prominent space above the document.
Replace it with a collapsed entry point:

```text
没有标出某项敏感信息？  补充标记
```

Opening it reveals the existing block, text, and type inputs. The creation
semantics and overlap checks do not change.

### 6. Layout

Target desktop layout:

```text
+------------------+--------------------------------+----------------------+
| Matters          | Document text                  | Analysis result      |
| Documents      ⋯ | highlighted sensitive item     | plain-language state |
|                  |                                | [修改结果] [非敏感]  |
+------------------+--------------------------------+----------------------+
```

CSS requirements:

- No horizontal overlap at 1280, 1440, and 1920 CSS pixels.
- `.review-layout` children use `min-width: 0`.
- The result panel may remain approximately 360 pixels wide but must wrap long
  Chinese and English strings.
- At narrow supported widths, use a deliberate breakpoint: stack the result
  panel below the document or allow the outer page to scroll. Do not let panels
  paint over one another.
- Preserve visible keyboard focus and at least the current button hit area.

## Application architecture

### 1. Sequential analysis service

Add `packages/application/src/document-analysis.ts` and export it from
`packages/application/src/index.ts`.

The application service composes existing services; it does not duplicate their
database transactions:

```ts
export type AnalysisStage = 'PARSE' | 'DETECT' | 'RESOLVE'

export interface DocumentAnalysisResult {
  readonly documentId: string
  readonly status: 'COMPLETE' | 'ALREADY_COMPLETE'
}

export class DocumentAnalysisService {
  constructor(
    private readonly review: ReviewQueryService,
    private readonly processing: DocumentProcessingService,
    private readonly detection: PrivacyDetectionService,
    private readonly resolution: EntityResolutionService
  ) {}

  analyze(documentId: string): Promise<DocumentAnalysisResult>
}
```

The exact constructor may use a narrower read interface instead of the concrete
review service. Do not add a new repository abstraction unless existing status
reads cannot express the state machine.

Required state behavior:

| Current persisted state | Next behavior |
|---|---|
| `IMPORTED` | process, then detect, then resolve |
| `PARSED` | detect, then resolve |
| `DETECTED` | resolve |
| `READY` or `SANITIZED` | successful no-op |
| `PARSING`, `DETECTING`, `RESOLVING`, `SANITIZING` | report already running; do not start another run |
| `FAILED` after parse/OCR | retry process, then continue |
| `FAILED` after DETECT job | retry detection, then continue |
| `FAILED` after RESOLVE job | retry resolution |
| `FAILED` after SANITIZE job | do not route into analysis; Preview owns sanitization retry |

Stage selection currently exists privately in `PipelineControls.selectStage`.
Move the rule into a pure application-layer function and test it there. The
renderer must not infer a failed stage differently from the main process.

After each awaited stage, re-read persisted status before choosing the next
stage. This accommodates idempotent completed-job reuse and prevents stale
assumptions if another authorized operation changes lifecycle state.

The analysis service must stop at the first failure. It must not transform a
stage-specific application error into success, reset a failed state, or continue
to the next stage.

### 2. Main-process scheduler

The IPC import handler must not await the full analysis pipeline. Introduce a
small main-process scheduler, for example:

```text
apps/desktop/main/src/document-analysis-runner.ts
```

Responsibilities:

- Hold an in-memory `Map<DocumentId, Promise<void>>` for the current app process.
- `start(documentId)` returns immediately after registering one background run.
- A second start for the same Document while the promise is active reuses or
  ignores the existing promise.
- Always attach a rejection handler. A background failure is represented by
  persisted Document/job state and must never become an unhandled rejection.
- Remove the map entry in `finally` so an explicit retry can start later.
- Do not log decrypted content, source paths, Mention text, or protected values.
- Expose a close/drain policy compatible with `AliasAiRuntime.close()` and tests.

The map is a process-local duplicate-start guard, not durable workflow state.
SQLite status and job records remain authoritative across restarts.

### 3. Runtime wiring

Extend `AliasAiServices` in `apps/desktop/main/src/runtime.ts` with the sequential
analysis service and the background runner. Reuse the already constructed
processing, detection, and resolution instances.

Do not construct a second set of repositories, keys, or Python workers.

### 4. IPC behavior

Add one narrow retry/start channel:

```ts
'document:analyze': {
  request: { readonly documentId: string }
  response: { readonly accepted: boolean }
}
```

The handler validates the ID, verifies that the Document is available, schedules
the runner, and returns without waiting for completion. `accepted: false` means
the same Document already has a run in this app process; it is not an error.

Update these existing handlers:

```text
document:pickAndImport
  -> persist/reuse Document
  -> schedule document:analyze
  -> return DocumentSummaryDTO immediately

document:pickAndReplace
  -> persist replacement Document
  -> schedule document:analyze for the replacement ID
  -> return replacement summary immediately
```

Cancellation of the file picker schedules nothing. A failed import or failed
replacement schedules nothing. A reused `READY`/`SANITIZED` Document is a cheap
analysis no-op.

Retain `document:process`, `document:detect`, and `document:resolve` for this
milestone, but mark them as diagnostic/compatibility channels in comments. No
normal renderer component should call them.

### 5. Startup and older Documents

When the renderer selects a Document in a resumable non-failed state
(`IMPORTED`, `PARSED`, or `DETECTED`), it invokes `document:analyze` once. The
runner deduplicates this with any import-triggered start. A selected `FAILED`
Document waits for the explicit `重新分析` action.

Do not automatically retry a persisted failure in a loop. Initial selection may
resume an interrupted non-failed state after existing startup recovery, but a
persisted `FAILED` state requires the visible `重新分析` action after the first
automatic attempt has failed.

If implementation reveals that startup recovery converts an interrupted state
to `FAILED`, add an explicit projection field distinguishing recoverable
interruption from a completed failed attempt. Do not implement timer-based
infinite retries.

## Renderer data flow

```text
pickAndImport / pickAndReplace returns DocumentSummaryDTO
    |
    |-- App selects returned Document ID
    |-- list refreshes
    `-- useDocumentStatus polls while processing is active
             |
             |-- AnalysisStatus renders friendly state
             `-- READY triggers review read and result-first UI
```

Required callback changes:

- `DocumentList` should expose `onImported(document: DocumentSummaryDTO)` and
  `onReplaced(document: DocumentSummaryDTO)` rather than only a generic refresh
  or the superseded ID.
- `App` stores the returned ID, clears the selected Mention, updates
  `aliasai.lastDocumentId`, and refreshes.
- Replacement selects the new Document. It must not clear the selection and
  leave the user on an empty page.

Polling rules:

- Continue the existing one-second polling while status is `PARSING`,
  `DETECTING`, `RESOLVING`, or `SANITIZING`.
- Also perform short-lived polling after scheduling while the persisted state is
  still the previous non-running state; otherwise an immediate `IMPORTED`
  response can stop polling before the background task marks `PARSING`.
- Stop polling at `READY`, `SANITIZED`, or a new attempt-specific `FAILED`
  revision; repeated reads of the pre-attempt FAILED revision are stale.
- Avoid introducing a second independent polling loop for review data.

One acceptable implementation is for the analyze mutation to invalidate the
same `refreshKey`, with `useDocumentStatus` treating `IMPORTED`, `PARSED`, and
`DETECTED` as temporarily pollable while an analysis request is pending. Keep
the pending flag local to the selected Document so switching Documents cannot
display another Document's progress.

## Review read model

Prefer projecting friendly state in the renderer from existing typed values.
Only extend `DocumentReviewDTO` if the result-first UI needs data that cannot be
derived safely.

Permitted additive fields include:

```ts
interface MentionReviewDTO {
  // Existing fields omitted.
  readonly requiresAttention: boolean
}
```

Do not persist display-only states. Do not put decrypted protected values into a
new DTO. The selected Mention text is already an explicit local review surface;
it must not be logged or copied into events.

The review count projection must have one mutually exclusive bucket per Mention.
Add a rejected count if necessary rather than allowing the displayed total to
disagree with its components.

## Error and concurrency behavior

1. A stage failure ends the current background run and produces one stable
   `FAILED` presentation.
2. The user receives one generic actionable message and `重新分析`. Detailed
   coded errors may remain in development diagnostics; never render stacks or
   file paths.
3. Two simultaneous schedule requests for one Document run one pipeline.
4. Running pipeline states continue to block trash and replacement through the
   existing lifecycle guards.
5. Trashing or replacing after analysis completes behaves exactly as today.
6. Closing the window must not produce an unhandled rejection or database write
   after runtime resources are closed. The runtime must either drain active runs
   before close or explicitly cancel/await the worker using existing safe
   shutdown semantics.
7. A failure to schedule analysis after a successful import does not roll back
   the imported Document. The Document remains visible with a retry action.
8. No automatic retry loop is allowed.
9. If a compatibility channel already owns a live stage, the automatic runner
   keeps responsibility, waits for its persisted result, and continues from
   the next resting stage. A read-then-acquire race is handled the same way.
10. If durable failure finalization itself fails, polling terminates on a
    code-only process-local signal. Explicit retry first retries that terminal
    write, then reruns the failed stage; lifecycle removal clears the signal.

## Security and audit requirements

- Python workers still return protocol-defined Blocks and never write directly
  to SQLite.
- Existing application services retain their transaction ownership.
- No plaintext protected value, decrypted block, source path, encryption key, or
  provider key may be added to logs, errors, progress DTOs, or IPC responses.
- Automatic decisions must create the same ResolutionEvents and evidence as a
  manually started resolution run.
- User corrections must continue creating the existing audit events.
- Public Tokens remain immutable; aliases remain editable.
- Automatic scheduling must respect trashed Matter/Document guards.
- The renderer receives no filesystem, SQLite, worker, or unrestricted Node.js
  capability.

## File-level implementation map

| Area | Expected files | Required change |
|---|---|---|
| Application | `packages/application/src/document-analysis.ts` | Sequential state machine and pure stage selection |
| Application export | `packages/application/src/index.ts` | Export new service/types |
| Application tests | `packages/application/test/document-analysis.test.ts` | State, retry, failure, and no-op tests |
| Main runner | `apps/desktop/main/src/document-analysis-runner.ts` | Background start, deduplication, rejection handling, close behavior |
| Runtime | `apps/desktop/main/src/runtime.ts` | Construct and expose analysis service/runner |
| IPC contract | `apps/desktop/main/src/ipc/contract.ts` | Add `document:analyze` |
| IPC handlers | `apps/desktop/main/src/ipc/handlers.ts` | Auto-schedule import/replace and implement retry |
| Preload types | preload bridge/type files discovered from the contract | Expose only the new narrow channel |
| IPC tests | `apps/desktop/main/src/ipc/index.test.ts` | Scheduling, cancellation, retry, dedupe |
| Status UI | replace or repurpose `PipelineControls.tsx` | Product-level `AnalysisStatus` |
| Document list | `DocumentList.tsx` | Action menu and returned-Document callbacks |
| Review UI | `DocumentReviewPage.tsx` | Result-first detail and collapsed editors |
| Advanced UI | `EntityPanel.tsx` | Render only inside advanced disclosure |
| App state | `App.tsx` | Auto-selection, status shell, remove manual controls |
| Hooks | `api/hooks.ts` | Poll across background scheduling transition |
| Copy | `i18n.tsx` | Chinese and English user-facing labels/errors |
| Layout | `styles.css` | Non-overlapping menu, responsive review layout |
| Renderer tests | component tests and `App.test.tsx` | New interaction and absence of jargon |
| Packaged UI test | `apps/desktop/main/src/ui-self-test.ts` | Wait for automatic `READY`; stop clicking stage buttons |
| Host self-test | `apps/desktop/main/src/self-test.ts` | Retain direct service test or add orchestration assertion |
| Architecture docs | `docs/architecture.md` | Document background orchestration after implementation |
| Release docs | `CHANGELOG.md`, `docs/rc1-acceptance.md` | User flow and acceptance updates |

The filenames for new renderer components are suggestions. Preserve existing
project conventions and keep each component focused.

## Test plan

### Application unit tests

Add tests proving:

1. `IMPORTED` runs process, detect, resolve in order and ends at `READY`.
2. `PARSED` skips process.
3. `DETECTED` skips process and detection.
4. `READY` and `SANITIZED` are no-ops.
5. A parse failure stops before detection.
6. A detection failure stops before resolution.
7. A resolution failure stops at resolution.
8. A retry from each supported `FAILED` origin selects the correct stage.
9. A sanitization failure is not treated as an analysis failure.
10. Status is re-read between stages.
11. Existing completed jobs remain reusable.
12. No new Entity is created by the orchestration layer itself; creation remains
    inside entity resolution.

Use synthetic values only. Do not weaken existing stage service tests.

### Main runner and IPC tests

Add tests proving:

1. Import schedules analysis exactly once and returns before a deliberately
   delayed analysis promise completes.
2. Replacement schedules the new ID, not the superseded ID.
3. File-picker cancellation schedules nothing.
4. Failed import/replacement schedules nothing.
5. Two starts for one ID share one active run.
6. Different Document IDs may run independently, subject to current worker
   capability.
7. A rejected background promise is observed and can be retried.
8. `document:analyze` rejects unavailable/trashed Documents with a coded error.
9. Runtime close does not leave an active unhandled task.

### Renderer tests

Add or update tests proving:

1. No `运行解析`, `运行隐私检测`, or `运行实体解析` button appears in the normal
   interface.
2. Each persisted state renders the correct friendly progress text.
3. Failure renders one `重新分析` action that calls `document:analyze`.
4. Import selects the returned Document and starts displaying progress.
5. Replacement selects the replacement Document.
6. Document actions are closed by default and accessible from `⋯`.
7. Trash confirmation appears below the row and cancellation restores focus.
8. The default result panel does not show `实体`, candidate score, margin,
   Must-Link, Cannot-Link, or `创建实体并分配`.
9. Opening `技术详情` shows diagnostic fields.
10. Opening `修改结果` or `高级身份管理` preserves the existing correction
    operations.
11. Only `NEEDS_REVIEW` and `UNRESOLVED` receive the prominent attention state.
12. Manual Mention creation is closed by default and works after expansion.
13. Chinese is the default locale and every new string has an English mapping.

Avoid brittle assertions on implementation-only class names when accessible
roles and labels can describe the behavior.

### End-to-end acceptance test

Use a synthetic PDF and the real local pipeline:

```text
create Matter
  -> import PDF
  -> do not invoke manual stage channels
  -> wait for READY
  -> assert detected Mention count > 0
  -> assert automatic Entity creation/assignment where current rules permit it
  -> assert unresolved cases appear as "needs confirmation"
  -> correct one result through existing audited operation
  -> generate sanitized preview
  -> verify rehydration still restores the synthetic source values
```

The test must prove the result was generated without renderer clicks on the
three old pipeline stages.

### Visual verification

Capture or inspect the review page at 1280x800, 1440x900, and 1920x1080 with:

- a long Chinese PDF filename,
- a long English PDF filename,
- the action menu open,
- trash confirmation open,
- analysis in progress,
- analysis complete with no attention items,
- analysis complete with attention items,
- advanced identity management expanded.

Verify that controls do not overlap, strings wrap, menus remain inside the
window, and keyboard focus is visible.

### Required commands

Run at minimum:

```bash
pnpm typecheck
pnpm lint
pnpm test
.venv/bin/python -m pytest
pnpm build
git diff --check
```

Run the packaged UI self-test or its documented equivalent before declaring the
milestone complete.

## Acceptance criteria

The milestone is accepted only when all statements are true:

- Importing a PDF requires no parse/detect/resolve button clicks.
- Replacing a PDF automatically analyzes the replacement.
- The selected new Document visibly moves from progress to result.
- Closing and reopening the app does not leave resumable Documents without a
  route to automatic continuation or explicit retry.
- A stage failure stops safely and exposes one retry action.
- Concurrent starts do not duplicate pages, blocks, Mentions, ProtectedValues,
  Entities, candidates, or ResolutionEvents.
- Default review copy explains the result without requiring the word `实体`.
- Users are not asked to create an Entity to obtain the initial result.
- Existing audited correction operations remain reachable.
- The sidebar action menu and confirmation do not obscure filenames at supported
  widths.
- Trash, replacement, lineage, rehydration, and review lifecycle guards still
  pass their existing tests.
- No new plaintext or key material crosses logging or IPC boundaries.
- TypeScript tests, Python tests, typecheck, lint, build, Markdown checks, and UI
  self-test all pass.

## Recommended delivery sequence

Use sequential, reviewable commits. Multiple AIs may work in parallel only with
strict file ownership because `App.tsx`, `i18n.tsx`, `styles.css`, IPC contracts,
and tests are common conflict points.

1. **Application orchestration**
   - Add state machine, service, export, and application tests.
   - Verification: application tests and typecheck.
2. **Main runner and IPC**
   - Add background deduplication, runtime wiring, import/replace scheduling,
     retry channel, and IPC tests.
   - Verification: IPC tests, shutdown test, typecheck.
3. **Automatic progress and Document actions**
   - Replace pipeline controls, auto-select new Documents, add overflow menu,
     polling transition, copy, styles, and focused tests.
   - Verification: renderer tests at supported widths.
4. **Result-first review shell**
   - Add summary/detail presentation and collapse manual/advanced controls.
   - Do not alter correction semantics.
   - Verification: review component tests and audit-operation regression tests.
5. **End-to-end and packaged UI tests**
   - Update the UI driver to wait for automatic analysis and exercise one
     correction through the new shell.
   - Verification: full gate suite.
6. **Documentation and release notes**
   - Update architecture, acceptance guide, and changelog to match delivered
     behavior.

Suggested ownership if several AIs are assigned:

| Owner | Exclusive responsibility | Must not edit |
|---|---|---|
| AI A | `packages/application` orchestration and tests | renderer and CSS |
| AI B | main runner, runtime, IPC contract/handlers/tests | review components |
| AI C | Document list, status UI, hooks, App integration | application services |
| AI D | review presentation and review tests | main runtime and IPC |

AI C and AI D both need `i18n.tsx` and `styles.css`; schedule their integration
sequentially or give those two shared files to one designated integrator. No AI
should revert unrelated changes made by another worker.

## Implementation review checklist

Before merging each commit, reviewers should ask:

- Does this layer compose existing behavior or duplicate it?
- Can the same Document be started twice?
- What happens if the window or runtime closes mid-stage?
- Does retry choose the stage from persisted evidence?
- Does any error/log/DTO expose paths or protected plaintext?
- Can a trashed Document or Matter enter analysis or review mutation?
- Does the UI show an internal term before the user opens an advanced section?
- Does every visible action explain its consequence?
- Are totals and attention counts internally consistent?
- Would removing the new guard make its regression test fail?

## Follow-up milestone: correction interaction

After this milestone is usable, review the manual correction flow with the
product owner before implementing a deeper redesign. Topics for that discussion:

- Whether corrections should edit a proposed sanitized phrase directly or edit
  identity ownership.
- How to distinguish “wrong sensitive-information type” from “wrong owner”.
- Whether one correction should update identical occurrences in the Document or
  across the Matter.
- How merge/split and Cannot-Link rules should be explained without exposing a
  graph editor.
- Whether rejected items need a one-click undo instead of manual re-marking.

Until that review is complete, preserve the current audited operations behind
the result-first shell and avoid inventing new identity semantics.
