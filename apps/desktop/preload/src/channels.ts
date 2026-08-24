/**
 * Runtime channel allowlist mirroring the main-side contract. Kept in its own
 * module (no Electron imports) so the drift test can import it under Node.
 */
export const CHANNELS = [
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
  'review:addConstraint',
  'preview:get',
  'preview:generate',
  'preview:rehydrate',
  'preview:copySanitized',
  'preview:exportSanitized',
  'ai:execute',
  'ai:latest',
  'ai:copyResult',
  'ai:exportResult'
] as const

export type Channel = (typeof CHANNELS)[number]
