import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiExecutionView } from '@aliasai/application'
import { invoke, UiError } from '../api/client'
import { useMutation } from '../api/hooks'
import { useI18n } from '../i18n'

interface PanelState {
  readonly sourceKey: string
  readonly seq: number
  readonly execution: AiExecutionView | null
  readonly loadError: UiError | null
}

type ResultVariant = 'SANITIZED' | 'REHYDRATED'
type DeliveryMessageKey =
  | 'ai.sanitizedCopied'
  | 'ai.sanitizedSaved'
  | 'ai.restoredCopied'
  | 'ai.restoredSaved'

/**
 * One AI execution panel for a single sanitized artifact and restore policy.
 * The parent remounts the panel (key) when the document changes, so no state
 * from one document can ever render for another.
 */
export function AiExecutionPanel(props: { readonly sanitizedDocumentId: string }) {
  const { t, formatError } = useI18n()
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
  const [deliveryStatus, setDeliveryStatus] = useState<{
    readonly sourceKey: string
    readonly messageKey: DeliveryMessageKey
  } | null>(null)
  const deliveryPending = deliveryKey === sourceKey && (copy.pending || exportResult.pending)
  const deliveryError = deliveryKey === sourceKey ? (copy.error ?? exportResult.error) : null

  // Derived at render time: a result from a different sourceKey (document or
  // restore policy) never displays, not even for the frame before effects run.
  const execution = panel.sourceKey === sourceKey ? panel.execution : null
  const loadError = panel.sourceKey === sourceKey ? panel.loadError : null

  return (
    <section className="ai-execution">
      <h4>{t('ai.title')}</h4>
      <p className="hint">{t('ai.hint')}</p>
      <label>
        <input
          type="checkbox"
          checked={includeOnRequest}
          onChange={(event) => setIncludeOnRequest(event.target.checked)}
        />
        {t('ai.restoreOnRequest')}
      </label>
      <button type="button" disabled={runPending} onClick={() => void run.run()}>
        {t(runPending ? 'ai.runningButton' : 'ai.send')}
      </button>
      {(runError ?? loadError) !== null && <p className="error">{formatError((runError ?? loadError)!)}</p>}
      {execution?.status === 'RUNNING' && <p>{t('ai.running')}</p>}
      {execution?.status === 'FAILED' && <p className="error">{t('ai.failed', { code: execution.errorCode })}</p>}
      {execution?.status === 'COMPLETED' && (
        <div className="ai-results">
          <h4>{t('ai.sanitizedResponse')}</h4>
          <pre>{execution.sanitizedResponse}</pre>
          <ResultActions
            label="sanitized"
            disabled={deliveryPending}
            onCopy={() => {
              setDeliveryKey(sourceKey)
              void copy.run(execution.id, 'SANITIZED').then((result) => {
                if (result !== null) setDeliveryStatus({ sourceKey, messageKey: 'ai.sanitizedCopied' })
              })
            }}
            onExport={() => {
              setDeliveryKey(sourceKey)
              void exportResult.run(execution.id, 'SANITIZED').then((result) => {
                if (result?.saved === true) setDeliveryStatus({ sourceKey, messageKey: 'ai.sanitizedSaved' })
              })
            }}
          />
          <h4>{t('ai.restoredResponse')}</h4>
          <pre>{execution.rehydratedResponse}</pre>
          <p className="warning">{t('ai.restoredWarning')}</p>
          <ResultActions
            label="restored"
            disabled={deliveryPending}
            onCopy={() => {
              setDeliveryKey(sourceKey)
              void copy.run(execution.id, 'REHYDRATED').then((result) => {
                if (result !== null) setDeliveryStatus({ sourceKey, messageKey: 'ai.restoredCopied' })
              })
            }}
            onExport={() => {
              setDeliveryKey(sourceKey)
              void exportResult.run(execution.id, 'REHYDRATED').then((result) => {
                if (result?.saved === true) setDeliveryStatus({ sourceKey, messageKey: 'ai.restoredSaved' })
              })
            }}
          />
          {execution.unresolvedTokens.length > 0 && (
            <p className="warning">{t('ai.unresolved', { tokens: execution.unresolvedTokens.join(', ') })}</p>
          )}
          {deliveryError !== null && <p className="error">{formatError(deliveryError)}</p>}
          {deliveryStatus?.sourceKey === sourceKey && <p role="status">{t(deliveryStatus.messageKey)}</p>}
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
  const { t } = useI18n()
  const variant = t(props.label === 'sanitized' ? 'ai.sanitizedVariant' : 'ai.restoredVariant')
  return (
    <div className="result-actions">
      <button type="button" disabled={props.disabled} onClick={props.onCopy}>
        {t('ai.copy', { variant })}
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onExport}>
        {t('ai.export', { variant })}
      </button>
    </div>
  )
}
