import { useState } from 'react'
import type { EntityType } from '@aliasai/domain'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

export function NewEntityForm(props: {
  readonly mentionId: string
  readonly onCreated: () => void
}) {
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
        placeholder="New entity primary alias"
        aria-label="New entity primary alias"
        onChange={(event) => setAlias(event.target.value)}
      />
      <select value={type} aria-label="Entity type" onChange={(event) => setType(event.target.value as EntityType)}>
        <option value="PERSON">PERSON</option>
        <option value="ORGANIZATION">ORGANIZATION</option>
      </select>
      <button type="submit" disabled={create.pending || alias.trim().length === 0}>
        Create entity &amp; assign
      </button>
      {create.error !== null && <p className="error">{create.error.message}</p>}
    </form>
  )
}
