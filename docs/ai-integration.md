# AliasAI AI Integration v1

## Scope

V1 defines a provider-independent execution boundary and ships two providers
behind it: the deterministic local Mock and an OpenAI-compatible network
adapter (Settings page, keychain-protected credentials, bounded transport).
It still deliberately does not ship prompt templates, streaming, tool calls,
or conversation history.

The only legal provider input is the ordered text of an immutable, persisted
`SanitizedDocument`. Callers cannot supply arbitrary prompt text through the
application or renderer API.

## Provider Port

```ts
interface AiProviderRequest {
  content: string
  signal?: AbortSignal   // cooperative cancel; a control channel, not data
}

interface AiProviderResponse {
  content: string
}

interface AiProvider {
  id: string
  execute(request: AiProviderRequest): Promise<AiProviderResponse>
}
```

The port intentionally excludes Matter, Document, Block, Mention, Entity, and
ProtectedValue identifiers; Mapping Vault rows; restoration policies; keys; source
paths; and decrypted real values. Both shipped providers preserve this port;
any future vendor adapter must too.

## Execution Boundary

`AIExecutionService.execute(sanitizedDocumentId)` performs these steps:

1. Reload the immutable artifact, encrypted Blocks, and local mapping references
   from SQLite. Mapping entity/token bindings are revalidated against their
   Mention and ProtectedValue; renderer-provided content is never trusted as
   provider input.
2. Fail closed when the Matter denylist exceeds 2048 entries: text-type
   checks are one substring pass per denied value, so an unbounded denylist
   would scale scan time with Matter size.
3. Decrypt and join sanitized Blocks locally in page and reading order,
   incrementally refusing to assemble a payload beyond the 5 MiB outbound
   cap — an oversized artifact is rejected before its plaintext is fully
   joined, encrypted, or persisted as a request.
4. Insert a RUNNING execution with the request encrypted under field-specific AAD.
5. Decrypt the Matter-wide ProtectedValue denylist only for the outbound privacy
   scan, then zero the transient byte buffers.
6. Fail closed with `OUTBOUND_DENYLIST_INTEGRITY_FAILURE` when a denylist value
   cannot be verified by the scan's digit grammar (for example a legacy row
   normalized under the old whitespace-collapsing rules): only the stable code
   is persisted, never the value.
7. Fail closed if the request contains a protected plaintext (including format
   variants), internal identifier, malformed or unknown restoration token, or
   omits any artifact token.
8. Call `AiProvider.execute({ content, signal })` only after the scan succeeds.
   `signal` is the service's cooperative cancel channel; aborting it makes the
   execution fail closed as `AI_CANCELLED` through the same encrypted,
   code-only failure path (no partial response is ever kept).
9. Encrypt and persist the sanitized provider response, or persist a stable
   code-only failure. Raw provider errors and stacks are not persisted or sent over
   IPC.
10. Rehydrate the response locally from the Mapping Vault according to restore
   policy. Unknown or modified tokens remain visible and are reported for review.

The provider request and response are each limited to 5 MiB. The response must
additionally be a non-empty string. The network adapter owns a bounded
transport timeout (default 120s) plus cancellation and a response-size
ceiling; the application layer never trusts a provider to police itself.

## Network Provider (OpenAI-Compatible)

`OpenAiCompatibleProvider` (`packages/ai/src/openai-compatible.ts`, provider id
`openai-compatible-v1`) speaks the OpenAI chat-completions convention:
`POST {baseUrl}/chat/completions` with `{ model, messages: [{ role: 'user',
content }], stream: false }`, and parses `choices[0].message.content` as the
pseudonymized response. Everything else about the transport is fail-closed:

- Base URL must be HTTPS, except HTTP on a loopback host (local models and the
  packaged self-test). Credentials, query strings, and fragments in the URL
  are rejected; the API key travels only in the `Authorization` header.
- Redirects are refused (`redirect: 'error'`): an endpoint that tries to
  redirect the Authorization header elsewhere fails instead of leaking it.
- Bounded timeout (default 120s, no retries) and cooperative cancellation via
  the request's `AbortSignal`; both fail closed as `AI_PROVIDER_FAILURE`
  executions (`AI_CANCELLED` when the user cancelled).
- The response body is capped at 5 MiB while it streams in (declared
  `content-length` is checked first); non-2xx status, non-JSON, missing
  `choices`, and non-string or empty content all fail closed.
