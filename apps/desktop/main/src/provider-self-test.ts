import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeRuntime, type AliasAiRuntime } from './runtime'
import { runAcceptanceChain, type SelfTestApp } from './self-test'
import type { SafeStorage } from './keys'

export interface ProviderSelfTestResult {
  readonly stages: readonly string[]
}

const FAKE_MODEL = 'aliasai-fake-model'
const FAKE_API_KEY = 'aliasai-provider-self-test-synthetic-key'

interface CapturedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: string
}

function assert(condition: boolean, stage: string, detail: string): asserts condition {
  if (!condition) throw new Error(`provider self-test failed at ${stage}: ${detail}`)
}

/**
 * A loopback-only, in-process OpenAI-compatible endpoint. It exists purely so
 * the packaged app can prove its real network provider path end to end
 * (authorization header, request shape, response parsing, rehydration) without
 * any external network or paid API. Every request body is captured so the
 * test can assert no protected plaintext ever crossed the wire.
 */
function startFakeEndpoint(): Promise<{ server: Server; baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body
      })
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload)
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
        response.end(text)
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        send(200, { data: [{ id: FAKE_MODEL }] })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { model: string; messages: { content: string }[] }
        send(200, { choices: [{ message: { content: `Local analysis:\n${parsed.messages[0]!.content}` } }] })
        return
      }
      send(404, {})
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests })
    })
  })
}

function assertTransportClean(requests: readonly CapturedRequest[]): void {
  const chatRequests = requests.filter((request) => request.path === '/v1/chat/completions')
  assert(chatRequests.length > 0, 'ai-http-transport', 'no chat completion request reached the endpoint')
  for (const request of requests) {
    assert(request.authorization === `Bearer ${FAKE_API_KEY}`, 'ai-http-transport', 'authorization header mismatch')
    assert(!request.body.includes('110101199003077774'), 'ai-http-transport', 'protected ID crossed the wire')
    assert(!request.body.includes('synthetic@example.test'), 'ai-http-transport', 'protected email crossed the wire')
  }
  for (const request of chatRequests) {
    const parsed = JSON.parse(request.body) as { model: string; stream: boolean; messages: { role: string }[] }
    assert(parsed.model === FAKE_MODEL, 'ai-http-transport', 'model name mismatch in request')
    assert(parsed.stream === false, 'ai-http-transport', 'streaming was requested')
    assert(request.body.includes('〔@'), 'ai-http-transport', 'sanitized tokens missing from request')
  }
}

/**
 * End-to-end acceptance run for the real (network) AI provider path against
 * the packaged app: a loopback fake endpoint stands in for the OpenAI-compatible
 * service, so no real network, account, or API key is involved. Verifies the
 * full chain Matter -> ... -> sanitization -> OpenAI-compatible dispatch ->
 * encrypted persistence -> local rehydration, plus that the provider
 * configuration (key included, OS-keychain-wrapped) survives an application
 * restart.
 */
export async function runProviderSelfTest(
  app: SelfTestApp,
  safeStorage: SafeStorage
): Promise<ProviderSelfTestResult> {
  const stages: string[] = []
  const userData = await mkdtemp(join(tmpdir(), 'aliasai-provider-self-test-'))
  app.setPath('userData', userData)
  const endpoint = await startFakeEndpoint()
  let runtime: AliasAiRuntime | undefined
  try {
    const stage = (name: string): void => {
      stages.push(name)
      console.log(`provider-self-test: ${name}`)
    }

    runtime = await initializeRuntime(app, safeStorage)
    stage('runtime-initialized')

    await runtime.services.aiProvider.configureOpenAi({
      baseUrl: endpoint.baseUrl,
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY
    })
    const status = runtime.services.aiProvider.status()
    assert(status.provider === 'openai-compatible', 'ai-provider-config', 'provider was not activated')
    assert(status.openai?.apiKeyConfigured === true, 'ai-provider-config', 'API key was not registered')
    stage('ai-provider-configured')

    const probe = await runtime.services.aiProvider.testConnection()
    assert(probe.httpStatus === 200, 'ai-provider-probe', 'connection test failed')
    stage('ai-provider-connection-tested')

    const { sanitizedDocumentId, sanitized } = await runAcceptanceChain(runtime, userData, stage)

    const ai = await runtime.services.ai.execute(sanitizedDocumentId, true)
    assert(ai.providerId === 'openai-compatible-v1', 'ai-http', 'execution did not use the network provider')
    assert(ai.sanitizedResponse === `Local analysis:\n${sanitized}`, 'ai-http', 'provider response mismatch')
    assert(!ai.sanitizedResponse.includes('110101199003077774'), 'ai-http', 'provider response leaked a protected value')
    assert(ai.rehydratedResponse.includes('110101199003077774'), 'rehydration', 'ID value was not restored locally')
    assert(ai.rehydratedResponse.includes('synthetic@example.test'), 'rehydration', 'email was not restored locally')
    assert(ai.unresolvedTokens.length === 0, 'rehydration', 'unexpected unresolved tokens')
    assertTransportClean(endpoint.requests)
    stage('ai-http-and-rehydration')

    // Simulate an application restart: the database, sanitized artifact, and
    // the keychain-wrapped provider configuration must all come back.
    runtime.close()
    runtime = undefined
    endpoint.requests.length = 0
    runtime = await initializeRuntime(app, safeStorage)
    const restored = runtime.services.aiProvider.status()
    assert(restored.provider === 'openai-compatible', 'ai-restart', 'provider selection did not survive restart')
    assert(restored.openai?.baseUrl === endpoint.baseUrl, 'ai-restart', 'base URL did not survive restart')
    assert(restored.openai?.model === FAKE_MODEL, 'ai-restart', 'model did not survive restart')
    assert(restored.openai?.apiKeyConfigured === true, 'ai-restart', 'API key did not survive restart')
    const rerun = await runtime.services.ai.execute(sanitizedDocumentId, true)
    assert(rerun.providerId === 'openai-compatible-v1', 'ai-restart', 'restarted execution used the wrong provider')
    assert(rerun.rehydratedResponse.includes('110101199003077774'), 'ai-restart', 'restarted rehydration failed')
    assertTransportClean(endpoint.requests)
    stage('ai-config-survived-restart')

    return { stages }
  } finally {
    runtime?.close()
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()))
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
