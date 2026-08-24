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
  { label: 'Parse', channel: 'document:process', enabledFrom: ['IMPORTED'] },
  { label: 'Detect', channel: 'document:detect', enabledFrom: ['PARSED'] },
  { label: 'Resolve', channel: 'document:resolve', enabledFrom: ['DETECTED'] }
]

export function PipelineControls(props: {
  readonly documentId: string
  readonly parseStatus: DocumentParseStatus
  readonly jobs: readonly JobSummaryDTO[]
  readonly onChanged: () => void
}) {
  const current = selectStage(props.parseStatus, props.jobs)
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
          {props.parseStatus === 'FAILED' ? 'Retry' : 'Run'} {current.label}
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

function selectStage(parseStatus: DocumentParseStatus, jobs: readonly JobSummaryDTO[]): Stage | undefined {
  if (parseStatus !== 'FAILED') return STAGES.find((stage) => stage.enabledFrom.includes(parseStatus))
  const failedJob = [...jobs]
    .filter((job) => job.status === 'FAILED' || job.status === 'CANCELLED')
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  if (failedJob?.type === 'DETECT') return STAGES[1]
  if (failedJob?.type === 'RESOLVE') return STAGES[2]
  // PARSE does not create a ProcessingJob yet. With no failed downstream job,
  // FAILED therefore belongs to parsing. SANITIZE retries from Preview.
  if (failedJob === undefined || failedJob.type === 'PARSE' || failedJob.type === 'OCR') return STAGES[0]
  return undefined
}
