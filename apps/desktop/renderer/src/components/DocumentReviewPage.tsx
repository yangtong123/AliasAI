import { useEffect, useState, type ReactNode } from 'react'
import type { BlockReviewDTO, DocumentReviewDTO, MentionDecisionStatus, MentionReviewDTO } from '@aliasai/application'
import type { MentionType } from '@aliasai/domain'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'
import { BlockText } from './BlockText'
import { CandidateList } from './CandidateList'
import { EntityPanel } from './EntityPanel'
import { EntityPicker } from './EntityPicker'
import { NewEntityForm } from './NewEntityForm'

/** Mutually exclusive outcome buckets derived from each Mention's decision status. */
interface ReviewBuckets {
  readonly found: number
  readonly handled: number
  readonly notSensitive: number
  readonly attention: number
}

/**
 * Product-level summary buckets. Every Mention has exactly one decision
 * status, so `found = handled + notSensitive + attention` always reconciles;
 * the display therefore never disagrees with its components.
 */
export function summarizeReview(blocks: readonly BlockReviewDTO[]): ReviewBuckets {
  let found = 0
  let handled = 0
  let notSensitive = 0
  let attention = 0
  for (const block of blocks) {
    for (const mention of block.mentions) {
      found += 1
      switch (mention.decisionStatus) {
        case 'AUTO_LINKED':
        case 'USER_ASSIGNED':
          handled += 1
          break
        case 'REJECTED':
          notSensitive += 1
          break
        case 'NEEDS_REVIEW':
        case 'UNRESOLVED':
          attention += 1
          break
      }
    }
  }
  return { found, handled, notSensitive, attention }
}

const STATE_LABEL_KEYS: Readonly<Record<MentionDecisionStatus, 'state.autoLinked' | 'state.userAssigned' | 'state.needsAttention' | 'state.rejected'>> = {
  AUTO_LINKED: 'state.autoLinked',
  USER_ASSIGNED: 'state.userAssigned',
  NEEDS_REVIEW: 'state.needsAttention',
  UNRESOLVED: 'state.needsAttention',
  REJECTED: 'state.rejected'
}

function needsAttention(status: MentionDecisionStatus): boolean {
  return status === 'NEEDS_REVIEW' || status === 'UNRESOLVED'
}

/**
 * The result-first panel for one selected item: what was found, what AliasAI
 * decided, and the actions that matter. Detector numbers stay behind the
 * 技术详情 disclosure and expert identity tools behind 高级身份管理 — every
 * existing audited operation remains reachable, just not defaulted.
 */
