import type { DocumentReviewDTO, MentionReviewDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
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
  const confirm = useMutation((mentionId: string) => invoke('review:confirm', { mentionId }))

  if (props.mention === null) {
    return <p className="empty">Select a highlighted mention to review it</p>
  }
  const mention = props.mention
  // Review mutations desync a SANITIZED artifact; block them until re-import.
  const locked = props.review.document.parseStatus === 'SANITIZED'

  return (
    <section className="mention-detail">
      <h3>
        {mention.text} <span className={`badge decision-${mention.decisionStatus.toLowerCase()}`}>{mention.decisionStatus}</span>
      </h3>
      <p>
        {mention.type} · {mention.strength} · confidence {mention.confidence.toFixed(2)} · page {mention.pageNo + 1}
        {mention.margin !== null && <> · margin {mention.margin}</>} · review {mention.reviewStatus}
      </p>
      {mention.assignedEntity !== null && (
        <p>
          Assigned to <strong>{mention.assignedEntity.primaryAlias ?? mention.assignedEntity.publicToken}</strong>
        </p>
      )}
      {locked ? (
        <p className="warning">Document is sanitized; re-import to change review decisions.</p>
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
            <button
              type="button"
              disabled={confirm.pending || mention.reviewStatus === 'CONFIRMED'}
              onClick={() => {
                void confirm.run(mention.mentionId).then((result) => {
                  if (result !== null) props.onChanged()
                })
              }}
            >
              {mention.reviewStatus === 'CONFIRMED' ? 'Confirmed' : 'Confirm'}
            </button>
          )}
          {confirm.error !== null && <p className="error">{confirm.error.message}</p>}
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
  const allMentions = props.review.blocks.flatMap((block) => block.mentions)
  const selected = allMentions.find((mention) => mention.mentionId === props.selectedMentionId) ?? null

  return (
    <div className="review-layout">
      <div className="review-blocks">
        <p className="counts">
          {props.review.counts.mentions} mentions · {props.review.counts.resolved} resolved ·{' '}
          {props.review.counts.needsReview} need review · {props.review.counts.unresolved} unresolved
        </p>
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
