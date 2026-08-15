import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initializeRuntime } from './runtime'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const rendererUrl = parseRendererUrl(process.env.ALIASAI_RENDERER_URL)
const rendererFilePath = join(currentDirectory, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererFilePath)

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

app.whenReady().then(async () => {
  try {
    // Keys and the database must exist before any renderer or IPC handler.
    await initializeRuntime(app, safeStorage)
  } catch (error) {
    // Sanitized message: never surfaces paths, keys, or stack traces.
    const message = error instanceof Error ? error.message : 'Unknown startup failure'
    dialog.showErrorBox('AliasAI', message)
    app.quit()
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
