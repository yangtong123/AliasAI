import type { HandlerRegistry } from './handlers'

/** The slice of Electron's ipcMain register.ts depends on; injectable for tests. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => void | Promise<unknown>): void
}

/**
 * Wires the pure handler registry into ipcMain. Handlers never throw — they
 * resolve to IpcResult envelopes — so no raw error can cross the boundary.
 */
export function registerIpcHandlers(registry: HandlerRegistry, ipcMain: IpcMainLike): void {
  for (const [channel, handler] of Object.entries(registry)) {
    ipcMain.handle(`aliasai:${channel}`, (_event, payload) => handler(payload))
  }
}
