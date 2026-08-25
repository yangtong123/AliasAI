import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { I18nProvider } from './i18n'

function EnglishI18n(props: { readonly children: ReactNode }) {
  return <I18nProvider initialLocale="en">{props.children}</I18nProvider>
}

/** Keeps existing behavior-focused component tests stable while production defaults to Chinese. */
export function renderInEnglish(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: EnglishI18n })
}
