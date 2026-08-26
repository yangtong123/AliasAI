import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from './i18n'

function Harness() {
  const { locale, setLocale, t, label, formatError } = useI18n()
  return (
    <>
      <p>{t('matters.title')}</p>
      <p>{t('trash.nav')}</p>
      <p>{t('trash.matterConfirm')}</p>
      <p>{t('document.replaceAction')}</p>
      <p>{formatError({ code: 'REPLACE_OPERATION_FAILED', message: 'The replacement failed' })}</p>
      <p>{label('ID_CARD')}</p>
      <p>{label('SHARED_PROTECTED_VALUE')}</p>
      <p>{label('SAME_LABELED_FIELD_GROUP')}</p>
      <p>{formatError({ code: 'DOCUMENT_NOT_FOUND', message: 'Document was not found' })}</p>
      <p>{formatError({ code: 'RESTORE_CONFLICT', message: 'An active Document with the same file hash already exists' })}</p>
      <p>{formatError({ code: 'DOCUMENT_BUSY', message: 'Document has running work' })}</p>
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
    expect(screen.getByText('回收站')).toBeDefined()
    expect(screen.getByText('用新 PDF 替换…')).toBeDefined()
    expect(screen.getByText('替换操作失败，请重试；原文档保持不变。')).toBeDefined()
    expect(screen.getByText('该事项的全部内容将从工作台消失，但可以在回收站中恢复。')).toBeDefined()
    expect(
      screen.getByText('该事项中已存在内容相同的活动文档；请先将它移入回收站后重试当前操作，或选择其他文件。')
    ).toBeDefined()
    expect(screen.getByText('文档正在处理或 AI 正在执行，请等待完成后再试。')).toBeDefined()
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
    expect(screen.getByText('Trash')).toBeDefined()
    expect(screen.getByText('Replace with new PDF…')).toBeDefined()
    expect(screen.getByText('The replacement failed')).toBeDefined()
    expect(
      screen.getByText('All contents of this matter will disappear from the workspace. They stay recoverable in trash.')
    ).toBeDefined()
    expect(screen.getByText('An active Document with the same file hash already exists')).toBeDefined()
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