export function MentionResultPanel(props: {
  readonly review: DocumentReviewDTO
  readonly mention: MentionReviewDTO | null
  readonly onChanged: () => void
}) {
  const { t, label, formatError } = useI18n()
  const [editing, setEditing] = useState(false)
  const reject = useMutation((mentionId: string) => invoke('review:rejectMention', { mentionId }))
  const selectedMentionId = props.mention?.mentionId

  // Correction state belongs to one item only.
  useEffect(() => {
    setEditing(false)
  }, [selectedMentionId])

  if (props.mention === null) {
    return (
      <section className="mention-detail">
        <p className="empty">{t('mention.select')}</p>
      </section>
    )
  }
  const mention = props.mention
  // Review mutations desync a SANITIZED artifact; block them until re-import.
  const locked = props.review.document.parseStatus === 'SANITIZED'
  const attention = needsAttention(mention.decisionStatus)
  const rejected = mention.decisionStatus === 'REJECTED'

  return (
    <section className="mention-detail">
      <h3>
        {mention.text}{' '}
        <span className={`badge decision-${mention.decisionStatus.toLowerCase()}`}>
          {t(STATE_LABEL_KEYS[mention.decisionStatus])}
        </span>
      </h3>
      <p>
        <span className="badge">{label(mention.type)}</span>
      </p>
      {mention.assignedEntity != null && (
        <p>
          {t('mention.belongsTo')}:{' '}
          <strong>{mention.assignedEntity.primaryAlias ?? mention.assignedEntity.publicToken}</strong>
        </p>
      )}
      <p className="hint">
        {rejected ? t('guidance.rejected') : attention ? t('guidance.attention') : t('guidance.handled')}
      </p>

      {locked ? (
        <p className="warning">{t('mention.locked')}</p>
      ) : (
        <>
          <div className="result-actions">
            {!rejected && !attention && !editing && (
              <button type="button" onClick={() => setEditing(true)}>
                {t('result.editResult')}
              </button>
            )}
            {attention && !editing && (
              <button type="button" className="selected" onClick={() => setEditing(true)}>
                {t('result.confirmOwner')}
              </button>
            )}
            {!rejected && !editing && (
              <button
                type="button"
                disabled={reject.pending}
                onClick={() => {
                  if (!window.confirm(t('result.rejectConfirm'))) return
                  void reject.run(mention.mentionId).then((result) => {
                    if (result !== null) props.onChanged()
                  })
                }}
              >
                {t('result.notSensitive')}
              </button>
            )}
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                {t('result.closeEditor')}
              </button>
            )}
          </div>
          {(reject.error ?? null) !== null && <p className="error">{formatError(reject.error!)}</p>}
          {editing && (
            <>
              <CandidateList mentionId={mention.mentionId} candidates={mention.candidates} onApplied={props.onChanged} />
              <EntityPicker
                mentionId={mention.mentionId}
                currentEntityId={mention.assignedEntity?.id ?? null}
                entities={props.review.entities}
                onApplied={props.onChanged}
              />
              {mention.assignedEntity != null && (
                <ConfirmAssignmentButton mentionId={mention.mentionId} confirmed={mention.reviewStatus === 'CONFIRMED'} onChanged={props.onChanged} />
              )}
              <Disclosure className="advanced-editor" label={t('result.advancedIdentity')}>
                <NewEntityForm mentionId={mention.mentionId} onCreated={props.onChanged} />
                <SplitMentionForm mentionId={mention.mentionId} enabled={mention.assignedEntity != null} onChanged={props.onChanged} />
              </Disclosure>
            </>
          )}
        </>
      )}

      <Disclosure className="tech-details" label={t('result.techDetails')}>
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
      </Disclosure>
    </section>
  )
}

/**
 * A disclosure whose content mounts only while open: expert tooling stays out
 * of both the visual default and the accessibility tree until expanded. The
 * open state is click-driven (with `preventDefault`) so behavior is identical
 * in real browsers and under jsdom, which never fires `toggle`.
 */
function Disclosure(props: {
  readonly className: string
  readonly label: string
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <details className={props.className} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
      >
        {props.label}
      </summary>
      {open && props.children}
    </details>
  )
}

function ConfirmAssignmentButton(props: {
  readonly mentionId: string
  readonly confirmed: boolean
  readonly onChanged: () => void
}) {
  const { t, formatError } = useI18n()
  const confirm = useMutation((mentionId: string) => invoke('review:confirm', { mentionId }))
  return (
    <>
      <button
        type="button"
        disabled={confirm.pending || props.confirmed}
        onClick={() => {
          void confirm.run(props.mentionId).then((result) => {
            if (result !== null) props.onChanged()
          })
        }}
      >
        {t(props.confirmed ? 'mention.confirmed' : 'mention.confirm')}
      </button>
      {confirm.error !== null && <p className="error">{formatError(confirm.error)}</p>}
    </>
  )
}

