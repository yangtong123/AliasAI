import { useEffect, useState } from 'react'
import type { DocumentReviewDTO, MentionReviewDTO } from '@aliasai/application'
import type { MentionType } from '@aliasai/domain'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'
import { BlockText } from './BlockText'
import { CandidateList } from './CandidateList'
import { EntityPanel } from './EntityPanel'
import { EntityPicker } from './EntityPicker'
import { NewEntityForm } from './NewEntityForm'

export function MentionDetail(props: {
  readonly review: DocumentReviewDTO
  readonly mention: MentionReviewDTO | null
  readonly onChanged: () => void
}) {
  const { t, label, formatError } = useI18n()
  const confirm = useMutation((mentionId: string) => invoke('review:confirm', { mentionId }))
  const reject = useMutation((mentionId: string) => invoke('review:rejectMention', { mentionId }))
  const split = useMutation((input: { mentionId: string; primaryAlias: string }) => invoke('review:splitMention', input))
  const [splitAlias, setSplitAlias] = useState('')

  if (props.mention === null) {
    return <p className="empty">{t('mention.select')}</p>
  }
  const mention = props.mention
  // Review mutations desync a SANITIZED artifact; block them until re-import.
  const locked = props.review.document.parseStatus === 'SANITIZED'

  return (
    <section className="mention-detail">
      <h3>
        {mention.text}{' '}
        <span className={`badge decision-${mention.decisionStatus.toLowerCase()}`}>{label(mention.decisionStatus)}</span>
      </h3>
      <p>
        {t('mention.details', {
          type: label(mention.type),
          strength: label(mention.strength),
          confidence: mention.confidence.toFixed(2),
          page: mention.pageNo
        })}
        {mention.margin !== null && t('mention.margin', { margin: mention.margin })}
        {t('mention.review', { status: label(mention.reviewStatus) })}
      </p>
      <p className="hint">{t('mention.systemResult')}</p>
      {mention.assignedEntity !== null && (
        <p>
          {t('mention.assigned')} <strong>{mention.assignedEntity.primaryAlias ?? mention.assignedEntity.publicToken}</strong>
        </p>
      )}
      {locked ? (
        <p className="warning">{t('mention.locked')}</p>
      ) : (
        <>
          <CandidateList mentionId={mention.mentionId} candidates={mention.candidates} onApplied={props.onChanged} />
          <NewEntityForm mentionId={mention.mentionId} onCreated={props.onChanged} />
          <EntityPicker
            mentionId={mention.mentionId}
            currentEntityId={mention.assignedEntity?.id ?? null}
            entities={props.review.entities}
            onApplied={props.onChanged}
          />
          {mention.assignedEntity !== null && (
            <>
              <button
                type="button"
                disabled={confirm.pending || mention.reviewStatus === 'CONFIRMED'}
                onClick={() => {
                  void confirm.run(mention.mentionId).then((result) => {
                    if (result !== null) props.onChanged()
                  })
                }}
              >
                {t(mention.reviewStatus === 'CONFIRMED' ? 'mention.confirmed' : 'mention.confirm')}
              </button>
              <form
                className="inline-operation"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (splitAlias.trim().length === 0) return
                  void split.run({ mentionId: mention.mentionId, primaryAlias: splitAlias }).then((result) => {
                    if (result !== null) {
                      setSplitAlias('')
                      props.onChanged()
                    }
                  })
                }}
              >
                <input
                  value={splitAlias}
                  aria-label={t('mention.splitAlias')}
                  placeholder={t('mention.splitAlias')}
                  onChange={(event) => setSplitAlias(event.target.value)}
                />
                <button type="submit" disabled={split.pending}>{t('mention.split')}</button>
              </form>
            </>
          )}
          <button
            type="button"
            className="danger"
            disabled={reject.pending || mention.reviewStatus === 'REJECTED'}
            onClick={() => {
              void reject.run(mention.mentionId).then((result) => {
                if (result !== null) props.onChanged()
              })
            }}
          >
            {t('mention.reject')}
          </button>
          {(confirm.error ?? reject.error ?? split.error) !== null && (
            <p className="error">{formatError((confirm.error ?? reject.error ?? split.error)!)}</p>
          )}
        </>
      )}
    </section>
  )
}

