import type {
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
import type { EntityConstraintType, EntityType } from '@aliasai/domain'

/**
 * The renderer <-> main IPC contract. One entry per channel: `request` is what
 * the renderer sends, `response` the data payload it gets back on success.
 * Errors travel as IpcResult error envelopes, never as thrown rejections.
 */
export interface AliasAiInvokeMap {
  'matter:list': { request: Record<string, never>; response: readonly MatterSummaryDTO[] }
  'matter:create': { request: { name: string }; response: MatterSummaryDTO }
  'dialog:pickPdf': { request: Record<string, never>; response: { filePath: string | null } }
  'document:import': { request: { matterId: string; filePath: string }; response: DocumentSummaryDTO }
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
}

export type AliasAiChannel = keyof AliasAiInvokeMap & string

/** Runtime channel allowlist; the preload mirrors it and the drift test compares both. */
export const ALIASAI_CHANNELS: readonly AliasAiChannel[] = [
  'matter:list',
  'matter:create',
  'dialog:pickPdf',
  'document:import',
  'document:list',
  'document:get',
  'document:process',
  'document:detect',
  'document:resolve',
  'review:getDocument',
  'review:assign',
  'review:confirm',
  'review:createEntityAndAssign',
  'review:addConstraint',
  'preview:get',
  'preview:generate',
  'preview:rehydrate'
]
