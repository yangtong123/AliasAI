import { useState } from 'react'
import type { MatterSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

export function MatterList(props: {
  readonly matters: readonly MatterSummaryDTO[]
  readonly selectedMatterId: string | null
  readonly onSelect: (matterId: string) => void
  readonly onCreated: () => void
}) {
  const [name, setName] = useState('')
  const create = useMutation((value: string) => invoke('matter:create', { name: value }))

  return (
    <section className="matter-list">
      <h2>Matters</h2>
      <ul>
        {props.matters.map((matter) => (
          <li key={matter.id}>
            <button
              type="button"
              className={matter.id === props.selectedMatterId ? 'selected' : undefined}
              onClick={() => props.onSelect(matter.id)}
            >
              {matter.name}
            </button>
          </li>
        ))}
        {props.matters.length === 0 && <li className="empty">No matters yet</li>}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (name.trim().length === 0) return
          void create.run(name).then((created) => {
            if (created !== null) {
              setName('')
              props.onCreated()
            }
          })
        }}
      >
        <input
          value={name}
          placeholder="New matter name"
          onChange={(event) => setName(event.target.value)}
          aria-label="New matter name"
        />
        <button type="submit" disabled={create.pending || name.trim().length === 0}>
          Create
        </button>
      </form>
      {create.error !== null && <p className="error">{create.error.message}</p>}
    </section>
  )
}
