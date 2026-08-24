import { ipcMain, type BrowserWindow } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandlerRegistry } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { initializeRuntime, type AliasAiRuntime, type AppLike } from './runtime'
import { syntheticPdf } from './self-test'
import type { SafeStorage } from './keys'

interface UiSelfTestApp extends AppLike {
  setPath(name: 'userData', path: string): void
}

export interface UiSelfTestResult {
  readonly stages: readonly string[]
}

/**
 * Drives the production renderer inside a real BrowserWindow. The OS dialogs
 * are replaced only at the host-capability boundary so the test can select a
 * deterministic synthetic PDF and verify copy/export without touching the
 * tester's clipboard or filesystem. Every application action still crosses
 * the production preload and IPC validation layers.
 */
export async function runUiSelfTest(
  app: UiSelfTestApp,
  safeStorage: SafeStorage,
  createWindow: () => BrowserWindow
): Promise<UiSelfTestResult> {
  const userData = await mkdtemp(join(tmpdir(), 'aliasai-ui-self-test-'))
  const sourcePath = join(userData, 'synthetic-ui.pdf')
  const copied: string[] = []
  const saved: Array<{ readonly name: string; readonly text: string }> = []
  let runtime: AliasAiRuntime | undefined
  let window: BrowserWindow | undefined
  try {
    app.setPath('userData', userData)
    await writeFile(sourcePath, syntheticPdf('Holder 110101199003077774 synthetic@example.test.'))
    runtime = await initializeRuntime(app, safeStorage)
    registerIpcHandlers(
      createHandlerRegistry(runtime, {
        pickPdf: async () => sourcePath,
        copyText: (text) => copied.push(text),
        saveText: async (name, text) => {
          saved.push({ name, text })
          return true
        }
      }),
      ipcMain
    )
    window = createWindow()
    await waitForLoad(window)
    const result = (await window.webContents.executeJavaScript(UI_DRIVER, true)) as UiSelfTestResult

    assert(copied.length === 3, 'delivery', 'expected sanitized document and both AI responses to be copied')
    assert(saved.length === 3, 'delivery', 'expected sanitized document and both AI responses to be exported')
    for (const text of [copied[0], saved[0]?.text]) {
      assert(text !== undefined && !containsProtectedValue(text), 'delivery', 'sanitized document export leaked plaintext')
    }
    for (const text of [copied[1], saved[1]?.text]) {
      assert(text !== undefined && !containsProtectedValue(text), 'delivery', 'sanitized AI export leaked plaintext')
    }
    for (const text of [copied[2], saved[2]?.text]) {
      assert(text !== undefined && containsProtectedValue(text), 'delivery', 'restored AI export omitted plaintext')
    }
    return result
  } finally {
    window?.destroy()
    runtime?.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function containsProtectedValue(text: string): boolean {
  return text.includes('110101199003077774') && text.includes('synthetic@example.test')
}

function assert(condition: boolean, stage: string, detail: string): asserts condition {
  if (!condition) throw new Error(`ui self-test failed at ${stage}: ${detail}`)
}

async function waitForLoad(window: BrowserWindow): Promise<void> {
  if (window.webContents.getURL().length > 0 && !window.webContents.isLoadingMainFrame()) return
  await new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve())
    window.webContents.once('did-fail-load', (_event, _code, description) => reject(new Error(description)))
  })
}

