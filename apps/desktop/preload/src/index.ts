import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type Channel } from './channels'

export interface IpcErrorEnvelope {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

export interface IpcSuccessEnvelope<T> {
  readonly ok: true
  readonly data: T
}

export type IpcEnvelope<T> = IpcSuccessEnvelope<T> | IpcErrorEnvelope

/**
 * The renderer's only bridge surface: one invoke function gated by the
 * channel allowlist. Nothing else — no Node APIs, no filesystem, no events.
 */
function invoke(channel: Channel, payload: unknown): Promise<IpcEnvelope<unknown>> {
  return ipcRenderer.invoke(`aliasai:${channel}`, payload)
}

contextBridge.exposeInMainWorld('aliasAi', {
  getRuntimeInfo: () => ({
    platform: process.platform,
    version: process.versions.electron
  }),
  invoke
})

export { CHANNELS }
export type { Channel }