function SplitMentionForm(props: {
  readonly mentionId: string
  readonly enabled: boolean
  readonly onChanged: () => void
}) {
  const { t, formatError } = useI18n()
  const [splitAlias, setSplitAlias] = useState('')
  const split = useMutation((input: { mentionId: string; primaryAlias: string }) => invoke('review:splitMention', input))
  if (!props.enabled) return null
  return (
    <form
      className="inline-operation"
      onSubmit={(event) => {
        event.preventDefault()
        if (splitAlias.trim().length === 0) return
        void split.run({ mentionId: props.mentionId, primaryAlias: splitAlias }).then((result) => {
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
      <button type="submit" disabled={split.pending}>
        {t('mention.split')}
      </button>
      {split.error !== null && <p className="error">{formatError(split.error)}</p>}
    </form>
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
  const summary = summarizeReview(props.review.blocks)
  const [missedOpen, setMissedOpen] = useState(false)
  const [manualBlockId, setManualBlockId] = useState(props.review.blocks[0]?.blockId ?? '')
  const [manualText, setManualText] = useState('')
  const [manualType, setManualType] = useState<MentionType>('PERSON')
  const [manualError, setManualError] = useState<string | null>(null)
  const createManual = useMutation((input: { blockId: string; type: MentionType; startOffset: number; endOffset: number }) =>
    invoke('review:createManualMention', input)
  )

  useEffect(() => {
    if (props.selectedMentionId !== null || allMentions.length === 0) return
    // Items needing confirmation come first; otherwise the first detected item
    // is shown without implying that user action is required.
    const focus =
      allMentions.find((mention) => needsAttention(mention.decisionStatus)) ??
      allMentions.find((mention) => mention.decisionStatus !== 'REJECTED') ??
      allMentions[0]
    if (focus !== undefined) props.onSelectMention(focus.mentionId)
  }, [allMentions, props.selectedMentionId, props.onSelectMention])

  return (
    <div className="review-layout">
      <div className="review-blocks">
        <section className="result-summary" aria-live="polite">
          <h3>{t('analysis.complete')}</h3>
          <p>
            {t('result.summaryCounts', {
              found: summary.found,
              handled: summary.handled,
              attention: summary.attention
            })}
          </p>
          {summary.notSensitive > 0 && <p className="empty">{t('result.summaryRejected', { rejected: summary.notSensitive })}</p>}
        </section>
        {props.review.document.parseStatus !== 'SANITIZED' && props.review.blocks.length > 0 && (
          missedOpen ? (
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
                      setMissedOpen(false)
                      props.onSelectMention(result.mentionId)
                      props.onChanged()
                    }
                  })
              }}
            >
              <strong>{t('missed.title')}</strong>
              <select value={manualBlockId} aria-label={t('mention.manualBlock')} onChange={(event) => setManualBlockId(event.target.value)}>
                {props.review.blocks.map((block) => <option key={block.blockId} value={block.blockId}>{t('block.position', { page: block.pageNo, block: block.readingOrder + 1 })}</option>)}
              </select>
              <input value={manualText} aria-label={t('mention.manualText')} placeholder={t('mention.manualText')} onChange={(event) => setManualText(event.target.value)} />
              <select value={manualType} aria-label={t('mention.manualType')} onChange={(event) => setManualType(event.target.value as MentionType)}>
                {(['PERSON', 'ORGANIZATION', 'PHONE', 'EMAIL', 'ID_CARD', 'BANK_ACCOUNT', 'ADDRESS'] as const).map((type) => <option key={type} value={type}>{label(type)}</option>)}
              </select>
              <button type="submit" disabled={createManual.pending}>{t('mention.manualCreate')}</button>
              <button type="button" onClick={() => setMissedOpen(false)}>{t('trash.cancel')}</button>
              {(manualError ?? (createManual.error === null ? null : formatError(createManual.error))) !== null && <span className="error">{manualError ?? formatError(createManual.error!)}</span>}
            </form>
          ) : (
            <p className="missed-entry">
              {t('missed.title')}{' '}
              <button type="button" onClick={() => setMissedOpen(true)}>
                {t('missed.action')}
              </button>
            </p>
          )
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
        <MentionResultPanel review={props.review} mention={selected} onChanged={props.onChanged} />
        {/*
          Matter-level identity management stays reachable regardless of the
          selected item: documents without mentions, fully rejected ones, and
          SANITIZED (locked) documents must still expose rename/merge/
          constraints/token list for audit and correction.
        */}
        <Disclosure className="matter-identity" label={t('result.advancedIdentity')}>
          <EntityPanel
            matterId={props.review.document.matterId}
            entities={props.review.entities}
            constraints={props.review.constraints}
            onConstraintAdded={props.onChanged}
          />
        </Disclosure>
      </div>
    </div>
  )
}
