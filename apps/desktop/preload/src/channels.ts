/**
 * Runtime channel allowlist mirroring the main-side contract. Kept in its own
 * module (no Electron imports) so the drift test can import it under Node.
 */
export const CHANNELS = [
  'matter:list',
  'matter:create',
  'matter:trash',
  'matter:restore',
  'trash:list',
  'document:pickAndImport',
  'document:list',
  'document:get',
  'document:process',
  'document:detect',
  'document:resolve',
  'document:trash',
  'document:restore',
  'document:pickAndReplace',
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
] as const

export type Channel = (typeof CHANNELS)[number]
