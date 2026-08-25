import type { AiProvider, AiProviderRequest, AiProviderResponse } from './index'

/** Bounded transport timeout owned by the network adapter, never by the caller. */
export const DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS = 120_000

/**
 * Hard ceiling on a provider HTTP response body (JSON envelope included). The
 * application layer caps provider output at the same 5 MiB, so a body that
 * fits here can still pass that check; anything larger is refused while it is
 * still streaming in.
 */
export const MAX_OPENAI_COMPATIBLE_RESPONSE_BYTES = 5 * 1024 * 1024

/** Stable, non-secret identifiers persisted with each execution row. */
export const MOCK_PROVIDER_ID = 'mock-v1'
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible-v1'

export type OpenAiCompatibleProviderErrorCode =
  | 'PROVIDER_CONFIG_INVALID'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_HTTP_ERROR'
  | 'PROVIDER_RESPONSE_TOO_LARGE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_NETWORK_ERROR'

/**
 * Static, key-free error surface: messages carry at most an HTTP status code.
 * The API key, request content, and response body never appear in them, so
 * these errors can safely cross the main-process boundary (test-connection UI)
 * without echoing sensitive material.
 */
export class OpenAiCompatibleProviderError extends Error {
  constructor(
    readonly code: OpenAiCompatibleProviderErrorCode,
    message: string,
    readonly httpStatus?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OpenAiCompatibleProviderError'
  }
}

export interface OpenAiCompatibleProviderConfig {
  /** Base URL including the version path, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string
  readonly model: string
  /** Lives only in main-process memory; never logged, persisted plaintext, or sent to the renderer. */
  readonly apiKey: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

export interface ResolvedOpenAiCompatibleConfig {
  readonly endpointBase: string
  readonly model: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]', '::1'])

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  // Any 127.0.0.0/8 address is loopback; IPv6 literals keep their brackets.
  if (/^\[?127\.\d{1,3}\.\d{1,3}\.\d{1,3}\]?$/.test(hostname)) return true
  return hostname === '::1'
}

/**
 * Validates the endpoint URL fail-closed: HTTP(S) only, HTTPS unless the host
 * is loopback (local models and self-tests), and no credentials, query, or
 * fragment — the API key travels exclusively in the Authorization header.
 */
export function parseProviderBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider base URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_CONFIG_INVALID',
      'AI provider base URL must use HTTPS (HTTP is allowed only on a loopback host)'
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_CONFIG_INVALID',
      'AI provider base URL must not embed credentials'
    )
  }
  if (url.search !== '' || url.hash !== '') {
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_CONFIG_INVALID',
      'AI provider base URL must not include a query or fragment'
    )
  }
  return url
}