- Provider errors carry only stable codes and HTTP status numbers
  (`PROVIDER_TIMEOUT`, `PROVIDER_HTTP_ERROR`, ...). The API key, request
  content, and response body never appear in an error message.

### Configuration and Credentials

Provider selection and endpoint settings live in the desktop Settings page and
persist in `userData/aliasai.ai-provider.json` (mode 0o600), written by
`AiProviderConfigStore` (`apps/desktop/main/src/ai-provider.ts`). The API key
is stored only as an Electron `safeStorage` (OS keychain) ciphertext blob; it
never enters SQLite, logs, or audit events, and the stored key is never
returned to the renderer. A newly typed key exists transiently in the settings
form and crosses IPC only in the explicit save or test request the user
initiated. The `ALIASAI_ALLOW_PLAINTEXT_KEYS=1` development/CI fallback
mirrors the key store and stores a clearly marked plaintext field. Writes go
through a mode-0600
temporary file and an atomic rename (no truncated config after a crash, and
the permission is re-established on every save), and all configuration
mutations (save, switch, clear) are serialized in invocation order inside the
main process so a slow earlier save can never reactivate a provider the user
just cleared. The desktop app enforces a single instance
(`requestSingleInstanceLock`) so those mutations are always serialized within
exactly one main process per `userData`; the acceptance modes use throwaway
`userData` directories and skip the lock.

The renderer sees only a non-sensitive status: active provider (`mock` or
`openai-compatible`), base URL, model name, and whether a key is configured.
The stored key never appears in any status, response, or error sent to the
renderer; a newly typed key travels exactly once, in the save or test request
the user explicitly triggered.

`AiProviderManager` (behind `AiExecutionService`) delegates to the configured
provider and fails closed whenever a persisted real-provider configuration
cannot be used — corrupt file, unreadable path (only a missing file means
"not configured"), invalid fields, unavailable keychain, or an undecryptable
key. Executions are refused with a stable code surfaced in Settings; the app
never silently falls back to the Mock provider, and the `id` exposed for
execution records always names the configured target
(`openai-compatible-v1`), never the internal placeholder.

## Leak Scanner

The scanner receives the sanitized text, the exact allowed restoration-token set
(scoped to this artifact only), a typed denylist of every ProtectedValue in the
Matter, and relevant local row identifiers. Findings contain only a code and
non-sensitive ordinal/position; they never echo the matched secret. UUID-shaped
internal identifiers are rejected even if a repository caller omits one from its
explicit denylist.

The denylist is Matter-wide on purpose: if Privacy Detection missed a value in
this document but the same value is already known from any other document in the
Matter, the scan still blocks it. Allowed restoration tokens remain scoped to
this artifact so tokens from other documents are treated as unknown.

Equivalence classes come from `normalizeProtectedValue` in
`@aliasai/entity-resolution` — the same rules used for Mention matching and
fingerprinting. EMAIL matches case-insensitively with whitespace stripped on
both sides (local-part and domain never legally contain spaces, so
`a @ b.test` and `A@B.TEST` are one equivalence class). Text types match after
NFKC normalization and whitespace collapsing.

Digit types (PHONE, ID_CARD, BANK_ACCOUNT) never search a whole-document digit
stream. After removing our own bracketed token spans, the scanner folds
non-ASCII Unicode decimal digits to ASCII using a mapping derived from the
engine's own `\p{Nd}` data (every Nd block is a ten-code-point 0–9 decade,
including astral scripts such as Osmanya and the chained Mathematical digit
styles), then tokenizes digit groups joined by the exact separator grammar
shared with domain normalization (`NUMBER_GROUP_SEPARATOR_CHARS` in
`@aliasai/entity-resolution`): horizontal spaces, ASCII/Unicode dashes, dots,
middle dots, slashes, parentheses, commas, colons, semicolons, the ideographic
comma, and zero-width format characters — because normalization accepts those
separators inside a stored value, the scanner treats them as transparent too,
so `138:0013:8000` and `6222,0210,0110,1234` are caught. Everything else
(prose, letters, tabs, newlines) is a hard boundary on both sides, and digit
normalization preserves those characters instead of collapsing them, so a
tab- or newline-split rendering is invalid on both sides; Blocks are joined
with `\n\n`, so numbers in different Blocks can never merge, and a value glued
to prose cannot enter the Vault in the first place because normalization
preserves the prose and validation rejects it.

