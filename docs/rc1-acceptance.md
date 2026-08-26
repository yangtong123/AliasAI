# AliasAI V1 RC1 acceptance guide

This release candidate is for test users on macOS. It is intentionally local,
single-user, and unsigned. The AI provider defaults to the deterministic
offline Mock; a tester can additionally configure any OpenAI-compatible
endpoint (own deployment or local model server) in Settings. The offline
workflow needs no repository, Node.js, pnpm, Python, or a network AI account.

## Supported package

- Apple Silicon: `AliasAI-1.0.0-rc.1-arm64-mac.zip`
- Intel: `AliasAI-1.0.0-rc.1-mac.zip`
- macOS only; packages are unsigned and not notarized.

Unzip the matching artifact, move `AliasAI.app` to Applications if desired,
then right-click → Open. If Gatekeeper still refuses the unsigned test build,
run `xattr -dr com.apple.quarantine AliasAI.app` once.

## Acceptance workflow

Use synthetic or disposable documents only during RC testing.

1. Create a Matter and select it.
2. Import a native-text PDF. Importing the same unchanged PDF again in the
   same Matter must reuse the existing Document rather than duplicate it.
3. Run Parse, Detect, and Resolve. A scanned/raster-only PDF is expected to
   fail closed in this package because the large OCR runtime is not bundled.
4. Inspect the automatically created Entities and assignments. Correct only
   exceptions using rename, reassign, reject, manual Mention, merge, or split;
   then optionally Confirm reviewed assignments.
5. Open Sanitized preview. Unsupported or tokenless Mentions must be listed as
   blockers. An identifier with no reliable Entity owner must still sanitize via
   a value-level alias/token without creating an Entity. With no blockers, generate the
   preview and verify real protected values are absent.
6. Run the AI analysis (Mock by default). The sanitized response must retain
   aliases/tokens but contain no protected plaintext. Enable the local
   RESTORE_ON_REQUEST option and verify the restored response only appears
   locally. While an execution is in flight, a Cancel button must stop it; the
   execution then shows as failed/cancelled without a partial result.
7. (Optional, requires an endpoint) Open 设置 Settings, switch the provider to
   OpenAI-compatible, enter the Base URL (must be HTTPS; loopback HTTP is
   allowed for local model servers), model name, and API key, then use
   测试连接 Test connection before saving. The key is stored encrypted by the
   macOS keychain; the page only ever shows 已配置 (configured), never the key
   itself. Saving returns to the Mock provider at any time, and 删除提供商配置
   removes every stored provider settings including the key.
8. Copy or export the sanitized Document and AI response. Copy/export of the
   restored response is intentionally allowed only after an explicit click;
   the warning means that sensitive plaintext is leaving AliasAI's encrypted
   store for the clipboard or selected text file.
9. Trash and restore. On the Matter and Document lists, each item has a
   移入回收站 (move to trash) button with a confirmation step: a Matter warns
   that all of its contents will disappear from the workspace, a Document
   warns that it stays recoverable. After trashing, the item disappears from
   the normal lists immediately; if it was selected, the selection is cleared.
   Open 回收站 (Trash) from the header: deleted Matters and individually
   deleted Documents are listed with a 恢复 (restore) action. Restoring a
   Matter makes its previous Documents visible again (a Document trashed
   before the Matter stays trashed). Re-importing the identical PDF of a
   trashed Document must create a new Document with a new identity; the old
   copy remains in trash and its sanitized artifact can still rehydrate
   locally after restore. Restoring while an active copy with the same content
   exists must show an actionable conflict message. Trashing an item with a
   running pipeline stage or AI execution is rejected with a busy message.
10. Quit and reopen. The last valid Matter and Document selection should be
   restored; persisted results and the configured AI provider (including the
   stored key) remain available.

The desktop UI defaults to Simplified Chinese. Use the language selector in
the upper-right corner to switch between 简体中文 and English; the choice must
survive an application restart. The packaged UI self-test switches both ways,
then completes the entire acceptance workflow through the Chinese interface.

## Failure and restart checks

- A failed Parse, Detect, or Resolve stage shows the matching Retry action.
- A SANITIZE failure is retried from Sanitized preview, not by rerunning Parse.
- Force-quitting during a job must not leave a permanently running state. On
  next launch, startup recovery marks it FAILED with the code `INTERRUPTED`;
  retry from the displayed stage. Completed encrypted data is retained.
- A changed source file is rejected before parse commit. Re-import the changed
  file to create a new Document identity.
- Trashing a Document while a pipeline stage or AI execution is running fails
  with `DOCUMENT_BUSY`; wait for it to finish, then retry. Nothing is partially
  trashed. Same-name files with different content are never rejected for their
  name.
- Permanent physical deletion, trash retention, and key destruction are not
  supported in this release; trash is recoverable only.
- Startup failures such as `PYTHON_RUNTIME_UNAVAILABLE` indicate an incomplete
  installation. Reinstall the package; the app never falls back to a system
  Python or repository path.

Errors shown to the renderer use stable codes/static messages. Raw stacks,
filesystem paths, keys, decrypted ProtectedValues, and provider internals are
not exposed through IPC or stored as diagnostic plaintext.

## Automated release gates

Both macOS architectures must pass:

```sh
pnpm typecheck
pnpm lint
pnpm test
.venv/bin/python -m pytest
pnpm --filter @aliasai/desktop build
node apps/desktop/scripts/audit-package.mjs /path/to/AliasAI.app
AliasAI.app/Contents/MacOS/AliasAI --self-test
AliasAI.app/Contents/MacOS/AliasAI --ui-self-test
AliasAI.app/Contents/MacOS/AliasAI --provider-self-test
```

Packaging CI records a strict manifest before the acceptance runs and checks
it afterward. Any added/removed file, content change, permission change,
escaping symlink, source map, test fixture, key/database, or build-machine path
fails the release. The provider self-test exercises the real HTTP provider
path against an in-process loopback endpoint only — it needs no network or
account.

## Deliberate RC1 limitations

- The OpenAI-compatible provider covers chat completions only — no prompt
  templates, streaming, tool calls, or conversation history; no provider
  bundled by default (Mock is offline and remains the default selection).
- Native text PDF parsing is bundled; PaddleOCR is not bundled.
- Mixed pages use their native text layer and do not OCR image regions.
- No NER, code signing/notarization, auto-update, cloud sync, collaboration,
  or multi-user access control.
- Exported/restored text and clipboard contents are outside AliasAI's encrypted
  storage boundary and become the tester's responsibility.