export function resolveOpenAiCompatibleConfig(config: OpenAiCompatibleProviderConfig): ResolvedOpenAiCompatibleConfig {
  const url = parseProviderBaseUrl(config.baseUrl)
  if (typeof config.model !== 'string' || config.model.trim().length === 0 || config.model.length > 200) {
    throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider model name is invalid')
  }
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0 || config.apiKey.length > 4096) {
    throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider API key is invalid')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_OPENAI_COMPATIBLE_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider timeout is out of range')
  }
  const maxResponseBytes = config.maxResponseBytes ?? MAX_OPENAI_COMPATIBLE_RESPONSE_BYTES
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_OPENAI_COMPATIBLE_RESPONSE_BYTES) {
    throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider response limit is out of range')
  }
  return {
    endpointBase: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`,
    model: config.model,
    apiKey: config.apiKey,
    timeoutMs,
    maxResponseBytes
  }
}

/**
 * Reads a response body while enforcing the byte ceiling on the streaming
 * chunks. An oversized body is cancelled (not merely released) so a hostile
 * endpoint cannot keep the connection open after the limit is exceeded.
 */
async function readBodyWithLimit(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new OpenAiCompatibleProviderError(
        'PROVIDER_RESPONSE_TOO_LARGE',
        `${label} exceeds the AI provider response limit`
      )
    }
  }
  if (response.body === null) {
    throw new OpenAiCompatibleProviderError('PROVIDER_INVALID_RESPONSE', 'AI provider returned an empty body')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      if (value !== undefined) {
        received += value.byteLength
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new OpenAiCompatibleProviderError(
            'PROVIDER_RESPONSE_TOO_LARGE',
            `${label} exceeds the AI provider response limit`
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(body)
}

/**
 * Body-phase error mapping: `fetch` has already resolved by the time headers
 * arrived, so an abort or connection reset during `reader.read()` surfaces as
 * a raw DOMException. This re-classifies it with the same stable codes the
 * dispatch phase uses, so nothing unclassified ever escapes the provider.
 */
async function readBodyMapped(
  response: Response,
  config: ResolvedOpenAiCompatibleConfig,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  label: string
): Promise<string> {
  try {
    return await readBodyWithLimit(response, config.maxResponseBytes, label)
  } catch (error) {
    if (error instanceof OpenAiCompatibleProviderError) throw error
    if (isAborted(externalSignal)) {
      throw new OpenAiCompatibleProviderError('PROVIDER_ABORTED', 'AI provider request was cancelled', undefined, {
        cause: error
      })
    }
    if (timeoutSignal.aborted) {
      throw new OpenAiCompatibleProviderError('PROVIDER_TIMEOUT', 'AI provider request timed out', undefined, {
        cause: error
      })
    }
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_NETWORK_ERROR',
      'AI provider response could not be read',
      undefined,
      { cause: error }
    )
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

interface DispatchResult {
  readonly response: Response
  readonly timeoutSignal: AbortSignal
}

/**
 * One request through the shared transport rules: bounded timeout, caller
 * cancellation, no redirects (an endpoint that tries to redirect the
 * Authorization header elsewhere fails closed), and no retries.
 */
async function dispatch(
  endpoint: string,
  init: RequestInit,
  config: ResolvedOpenAiCompatibleConfig,
  externalSignal: AbortSignal | undefined
): Promise<DispatchResult> {
  if (isAborted(externalSignal)) {
    throw new OpenAiCompatibleProviderError('PROVIDER_ABORTED', 'AI provider request was cancelled')
  }
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = externalSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, externalSignal])
  let response: Response
  try {
    response = await fetch(endpoint, { ...init, signal, redirect: 'error' })
  } catch (error) {
    if (isAborted(externalSignal)) {
      throw new OpenAiCompatibleProviderError('PROVIDER_ABORTED', 'AI provider request was cancelled', undefined, {
        cause: error
      })
    }
    if (timeoutSignal.aborted) {
      throw new OpenAiCompatibleProviderError('PROVIDER_TIMEOUT', 'AI provider request timed out', undefined, {
        cause: error
      })
    }
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_NETWORK_ERROR',
      'AI provider endpoint could not be reached',
      undefined,
      { cause: error }
    )
  }
  return { response, timeoutSignal }
}

function assertHttpSuccess(response: Response): void {
  if (response.ok) return
  response.body?.cancel().catch(() => undefined)
  throw new OpenAiCompatibleProviderError(
    'PROVIDER_HTTP_ERROR',
    `AI provider endpoint returned HTTP ${response.status}`,
    response.status
  )
}

function parseChatCompletion(body: string, maxBytes: number): string {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch (error) {
    throw new OpenAiCompatibleProviderError(
      'PROVIDER_INVALID_RESPONSE',
      'AI provider response was not valid JSON',
      undefined,
      { cause: error }
    )
  }
  const content = (payload as { choices?: unknown } | null)?.choices
  if (!Array.isArray(content) || content.length === 0) {
    throw new OpenAiCompatibleProviderError('PROVIDER_INVALID_RESPONSE', 'AI provider response has no choices')
  }
  const message = (content[0] as { message?: unknown } | null)?.message
  const text = (message as { content?: unknown } | null)?.content
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new OpenAiCompatibleProviderError('PROVIDER_INVALID_RESPONSE', 'AI provider response content is invalid')
  }
  return text
}

/**
 * OpenAI-chat-completions-compatible network provider. It implements the same
 * narrow port as the Mock provider — a single sanitized content string in, a
 * single pseudonymized string out — and owns every transport concern itself:
 * bounded timeout, cancellation, response-size ceiling, redirect refusal, and
 * fail-closed validation of the response shape.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID
  private readonly config: ResolvedOpenAiCompatibleConfig

  constructor(config: OpenAiCompatibleProviderConfig) {
    this.config = resolveOpenAiCompatibleConfig(config)
  }

  async execute(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (request.content.length === 0) {
      throw new OpenAiCompatibleProviderError('PROVIDER_CONFIG_INVALID', 'AI provider content must not be empty')
    }
    const { response, timeoutSignal } = await dispatch(
      `${this.config.endpointBase}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: request.content }],
          stream: false
        })
      },
      this.config,
      request.signal
    )
    assertHttpSuccess(response)
    const body = await readBodyMapped(response, this.config, request.signal, timeoutSignal, 'AI provider response')
    return { content: parseChatCompletion(body, this.config.maxResponseBytes) }
  }
}

export interface OpenAiConnectionTestResult {
  readonly httpStatus: number
}

/**
 * Lightweight reachability probe against the configured endpoint
 * (`GET /models`) using the same transport rules as real executions. It never
 * sends document content; only the Authorization header and the model-less
 * endpoint matter here.
 */
export async function testOpenAiCompatibleConnection(
  config: OpenAiCompatibleProviderConfig,
  timeoutMs?: number
): Promise<OpenAiConnectionTestResult> {
  const resolved = resolveOpenAiCompatibleConfig(timeoutMs === undefined ? config : { ...config, timeoutMs })
  const { response, timeoutSignal } = await dispatch(
    `${resolved.endpointBase}/models`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${resolved.apiKey}`,
        accept: 'application/json'
      }
    },
    resolved,
    undefined
  )
  assertHttpSuccess(response)
  await readBodyMapped(
    response,
    resolved,
    undefined,
    timeoutSignal,
    'AI provider connection test response'
  )
  return { httpStatus: response.status }
}