export function DocumentReviewPage(props: {
  readonly review: DocumentReviewDTO
  readonly selectedMentionId: string | null
  readonly onSelectMention: (mentionId: string | null) => void
  readonly onChanged: () => void
}) {
  const { t, label, formatError } = useI18n()
  const allMentions = props.review.blocks.flatMap((block) => block.mentions)
  const selected = allMentions.find((mention) => mention.mentionId === props.selectedMentionId) ?? null
  const [manualBlockId, setManualBlockId] = useState(props.review.blocks[0]?.blockId ?? '')
  const [manualText, setManualText] = useState('')
  const [manualType, setManualType] = useState<MentionType>('PERSON')
  const [manualError, setManualError] = useState<string | null>(null)
  const createManual = useMutation((input: { blockId: string; type: MentionType; startOffset: number; endOffset: number }) =>
    invoke('review:createManualMention', input)
  )

  useEffect(() => {
    if (props.selectedMentionId === null && allMentions.length > 0) {
      const first = allMentions.find((mention) => mention.decisionStatus !== 'REJECTED') ?? allMentions[0]!
      props.onSelectMention(first.mentionId)
    }
  }, [allMentions, props.selectedMentionId, props.onSelectMention])

  return (
    <div className="review-layout">
      <div className="review-blocks">
        <p className="counts">
          {t('mention.counts', {
            mentions: props.review.counts.mentions,
            resolved: props.review.counts.resolved,
            needsReview: props.review.counts.needsReview,
            unresolved: props.review.counts.unresolved,
            rejected: props.review.counts.rejected
          })}
        </p>
        {props.review.document.parseStatus !== 'SANITIZED' && props.review.blocks.length > 0 && (
          <form
            className="manual-mention"
            onSubmit={(event) => {
              event.preventDefault()
              const block = props.review.blocks.find((item) => item.blockId === manualBlockId)
              const startOffset = block?.text.indexOf(manualText) ?? -1
              if (block === undefined || manualText.length === 0 || startOffset < 0) {
                setManualError(t('mention.manualNotFound'))
                return
              }
              if (block.text.indexOf(manualText, startOffset + 1) >= 0) {
                setManualError(t('mention.manualAmbiguous'))
                return
              }
              setManualError(null)
              void createManual
                .run({ blockId: block.blockId, type: manualType, startOffset, endOffset: startOffset + manualText.length })
                .then((result) => {
                  if (result !== null) {
                    setManualText('')
                    props.onSelectMention(result.mentionId)
                    props.onChanged()
                  }
                })
            }}
          >
            <strong>{t('mention.manualTitle')}</strong>
            <select value={manualBlockId} aria-label={t('mention.manualBlock')} onChange={(event) => setManualBlockId(event.target.value)}>
              {props.review.blocks.map((block) => <option key={block.blockId} value={block.blockId}>{t('block.position', { page: block.pageNo, block: block.readingOrder + 1 })}</option>)}
            </select>
            <input value={manualText} aria-label={t('mention.manualText')} placeholder={t('mention.manualText')} onChange={(event) => setManualText(event.target.value)} />
            <select value={manualType} aria-label={t('mention.manualType')} onChange={(event) => setManualType(event.target.value as MentionType)}>
              {(['PERSON', 'ORGANIZATION', 'PHONE', 'EMAIL', 'ID_CARD', 'BANK_ACCOUNT', 'ADDRESS'] as const).map((type) => <option key={type} value={type}>{label(type)}</option>)}
            </select>
            <button type="submit" disabled={createManual.pending}>{t('mention.manualCreate')}</button>
            {(manualError ?? (createManual.error === null ? null : formatError(createManual.error))) !== null && <span className="error">{manualError ?? formatError(createManual.error!)}</span>}
          </form>
        )}
        {props.review.blocks.map((block) => (
          <BlockText
            key={block.blockId}
            block={block}
            selectedMentionId={props.selectedMentionId}
            onSelectMention={props.onSelectMention}
          />
        ))}
      </div>
      <div className="review-side">
        <MentionDetail review={props.review} mention={selected} onChanged={props.onChanged} />
        <EntityPanel
          matterId={props.review.document.matterId}
          entities={props.review.entities}
          constraints={props.review.constraints}
          onConstraintAdded={props.onChanged}
        />
      </div>
    </div>
  )
}
