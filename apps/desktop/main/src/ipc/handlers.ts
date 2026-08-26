import type { DocumentSummaryDTO } from '@aliasai/application'
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

  const documentStatus = (documentId: string) => services.reviewQuery.getDocumentStatus(documentId)
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

  return {
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
    'document:pickAndImport': (payload) =>
      toIpcResult(async () => {
        const matterId = requireId(readField(payload, 'matterId'), 'matterId')
        const filePath = await host.pickPdf()
        if (filePath === null) return null
        const imported = await services.importDocs.importFromPath(matterId, filePath)
        return importedSummary(matterId, imported.id)
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
    'document:process': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.processing.process(documentId)
        return documentStatus(documentId)
      }),
    'document:detect': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.detection.detect(documentId)
        return documentStatus(documentId)
      }),
    'document:resolve': (payload) =>
      toIpcResult(async () => {
        const documentId = requireId(readField(payload, 'documentId'), 'documentId')
        await services.resolution.resolve(documentId)
        return documentStatus(documentId)
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
  }
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
