import type { DocumentParseStatus } from '@aliasai/domain'

export function StatusBadge(props: { readonly status: DocumentParseStatus }) {
  return <span className={`badge status-${props.status.toLowerCase()}`}>{props.status}</span>
}
