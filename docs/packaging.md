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
- Requirements installed with that runtime's own pip, fully pinned:
  `pdfminer.six==20260107`, `cryptography==50.0.0`, `cffi==2.1.1`,
  `pycparser==3.0`, `charset-normalizer==3.5.0` (wheels only).
- Post-install pruning: `bin/` keeps only the `python3` interpreters, and the
  pip package is removed. Both steps exist because pip's console scripts and
  entry points embed the build machine's absolute paths — the audit rejects
  any repository path inside the bundle.

Bumping any pin means editing the constants at the top of the script (the
stamp file invalidates automatically) and re-running packaging for both
architectures.

## Building locally

```sh
pnpm --filter @aliasai/desktop package          # host architecture
pnpm --filter @aliasai/desktop package:arm64    # explicit arch
pnpm --filter @aliasai/desktop package:x64
```

Each script runs the normal build, provisions the Python runtime for the
target arch, and invokes electron-builder (`apps/desktop/electron-builder.yml`)
for `dir` + `zip` targets. Output lands in `apps/desktop/release/`
(`mac-arm64/AliasAI.app` and `AliasAI-0.0.0-<arch>-mac.zip`, ~160 MB).
`better-sqlite3` is rebuilt against the Electron ABI during packaging.

## Verifying a package

```sh
node apps/desktop/scripts/audit-package.mjs [path/to/AliasAI.app]
AliasAI.app/Contents/MacOS/AliasAI --self-test
```

- **Audit** fails the build on forbidden content (test files, mock worker,
  `.venv`, databases, key material, source maps, embedded repository paths)
  and on missing required pieces (bundled interpreter, worker sources,
  migrations, native SQLite binding).
- **Self-test** runs the complete user acceptance chain against the packaged
  binary in a throwaway `userData` directory: create Matter → import a
  synthetic PDF → parse (through the bundled Python worker) → detect →
  resolve → review → sanitization → Mock AI → local rehydration. It prints a
  JSON stage summary and exits non-zero on any failure. On machines without
  an interactive keychain (CI), run it with `ALIASAI_ALLOW_PLAINTEXT_KEYS=1`.

Both gates run in CI for every push to `main`
(`.github/workflows/packaging.yml`, `macos-15` arm64 + `macos-15-intel` x64
matrix) and the zips are uploaded as artifacts.

## User data, upgrades, and troubleshooting

- All persistent state lives under
  `~/Library/Application Support/AliasAI/` (`userData`): `aliasai.db`
  (SQLite database) and `aliasai.keys` (safeStorage-wrapped keys). Nothing is
  written inside the `.app` bundle.
- Upgrades: replace the app bundle; `userData` is untouched and migrations
  run on next launch. Uninstalling the app does not delete user data.
- Gatekeeper (unsigned V1 builds): right-click the app → Open, or
  `xattr -dr com.apple.quarantine AliasAI.app` after download.
- `PYTHON_RUNTIME_UNAVAILABLE` at startup means the bundled Python resources
  are missing or damaged — reinstall the app.
- The app is current-user only; documents never leave the machine except as
  sanitized content through the configured AI provider (Mock in V1).
