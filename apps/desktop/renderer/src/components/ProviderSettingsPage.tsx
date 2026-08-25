import { useEffect, useState } from 'react'
import { invoke } from '../api/client'
import { useAiProviderStatus, useMutation, type AiProviderStatus } from '../api/hooks'
import { useI18n } from '../i18n'

type ProviderKind = 'mock' | 'openai-compatible'

/**
 * AI provider settings. The API key is only ever submitted (typed here), never
 * displayed back: the form shows "configured" instead of any stored secret.
 */
export function ProviderSettingsPage(props: {
  readonly onClose: () => void
  /** Informs the owning view while an operation is in flight, so navigation that would unmount this page (and reset the mutual exclusion) is blocked. */
  readonly onBusyChange?: (busy: boolean) => void
}) {
  const { t, formatError } = useI18n()
  const { status: loaded, error: loadError } = useAiProviderStatus()
  // The latest status the page itself produced (save/clear); it overrides the
  // initial load until the component remounts.
  const [applied, setApplied] = useState<AiProviderStatus | null>(null)
  const status = applied ?? loaded
  const [kind, setKind] = useState<ProviderKind | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testStatus, setTestStatus] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (status === null || kind !== null) return
    setKind(status.provider)
    if (status.openai !== null) {
      setBaseUrl(status.openai.baseUrl)
      setModel(status.openai.model)
    }
  }, [status, kind])

  const applyStatus = (next: AiProviderStatus): void => {
    setApplied(next)
    setKind(next.provider)
    if (next.openai !== null) {
      setBaseUrl(next.openai.baseUrl)
      setModel(next.openai.model)
    }
    setApiKey('')
    setTestStatus(null)
  }

  const save = useMutation(() => {
    setSaved(false)
    setTestStatus(null)
    if (kind === 'openai-compatible') {
      const trimmedKey = apiKey.trim()
      return invoke('aiProvider:save', {
        provider: 'openai-compatible',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {})
      })
    }
    return invoke('aiProvider:save', { provider: 'mock' })
  })
  const test = useMutation(() => {
    setTestStatus(null)
    const trimmedKey = apiKey.trim()
    const useForm = kind === 'openai-compatible'
    return invoke('aiProvider:testConnection', {
      ...(useForm ? { baseUrl: baseUrl.trim(), model: model.trim() } : {}),
      ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {})
    })
  })
  const clearConfig = useMutation(() => {
    setTestStatus(null)
    return invoke('aiProvider:clear', {})
  })

  // All settings operations are mutually exclusive and the whole form is
  // locked while any is in flight: a slow connection test can then never
  // report a result against a configuration the user has already changed.
  const busy = save.pending || clearConfig.pending || test.pending

  // Leaving the page mid-operation would reset this lock with fresh hooks, so
  // the owning view blocks navigation (and on unmount reports not-busy again).
  const { onBusyChange } = props
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])

  const keyConfigured = status?.openai?.apiKeyConfigured === true

  return (
    <section className="provider-settings" aria-labelledby="provider-settings-title">
      <header>
        <h2 id="provider-settings-title">{t('settings.providerTitle')}</h2>
        <button type="button" disabled={busy} onClick={props.onClose}>
          {t('nav.closeSettings')}
        </button>
      </header>
      <p className="hint">{t('settings.providerIntro')}</p>
      {status !== null && (
        <p className="hint">
          {t('settings.current', {
            provider: t(status.provider === 'mock' ? 'settings.provider.mock' : 'settings.provider.openai')
          })}
        </p>
      )}
      {loadError !== null && <p className="error">{formatError(loadError)}</p>}
      {status?.configErrorCode != null && (
        <p className="warning">{t('settings.configError', { code: status.configErrorCode })}</p>
      )}

      <fieldset className="provider-choice">
        <label>
          <input
            type="radio"
            name="ai-provider"
            disabled={busy}
            checked={kind === 'mock'}
            onChange={() => {
              setKind('mock')
              setTestStatus(null)
            }}
          />
          {t('settings.provider.mock')}
        </label>
        <p className="hint">{t('settings.provider.mockHint')}</p>
        <label>
          <input
            type="radio"
            name="ai-provider"
            disabled={busy}
            checked={kind === 'openai-compatible'}
            onChange={() => {
              setKind('openai-compatible')
              setTestStatus(null)
            }}
          />
          {t('settings.provider.openai')}
        </label>
        <p className="hint">{t('settings.provider.openaiHint')}</p>
      </fieldset>

      {kind === 'openai-compatible' && (
        <div className="provider-form">
          <label htmlFor="provider-base-url">{t('settings.baseUrl')}</label>
          <input
            id="provider-base-url"
            value={baseUrl}
            disabled={busy}
            placeholder={t('settings.baseUrlPlaceholder')}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <label htmlFor="provider-model">{t('settings.model')}</label>
          <input
            id="provider-model"
            value={model}
            disabled={busy}
            placeholder={t('settings.modelPlaceholder')}
            onChange={(event) => setModel(event.target.value)}
          />
          <label htmlFor="provider-api-key">{t('settings.apiKey')}</label>
          <input
            id="provider-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={busy}
            placeholder={t(keyConfigured ? 'settings.apiKeyConfigured' : 'settings.apiKeyMissing')}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      )}

      <div className="provider-actions">
        <button
          type="button"
          disabled={busy || kind === null}
          onClick={() => void save.run().then((result) => {
            if (result !== null) {
              applyStatus(result)
              setSaved(true)
            }
          })}
        >
          {t(save.pending ? 'settings.saving' : 'settings.save')}
        </button>
        <button
          type="button"
          disabled={busy || kind !== 'openai-compatible'}
          onClick={() => void test.run().then((result) => {
            if (result !== null) setTestStatus(result.httpStatus)
          })}
        >
          {t(test.pending ? 'settings.testing' : 'settings.test')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void clearConfig.run().then((result) => {
            if (result !== null) applyStatus(result)
          })}
        >
          {t('settings.clear')}
        </button>
      </div>

      {saved && !save.pending && <p role="status">{t('settings.saved')}</p>}
      {save.error !== null && <p className="error">{formatError(save.error)}</p>}
      {test.error !== null && <p className="error">{formatError(test.error)}</p>}
      {testStatus !== null && test.error === null && (
        <p role="status">{t('settings.testOk', { status: testStatus })}</p>
      )}
      {clearConfig.error !== null && <p className="error">{formatError(clearConfig.error)}</p>}
    </section>
  )
}
