import {
  AiLeakDetectedError,
  MAX_OUTBOUND_PAYLOAD_BYTES,
  assertSafeOutboundPayload,
  isDeniedValueIndexable,
  type AiProvider,
  type DeniedProtectedValue
} from '@aliasai/ai'
import { decrypt, encrypt, generateUuidV7 } from '@aliasai/crypto'
import type { AiExecution } from '@aliasai/domain'
import type {
  AiExecutionRecord,
  AiExecutionRepository,
  AiExecutionSource
} from '@aliasai/database'
import type { ApplicationKeys } from './index'
import type { RehydrationResult, RehydrationService } from './sanitization'
import { protectedValueContext } from './entity-resolution'
import { sanitizedBlockTextContext } from './sanitization'

const MAX_AI_RESPONSE_BYTES = 5 * 1024 * 1024

/**
 * Hard ceiling on Matter denylist entries: the outbound scan's text-type
 * checks are one substring pass per denied value, so an unbounded denylist
 * would scale scan time with Matter size. Matters beyond the cap fail closed
 * instead of silently degrading the outbound boundary. The repository query
 * reads at most one row past this cap (see findSource in packages/database).
 */
const MAX_OUTBOUND_DENIED_VALUES = 2048

export type AiExecutionView =
  | {
      readonly id: string
      readonly sanitizedDocumentId: string
      readonly providerId: string
      readonly status: 'RUNNING'
      readonly createdAt: number
    }
  | {
      readonly id: string
      readonly sanitizedDocumentId: string
      readonly providerId: string
      readonly status: 'FAILED'
      readonly errorCode: string
      readonly createdAt: number
      readonly finishedAt: number
    }
  | {
      readonly id: string
      readonly sanitizedDocumentId: string
      readonly providerId: string
      readonly status: 'COMPLETED'
      readonly sanitizedResponse: string
      readonly rehydratedResponse: string
      readonly unresolvedTokens: readonly string[]
      readonly createdAt: number
      readonly finishedAt: number
    }

type AiExecutionStore = Pick<
  AiExecutionRepository,
  'findSource' | 'begin' | 'complete' | 'fail' | 'findById' | 'findLatest'
>

type LocalRehydrator = Pick<RehydrationService, 'rehydrate'>

export type AiExecutionIdFactory = (timestamp: number) => string

export class AiExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'AiExecutionError'
  }
}

export function aiExecutionRequestContext(executionId: string): Buffer {
  return Buffer.from(`${executionId}:aiExecution.request`)
}

export function aiExecutionResponseContext(executionId: string): Buffer {
  return Buffer.from(`${executionId}:aiExecution.response`)
}

export function aiExecutionErrorContext(executionId: string): Buffer {
  return Buffer.from(`${executionId}:aiExecution.error`)
}

/**
 * Sends only an immutable persisted SanitizedDocument to a narrow provider
 * port. Mapping Vault rows and decrypted values exist only long enough to run
 * the local outbound verifier and rehydrator; neither crosses the provider
 * boundary.
 */
export class AiExecutionService {
  constructor(
    private readonly executions: AiExecutionStore,
    private readonly rehydration: LocalRehydrator,
    private readonly provider: AiProvider,
    private readonly keys: ApplicationKeys,
    private readonly now: () => number = Date.now,
    private readonly generateId: AiExecutionIdFactory = generateUuidV7
  ) {
    if (provider.id.trim().length === 0) throw new Error('AI provider id must not be empty')
  }

  async execute(
    sanitizedDocumentId: string,
    includeRestoreOnRequest = false
  ): Promise<Extract<AiExecutionView, { status: 'COMPLETED' }>> {
    let source: AiExecutionSource | undefined
    try {
      source = this.executions.findSource(sanitizedDocumentId)
    } catch (error) {
      throw new AiExecutionError('AI_SOURCE_INTEGRITY_FAILURE', 'Sanitized Document failed integrity validation', {
        cause: error
      })
    }
    if (source === undefined) {
      throw new AiExecutionError('SANITIZED_DOCUMENT_NOT_AVAILABLE', 'Sanitized Document is not available for AI')
    }
    if (source.matterDenylist.length > MAX_OUTBOUND_DENIED_VALUES) {
      throw new AiExecutionError('OUTBOUND_DENYLIST_TOO_LARGE', 'Matter denylist exceeds the outbound scan capacity')
    }

    const content = this.joinProviderContent(source)
    const startedAt = this.now()
    const executionId = this.generateId(startedAt)
    const requestCipher = this.encryptText(content, aiExecutionRequestContext(executionId))
    const execution: AiExecution = {
      id: executionId,
      matterId: source.sanitizedDocument.matterId,
      sanitizedDocumentId,
      providerId: this.provider.id,
      status: 'RUNNING',
      createdAt: startedAt,
      startedAt
    }
    try {
      this.executions.begin({ execution, requestCipher })
    } catch (error) {
      throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'AI execution could not be started', { cause: error })
    } finally {
      requestCipher.fill(0)
    }

