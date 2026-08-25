import { useState } from 'react'
import type { SanitizedPreview } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'
import { AiExecutionPanel } from './AiExecutionPanel'

export function SanitizedPreviewView(props: {
  readonly documentId: string
  readonly preview: SanitizedPreview | null
  readonly onGenerated: () => void
  readonly onReviewMention?: (mentionId: string) => void
}) {
  const { t, label, formatError } = useI18n()
  const [includeOnRequest, setIncludeOnRequest] = useState(true)
  const [demoText, setDemoText] = useState('')
  const [demoResult, setDemoResult] = useState<{ text: string; unresolvedTokens: readonly string[] } | null>(null)

  const generate = useMutation(() => invoke('preview:generate', { documentId: props.documentId }))
  const rehydrate = useMutation((input: { text: string; includeRestoreOnRequest: boolean }) =>
    invoke('preview:rehydrate', {
      sanitizedDocumentId: availablePreview(props.preview)?.sanitizedDocumentId ?? '',
      ...input
    })
  )
  const copySanitized = useMutation((documentId: string, sanitizedDocumentId: string) =>
    invoke('preview:copySanitized', { documentId, sanitizedDocumentId })
  )
  const exportSanitized = useMutation((documentId: string, sanitizedDocumentId: string) =>
    invoke('preview:exportSanitized', { documentId, sanitizedDocumentId })
  )
  const [artifactStatus, setArtifactStatus] = useState<'preview.copied' | 'preview.saved' | null>(null)

  if (props.preview === null) {
    return <p className="empty">{t('preview.empty')}</p>
  }
  if (props.preview.status === 'NOT_READY') {
    return <p className="empty">{t('preview.notReady', { status: label(props.preview.parseStatus) })}</p>
  }
  if (props.preview.status === 'READY') {
    if (props.preview.blockers.length === 0) {
      return (
        <section className="preview">
          <h3>{t('preview.readyTitle')}</h3>
          <p>{t('preview.readyDescription')}</p>
          <button
            type="button"
            disabled={generate.pending}
            onClick={() => {
              void generate.run().then((result) => {
                if (result !== null) props.onGenerated()
              })
            }}
          >
            {t(generate.pending ? 'preview.generating' : 'preview.generate')}
          </button>
          {generate.error !== null && <p className="error">{formatError(generate.error)}</p>}
        </section>
      )
    }
    return (
      <section className="preview">
        <h3>{t('preview.blocked')}</h3>
        <ul>
          {props.preview.blockers.map((blocker) => (
            <li key={blocker.mentionId}>
              {blocker.mentionId}: {label(blocker.reason)}{' '}
              {props.onReviewMention !== undefined && (
                <button type="button" onClick={() => props.onReviewMention?.(blocker.mentionId)}>
                  {t('preview.reviewMention')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p>{t('preview.resolveAll')}</p>
      </section>
    )
  }

  const preview = props.preview
  const sanitizedJoin = preview.blocks.map((block) => block.text).join('\n\n')

  return (
    <section className="preview">
      <h3>{t('preview.title')}</h3>
      {preview.blocks.map((block) => (
        <p key={block.blockId} className="sanitized-block">
          {block.text}
        </p>
      ))}
      <div className="result-actions">
        <button
          type="button"
          disabled={copySanitized.pending || exportSanitized.pending}
          onClick={() => {
            void copySanitized.run(props.documentId, preview.sanitizedDocumentId).then((result) => {
              if (result !== null) setArtifactStatus('preview.copied')
            })
          }}
        >
          {t('preview.copy')}
        </button>
        <button
          type="button"
          disabled={copySanitized.pending || exportSanitized.pending}
          onClick={() => {
            void exportSanitized.run(props.documentId, preview.sanitizedDocumentId).then((result) => {
              if (result?.saved === true) setArtifactStatus('preview.saved')
            })
          }}
        >
          {t('preview.export')}
        </button>
      </div>
      {(copySanitized.error ?? exportSanitized.error) !== null && (
        <p className="error">{formatError((copySanitized.error ?? exportSanitized.error)!)}</p>
      )}
      {artifactStatus !== null && <p role="status">{t(artifactStatus)}</p>}

      {/* Remounting per document keeps AI execution state (results, pending,
          errors) from ever bleeding across documents. */}
      <AiExecutionPanel key={preview.sanitizedDocumentId} sanitizedDocumentId={preview.sanitizedDocumentId} />

      <h4>{t('preview.demoTitle')}</h4>
      <p className="hint">{t('preview.demoHint')}</p>
      <textarea
        value={demoText}
        rows={4}
        aria-label={t('preview.demoAria')}
        placeholder={sanitizedJoin}
        onChange={(event) => setDemoText(event.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={includeOnRequest}
          onChange={(event) => setIncludeOnRequest(event.target.checked)}
        />
        {t('preview.restoreOnRequest')}
      </label>
      <button
        type="button"
        disabled={demoText.trim().length === 0 || rehydrate.pending}
        onClick={() => {
          void rehydrate.run({ text: demoText, includeRestoreOnRequest: includeOnRequest }).then((result) => {
            if (result !== null) setDemoResult(result)
          })
        }}
      >
        {t('preview.rehydrate')}
      </button>
      <button type="button" onClick={() => setDemoText(sanitizedJoin)}>
        {t('preview.useSanitized')}
      </button>
      {rehydrate.error !== null && <p className="error">{formatError(rehydrate.error)}</p>}

      {demoResult !== null && (
        <div className="demo-result">
          <p>{demoResult.text}</p>
          {demoResult.unresolvedTokens.length > 0 && (
            <p className="warning">
              {t('preview.unresolved', { tokens: demoResult.unresolvedTokens.join(', ') })}
            </p>
          )}
        </div>
      )}

      <button type="button" disabled={generate.pending} onClick={() => {
        void generate.run().then((result) => {
          if (result !== null) props.onGenerated()
        })
      }}>
        {t('preview.regenerate')}
      </button>
      {generate.error !== null && <p className="error">{formatError(generate.error)}</p>}
    </section>
  )
}

function availablePreview(
  preview: SanitizedPreview | null
): Extract<SanitizedPreview, { status: 'AVAILABLE' }> | null {
  return preview !== null && preview.status === 'AVAILABLE' ? preview : null
}
