# AliasAI Packaging (macOS V1)

How the desktop app becomes a distributable, self-contained macOS bundle that
a tester can install without Node, pnpm, a repository checkout, or a system
Python.

## What ships inside the app

```text
AliasAI.app/Contents/
  MacOS/AliasAI                     # Electron binary
  Resources/
    app.asar                        # dist/main (bundled main process), renderer, preload
    app.asar.unpacked/
      dist/main/drizzle/*.sql       # database migrations (unpacked for direct fs reads)
      node_modules/better-sqlite3/  # the only production Node dependency
    python-runtime/                 # pinned standalone CPython + pdfminer.six (extraResources)
    python-workers/document_parser/ # native_worker.py, native_pdf.py, protocol.py
```

Everything the main process needs at runtime is either inside the esbuild
bundle or one of these resources. The app never reads the repository, a
`.venv`, or the user's system Python in packaged mode.

## Resource resolution

`resolvePackagedPythonResources` in `apps/desktop/main/src/runtime.ts` is the
single resolution interface, used identically by development and packaged
runs, with one precedence order:

1. `ALIASAI_PYTHON_COMMAND` + `ALIASAI_NATIVE_WORKER_PATH` env overrides
   (tests and experiments).
2. Packaged resources — only when `app.isPackaged`: `python-runtime/bin/python3`
   and `python-workers/document_parser/native_worker.py` under
   `process.resourcesPath`. A half-present bundle resolves to nothing and the
   app fails closed with `PYTHON_RUNTIME_UNAVAILABLE`.
3. Development fallback: workspace-root discovery (`.venv/bin/python` and the
   repository `python/` sources).

The OCR worker is not bundled in V1: it stays an opt-in dev/`ALIASAI_OCR_WORKER_PATH`
feature and would require shipping the PaddleOCR stack.

## The bundled Python runtime

`apps/desktop/scripts/prepare-python.mjs` provisions `build/python-runtime/`:

