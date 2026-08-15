import type { JSX } from 'react'
import type { BlockReviewDTO, MentionReviewDTO } from '@aliasai/application'

/**
 * Renders block text with its mention spans highlighted. Mentions arrive in
 * startOffset order and never overlap within a block (the same invariant
 * sanitization relies on), so a single left-to-right slice is exact.
 */
export function BlockText(props: {
  readonly block: BlockReviewDTO
  readonly selectedMentionId: string | null
  readonly onSelectMention: (mentionId: string) => void
}) {
  const nodes: JSX.Element[] = []
  let cursor = 0
  props.block.mentions.forEach((mention, index) => {
    if (mention.startOffset > cursor) {
      nodes.push(<span key={`text-${index}`}>{props.block.text.slice(cursor, mention.startOffset)}</span>)
    }
    nodes.push(
      <button
        key={mention.mentionId}
        type="button"
        className={`mention decision-${mention.decisionStatus.toLowerCase()}${
          mention.mentionId === props.selectedMentionId ? ' selected' : ''
        }`}
        onClick={() => props.onSelectMention(mention.mentionId)}
        title={`${mention.type} · ${mention.decisionStatus}`}
      >
        {props.block.text.slice(mention.startOffset, mention.endOffset)}
      </button>
    )
    cursor = mention.endOffset
  })
  if (cursor < props.block.text.length) {
    nodes.push(<span key="text-tail">{props.block.text.slice(cursor)}</span>)
  }

  return (
    <article className="block">
      <header>
        Page {props.block.pageNo} · Block {props.block.readingOrder + 1}
      </header>
      <p className="block-text">{nodes}</p>
    </article>
  )
}

export function mentionByText(mentions: readonly MentionReviewDTO[], text: string): MentionReviewDTO | undefined {
  return mentions.find((mention) => mention.text === text)
}
