import type { DocumentSummaryDTO } from '@aliasai/application'
import { DocumentAnalysisError, WorkspaceLifecycleError } from '@aliasai/application'
import { IpcShutdownError } from '../ipc-operations'
import { IpcValidationError, optionalBoolean, optionalText, requireEnum, requireId, requireNonNegativeInteger, requireText } from './validate'
import { toIpcResult, type IpcResult } from './errors'
import type { AliasAiChannel, AliasAiInvokeMap } from './contract'
import type { AliasAiRuntime } from '../runtime'

/** Host capabilities the registry needs beyond the application services. */
export interface HandlerHost {
  /** Opens the OS file picker filtered to PDFs; returns null when cancelled. */
  readonly pickPdf: () => Promise<string | null>
  /** Explicitly copies a locally reloaded result to the OS clipboard. */
  readonly copyText: (text: string) => void
  /** Opens the OS save dialog and writes only after the user chooses a path. */
  readonly saveText: (suggestedName: string, text: string) => Promise<boolean>
}

export type HandlerRegistry = {
  readonly [K in AliasAiChannel]: (payload: unknown) => Promise<IpcResult<AliasAiInvokeMap[K]['response']>>
}

/**
 * Pure channel registry: no Electron imports, so the whole IPC surface is
 * unit-testable over a real in-memory service graph. Every handler validates
 * its payload, runs the service, and funnels errors through toIpcResult.
 */
