import { useState } from 'react'
import type { MatterSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'

export function MatterList(props: {
  readonly matters: readonly MatterSummaryDTO[]
  readonly selectedMatterId: string | null
  readonly onSelect: (matterId: string) => void
  readonly onCreated: (matterId: string) => void
  /** Called after a Matter really moved to trash; selection cleanup is the parent's job. */
  readonly onTrashed?: (matterId: string) => void
}) {
  const { t, formatError } = useI18n()
  const [name, setName] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const create = useMutation((value: string) => invoke('matter:create', { name: value }))
  const trash = useMutation((matterId: string) => invoke('matter:trash', { matterId }))

  const onTrashConfirmed = (matterId: string) => {
    void trash.run(matterId).then((result) => {
      if (result !== null) {
        setConfirmingId(null)
        props.onTrashed?.(matterId)
      }
    })
  }

  return (
    <section className="matter-list">
      <h2>{t('matters.title')}</h2>
      <ul>
        {props.matters.map((matter) => (
          <li key={matter.id} className={confirmingId === matter.id ? 'confirming' : undefined}>
            <div className="item-row">
              <button
                type="button"
                className={matter.id === props.selectedMatterId ? 'selected' : undefined}
                onClick={() => props.onSelect(matter.id)}
              >
                {matter.name}
              </button>
              {confirmingId !== matter.id && (
                <button
                  type="button"
                  className="trash-button"
                  aria-label={`${t('matter.trashAction')}: ${matter.name}`}
                  disabled={trash.pending}
                  onClick={() => setConfirmingId(matter.id)}
                >
                  {t('matter.trashAction')}
                </button>
              )}
            </div>
            {confirmingId === matter.id && (
              <div className="trash-confirm">
                <p className="warning">{t('trash.matterConfirm')}</p>
                <div className="trash-confirm-actions">
                  <button type="button" onClick={() => onTrashConfirmed(matter.id)} disabled={trash.pending}>
                    {t('trash.confirm')}
                  </button>
                  <button type="button" onClick={() => setConfirmingId(null)} disabled={trash.pending}>
                    {t('trash.cancel')}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {props.matters.length === 0 && <li className="empty">{t('matters.empty')}</li>}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim().length === 0) return
          void create.run(name).then((created) => {
            if (created !== null) {
              setName('')
              props.onCreated(created.id)
            }
          })
        }}
      >
        <input
          value={name}
          placeholder={t('matters.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
          aria-label={t('matters.namePlaceholder')}
        />
        <button type="submit" disabled={create.pending || name.trim().length === 0}>
          {t('matters.create')}
        </button>
      </form>
      {create.error !== null && <p className="error">{formatError(create.error)}</p>}
      {trash.error !== null && <p className="error">{formatError(trash.error)}</p>}
    </section>
  )
}
