import type { DocumentParseStatus } from '@aliasai/domain'
import type { JobSummaryDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

type Stage = {
  readonly label: string
  readonly channel: 'document:process' | 'document:detect' | 'document:resolve'
  /** Statuses from which this stage can run. */
  readonly enabledFrom: readonly DocumentParseStatus[]
}

const STAGES: readonly Stage[] = [
  { label: 'Parse', channel: 'document:process', enabledFrom: ['IMPORTED', 'FAILED'] },
  { label: 'Detect', channel: 'document:detect', enabledFrom: ['PARSED', 'FAILED'] },
  { label: 'Resolve', channel: 'document:resolve', enabledFrom: ['DETECTED', 'FAILED'] }
]

export function PipelineControls(props: {
  readonly documentId: string
  readonly parseStatus: DocumentParseStatus
  readonly jobs: readonly JobSummaryDTO[]
  readonly onChanged: () => void
}) {
  const current = STAGES.find((stage) => stage.enabledFrom.includes(props.parseStatus))
  const run = useMutation((channel: Stage['channel']) => invoke(channel, { documentId: props.documentId }))

  const onRun = () => {
    if (current === undefined) return
    void run.run(current.channel).then((result) => {
      if (result !== null) props.onChanged()
    })
  }

  const activeJob = props.jobs.find((job) => job.status === 'RUNNING')

  return (
    <section className="pipeline">
      <ol className="stages">
        {STAGES.map((stage) => (
          <li key={stage.channel}>{stage.label}</li>
        ))}
      </ol>
      {current !== undefined ? (
        <button type="button" onClick={onRun} disabled={run.pending}>
          Run {current.label}
        </button>
      ) : (
        <p className="empty">Pipeline idle</p>
      )}
      {activeJob !== undefined && (
        <p>
          {activeJob.type}: {Math.round(activeJob.progress * 100)}%
        </p>
      )}
      {run.error !== null && <p className="error">{run.error.message}</p>}
    </section>
  )
}