const UI_DRIVER = String.raw`
(async () => {
  const stages = [];
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (read, description, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await pause(50);
    }
    const visible = Array.from(document.querySelectorAll('button, .error, .preview li'))
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(' | ')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[redacted-email]')
      .replace(/\d{5,}/g, '[redacted-number]');
    throw new Error('ui self-test timed out: ' + description + '; visible controls: ' + visible);
  };
  const buttons = () => Array.from(document.querySelectorAll('button'));
  const button = (label) => buttons().find(
    (candidate) => candidate.textContent.trim() === label && !candidate.disabled
  );
  const click = async (label) => {
    const target = await waitFor(() => button(label), 'button ' + label);
    target.click();
  };
  const setInput = async (label, value) => {
    const input = await waitFor(
      () => document.querySelector('[aria-label="' + label + '"]'),
      'input ' + label
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const stage = (name) => stages.push(name);

  const bridgeProbe = await window.aliasAi.invoke('matter:list', {});
  if (!bridgeProbe.ok) throw new Error('ui self-test bridge probe failed: ' + bridgeProbe.error.code);

  await setInput('New matter name', 'AliasAI UI Self-Test Matter');
  await click('Create');
  await click('AliasAI UI Self-Test Matter');
  stage('matter-created');

  await click('Import PDF…');
  await click('synthetic-ui.pdf IMPORTED');
  stage('document-imported');

  await click('Run Parse');
  await click('Run Detect');
  await click('Run Resolve');
  await waitFor(() => document.querySelector('[title^="ID_CARD"]'), 'ID_CARD mention');
  stage('pipeline-ready');

  document.querySelector('[title^="ID_CARD"]').click();
  await setInput('New entity primary alias', 'Holder One');
  await click('Create entity & assign');
  await waitFor(() => document.querySelector('.mention-detail strong')?.textContent === 'Holder One', 'ID assignment');
  await click('Confirm');
  await waitFor(() => button('Confirmed') || buttons().find((candidate) => candidate.textContent.trim() === 'Confirmed'), 'ID confirmation');

  document.querySelector('[title^="EMAIL"]').click();
  const picker = await waitFor(() => document.querySelector('.entity-picker select'), 'entity picker');
  const option = Array.from(picker.options).find((candidate) => candidate.textContent.includes('Holder One'));
  if (!option) throw new Error('ui self-test failed: Holder One was absent from entity picker');
  picker.value = option.value;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => document.querySelector('.mention-detail strong')?.textContent === 'Holder One', 'email assignment');
  await click('Confirm');
  await waitFor(() => button('Confirmed') || buttons().find((candidate) => candidate.textContent.trim() === 'Confirmed'), 'email confirmation');
  await waitFor(() => document.querySelector('.counts')?.textContent.includes('2 resolved'), 'both assignments');
  stage('review-completed');

  await click('Sanitized preview');
  await click('Generate sanitized preview');
  await waitFor(() => Array.from(document.querySelectorAll('h3')).some((node) => node.textContent === 'Sanitized preview'), 'sanitized preview');
  const sanitized = Array.from(document.querySelectorAll('.sanitized-block')).map((node) => node.textContent).join('\n');
  if (sanitized.includes('110101199003077774') || sanitized.includes('synthetic@example.test')) {
    throw new Error('ui self-test failed: sanitized preview leaked plaintext');
  }
  await click('Copy sanitized document');
  await waitFor(() => document.body.textContent.includes('Sanitized document copied.'), 'sanitized copy');
  await click('Export sanitized document…');
  await waitFor(() => document.body.textContent.includes('Sanitized document saved.'), 'sanitized export');
  stage('sanitized-and-exported');

  const restoreLabel = Array.from(document.querySelectorAll('label')).find(
    (candidate) => candidate.textContent.trim() === 'Restore RESTORE_ON_REQUEST values locally'
  );
  if (!restoreLabel) throw new Error('ui self-test failed: restore policy control missing');
  restoreLabel.querySelector('input').click();
  await click('Send sanitized document');
  await waitFor(() => Array.from(document.querySelectorAll('h4')).some((node) => node.textContent === 'Sanitized AI response'), 'AI response');
  const responses = Array.from(document.querySelectorAll('.ai-results pre')).map((node) => node.textContent);
  if (responses.length !== 2) throw new Error('ui self-test failed: AI results incomplete');
  if (responses[0].includes('110101199003077774') || responses[0].includes('synthetic@example.test')) {
    throw new Error('ui self-test failed: sanitized AI response leaked plaintext');
  }
  if (!responses[1].includes('110101199003077774') || !responses[1].includes('synthetic@example.test')) {
    throw new Error('ui self-test failed: local rehydration omitted plaintext');
  }
  await click('Copy sanitized response');
  await waitFor(() => document.body.textContent.includes('Sanitized response copied.'), 'sanitized response copy');
  await click('Export sanitized response…');
  await waitFor(() => document.body.textContent.includes('Sanitized response saved.'), 'sanitized response export');
  await click('Copy restored response');
  await waitFor(() => document.body.textContent.includes('Restored response copied.'), 'restored response copy');
  await click('Export restored response…');
  await waitFor(() => document.body.textContent.includes('Restored response saved.'), 'restored response export');
  stage('ai-rehydrated-and-exported');

  return { stages };
})()
`
