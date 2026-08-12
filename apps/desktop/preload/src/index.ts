import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('aliasAi', {
  getRuntimeInfo: () => ({
    platform: process.platform,
    version: process.versions.electron
  })
})
