import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OpenAiCompatibleProvider,
  OpenAiCompatibleProviderError,
  parseProviderBaseUrl,
  testOpenAiCompatibleConnection
} from '../src'

const API_KEY = 'sk-synthetic-test-key-000'

interface CapturedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly contentType: string | undefined
  readonly body: string
}

/**
 * A real loopback OpenAI-compatible endpoint. Handlers record every request so
 * tests can assert exactly what crossed the wire.
 */
class FakeProviderServer {
  readonly requests: CapturedRequest[] = []
  private readonly server: Server
  private handler: (request: IncomingMessage, response: ServerResponse, body: string) => void = () => {
    throw new Error('no handler installed')
  }

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        this.requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body
        })
        this.handler(request, response, body)
      })
    })
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  respondsWith(handler: FakeProviderServer['handler']): void {
    this.handler = handler
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => (error === undefined ? resolve() : reject(error))))
  }
}

let server: FakeProviderServer

beforeEach(async () => {
  server = new FakeProviderServer()
  await server.listen()
})

afterEach(async () => {
  await server.close()
})

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

describe('OpenAI-compatible provider configuration', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://api.openai.com/v1/',
    'http://127.0.0.1:9000/v1',
    'http://localhost:9000/v1',
    'http://[::1]:9000/v1'
  ])('accepts %s', (baseUrl) => {
    expect(parseProviderBaseUrl(baseUrl).protocol.length).toBeGreaterThan(0)
  })

  it.each([
    ['plaintext off loopback', 'http://api.openai.com/v1'],
    ['unsupported protocol', 'ftp://api.openai.com/v1'],
    ['embedded credentials', 'https://user:secret@api.openai.com/v1'],
    ['query string', 'https://api.openai.com/v1?key=abc'],
    ['fragment', 'https://api.openai.com/v1#section'],
    ['not a URL', 'api.openai.com']
  ])('rejects %s', (_name, baseUrl) => {
    expect(() => parseProviderBaseUrl(baseUrl)).toThrow(OpenAiCompatibleProviderError)
  })

  it('rejects an empty model or API key before any network access', () => {
    expect(() => new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: ' ', apiKey: API_KEY })).toThrow(
      OpenAiCompatibleProviderError
    )
    expect(() => new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: 'gpt-test', apiKey: '' })).toThrow(
      OpenAiCompatibleProviderError
    )
  })
})

