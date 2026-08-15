import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const productionCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')
const developmentCsp = productionCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'none'", "connect-src 'self' ws: wss:")

function contentSecurityPolicy(command: 'build' | 'serve'): Plugin {
  return {
    name: 'aliasai-content-security-policy',
    transformIndexHtml(html) {
      return html.replace('__ALIASAI_CSP__', command === 'build' ? productionCsp : developmentCsp)
    }
  }
}

export default defineConfig(({ command }) => ({
  root: currentDirectory,
  plugins: [react(), contentSecurityPolicy(command)],
  base: './',
  // Bind IPv4 explicitly: the dev script waits on http://127.0.0.1:5173, and
  // Vite's default `localhost` binding can resolve to IPv6-only on some hosts.
  server: {
    host: '127.0.0.1'
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true
  }
}))
