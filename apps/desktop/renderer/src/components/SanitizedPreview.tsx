import { useState } from 'react'
import type { SanitizedPreview } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'
import { AiExecutionPanel } from './AiExecutionPanel'

export function SanitizedPreviewView(props: {
  readonly documentId: string
  readonly preview: SanitizedPreview | null
  readonly onGenerated: () => void
}) {
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

  if (props.preview === null) {
    return <p className="empty">No preview yet</p>
  }
  if (props.preview.status === 'NOT_READY') {
    return <p className="empty">Run the pipeline to READY before generating a preview ({props.preview.parseStatus}).</p>
  }
  if (props.preview.status === 'READY') {
    return (
      <section className="preview">
        <h3>Preview blocked</h3>
        <ul>
          {props.preview.blockers.map((blocker) => (
            <li key={blocker.mentionId}>
              {blocker.mentionId}: {blocker.reason}
            </li>
          ))}
        </ul>
        <p>Resolve every mention in review, then generate again.</p>
      </section>
    )
  }

  const preview = props.preview
  const sanitizedJoin = preview.blocks.map((block) => block.text).join('\n\n')

  return (
    <section className="preview">
      <h3>Sanitized preview</h3>
      {preview.blocks.map((block) => (
        <p key={block.blockId} className="sanitized-block">
          {block.text}
        </p>
      ))}

      {/* Remounting per document keeps AI execution state (results, pending,
          errors) from ever bleeding across documents. */}
      <AiExecutionPanel key={preview.sanitizedDocumentId} sanitizedDocumentId={preview.sanitizedDocumentId} />

      <h4>Local rehydration demo</h4>
      <p className="hint">
        Paste or edit the sanitized text as a simulated AI reply; tokens are restored locally only.
      </p>
      <textarea
        value={demoText}
        rows={4}
        aria-label="Simulated AI reply"
        placeholder={sanitizedJoin}
        onChange={(event) => setDemoText(event.target.value)}
      />
      <label>
        <input
          type="checkbox"
          checked={includeOnRequest}
          onChange={(event) => setIncludeOnRequest(event.target.checked)}
        />
        Restore RESTORE_ON_REQUEST values
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
        Rehydrate locally
      </button>
      <button type="button" onClick={() => setDemoText(sanitizedJoin)}>
        Use sanitized text
      </button>
      {rehydrate.error !== null && <p className="error">{rehydrate.error.message}</p>}

      {demoResult !== null && (
        <div className="demo-result">
          <p>{demoResult.text}</p>
          {demoResult.unresolvedTokens.length > 0 && (
            <p className="warning">
              Unresolved tokens for manual review: {demoResult.unresolvedTokens.join(', ')}
            </p>
          )}
        </div>
      )}

      <button type="button" disabled={generate.pending} onClick={() => {
        void generate.run().then((result) => {
          if (result !== null) props.onGenerated()
        })
      }}>
        Regenerate
      </button>
      {generate.error !== null && <p className="error">{generate.error.message}</p>}
    </section>
  )
}

function availablePreview(
  preview: SanitizedPreview | null
): Extract<SanitizedPreview, { status: 'AVAILABLE' }> | null {
  return preview !== null && preview.status === 'AVAILABLE' ? preview : null
}
