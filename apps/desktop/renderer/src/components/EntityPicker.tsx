import type { EntitySummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

/** Reassigns the mention to any other entity in the matter. */
export function EntityPicker(props: {
  readonly mentionId: string
  readonly currentEntityId: string | null
  readonly entities: readonly EntitySummaryDTO[]
  readonly onApplied: () => void
}) {
  const assign = useMutation((entityId: string) => invoke('review:assign', { mentionId: props.mentionId, entityId }))
  const others = props.entities.filter((entity) => entity.id !== props.currentEntityId)

  if (others.length === 0) return <p className="empty">No other entities</p>

  return (
    <div className="entity-picker">
      <label>
        Reassign to
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
            Choose entity…
          </option>
          {others.map((entity) => (
            <option key={entity.id} value={entity.id}>
              {entity.primaryAlias ?? entity.publicToken} ({entity.type})
            </option>
          ))}
        </select>
      </label>
      {assign.error !== null && <p className="error">{assign.error.message}</p>}
    </div>
  )
}
