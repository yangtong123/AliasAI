import { useState } from 'react'
import type { EntityType } from '@aliasai/domain'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'

export function NewEntityForm(props: {
  readonly mentionId: string
  readonly onCreated: () => void
}) {
  const { t, label, formatError } = useI18n()
  const [alias, setAlias] = useState('')
  const [type, setType] = useState<EntityType>('PERSON')
  const create = useMutation((input: { primaryAlias: string; entityType: EntityType }) =>
    invoke('review:createEntityAndAssign', { mentionId: props.mentionId, ...input })
  )

  return (
    <form
      className="new-entity"
      onSubmit={(event) => {
        event.preventDefault()
        if (alias.trim().length === 0) return
        void create.run({ primaryAlias: alias, entityType: type }).then((result) => {
          if (result !== null) {
            setAlias('')
            props.onCreated()
          }
        })
      }}
    >
      <input
        value={alias}
        placeholder={t('entity.newAlias')}
        aria-label={t('entity.newAlias')}
        onChange={(event) => setAlias(event.target.value)}
      />
      <select value={type} aria-label={t('entity.type')} onChange={(event) => setType(event.target.value as EntityType)}>
        <option value="PERSON">{label('PERSON')}</option>
        <option value="ORGANIZATION">{label('ORGANIZATION')}</option>
      </select>
      <button type="submit" disabled={create.pending || alias.trim().length === 0}>
        {t('entity.createAssign')}
      </button>
      {create.error !== null && <p className="error">{formatError(create.error)}</p>}
    </form>
  )
}
