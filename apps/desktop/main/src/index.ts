import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initializeRuntime, type AliasAiRuntime } from './runtime'
import { runSelfTest } from './self-test'
import { runProviderSelfTest } from './provider-self-test'
import { runUiSelfTest } from './ui-self-test'
import { createQuitCoordinator } from './quit-coordinator'
import { createHandlerRegistry } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const rendererUrl = parseRendererUrl(process.env.ALIASAI_RENDERER_URL)
const rendererFilePath = join(currentDirectory, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererFilePath)

if (process.argv.includes('--self-test')) {
  // Packaged-app acceptance mode: no window, no IPC, a throwaway userData
  // directory, and the full pipeline through the real (bundled) Python
  // worker. Exit code and stdout JSON are the contract for CI and testers.
  void app.whenReady().then(async () => {
    try {
      const result = await runSelfTest(app, safeStorage)
      console.log(JSON.stringify({ status: 'PASSED', stages: result.stages }))
      app.exit(0)
    } catch (error) {
      // Sanitized: static stage messages only, never values or paths.
      console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : 'unknown failure' }))
      app.exit(1)
    }
  })
} else if (process.argv.includes('--provider-self-test')) {
  // Network-provider acceptance mode: the full pipeline dispatched through the
  // real OpenAI-compatible HTTP provider against an in-process loopback fake
  // endpoint — no external network, account, or real API key involved.
  void app.whenReady().then(async () => {
    try {
      const result = await runProviderSelfTest(app, safeStorage)
      console.log(JSON.stringify({ status: 'PASSED', stages: result.stages }))
      app.exit(0)
    } catch (error) {
      console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : 'unknown failure' }))
      app.exit(1)
    }
  })
} else if (process.argv.includes('--ui-self-test')) {
  // Real desktop acceptance mode: creates a BrowserWindow and drives the
  // production React -> preload -> IPC -> application stack with synthetic
  // data in a throwaway userData directory.
  void app.whenReady().then(async () => {
    try {
      const result = await runUiSelfTest(app, safeStorage, createWindow)
      console.log(JSON.stringify({ status: 'PASSED', stages: result.stages }))
      app.exit(0)
    } catch (error) {
      console.error(
        JSON.stringify({
          status: 'FAILED',
          message: error instanceof Error ? error.message : 'unknown failure'
        })
      )
      app.exit(1)
    }
  })
} else {
  // The desktop app is single-instance: provider-configuration mutations are
  // serialized within one main process, so a second instance sharing the same
  // userData (and its provider configuration file) must not run. Acceptance
  // modes above use throwaway userData directories and skip the lock.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const [window] = BrowserWindow.getAllWindows()
      if (window !== undefined) {
        if (window.isMinimized()) window.restore()
        window.focus()
      }
    })
    void app.whenReady().then(async () => {
      let runtime: AliasAiRuntime
      try {
        // Keys and the database must exist before any renderer or IPC handler.
        runtime = await initializeRuntime(app, safeStorage)
      } catch (error) {
        // Sanitized message: never surfaces paths, keys, or stack traces.
        const message = error instanceof Error ? error.message : 'Unknown startup failure'
        dialog.showErrorBox('AliasAI', message)
        app.quit()
        return
      }

      registerIpcHandlers(
        createHandlerRegistry(runtime, {
          pickPdf: async () => {
            const result = await dialog.showOpenDialog({
              properties: ['openFile'],
              filters: [{ name: 'PDF documents', extensions: ['pdf'] }]
            })
            return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!
          },
          copyText: (text) => clipboard.writeText(text),
          saveText: async (suggestedName, text) => {
            const result = await dialog.showSaveDialog({
              defaultPath: suggestedName,
              filters: [{ name: 'Text document', extensions: ['txt'] }]
            })
            if (result.canceled || result.filePath === undefined) return false
            await writeFile(result.filePath, text, 'utf8')
            return true
          }
        }),
        ipcMain
      )

      createWindow()

      // Two-phase quit gate (see quit-coordinator.ts): every before-quit is
      // prevented while draining; shutdown orders intake-close -> await runs
      // -> SQLite-close (including the zero-run path); exactly one quit fires
      // once settled.
      const quitCoordinator = createQuitCoordinator(runtime, () => app.quit())
      app.on('before-quit', (event) => {
        quitCoordinator.handleBeforeQuit(event, () => event.preventDefault())
      })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
  }
}

function parseRendererUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined

  const url = new URL(value)
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopback) {
    throw new Error('ALIASAI_RENDERER_URL must use HTTP(S) on a loopback host')
  }
  return url
}

function isAllowedRendererNavigation(target: string): boolean {
  try {
    const targetUrl = new URL(target)
    if (rendererUrl !== undefined) return targetUrl.origin === rendererUrl.origin
    return targetUrl.protocol === 'file:' && targetUrl.pathname === rendererFileUrl.pathname
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: rendererUrl
        ? resolve(currentDirectory, '../../dist/preload/index.cjs')
        : join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!isAllowedRendererNavigation(target)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, target) => {
    if (!isAllowedRendererNavigation(target)) event.preventDefault()
  })

  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl.href)
  } else {
    void window.loadFile(rendererFilePath)
  }

  return window
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
