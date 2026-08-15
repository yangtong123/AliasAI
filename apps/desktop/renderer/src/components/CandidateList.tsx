import type { CandidateDTO } from '@aliasai/application'
import { invoke } from '../api/client'
import { useMutation } from '../api/hooks'

export function CandidateList(props: {
  readonly mentionId: string
  readonly candidates: readonly CandidateDTO[]
  readonly onApplied: () => void
}) {
  const assign = useMutation((entityId: string) => invoke('review:assign', { mentionId: props.mentionId, entityId }))

  if (props.candidates.length === 0) {
    return <p className="empty">No candidates — create a new entity or keep pending</p>
  }

  return (
    <ul className="candidates">
      {props.candidates.map((candidate) => (
        <li key={candidate.candidateId} className={`candidate state-${candidate.state.toLowerCase()}`}>
          <div className="candidate-head">
            <strong>{candidate.entity.primaryAlias ?? candidate.entity.publicToken}</strong>
            <span>
              score {candidate.score} · {candidate.state}
            </span>
          </div>
          <ul className="evidence">
            {candidate.evidence.map((item) => (
              <li key={`${candidate.candidateId}:${item.evidenceType}`}>
                {item.evidenceType} (weight {item.weight}, score {item.score})
              </li>
            ))}
          </ul>
          {candidate.state === 'PENDING' && (
            <button
              type="button"
              disabled={assign.pending}
              onClick={() => {
                void assign.run(candidate.entity.id).then((result) => {
                  if (result !== null) props.onApplied()
                })
              }}
            >
              Accept
            </button>
          )}
        </li>
      ))}
      {assign.error !== null && <li className="error">{assign.error.message}</li>}
    </ul>
  )
}
