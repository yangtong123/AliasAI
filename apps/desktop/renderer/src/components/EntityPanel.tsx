import { useState } from 'react'
import type { ConstraintDTO, EntitySummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'

export function EntityPanel(props: {
  readonly matterId: string
  readonly entities: readonly EntitySummaryDTO[]
  readonly constraints: readonly ConstraintDTO[]
  readonly onConstraintAdded: () => void
}) {
  const { t, label, formatError } = useI18n()
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const [reason, setReason] = useState('')
  const [renameValues, setRenameValues] = useState<Record<string, string>>({})
  const [mergeSource, setMergeSource] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const add = useMutation((input: { entityAId: string; entityBId: string; reason: string }) =>
    invoke('review:addConstraint', { ...input, type: 'CANNOT_LINK', matterId: props.matterId })
  )
  const rename = useMutation((input: { entityId: string; primaryAlias: string }) => invoke('review:renameEntity', input))
  const merge = useMutation((input: { sourceEntityId: string; targetEntityId: string }) => invoke('review:mergeEntities', input))

  return (
    <section className="entity-panel">
      <h3>{t('entity.title')}</h3>
      <ul>
        {props.entities.map((entity) => (
          <li key={entity.id}>
            <div>{entity.primaryAlias ?? entity.publicToken} · {label(entity.type)} · {entity.publicToken}</div>
            <form
              className="inline-operation"
              onSubmit={(event) => {
                event.preventDefault()
                const primaryAlias = renameValues[entity.id]?.trim() ?? ''
                if (primaryAlias.length === 0) return
                void rename.run({ entityId: entity.id, primaryAlias }).then((result) => {
                  if (result !== null) {
                    setRenameValues((values) => ({ ...values, [entity.id]: '' }))
                    props.onConstraintAdded()
                  }
                })
              }}
            >
              <input
                value={renameValues[entity.id] ?? ''}
                aria-label={t('entity.renameAlias')}
                placeholder={t('entity.renameAlias')}
                onChange={(event) => setRenameValues((values) => ({ ...values, [entity.id]: event.target.value }))}
              />
              <button type="submit" disabled={rename.pending}>{t('entity.rename')}</button>
            </form>
          </li>
        ))}
        {props.entities.length === 0 && <li className="empty">{t('entity.empty')}</li>}
      </ul>
      {props.entities.length >= 2 && (
        <form
          className="inline-operation"
          onSubmit={(event) => {
            event.preventDefault()
            if (mergeSource === '' || mergeTarget === '' || mergeSource === mergeTarget) return
            void merge.run({ sourceEntityId: mergeSource, targetEntityId: mergeTarget }).then((result) => {
              if (result !== null) {
                setMergeSource('')
                setMergeTarget('')
                props.onConstraintAdded()
              }
            })
          }}
        >
          <select value={mergeSource} aria-label={t('entity.mergeSource')} onChange={(event) => setMergeSource(event.target.value)}>
            <option value="">{t('entity.mergeSource')}</option>
            {props.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.primaryAlias ?? entity.publicToken}</option>)}
          </select>
          <select value={mergeTarget} aria-label={t('entity.mergeTarget')} onChange={(event) => setMergeTarget(event.target.value)}>
            <option value="">{t('entity.mergeTarget')}</option>
            {props.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.primaryAlias ?? entity.publicToken}</option>)}
          </select>
          <button type="submit" disabled={merge.pending}>{t('entity.merge')}</button>
        </form>
      )}
      <h4>{t('entity.constraints')}</h4>
      <ul>
        {props.constraints.map((constraint) => (
          <li key={constraint.id}>
            {constraint.entityAId} ✕ {constraint.entityBId} — {constraint.reason}
          </li>
        ))}
        {props.constraints.length === 0 && <li className="empty">{t('entity.none')}</li>}
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
          <select value={first} aria-label={t('entity.first')} onChange={(event) => setFirst(event.target.value)}>
            <option value="" disabled>
              {t('entity.firstOption')}
            </option>
            {props.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.primaryAlias ?? entity.publicToken}
              </option>
            ))}
          </select>
          <select value={second} aria-label={t('entity.second')} onChange={(event) => setSecond(event.target.value)}>
            <option value="" disabled>
              {t('entity.secondOption')}
            </option>
            {props.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.primaryAlias ?? entity.publicToken}
              </option>
            ))}
          </select>
          <input
            value={reason}
            placeholder={t('entity.reason')}
            aria-label={t('entity.constraintReason')}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="submit" disabled={add.pending}>
            {t('entity.cannotLink')}
          </button>
        </form>
      )}
      {(add.error ?? rename.error ?? merge.error) !== null && (
        <p className="error">{formatError((add.error ?? rename.error ?? merge.error)!)}</p>
      )}
    </section>
  )
}
