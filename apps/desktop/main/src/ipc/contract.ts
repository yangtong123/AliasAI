import type {
  AiExecutionView,
  ConstraintDTO,
  DocumentReviewDTO,
  DocumentSummaryDTO,
  JobSummaryDTO,
  MatterSummaryDTO,
  MentionReviewDTO,
  EntitySummaryDTO,
  SanitizedPreview,
  RehydrationResult
} from '@aliasai/application'
import type { EntityConstraintType, EntityType, MentionType } from '@aliasai/domain'
import type { AiProviderStatus } from '../ai-provider'

/**
 * Provider settings the renderer may submit. The API key crosses IPC only in
 * this explicit user action (typed in the settings form); it is never part of
 * any response, status, or log line.
 */
export type AiProviderSaveRequest =
  | { readonly provider: 'mock' }
  | {
      readonly provider: 'openai-compatible'
      readonly baseUrl: string
      readonly model: string
      readonly apiKey?: string
    }

/**
 * The renderer <-> main IPC contract. One entry per channel: `request` is what
 * the renderer sends, `response` the data payload it gets back on success.
 * Errors travel as IpcResult error envelopes, never as thrown rejections.
 */
export interface AliasAiInvokeMap {
  'matter:list': { request: Record<string, never>; response: readonly MatterSummaryDTO[] }
  'matter:create': { request: { name: string }; response: MatterSummaryDTO }
  'document:pickAndImport': { request: { matterId: string }; response: DocumentSummaryDTO | null }
  'document:list': { request: { matterId: string }; response: readonly DocumentSummaryDTO[] }
  'document:get': {
    request: { documentId: string }
    response: { document: DocumentSummaryDTO; jobs: readonly JobSummaryDTO[] }
  }
  'document:process': {
    request: { documentId: string }
    response: { document: DocumentSummaryDTO; jobs: readonly JobSummaryDTO[] }
  }
  'document:detect': {
    request: { documentId: string }
    response: { document: DocumentSummaryDTO; jobs: readonly JobSummaryDTO[] }
  }
  'document:resolve': {
    request: { documentId: string }
    response: { document: DocumentSummaryDTO; jobs: readonly JobSummaryDTO[] }
  }
  'review:getDocument': { request: { documentId: string }; response: DocumentReviewDTO }
  'review:assign': { request: { mentionId: string; entityId: string }; response: MentionReviewDTO }
  'review:confirm': { request: { mentionId: string }; response: MentionReviewDTO }
  'review:createEntityAndAssign': {
    request: { mentionId: string; primaryAlias: string; entityType: EntityType }
    response: { mention: MentionReviewDTO; entity: EntitySummaryDTO }
  }
  'review:renameEntity': {
    request: { entityId: string; primaryAlias: string }
    response: { renamed: true }
  }
  'review:rejectMention': { request: { mentionId: string }; response: MentionReviewDTO }
  'review:mergeEntities': {
    request: { sourceEntityId: string; targetEntityId: string }
    response: { merged: true }
  }
  'review:splitMention': {
    request: { mentionId: string; primaryAlias: string }
    response: { mention: MentionReviewDTO; entityId: string }
  }
  'review:createManualMention': {
    request: { blockId: string; type: MentionType; startOffset: number; endOffset: number }
    response: MentionReviewDTO
  }
  'review:addConstraint': {
    request: {
      matterId: string
      entityAId: string
      entityBId: string
      type: EntityConstraintType
      reason: string
    }
    response: ConstraintDTO
  }
  'preview:get': { request: { documentId: string }; response: SanitizedPreview }
  'preview:generate': { request: { documentId: string }; response: SanitizedPreview }
  'preview:rehydrate': {
    request: { sanitizedDocumentId: string; text: string; includeRestoreOnRequest?: boolean }
    response: RehydrationResult
  }
  'preview:copySanitized': {
    request: { documentId: string; sanitizedDocumentId: string }
    response: { copied: true }
  }
  'preview:exportSanitized': {
    request: { documentId: string; sanitizedDocumentId: string }
    response: { saved: boolean }
  }
  'ai:execute': {
    request: { sanitizedDocumentId: string; includeRestoreOnRequest?: boolean }
    response: Extract<AiExecutionView, { status: 'COMPLETED' }>
  }
  'ai:latest': {
    request: { sanitizedDocumentId: string; includeRestoreOnRequest?: boolean }
    response: AiExecutionView | null
  }
  'ai:copyResult': {
    request: { executionId: string; variant: 'SANITIZED' | 'REHYDRATED'; includeRestoreOnRequest?: boolean }
    response: { copied: true }
  }
  'ai:exportResult': {
    request: { executionId: string; variant: 'SANITIZED' | 'REHYDRATED'; includeRestoreOnRequest?: boolean }
    response: { saved: boolean }
  }
  'ai:cancel': { request: Record<string, never>; response: { cancelled: number } }
  'aiProvider:getStatus': { request: Record<string, never>; response: AiProviderStatus }
  'aiProvider:save': { request: AiProviderSaveRequest; response: AiProviderStatus }
  'aiProvider:clear': { request: Record<string, never>; response: AiProviderStatus }
  'aiProvider:testConnection': {
    request: { baseUrl?: string; model?: string; apiKey?: string }
    response: { httpStatus: number }
  }
}

export type AliasAiChannel = keyof AliasAiInvokeMap & string

/** Runtime channel allowlist; the preload mirrors it and the drift test compares both. */
export const ALIASAI_CHANNELS: readonly AliasAiChannel[] = [
  'matter:list',
  'matter:create',
  'document:pickAndImport',
  'document:list',
  'document:get',
  'document:process',
  'document:detect',
  'document:resolve',
  'review:getDocument',
  'review:assign',
  'review:confirm',
  'review:createEntityAndAssign',
  'review:renameEntity',
  'review:rejectMention',
  'review:mergeEntities',
  'review:splitMention',
  'review:createManualMention',
  'review:addConstraint',
  'preview:get',
  'preview:generate',
  'preview:rehydrate',
  'preview:copySanitized',
  'preview:exportSanitized',
  'ai:execute',
  'ai:latest',
  'ai:copyResult',
  'ai:exportResult',
  'ai:cancel',
  'aiProvider:getStatus',
  'aiProvider:save',
  'aiProvider:clear',
  'aiProvider:testConnection'
]
