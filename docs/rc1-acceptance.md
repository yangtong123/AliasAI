# AliasAI V1 RC1 acceptance guide

This release candidate is for test users on macOS. It is intentionally local,
single-user, unsigned, and uses a deterministic local Mock AI provider. A
tester does not need the repository, Node.js, pnpm, Python, or a network AI
account.

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
4. Select each highlighted Mention. Create or choose an Entity, then click
   Confirm. The UI shows `review CONFIRMED` and disables the button as
   `Confirmed`.
5. Open Sanitized preview. Any unresolved/unsupported Mention must be listed
   as a blocker with a Review mention action. With no blockers, generate the
   preview and verify real protected values are absent.
6. Run Mock AI. The sanitized response must retain aliases/tokens but contain
   no protected plaintext. Enable the local RESTORE_ON_REQUEST option and
   verify the restored response only appears locally.
7. Copy or export the sanitized Document and AI response. Copy/export of the
   restored response is intentionally allowed only after an explicit click;
   the warning means that sensitive plaintext is leaving AliasAI's encrypted
   store for the clipboard or selected text file.
8. Quit and reopen. The last valid Matter and Document selection should be
   restored; persisted results remain available.

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
```

Packaging CI records a strict manifest before both acceptance runs and checks
it afterward. Any added/removed file, content change, permission change,
escaping symlink, source map, test fixture, key/database, or build-machine path
fails the release.

## Deliberate RC1 limitations

- No real/network AI provider; Mock AI only.
- Native text PDF parsing is bundled; PaddleOCR is not bundled.
- Mixed pages use their native text layer and do not OCR image regions.
- No NER, code signing/notarization, auto-update, cloud sync, collaboration,
  or multi-user access control.
- Exported/restored text and clipboard contents are outside AliasAI's encrypted
  storage boundary and become the tester's responsibility.