The denylist is pre-indexed by type, and the content is streamed once,
character by character: the matcher keeps only the digit group being read plus
a bounded suffix of the current run (never longer than the longest denied
value plus slack) and, at each group boundary, looks up exactly the window
lengths the denylist can match — a phone window is also tried with a glued
`86` prefix, using the same prefix rule as normalization. Nothing
proportional to the content is materialized, so neither time nor memory
scales with digit-dense adversarial payloads. Windows are normalized exactly
like the denylist side before the typed equality check, so a rendered number
still matches when an extension, year, or `+86` prefix is glued into the same
run. The ID-card check character is matched whenever an X follows run digits,
regardless of the character after it — `777X已登记` is the normal Chinese
rendering — because the 17-digit window must equal a denied value exactly, so
an unrelated `X轴` can never match. The scanner deliberately covers lengths
beyond the domain contract (PHONE is 5–20 digits in the Vault) so legacy
out-of-contract values cannot bypass it. A denied digit value that cannot be
represented by the grammar at all — non-digit characters surviving
normalization, a below-floor value no valid Vault row could hold, or a value
longer than any bounded window — cannot be proven absent from any payload:
the scanner flags it, and `AiExecutionService` rejects the execution up front
with `OUTBOUND_DENYLIST_INTEGRITY_FAILURE`.

An outbound request larger than 5 MiB is rejected with `PAYLOAD_TOO_LARGE`
without being scanned, and `AiExecutionService` refuses to assemble such a
payload in the first place (`OUTBOUND_PAYLOAD_TOO_LARGE`, checked
incrementally while joining Blocks, before any encryption, persistence, or
denylist decryption). Matters with more than 2048 denied values fail closed
with `OUTBOUND_DENYLIST_TOO_LARGE`; the repository caps the denylist read at
one row past that limit so an abnormal Matter never costs an unbounded query.

Residual limitations: digit groups on one line separated only by grammar
separators are treated as one ambiguous run and their concatenation is checked
(fail-closed); an EMAIL substring match may span a whitespace-removed word
boundary (rare, fail-closed). Both block or flag, never silently pass.

The scan is a final outbound safety boundary, not a substitute for Privacy
Detection or Pseudonymization. Any finding prevents provider dispatch and
records `OUTBOUND_LEAK_DETECTED` locally (an oversized request records
`OUTBOUND_PAYLOAD_TOO_LARGE` instead).

Known limitation: the scan still runs synchronously on the Electron main
process. The payload cap, the denylist cap, and the character-level streaming
matcher bound its cost (roughly 0.5s for a pathological 4 MiB all-digit
payload, far less for prose), so the real network provider ships with the scan
in place; moving it off the main thread (for example a worker-process matcher)
remains future hardening work.

## Desktop IPC

The preload allowlist exposes only:

- `ai:execute({ sanitizedDocumentId, includeRestoreOnRequest? })`
- `ai:latest({ sanitizedDocumentId, includeRestoreOnRequest? })`
- `ai:cancel()` — aborts in-flight executions (fail-closed `AI_CANCELLED`)
- `aiProvider:getStatus()` — non-sensitive provider status (key presence only)
- `aiProvider:save({ provider: 'mock' } | { provider: 'openai-compatible',
  baseUrl, model, apiKey? })` — omits `apiKey` to keep the stored key
- `aiProvider:clear()` — deletes the persisted configuration including the key
- `aiProvider:testConnection({ baseUrl?, model?, apiKey? }?)` — probes
  `GET /models` with the form values or the stored configuration

The renderer receives execution metadata, sanitized response text, locally restored
response text, and unresolved token strings. It never receives Mapping Vault rows,
encrypted fields, keys, provider internals, or raw errors.

## Verification Target

The V1 end-to-end tests cover:

```text
synthetic PDF -> Block -> Mention -> Entity -> SanitizedDocument
              -> outbound scan -> provider -> encrypted response
              -> local Rehydration
```

with the provider being the Mock (`packages/application` e2e), the real HTTP
adapter against a loopback OpenAI-compatible fake (`packages/ai` transport
tests: auth header, request shape, HTTP/timeout/abort/oversize/invalid-shape
failures, key-free error messages), and the packaged app itself
(`--provider-self-test`: full chain over the real HTTP adapter plus
restart-recovery of the keychain-wrapped configuration).

Negative tests cover protected plaintext, internal identifiers, unknown/malformed/
missing tokens, provider failure redaction, cross-row ciphertext swaps, database
scope and lifecycle enforcement, and IPC error sanitization.