describe('OpenAI-compatible provider execution', () => {
  it('sends only the sanitized content with the key in the Authorization header', async () => {
    server.respondsWith((_request, response, body) => {
      const parsed = JSON.parse(body) as { model: string; messages: { role: string; content: string }[]; stream: boolean }
      jsonResponse(response, 200, { choices: [{ message: { content: `回声：${parsed.messages[0]!.content}` } }] })
    })
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY })

    const result = await provider.execute({ content: '原告甲〔@N-ABC123〕提交材料。' })

    expect(result.content).toBe('回声：原告甲〔@N-ABC123〕提交材料。')
    expect(provider.id).toBe('openai-compatible-v1')
    expect(server.requests).toHaveLength(1)
    const sent = server.requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.path).toBe('/v1/chat/completions')
    expect(sent.authorization).toBe(`Bearer ${API_KEY}`)
    expect(sent.contentType).toBe('application/json')
    const parsedBody = JSON.parse(sent.body)
    expect(parsedBody).toEqual({
      model: 'gpt-synthetic',
      messages: [{ role: 'user', content: '原告甲〔@N-ABC123〕提交材料。' }],
      stream: false
    })
    expect(sent.body).not.toContain(API_KEY)
  })

  it.each([
    ['unauthorized', 401],
    ['rate limited', 429],
    ['server error', 500]
  ])('fails closed on HTTP %s without echoing the response body', async (_name, status) => {
    server.respondsWith((_request, response) => jsonResponse(response, status, { error: 'secret diagnostic 13800138000' }))
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY })

    const error = await provider.execute({ content: 'synthetic' }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).code).toBe('PROVIDER_HTTP_ERROR')
    expect((error as OpenAiCompatibleProviderError).httpStatus).toBe(status)
    expect((error as OpenAiCompatibleProviderError).message).toBe(
      `AI provider endpoint returned HTTP ${status}`
    )
    expect((error as OpenAiCompatibleProviderError).message).not.toContain(API_KEY)
  })

  it.each([
    ['not JSON', 'not-json'],
    ['empty choices', '{"choices":[]}'],
    ['missing message', '{"choices":[{}]}'],
    ['non-string content', '{"choices":[{"message":{"content":42}}]}'],
    ['empty content', '{"choices":[{"message":{"content":""}}]}']
  ])('fails closed when the response is %s', async (_name, body) => {
    server.respondsWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE'
    })
  })

  it('refuses a response body larger than the byte ceiling while streaming', async () => {
    server.respondsWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(`{"choices":[{"message":{"content":"${'x'.repeat(4096)}"}}]}`)
    })
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      maxResponseBytes: 2048
    })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE'
    })
  })

  it('cancels the transfer once the streaming body exceeds the byte ceiling', async () => {
    let connectionClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      connectionClosed = resolve
    })
    server.respondsWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.once('close', connectionClosed)
      // Far beyond the ceiling, and the socket is deliberately left open.
      response.write(`{"choices":[{"message":{"content":"${'x'.repeat(4096)}"}`)
    })
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      maxResponseBytes: 2048
    })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE'
    })
    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still-open'), 3_000))
    ])
    expect(outcome).toBe('closed')
  }, 10_000)

  it('classifies a stalled response body as a timeout, not a raw DOMException', async () => {
    server.respondsWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '512' })
      response.write('{"choices":[{"message":{"content":"partial')
    })
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      timeoutMs: 1_000
    })

    const error = await provider.execute({ content: 'synthetic' }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).code).toBe('PROVIDER_TIMEOUT')
    expect((error as OpenAiCompatibleProviderError).message).not.toContain(API_KEY)
  }, 15_000)

  it('classifies caller cancellation during the response body phase', async () => {
    server.respondsWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"choices":')
    })
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      timeoutMs: 120_000
    })
    const controller = new AbortController()
    const pending = provider.execute({ content: 'synthetic', signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    const error = await pending.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).code).toBe('PROVIDER_ABORTED')
  })

  it('refuses an oversized response before reading it when content-length declares it', async () => {
    server.respondsWith((_request, response) => {
      const body = `{"choices":[{"message":{"content":"${'x'.repeat(4096)}"}}]}`
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
    })
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      maxResponseBytes: 2048
    })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE'
    })
  })

  it('times out when the endpoint hangs', async () => {
    server.respondsWith(() => undefined)
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      timeoutMs: 1_000
    })

    const error = await provider.execute({ content: 'synthetic' }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).code).toBe('PROVIDER_TIMEOUT')
    expect((error as OpenAiCompatibleProviderError).message).not.toContain(API_KEY)
  }, 15_000)

  it('aborts promptly when the caller cancels', async () => {
    server.respondsWith(() => undefined)
    const provider = new OpenAiCompatibleProvider({
      baseUrl: server.baseUrl,
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      timeoutMs: 120_000
    })
    const controller = new AbortController()
    const pending = provider.execute({ content: 'synthetic', signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    const error = await pending.catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).code).toBe('PROVIDER_ABORTED')
  })

  it('fails closed on a redirecting endpoint', async () => {
    server.respondsWith((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(302, { location: `${server.baseUrl}/elsewhere` })
        response.end()
        return
      }
      jsonResponse(response, 200, { choices: [{ message: { content: 'redirected' } }] })
    })
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_NETWORK_ERROR'
    })
  })

  it('fails closed on an unreachable endpoint', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'gpt-synthetic',
      apiKey: API_KEY,
      timeoutMs: 2_000
    })

    await expect(provider.execute({ content: 'synthetic' })).rejects.toMatchObject({
      code: 'PROVIDER_NETWORK_ERROR'
    })
  })
})

describe('OpenAI-compatible connection test', () => {
  it('probes the models endpoint without document content', async () => {
    server.respondsWith((request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        jsonResponse(response, 200, { data: [{ id: 'gpt-synthetic' }] })
        return
      }
      response.writeHead(404)
      response.end()
    })

    const result = await testOpenAiCompatibleConnection(
      { baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY },
      5_000
    )

    expect(result.httpStatus).toBe(200)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]!.body).toBe('')
    expect(server.requests[0]!.authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('surfaces authentication failures as HTTP errors', async () => {
    server.respondsWith((_request, response) => jsonResponse(response, 401, { error: 'bad key' }))

    const error = await testOpenAiCompatibleConnection(
      { baseUrl: server.baseUrl, model: 'gpt-synthetic', apiKey: API_KEY },
      5_000
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(OpenAiCompatibleProviderError)
    expect((error as OpenAiCompatibleProviderError).httpStatus).toBe(401)
    expect((error as OpenAiCompatibleProviderError).message).not.toContain(API_KEY)
  })
})
