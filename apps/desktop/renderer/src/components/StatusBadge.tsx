import type { DocumentParseStatus } from '@aliasai/domain'
import { useI18n } from '../i18n'

export function StatusBadge(props: { readonly status: DocumentParseStatus }) {
  const { label } = useI18n()
  return <span className={`badge status-${props.status.toLowerCase()}`}>{label(props.status)}</span>
}