export function createHandlerRegistry(runtime: AliasAiRuntime, host: HandlerHost): HandlerRegistry {
  const { services } = runtime
  // Every handler executes under shutdown protection: in-flight operations
  // are awaited by runtime.shutdown() before SQLite closes, and operations
  // arriving after shutdown began fail fast with a coded envelope.
  const guarded = <T>(operation: () => Promise<T>): Promise<T> => runtime.ipcOperations.run(operation)

  const persistedDocumentStatus = (documentId: string) => services.reviewQuery.getDocumentStatus(documentId)
  const documentStatus = (documentId: string) => {
    const status = persistedDocumentStatus(documentId)
    if (status.document.parseStatus === 'READY' || status.document.parseStatus === 'SANITIZED') {
      runtime.analysisRunner.clearFailure(documentId)
    }
    if (runtime.analysisRunner.failureFor(documentId) !== undefined) {
      throw new DocumentAnalysisError(
        'ANALYSIS_FAILURE_UNRECORDED',
        'Automatic analysis stopped before its failure could be saved'
      )
    }
    return status
  }
  /**
   * A scheduled analysis occupies the runner BEFORE any persisted state or
   * RUNNING job exists (the orchestrator defers into a fresh macrotask), so
   * lifecycle guards that only inspect the database would let a Document be
   * trashed mid-schedule. The runner's in-process reservation closes that
   * window: trashing something it is about to analyze is a busy failure.
   */
  const assertNoScheduledAnalysis = (documentId: string): void => {
    if (runtime.analysisRunner.isActive(documentId)) {
      throw new WorkspaceLifecycleError('DOCUMENT_BUSY', 'Document analysis is scheduled or running')
    }
  }
  const importedSummary = async (matterId: string, documentId: string): Promise<DocumentSummaryDTO> => {
    const found = services.reviewQuery.listDocuments(matterId).find((document) => document.id === documentId)
    if (found === undefined) throw new Error('imported document summary was not found')
    return found
  }
  const loadAiResult = (payload: unknown): { text: string; suggestedName: string } => {
    const executionId = requireId(readField(payload, 'executionId'), 'executionId')
    const variant = requireEnum(readField(payload, 'variant'), ['SANITIZED', 'REHYDRATED'], 'variant')
    const includeRestoreOnRequest = optionalBoolean(
      readOptionalField(payload, 'includeRestoreOnRequest'),
      'includeRestoreOnRequest',
      false
    )
    const execution = services.ai.getCompleted(executionId, includeRestoreOnRequest)
    return variant === 'SANITIZED'
      ? { text: execution.sanitizedResponse, suggestedName: 'AliasAI-sanitized-response.txt' }
      : { text: execution.rehydratedResponse, suggestedName: 'AliasAI-restored-response.txt' }
  }

  const buildHandlers = (): HandlerRegistry => ({
    'matter:list': (payload) =>
      toIpcResult(() => {
        requireEmpty(payload)
        return services.reviewQuery.listMatters()
      }),
    'matter:create': (payload) =>
      toIpcResult(() => {
        const name = requireText(readField(payload, 'name'), 'name', 200)
        const created = services.matters.create(name)
        const summary = services.reviewQuery.listMatters().find((matter) => matter.id === created.id)
        if (summary === undefined) throw new Error('created matter summary was not found')
        return summary
      }),
    'matter:trash': (payload) =>
      toIpcResult(() => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        const matterDocuments = services.reviewQuery.listDocuments(matterId)
        for (const document of matterDocuments) {
          assertNoScheduledAnalysis(document.id)
        }
        const result = services.lifecycle.trashMatter(matterId)
        for (const document of matterDocuments) runtime.analysisRunner.clearFailure(document.id)
        return result
      }),
    'matter:restore': (payload) =>
      toIpcResult(() => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        return services.lifecycle.restoreMatter(matterId)
      }),
    'trash:list': (payload) =>
      toIpcResult(() => {
        requireEmpty(payload)
        return services.lifecycle.listTrash()
      }),
    'document:pickAndImport': (payload) =>
      toIpcResult(async () => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        const filePath = await host.pickPdf()
        if (filePath === null) return null
        const imported = await services.importDocs.importFromPath(matterId, filePath)
        const summary = await importedSummary(matterId, imported.id)
        // Analysis continues in the background; the renderer gets its summary
        // immediately. A scheduling refusal leaves the Document visible with
        // its persisted state and never rolls back the import.
        runtime.analysisRunner.start(imported.id)
        return summary
      }),
    'document:list': (payload) =>
      toIpcResult(() => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        return services.reviewQuery.listDocuments(matterId)
      }),
    'document:get': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        return documentStatus(documentId)
      }),
    // Automatic analysis entry point: validates availability, registers the
    // background run, and returns without waiting for any pipeline stage.
    'document:analyze': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        // Unknown, trashed, or Matter-deleted Documents fail closed here with
        // the coded DOCUMENT_NOT_FOUND error instead of a background failure.
        persistedDocumentStatus(documentId)
        return { accepted: runtime.analysisRunner.start(documentId) }
      }),
    // Diagnostic/compatibility stage channels for this milestone: kept so
    // tooling and tests can drive single stages, but no production renderer
    // component calls them — document:analyze composes the full pipeline.
    'document:process': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.processing.process(documentId)
        runtime.analysisRunner.clearFailure(documentId)
        return documentStatus(documentId)
      }),
    'document:detect': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.detection.detect(documentId)
        runtime.analysisRunner.clearFailure(documentId)
        return documentStatus(documentId)
      }),
    'document:resolve': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.resolution.resolve(documentId)
        runtime.analysisRunner.clearFailure(documentId)
        return documentStatus(documentId)
      }),
    'document:trash': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        assertNoScheduledAnalysis(documentId)
        const result = services.lifecycle.trashDocument(documentId)
        runtime.analysisRunner.clearFailure(documentId)
        return result
      }),
    'document:restore': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        return services.lifecycle.restoreDocument(documentId)
      }),
    'document:pickAndReplace': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        // Fail fast before opening the picker…
        assertNoScheduledAnalysis(documentId)
        const filePath = await host.pickPdf()
        if (filePath === null) return null
        // The AUTHORITATIVE check lives inside the replacement service: it
        // runs after the awaited source inspection, on the synchronous path
        // into the transaction (see DocumentReplacementService.preCommitGuard).
        const replaced = await services.replacement.replaceFromPath(documentId, filePath)
        runtime.analysisRunner.clearFailure(documentId)
        const summary = await importedSummary(replaced.matterId, replaced.id)
        // The replacement — not the superseded Document — is analyzed.
        runtime.analysisRunner.start(replaced.id)
        return summary
      }),
    'review:getDocument': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        return services.reviewQuery.getDocumentReview(documentId)
      }),
    'review:assign': (payload) =>
      toIpcResult(() => {
        const mentionId = requireId(readField(payload, 'mentionId'), 'mentionId')
        const entityId = requireId(readField(payload, 'entityId'), 'entityId')
        return services.reviewOperations.assignToEntity(mentionId, entityId)
      }),
    'review:confirm': (payload) =>
      toIpcResult(() => {
        const mentionId = requireId(readField(payload, 'mentionId'), 'mentionId')
        return services.reviewOperations.confirmMention(mentionId)
      }),
    'review:createEntityAndAssign': (payload) =>
      toIpcResult(() => {
        const mentionId = requireId(readField(payload, 'mentionId'), 'mentionId')
        const primaryAlias = requireText(readField(payload, 'primaryAlias'), 'primaryAlias', 200)
        const entityType = requireEnum(readField(payload, 'entityType'), ['PERSON', 'ORGANIZATION'], 'entityType')
        return services.reviewOperations.createEntityAndAssign(mentionId, { primaryAlias, entityType })
      }),
    'review:renameEntity': (payload) =>
      toIpcResult(() => {
        const entityId = requireId(readField(payload, 'entityId'), 'entityId')
        const primaryAlias = requireText(readField(payload, 'primaryAlias'), 'primaryAlias', 200)
        return services.reviewOperations.renameEntity(entityId, primaryAlias)
      }),
    'review:rejectMention': (payload) =>
      toIpcResult(() => {
        const mentionId = requireId(readField(payload, 'mentionId'), 'mentionId')
        return services.reviewOperations.rejectMention(mentionId)
      }),
    'review:mergeEntities': (payload) =>
      toIpcResult(() => {
        const sourceEntityId = requireId(readField(payload, 'sourceEntityId'), 'sourceEntityId')
        const targetEntityId = requireId(readField(payload, 'targetEntityId'), 'targetEntityId')
        return services.reviewOperations.mergeEntities(sourceEntityId, targetEntityId)
      }),
    'review:splitMention': (payload) =>
      toIpcResult(() => {
        const mentionId = requireId(readField(payload, 'mentionId'), 'mentionId')
        const primaryAlias = requireText(readField(payload, 'primaryAlias'), 'primaryAlias', 200)
        return services.reviewOperations.splitMention(mentionId, primaryAlias)
      }),
    'review:createManualMention': (payload) =>
      toIpcResult(() => {
        const blockId = requireId(readField(payload, 'blockId'), 'blockId')
        const type = requireEnum(
          readField(payload, 'type'),
          ['PERSON', 'ORGANIZATION', 'PHONE', 'EMAIL', 'ID_CARD', 'BANK_ACCOUNT', 'ADDRESS'],
          'type'
        )
        const startOffset = requireNonNegativeInteger(readField(payload, 'startOffset'), 'startOffset')
        const endOffset = requireNonNegativeInteger(readField(payload, 'endOffset'), 'endOffset')
        return services.reviewOperations.createManualMention({ blockId, type, startOffset, endOffset })
      }),
    'review:addConstraint': (payload) =>
      toIpcResult(() => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        const entityAId = requireId(readField(payload, 'entityAId'), 'entityAId')
        const entityBId = requireId(readField(payload, 'entityBId'), 'entityBId')
        const type = requireEnum(readField(payload, 'type'), ['MUST_LINK', 'CANNOT_LINK'], 'type')
        const reason = requireText(readField(payload, 'reason'), 'reason', 500)
        return services.reviewOperations.markConstraint(matterId, entityAId, entityBId, type, reason)
      }),
    'preview:get': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        return services.preview.getPreview(documentId)
      }),
    'preview:generate': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        return services.preview.generatePreview(documentId)
      }),
    'preview:rehydrate': (payload) =>
      toIpcResult(() => {
        const sanitizedDocumentId = requireId(readField(payload, 'sanitizedDocumentId'), 'sanitizedDocumentId')
        const text = requireText(readField(payload, 'text'), 'text', 1_000_000)
        const includeRestoreOnRequest = optionalBoolean(
          readOptionalField(payload, 'includeRestoreOnRequest'),
          'includeRestoreOnRequest',
          false
        )
        return services.preview.rehydrateDemo({ sanitizedDocumentId, text, includeRestoreOnRequest })
      }),
    'preview:copySanitized': (payload) =>
      toIpcResult(() => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        const sanitizedDocumentId = requireId(readField(payload, 'sanitizedDocumentId'), 'sanitizedDocumentId')
        host.copyText(services.preview.getSanitizedText(documentId, sanitizedDocumentId))
        return { copied: true as const }
      }),
    'preview:exportSanitized': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        const sanitizedDocumentId = requireId(readField(payload, 'sanitizedDocumentId'), 'sanitizedDocumentId')
        const text = services.preview.getSanitizedText(documentId, sanitizedDocumentId)
        return { saved: await host.saveText('AliasAI-sanitized-document.txt', text) }
      }),
    'ai:execute': (payload) =>
      toIpcResult(async () => {
        const sanitizedDocumentId = requireId(readField(payload, 'sanitizedDocumentId'), 'sanitizedDocumentId')
        const includeRestoreOnRequest = optionalBoolean(
          readOptionalField(payload, 'includeRestoreOnRequest'),
          'includeRestoreOnRequest',
          false
        )
        return services.ai.execute(sanitizedDocumentId, includeRestoreOnRequest)
      }),
    'ai:latest': (payload) =>
      toIpcResult(() => {
        const sanitizedDocumentId = requireId(readField(payload, 'sanitizedDocumentId'), 'sanitizedDocumentId')
        const includeRestoreOnRequest = optionalBoolean(
          readOptionalField(payload, 'includeRestoreOnRequest'),
          'includeRestoreOnRequest',
          false
        )
        return services.ai.findLatest(sanitizedDocumentId, includeRestoreOnRequest) ?? null
      }),
    'ai:copyResult': (payload) =>
      toIpcResult(() => {
        const result = loadAiResult(payload)
        host.copyText(result.text)
        return { copied: true as const }
      }),
    'ai:exportResult': (payload) =>
      toIpcResult(async () => {
        const result = loadAiResult(payload)
        return { saved: await host.saveText(result.suggestedName, result.text) }
      }),
    'ai:cancel': (payload) =>
      toIpcResult(() => {
        requireEmpty(payload)
        return { cancelled: services.ai.cancelActive() }
      }),
    'aiProvider:getStatus': (payload) =>
      toIpcResult(() => {
        requireEmpty(payload)
        return services.aiProvider.status()
      }),
    'aiProvider:save': (payload) =>
      toIpcResult(async () => {
        const provider = requireEnum(readField(payload, 'provider'), ['mock', 'openai-compatible'], 'provider')
        if (provider === 'mock') {
          await services.aiProvider.configureMock()
          return services.aiProvider.status()
        }
        const baseUrl = requireText(readField(payload, 'baseUrl'), 'baseUrl', 2_048).trim()
        const model = requireText(readField(payload, 'model'), 'model', 200).trim()
        const apiKey = optionalText(readOptionalField(payload, 'apiKey'), 'apiKey', 4_096)
        await services.aiProvider.configureOpenAi({ baseUrl, model, ...(apiKey === undefined ? {} : { apiKey }) })
        return services.aiProvider.status()
      }),
    'aiProvider:clear': (payload) =>
      toIpcResult(async () => {
        requireEmpty(payload)
        await services.aiProvider.clear()
        return services.aiProvider.status()
      }),
    'aiProvider:testConnection': (payload) =>
      toIpcResult(async () => {
        const baseUrl = optionalText(readOptionalField(payload, 'baseUrl'), 'baseUrl', 2_048)
        const model = optionalText(readOptionalField(payload, 'model'), 'model', 200)
        const apiKey = optionalText(readOptionalField(payload, 'apiKey'), 'apiKey', 4_096)
        const input = {
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(model === undefined ? {} : { model }),
          ...(apiKey === undefined ? {} : { apiKey })
        }
        return services.aiProvider.testConnection(input)
      })
  })

  // Wrap every entry under shutdown protection AFTER construction so each
  // in-flight operation is visible to runtime.shutdown() and late arrivals
  // fail fast with the coded APP_SHUTTING_DOWN envelope.
  const entries: Readonly<Record<string, (payload: unknown) => Promise<unknown>>> = buildHandlers()
  // The shutdown wrapper is uniform across channels; the final cast restores
  // the exact per-channel HandlerRegistry typing.
  const wrapped: Record<string, (payload: unknown) => Promise<unknown>> = {}
  for (const [channel, handler] of Object.entries(entries)) {
    // Handlers already produce IpcResult envelopes; the shutdown refusal is
    // the one raw rejection `guarded` can produce, mapped here to keep every
    // channel non-throwing.
    wrapped[channel] = async (payload: unknown) => {
      try {
        return await guarded(() => handler(payload))
      } catch (error) {
        if (error instanceof IpcShutdownError) {
          return { ok: false, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    }
  }
  return wrapped as HandlerRegistry
}

function readField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null) {
    throw new IpcValidationError(field, `${field} is required`)
  }
  return (payload as Record<string, unknown>)[field]
}

function readOptionalField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[field]
}

function requireEmpty(payload: unknown): void {
  if (payload === undefined || payload === null) return
  if (typeof payload === 'object' && Object.keys(payload).length === 0) return
  throw new IpcValidationError('payload', 'payload must be empty')
}
