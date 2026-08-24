import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiExecutionView } from '@aliasai/application'
import { invoke, UiError } from '../api/client'
import { useMutation } from '../api/hooks'

interface PanelState {
  readonly sourceKey: string
  readonly seq: number
  readonly execution: AiExecutionView | null
  readonly loadError: UiError | null
}

type ResultVariant = 'SANITIZED' | 'REHYDRATED'

/**
 * One AI execution panel for a single sanitized artifact and restore policy.
 * The parent remounts the panel (key) when the document changes, so no state
 * from one document can ever render for another.
 */
export function AiExecutionPanel(props: { readonly sanitizedDocumentId: string }) {
  const [includeOnRequest, setIncludeOnRequest] = useState(false)
  const sourceKey = `${props.sanitizedDocumentId}:${includeOnRequest}`
  const [panel, setPanel] = useState<PanelState>(() => ({
    sourceKey,
    seq: 0,
    execution: null,
    loadError: null
  }))
  /**
   * Monotonic response sequencing shared by ai:latest and ai:execute: a
   * response may only be applied if it is at least as new as the last applied
   * one, so a slow ai:latest can never overwrite a fresher ai:execute result.
   */
  const sequenceRef = useRef(0)
  const lastAppliedSeqRef = useRef(0)
  const applyResponse = useCallback(
    (seq: number, key: string, execution: AiExecutionView | null, loadError: UiError | null): void => {
      if (seq < lastAppliedSeqRef.current) return
      lastAppliedSeqRef.current = seq
      setPanel({ sourceKey: key, seq, execution, loadError })
    },
    []
  )

  useEffect(() => {
    const seq = ++sequenceRef.current
    applyResponse(seq, sourceKey, null, null)
    invoke('ai:latest', {
      sanitizedDocumentId: props.sanitizedDocumentId,
      includeRestoreOnRequest: includeOnRequest
    })
      .then((result) => applyResponse(seq, sourceKey, result, null))
      .catch((error: unknown) => {
        applyResponse(
          seq,
          sourceKey,
          null,
          error instanceof UiError ? error : new UiError('INTERNAL_ERROR', 'An internal error occurred')
        )
      })
  }, [props.sanitizedDocumentId, includeOnRequest, sourceKey, applyResponse])

  // Bind the shared mutation state to the policy it was issued under: a
  // hanging request or its error must not disable or alarm a different policy.
  // useMutation additionally ignores updates from superseded invocations, so
  // when two policies have requests in flight, an older failure can neither
  // surface nor clear the newer request's pending state.
  const [mutationKey, setMutationKey] = useState<string | null>(null)
  const run = useMutation(() => {
    const seq = ++sequenceRef.current
    setMutationKey(sourceKey)
    return invoke('ai:execute', {
      sanitizedDocumentId: props.sanitizedDocumentId,
      includeRestoreOnRequest: includeOnRequest
    }).then((result) => {
      applyResponse(seq, sourceKey, result, null)
      return result
    })
  })
  const runPending = run.pending && mutationKey === sourceKey
  const runError = mutationKey === sourceKey ? run.error : null
  const copy = useMutation((executionId: string, variant: ResultVariant) =>
    invoke('ai:copyResult', { executionId, variant, includeRestoreOnRequest: includeOnRequest })
  )
  const exportResult = useMutation((executionId: string, variant: ResultVariant) =>
    invoke('ai:exportResult', { executionId, variant, includeRestoreOnRequest: includeOnRequest })
  )
  const [deliveryKey, setDeliveryKey] = useState<string | null>(null)
  const [deliveryStatus, setDeliveryStatus] = useState<{ readonly sourceKey: string; readonly message: string } | null>(null)
  const deliveryPending = deliveryKey === sourceKey && (copy.pending || exportResult.pending)
  const deliveryError = deliveryKey === sourceKey ? (copy.error ?? exportResult.error) : null

  // Derived at render time: a result from a different sourceKey (document or
  // restore policy) never displays, not even for the frame before effects run.
  const execution = panel.sourceKey === sourceKey ? panel.execution : null
  const loadError = panel.sourceKey === sourceKey ? panel.loadError : null

  return (
    <section className="ai-execution">
      <h4>Mock AI</h4>
      <p className="hint">Only the persisted sanitized document is sent. Restoration happens locally.</p>
      <label>
        <input
          type="checkbox"
          checked={includeOnRequest}
          onChange={(event) => setIncludeOnRequest(event.target.checked)}
        />
        Restore RESTORE_ON_REQUEST values locally
      </label>
      <button type="button" disabled={runPending} onClick={() => void run.run()}>
        {runPending ? 'Running…' : 'Send sanitized document'}
      </button>
      {(runError ?? loadError) !== null && <p className="error">{(runError ?? loadError)!.message}</p>}
      {execution?.status === 'RUNNING' && <p>AI execution is running.</p>}
      {execution?.status === 'FAILED' && <p className="error">AI execution failed: {execution.errorCode}</p>}
      {execution?.status === 'COMPLETED' && (
        <div className="ai-results">
          <h4>Sanitized AI response</h4>
          <pre>{execution.sanitizedResponse}</pre>
          <ResultActions
            label="sanitized"
            disabled={deliveryPending}
            onCopy={() => {
              setDeliveryKey(sourceKey)
              void copy.run(execution.id, 'SANITIZED').then((result) => {
                if (result !== null) setDeliveryStatus({ sourceKey, message: 'Sanitized response copied.' })
              })
            }}
            onExport={() => {
              setDeliveryKey(sourceKey)
              void exportResult.run(execution.id, 'SANITIZED').then((result) => {
                if (result?.saved === true) setDeliveryStatus({ sourceKey, message: 'Sanitized response saved.' })
              })
            }}
          />
          <h4>Locally rehydrated response</h4>
          <pre>{execution.rehydratedResponse}</pre>
          <p className="warning">Copying or exporting this restored result exposes sensitive plaintext outside AliasAI.</p>
          <ResultActions
            label="restored"
            disabled={deliveryPending}
            onCopy={() => {
              setDeliveryKey(sourceKey)
              void copy.run(execution.id, 'REHYDRATED').then((result) => {
                if (result !== null) setDeliveryStatus({ sourceKey, message: 'Restored response copied.' })
              })
            }}
            onExport={() => {
              setDeliveryKey(sourceKey)
              void exportResult.run(execution.id, 'REHYDRATED').then((result) => {
                if (result?.saved === true) setDeliveryStatus({ sourceKey, message: 'Restored response saved.' })
              })
            }}
          />
          {execution.unresolvedTokens.length > 0 && (
            <p className="warning">Unresolved tokens: {execution.unresolvedTokens.join(', ')}</p>
          )}
          {deliveryError !== null && <p className="error">{deliveryError.message}</p>}
          {deliveryStatus?.sourceKey === sourceKey && <p role="status">{deliveryStatus.message}</p>}
        </div>
      )}
    </section>
  )
}

function ResultActions(props: {
  readonly label: 'sanitized' | 'restored'
  readonly disabled: boolean
  readonly onCopy: () => void
  readonly onExport: () => void
}) {
  return (
    <div className="result-actions">
      <button type="button" disabled={props.disabled} onClick={props.onCopy}>
        Copy {props.label} response
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onExport}>
        Export {props.label} response…
      </button>
    </div>
  )
}
