import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from './i18n'

function Harness() {
  const { locale, setLocale, t, label, formatError } = useI18n()
  return (
    <>
      <p>{t('matters.title')}</p>
      <p>{label('ID_CARD')}</p>
      <p>{label('SHARED_PROTECTED_VALUE')}</p>
      <p>{label('SAME_LABELED_FIELD_GROUP')}</p>
      <p>{formatError({ code: 'DOCUMENT_NOT_FOUND', message: 'Document was not found' })}</p>
      <button type="button" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>
        {t('language.switch')}
      </button>
    </>
  )
}

describe('renderer internationalization', () => {
  beforeEach(() => localStorage.clear())

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('uses Simplified Chinese by default and localizes domain labels and errors', () => {
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    )

    expect(screen.getByText('事项')).toBeDefined()
    expect(screen.getByText('身份证号')).toBeDefined()
    expect(screen.getByText('受保护值相同')).toBeDefined()
    expect(screen.getByText('同标签字段组')).toBeDefined()
    expect(screen.getByText('未找到该文档。')).toBeDefined()
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('switches to English and restores the persisted locale after remounting', async () => {
    const user = userEvent.setup()
    const first = render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    )

    await user.click(screen.getByRole('button', { name: '切换语言' }))
    expect(screen.getByText('Matters')).toBeDefined()
    expect(screen.getByText('ID card number')).toBeDefined()
    expect(screen.getByText('Labeled field group')).toBeDefined()
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')

    first.unmount()
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    )
    expect(screen.getByText('Matters')).toBeDefined()
  })
})