- A pinned [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  `install_only_stripped` CPython (release, Python version, and per-arch
  sha256 are hardcoded in the script; checksums come from the release's
  SHA256SUMS).
- Requirements install with `pip install --require-hashes` from the committed
  `apps/desktop/python-requirements.lock`, which pins every wheel (pure,
  universal2, and per-arch variants) by sha256 — the same supply-chain
  guarantee as the CPython archive itself.
- Post-install pruning: `bin/` keeps only the `python3` interpreters, and the
  pip package is removed. Both steps exist because pip's console scripts and
  entry points embed the build machine's absolute paths — the audit rejects
  any repository path inside the bundle.
- The worker process runs with `PYTHONDONTWRITEBYTECODE=1` (set by
  `PythonWorkerClient`), so running the app never writes `__pycache__` into
  `Contents/Resources`; CI re-audits the bundle after the self-test to prove
  it stayed byte-identical.

Provisioning is guarded by a single global stamp covering every input —
architecture, archive checksum, requirements-lock checksum, worker source
checksums, and a hash of the provisioning script itself (so changing pip
flags, pruning rules, or the assembly flow also invalidates the cache) — and
the runtime/workers directories are swapped in atomically from a staging
directory only after provisioning fully succeeded. Switching architectures
or editing a worker always reprovisions; a failed run never leaves mixed
output.

Bumping a pin means updating the constants at the top of the script and/or
the lock file (the stamp invalidates automatically). To regenerate the lock,
download both architectures' wheels from PyPI and record their hashes:

```sh
for arch in macosx_11_0_arm64 macosx_11_0_x86_64; do
  python3 -m pip download --index-url https://pypi.org/simple \
    --only-binary :all: --implementation cp --python-version 3.12 \
    --platform "$arch" -d "/tmp/wheels-$arch" \
    pdfminer.six==<ver> cryptography==<ver> cffi==<ver> pycparser==<ver> charset-normalizer==<ver>
done
shasum -a 256 /tmp/wheels-*/*
# one entry per package, one --hash line per distinct wheel
```

## Building locally

```sh
pnpm --filter @aliasai/desktop package          # host architecture
pnpm --filter @aliasai/desktop package:arm64    # explicit arch
pnpm --filter @aliasai/desktop package:x64
```

Each script runs the normal build, provisions the Python runtime for the
target arch, and invokes electron-builder (`apps/desktop/electron-builder.yml`)
for `dir` + `zip` targets. Output lands in `apps/desktop/release/`
(`mac-arm64/AliasAI.app` / `mac/AliasAI.app` and
`AliasAI-<version>-arm64-mac.zip` / `AliasAI-<version>-mac.zip`, ~160 MB).
`better-sqlite3` is rebuilt against the Electron ABI during packaging.

## Verifying a package

```sh
node apps/desktop/scripts/audit-package.mjs [path/to/AliasAI.app]
AliasAI.app/Contents/MacOS/AliasAI --self-test
AliasAI.app/Contents/MacOS/AliasAI --provider-self-test
AliasAI.app/Contents/MacOS/AliasAI --ui-self-test
```

- **Audit** fails the build on forbidden content (test files, mock worker,
  `.venv`, databases, key material, standalone or inline source maps —
  including inside `app.asar` — and embedded build-machine paths) and on
  missing required pieces (bundled interpreter, worker sources, migrations,
  native SQLite binding). Path scanning uses the actual repository root plus
  common CI workspace locations; third-party wheel SBOMs under
  `.dist-info/sboms/` are exempt because they legitimately reference the
  vendor's own CI and are hash-locked.
- **Manifest** (`--record-manifest` / `--check-manifest`) fingerprints every
  bundle entry (path, type, permissions, sha256; symlinks by target) and
  compares strictly, proving a run did not mutate the bundle at all — not
  merely that it still satisfies the audit rules.
- **Self-test** runs the complete user acceptance chain against the packaged
  binary in a throwaway `userData` directory: create Matter → import a
  synthetic PDF → parse (through the bundled Python worker) → detect →
  resolve → review → sanitization → Mock AI → local rehydration. It prints a
  JSON stage summary and exits non-zero on any failure. On machines without
  an interactive keychain (CI), run it with `ALIASAI_ALLOW_PLAINTEXT_KEYS=1`.
- **Provider self-test** drives the same chain but dispatches the AI stage
  through the real OpenAI-compatible HTTP provider against an in-process
  loopback fake endpoint (`--provider-self-test`). No external network,
  account, or real API key is involved: the fake endpoint asserts the
  Authorization header, the exact chat-completions request shape, and that no
  protected plaintext ever crossed the wire; the app then restarts its runtime
  to prove the keychain-wrapped provider configuration survives relaunch.
  Runs with the same `ALIASAI_ALLOW_PLAINTEXT_KEYS=1` CI fallback.
- **UI self-test** creates a real sandboxed Electron `BrowserWindow` and drives
  the production React → bundled preload → validated IPC → application stack.
  It clicks the same controls a tester uses through Matter creation, PDF
  import, parse/detect/resolve, confirmation, sanitization, Mock AI, local
  rehydration, copy, and export. Native chooser/clipboard capabilities are
  replaced at their narrow main-process boundary with deterministic in-memory
  hosts so CI never touches the runner's personal clipboard or files.

All gates run in CI for every push to `main` and on pull requests that touch
the app, packages, or worker sources
(`.github/workflows/packaging.yml`, `macos-15` arm64 + `macos-15-intel` x64
matrix): audit → manifest record → service self-test → UI self-test →
provider self-test → strict manifest re-check, and
the zips are uploaded as artifacts.

## User data, upgrades, and troubleshooting

- All persistent state lives under
  `~/Library/Application Support/AliasAI/` (`userData`): `aliasai.db`
  (SQLite database), `aliasai.keys` (safeStorage-wrapped keys), and
  `aliasai.ai-provider.json` (AI provider selection; the OpenAI-compatible
  API key inside it is safeStorage-wrapped). Nothing is
  written inside the `.app` bundle. The sole intentional exception is a text
  export after the user explicitly chooses a destination in the native save
  dialog; copying similarly places the selected result on the OS clipboard.
- Upgrades: replace the app bundle; `userData` is untouched and migrations
  run on next launch. A migration regression test opens a 0003 database,
  preserves an existing Matter, and upgrades it through 0004. Uninstalling the
  app does not delete user data.
- After an unclean shutdown, startup recovery marks interrupted jobs FAILED
  before opening a window. Select the document and use the stage-specific
  Retry action; completed encrypted artifacts are preserved.
- Gatekeeper (unsigned V1 builds): right-click the app → Open, or
  `xattr -dr com.apple.quarantine AliasAI.app` after download.
- `PYTHON_RUNTIME_UNAVAILABLE` at startup means the bundled Python resources
  are missing or damaged — reinstall the app.
- The app is current-user only; documents never leave the machine except as
  sanitized content through the configured AI provider (offline Mock by
  default, or the OpenAI-compatible endpoint the user configures in
  Settings).
