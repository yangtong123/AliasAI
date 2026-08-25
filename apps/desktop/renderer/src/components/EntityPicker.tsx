import type { EntitySummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'

/** Reassigns the mention to any other entity in the matter. */
export function EntityPicker(props: {
  readonly mentionId: string
  readonly currentEntityId: string | null
  readonly entities: readonly EntitySummaryDTO[]
  readonly onApplied: () => void
}) {
  const { t, label, formatError } = useI18n()
  const assign = useMutation((entityId: string) => invoke('review:assign', { mentionId: props.mentionId, entityId }))
  const others = props.entities.filter((entity) => entity.id !== props.currentEntityId)

  if (others.length === 0) return <p className="empty">{t('entity.noOther')}</p>

  return (
    <div className="entity-picker">
      <label>
        {t('entity.reassign')}
        <select
          defaultValue=""
          onChange={(event) => {
            const entityId = event.target.value
            if (entityId === '') return
            void assign.run(entityId).then((result) => {
              if (result !== null) {
                event.target.value = ''
                props.onApplied()
              }
            })
          }}
        >
          <option value="" disabled>
            {t('entity.choose')}
          </option>
          {others.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.primaryAlias ?? entity.publicToken} ({label(entity.type)})
            </option>
          ))}
        </select>
      </label>
      {assign.error !== null && <p className="error">{formatError(assign.error)}</p>}
    </div>
  )
}
