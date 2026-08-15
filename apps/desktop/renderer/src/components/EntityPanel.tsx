import { useState } from 'react'
import type { ConstraintDTO, EntitySummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

export function EntityPanel(props: {
  readonly matterId: string
  readonly entities: readonly EntitySummaryDTO[]
  readonly constraints: readonly ConstraintDTO[]
  readonly onConstraintAdded: () => void
}) {
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const [reason, setReason] = useState('')
  const add = useMutation((input: { entityAId: string; entityBId: string; reason: string }) =>
    invoke('review:addConstraint', { ...input, type: 'CANNOT_LINK', matterId: props.matterId })
  )

  return (
    <section className="entity-panel">
      <h3>Entities</h3>
      <ul>
        {props.entities.map((entity) => (
          <li key={entity.id}>
            {entity.primaryAlias ?? entity.publicToken} · {entity.type} · {entity.publicToken}
          </li>
        ))}
        {props.entities.length === 0 && <li className="empty">No entities</li>}
      </ul>
      <h4>Cannot-Link constraints</h4>
      <ul>
        {props.constraints.map((constraint) => (
          <li key={constraint.id}>
            {constraint.entityAId} ✕ {constraint.entityBId} — {constraint.reason}
          </li>
        ))}
        {props.constraints.length === 0 && <li className="empty">None</li>}
      </ul>
      {props.entities.length >= 2 && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (first === '' || second === '' || first === second || reason.trim().length === 0) return
            void add.run({ entityAId: first, entityBId: second, reason }).then((result) => {
              if (result !== null) {
                setFirst('')
                setSecond('')
                setReason('')
                props.onConstraintAdded()
              }
            })
          }}
        >
          <select value={first} aria-label="First entity" onChange={(event) => setFirst(event.target.value)}>
            <option value="" disabled>
              First…
            </option>
            {props.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.primaryAlias ?? entity.publicToken}
              </option>
            ))}
          </select>
          <select value={second} aria-label="Second entity" onChange={(event) => setSecond(event.target.value)}>
            <option value="" disabled>
              Second…
            </option>
            {props.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.primaryAlias ?? entity.publicToken}
              </option>
            ))}
          </select>
          <input
            value={reason}
            placeholder="Reason"
            aria-label="Constraint reason"
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="submit" disabled={add.pending}>
            Cannot-Link
          </button>
        </form>
      )}
      {add.error !== null && <p className="error">{add.error.message}</p>}
    </section>
  )
}