    let completed: AiExecutionRecord
    let sanitizedResponse: string
    try {
      this.verifyOutbound(content, source, executionId)
      let response: Awaited<ReturnType<AiProvider['execute']>>
      try {
        response = await this.provider.execute({ content })
      } catch (error) {
        throw new AiExecutionError('AI_PROVIDER_FAILURE', 'AI provider request failed', {
          cause: error
        })
      }
      if (
        typeof response?.content !== 'string' ||
        response.content.length === 0 ||
        Buffer.byteLength(response.content, 'utf8') > MAX_AI_RESPONSE_BYTES
      ) {
        throw new AiExecutionError('INVALID_PROVIDER_RESPONSE', 'AI provider returned an invalid response')
      }
      sanitizedResponse = response.content
      completed = this.persistResponse(executionId, response.content)
    } catch (error) {
      const failure = this.normalizeFailure(error)
      this.persistFailure(executionId, failure)
      throw failure
    }
    return this.toCompletedView(completed, sanitizedResponse, includeRestoreOnRequest)
  }

  findLatest(sanitizedDocumentId: string, includeRestoreOnRequest = false): AiExecutionView | undefined {
    const execution = this.executions.findLatest(sanitizedDocumentId)
    return execution === undefined ? undefined : this.toView(execution, includeRestoreOnRequest)
  }

  /** Reloads one persisted result for an explicit local copy/export action. */
  getCompleted(executionId: string, includeRestoreOnRequest = false): Extract<AiExecutionView, { status: 'COMPLETED' }> {
    const execution = this.executions.findById(executionId)
    if (execution === undefined || execution.status !== 'COMPLETED') {
      throw new AiExecutionError('AI_RESULT_NOT_AVAILABLE', 'Completed AI result is not available')
    }
    return this.toView(execution, includeRestoreOnRequest) as Extract<AiExecutionView, { status: 'COMPLETED' }>
  }

  private toView(execution: AiExecutionRecord, includeRestoreOnRequest: boolean): AiExecutionView {
    if (execution.status === 'RUNNING') {
      return {
        id: execution.id,
        sanitizedDocumentId: execution.sanitizedDocumentId,
        providerId: execution.providerId,
        status: 'RUNNING',
        createdAt: execution.createdAt
      }
    }
    if (execution.status === 'FAILED') {
      if (execution.errorCipher === undefined || execution.finishedAt === undefined) {
        throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'Failed AI execution is incomplete')
      }
      return {
        id: execution.id,
        sanitizedDocumentId: execution.sanitizedDocumentId,
        providerId: execution.providerId,
        status: 'FAILED',
        errorCode: this.decryptErrorCode(execution),
        createdAt: execution.createdAt,
        finishedAt: execution.finishedAt
      }
    }
    if (execution.responseCipher === undefined) {
      throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'Completed AI execution is missing its response')
    }
    const response = this.decryptText(
      execution.responseCipher,
      aiExecutionResponseContext(execution.id),
      'AI_RESPONSE_DECRYPTION_FAILED'
    )
    return this.toCompletedView(execution, response, includeRestoreOnRequest)
  }

  /**
   * Decrypts sanitized Blocks and joins them in order, refusing to assemble a
   * payload beyond the outbound cap. The check is incremental — an oversized
   * artifact is rejected before its plaintext is fully joined, encrypted, or
   * persisted as a RUNNING request, and before the denylist is decrypted.
   */
  private joinProviderContent(source: AiExecutionSource): string {
    const blocks: string[] = []
    let totalBytes = 0
    for (const block of source.blocks) {
      const text = this.decryptText(
        block.textCipher,
        sanitizedBlockTextContext(block.id),
        'SANITIZED_BLOCK_DECRYPTION_FAILED'
      )
      if (blocks.length > 0) totalBytes += 2 // the '\n\n' joiner
      totalBytes += Buffer.byteLength(text, 'utf8')
      if (totalBytes > MAX_OUTBOUND_PAYLOAD_BYTES) {
        throw new AiExecutionError('OUTBOUND_PAYLOAD_TOO_LARGE', 'AI request exceeds the outbound payload limit')
      }
      blocks.push(text)
    }
    return blocks.join('\n\n')
  }

  private verifyOutbound(content: string, source: AiExecutionSource, executionId: string): void {
    const deniedValues: DeniedProtectedValue[] = []
    const transientValues: Buffer[] = []
    try {
      // The denylist is Matter-wide: values known from any document in this
      // Matter are denied here even when this artifact never mapped them.
      for (const denied of source.matterDenylist) {
        const value = decrypt(
          denied.valueCipher,
          this.keys.persistenceKey,
          protectedValueContext(denied.id)
        )
        transientValues.push(value)
        deniedValues.push({ type: denied.valueType, value: value.toString('utf8') })
      }
      // A denylist value the streaming matcher cannot index (legacy rows
      // normalized under the old whitespace-collapsing rules, or digit values
      // beyond any bounded window) can never be proven absent, so execution
      // fails closed with an integrity error instead of dispatching. Only the
      // stable code is persisted; the value itself never reaches logs or IPC.
      if (deniedValues.some((entry) => !isDeniedValueIndexable(entry.type, entry.value))) {
        throw new AiExecutionError(
          'OUTBOUND_DENYLIST_INTEGRITY_FAILURE',
          'Matter denylist holds a value the outbound scan cannot verify'
        )
      }
      assertSafeOutboundPayload({
        content,
        allowedTokens: new Set(source.mappings.map((mapping) => mapping.publicToken)),
        deniedValues,
        forbiddenIdentifiers: [...source.internalIdentifiers, executionId]
      })
    } catch (error) {
      if (error instanceof AiLeakDetectedError) {
        throw new AiExecutionError('OUTBOUND_LEAK_DETECTED', 'AI request failed privacy verification', {
          cause: error
        })
      }
      if (error instanceof AiExecutionError) throw error
      throw new AiExecutionError('MAPPING_DECRYPTION_FAILED', 'AI privacy verification could not read Mapping Vault', {
        cause: error
      })
    } finally {
      for (const value of transientValues) value.fill(0)
      deniedValues.length = 0
    }
  }

  private toCompletedView(
    execution: AiExecutionRecord,
    sanitizedResponse: string,
    includeRestoreOnRequest: boolean
  ): Extract<AiExecutionView, { status: 'COMPLETED' }> {
    if (execution.finishedAt === undefined) {
      throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'Completed AI execution is missing finishedAt')
    }
    let restored: RehydrationResult
    try {
      restored = this.rehydration.rehydrate({
        sanitizedDocumentId: execution.sanitizedDocumentId,
        text: sanitizedResponse,
        includeRestoreOnRequest
      })
    } catch (error) {
      throw new AiExecutionError('AI_REHYDRATION_FAILED', 'AI response could not be rehydrated locally', {
        cause: error
      })
    }
    return {
      id: execution.id,
      sanitizedDocumentId: execution.sanitizedDocumentId,
      providerId: execution.providerId,
      status: 'COMPLETED',
      sanitizedResponse,
      rehydratedResponse: restored.text,
      unresolvedTokens: restored.unresolvedTokens,
      createdAt: execution.createdAt,
      finishedAt: execution.finishedAt
    }
  }

  private normalizeFailure(error: unknown): AiExecutionError {
    if (error instanceof AiExecutionError) return error
    return new AiExecutionError('AI_PROVIDER_FAILURE', 'AI provider request failed', {
      cause: error
    })
  }

  private persistResponse(executionId: string, response: string): AiExecutionRecord {
    let responseCipher: Buffer | undefined
    try {
      responseCipher = this.encryptText(response, aiExecutionResponseContext(executionId))
      return this.executions.complete(executionId, responseCipher, this.now())
    } catch (error) {
      throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'AI response could not be persisted', {
        cause: error
      })
    } finally {
      responseCipher?.fill(0)
    }
  }

  private persistFailure(executionId: string, failure: AiExecutionError): void {
    const errorCipher = this.encryptText(
      JSON.stringify({ code: failure.code }),
      aiExecutionErrorContext(executionId)
    )
    try {
      this.executions.fail(executionId, errorCipher, this.now())
    } catch (stateError) {
      throw new AiExecutionError('AI_PERSISTENCE_FAILURE', 'AI execution failure could not be persisted', {
        cause: new AggregateError([failure, stateError])
      })
    } finally {
      errorCipher.fill(0)
    }
  }

  private decryptErrorCode(execution: AiExecutionRecord): string {
    const payload = this.decryptText(
      execution.errorCipher!,
      aiExecutionErrorContext(execution.id),
      'AI_ERROR_DECRYPTION_FAILED'
    )
    try {
      const parsed = JSON.parse(payload) as unknown
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('code' in parsed) ||
        typeof parsed.code !== 'string' ||
        parsed.code.length === 0
      ) {
        throw new Error('invalid AI error payload')
      }
      return parsed.code
    } catch (error) {
      throw new AiExecutionError('AI_ERROR_DECRYPTION_FAILED', 'AI execution error could not be read', { cause: error })
    }
  }

  private encryptText(text: string, context: Buffer): Buffer {
    const bytes = Buffer.from(text, 'utf8')
    try {
      return encrypt(bytes, this.keys.persistenceKey, context)
    } finally {
      bytes.fill(0)
    }
  }

  private decryptText(cipher: Buffer, context: Buffer, code: string): string {
    let bytes: Buffer
    try {
      bytes = decrypt(cipher, this.keys.persistenceKey, context)
    } catch (error) {
      throw new AiExecutionError(code, 'Encrypted AI field could not be decrypted', { cause: error })
    }
    try {
      return bytes.toString('utf8')
    } finally {
      bytes.fill(0)
    }
  }
}
