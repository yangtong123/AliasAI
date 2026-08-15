import type { AliasAiChannel, AliasAiInvokeMap } from '../../../main/src/ipc/contract'
import type { Channel } from '../../../preload/src/channels'

/**
 * Renderer-side typed IPC facade. All imports from @aliasai/* and the main
 * contract are type-only (erased at build), so no Node code ever enters the
 * browser bundle. window.aliasAi.invoke is the only bridge used.
 */
export class UiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'UiError'
  }
}

type Envelope = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }

interface AliasAiBridge {
  invoke(channel: Channel, payload: unknown): Promise<Envelope>
}

declare global {
  interface Window {
    readonly aliasAi: AliasAiBridge
  }
}

export async function invoke<K extends AliasAiChannel>(
  channel: K,
  payload: AliasAiInvokeMap[K]['request']
): Promise<AliasAiInvokeMap[K]['response']> {
  const result = await window.aliasAi.invoke(channel as Channel, payload as unknown)
  if (!result.ok) {
    throw new UiError(result.error.code, result.error.message)
  }
  return result.data as AliasAiInvokeMap[K]['response']
}
