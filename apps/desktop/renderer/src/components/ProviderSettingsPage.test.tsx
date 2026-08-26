import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInEnglish } from '../test-utils'
import { ProviderSettingsPage } from './ProviderSettingsPage'

const mockStatus = {
  provider: 'mock' as const,
  openai: null,
  configErrorCode: null
}
const configuredStatus = {
  provider: 'openai-compatible' as const,
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: true },
  configErrorCode: null
}

describe('ProviderSettingsPage', () => {
  const bridge = vi.fn()

  beforeEach(() => {
    bridge.mockReset()
    ;(window as { aliasAi: unknown }).aliasAi = { invoke: bridge }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the Mock default with the OpenAI form hidden', async () => {
    bridge.mockResolvedValue({ ok: true, data: mockStatus })

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)

    expect(await screen.findByText('Current provider: Mock (offline)')).toBeDefined()
    // The radio selection is applied by an effect after the status arrives.
    expect(await screen.findByRole('radio', { name: 'Mock (offline)', checked: true })).toBeDefined()
    expect(screen.queryByLabelText('API Base URL')).toBeNull()
  })

  it('saves a complete OpenAI-compatible configuration', async () => {
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: mockStatus })
      if (channel === 'aiProvider:save') return Promise.resolve({ ok: true, data: configuredStatus })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    await user.click(await screen.findByRole('radio', { name: 'OpenAI-compatible (network)' }))
    await user.type(screen.getByLabelText('API Base URL'), 'https://api.openai.com/v1')
    await user.type(screen.getByLabelText('Model name'), 'gpt-synthetic')
    await user.type(screen.getByLabelText('API Key'), 'sk-synthetic-renderer-key')
    await user.click(screen.getByRole('button', { name: 'Save provider settings' }))

    expect(bridge).toHaveBeenCalledWith('aiProvider:save', {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic',
      apiKey: 'sk-synthetic-renderer-key'
    })
    expect(await screen.findByText('Provider settings saved.')).toBeDefined()
    // After saving, the key field is cleared and only its presence is shown.
    expect(screen.getByLabelText('API Key')).toHaveProperty('value', '')
    expect(screen.getByPlaceholderText('Configured — leave blank to keep the current key')).toBeDefined()
  })

  it('keeps the stored key when the field is left blank', async () => {
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: configuredStatus })
      if (channel === 'aiProvider:save') return Promise.resolve({ ok: true, data: configuredStatus })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    await screen.findByText('Current provider: OpenAI-compatible (network)')
    await user.click(screen.getByRole('button', { name: 'Save provider settings' }))

    expect(bridge).toHaveBeenCalledWith('aiProvider:save', {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-synthetic'
    })
  })

  it('tests the connection with the form values and shows the HTTP status', async () => {
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: mockStatus })
      if (channel === 'aiProvider:testConnection') return Promise.resolve({ ok: true, data: { httpStatus: 200 } })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    await user.click(await screen.findByRole('radio', { name: 'OpenAI-compatible (network)' }))
    await user.type(screen.getByLabelText('API Base URL'), 'http://127.0.0.1:9000/v1')
    await user.type(screen.getByLabelText('Model name'), 'gpt-synthetic')
    await user.type(screen.getByLabelText('API Key'), 'sk-unsaved')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(bridge).toHaveBeenCalledWith('aiProvider:testConnection', {
      baseUrl: 'http://127.0.0.1:9000/v1',
      model: 'gpt-synthetic',
      apiKey: 'sk-unsaved'
    })
    expect(await screen.findByText('Connection succeeded (HTTP 200).')).toBeDefined()
  })

  it('surfaces a coded connection failure without any key material', async () => {
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: configuredStatus })
      if (channel === 'aiProvider:testConnection') {
        return Promise.resolve({
          ok: false,
          error: { code: 'PROVIDER_HTTP_ERROR', message: 'AI provider endpoint returned HTTP 401' }
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    // The button stays disabled until the async provider status loads and
    // selects the openai-compatible kind; clicking earlier would be dropped.
    const testButton = await screen.findByRole('button', { name: 'Test connection' })
    await waitFor(() => {
      expect(testButton).toHaveProperty('disabled', false)
    })
    await user.click(testButton)

    expect(
      await screen.findByText('AI provider endpoint returned HTTP 401', undefined, { timeout: 3_000 })
    ).toBeDefined()
  })

  it('warns when the stored configuration is unusable and clear resets to Mock', async () => {
    const brokenStatus = {
      provider: 'openai-compatible' as const,
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-synthetic', apiKeyConfigured: false },
      configErrorCode: 'AI_PROVIDER_KEY_UNAVAILABLE'
    }
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: brokenStatus })
      if (channel === 'aiProvider:clear') return Promise.resolve({ ok: true, data: mockStatus })
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)

    expect(
      await screen.findByText('The saved provider configuration cannot be used (AI_PROVIDER_KEY_UNAVAILABLE). Re-enter the settings below and save.')
    ).toBeDefined()
    expect(screen.queryByPlaceholderText('Configured — leave blank to keep the current key')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Delete provider configuration' }))
    expect(bridge).toHaveBeenCalledWith('aiProvider:clear', {})
    expect(await screen.findByText('Current provider: Mock (offline)')).toBeDefined()
  })

  it('blocks every configuration mutation while one is in flight', async () => {
    let resolveSave!: (envelope: unknown) => void
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: configuredStatus })
      if (channel === 'aiProvider:save') {
        return new Promise((resolve) => {
          resolveSave = resolve
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    const save = await screen.findByRole('button', { name: 'Save provider settings' })
    const clear = screen.getByRole('button', { name: 'Delete provider configuration' })
    const test = screen.getByRole('button', { name: 'Test connection' })
    const back = screen.getByRole('button', { name: 'Back to workspace' })
    await user.click(save)

    // A slow save must not race a clear issued right after it, and leaving
    // the page (which would reset the mutex) is blocked while it is pending.
    expect(save).toHaveProperty('disabled', true)
    expect(clear).toHaveProperty('disabled', true)
    expect(test).toHaveProperty('disabled', true)
    expect(back).toHaveProperty('disabled', true)

    resolveSave({ ok: true, data: configuredStatus })
    expect(await screen.findByText('Provider settings saved.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Delete provider configuration' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toHaveProperty('disabled', false)
  })

  it('reports busy state to the owning view and resets it on unmount', async () => {
    const onBusyChange = vi.fn()
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: mockStatus })
      return Promise.resolve({ ok: true, data: null })
    })

    const { unmount } = renderInEnglish(<ProviderSettingsPage onClose={() => {}} onBusyChange={onBusyChange} />)
    await screen.findByText('Current provider: Mock (offline)')
    expect(onBusyChange).toHaveBeenLastCalledWith(false)

    unmount()
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
  })

  it('locks the whole settings form while a connection test is in flight', async () => {
    let resolveTest!: (envelope: unknown) => void
    bridge.mockImplementation((channel: string) => {
      if (channel === 'aiProvider:getStatus') return Promise.resolve({ ok: true, data: mockStatus })
      if (channel === 'aiProvider:testConnection') {
        return new Promise((resolve) => {
          resolveTest = resolve
        })
      }
      return Promise.resolve({ ok: true, data: null })
    })
    const user = userEvent.setup()

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    await user.click(await screen.findByRole('radio', { name: 'OpenAI-compatible (network)' }))
    await user.type(screen.getByLabelText('API Base URL'), 'https://api.openai.com/v1')
    await user.type(screen.getByLabelText('Model name'), 'gpt-synthetic')
    await user.type(screen.getByLabelText('API Key'), 'sk-synthetic')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    // While the test is pending the configuration cannot be changed, so the
    // eventual result always describes the form the user is looking at.
    expect(screen.getByRole('button', { name: 'Save provider settings' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Delete provider configuration' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: 'Mock (offline)' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('radio', { name: 'OpenAI-compatible (network)' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('API Base URL')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Model name')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('API Key')).toHaveProperty('disabled', true)

    resolveTest({ ok: true, data: { httpStatus: 200 } })
    expect(await screen.findByText('Connection succeeded (HTTP 200).')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save provider settings' })).toHaveProperty('disabled', false)
    expect(screen.getByLabelText('API Base URL')).toHaveProperty('disabled', false)
  })

  it('renders through the typed client contract', async () => {
    bridge.mockResolvedValue({ ok: true, data: mockStatus })

    renderInEnglish(<ProviderSettingsPage onClose={() => {}} />)
    await screen.findByText('Current provider: Mock (offline)')

    expect(bridge).toHaveBeenCalledWith('aiProvider:getStatus', {})
    expect(bridge).not.toHaveBeenCalledWith('aiProvider:save', expect.anything())
  })
})
