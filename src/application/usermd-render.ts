/**
 * user.md renderer (design §8.5). Renders an `EntityCard` to the human-readable
 * Markdown view that a user edits directly. The view is derived purely from the
 * card — it holds no independent data, so it can never drift from the facts.
 *
 * Format:
 *   # User Profile: <name>
 *   ## 核心摘要
 *   - <summary line>
 *   ## 详细偏好
 *   ### <label> (predicate: <canonical>)
 *   - <fact content>
 *
 * Only semantic and procedural active, retrieval-visible facts are rendered —
 * episodic events are not part of a persistent profile.
 *
 * @module dsh-memory/application/usermd-render
 */
import type { EntityCard, CardGroup } from '../domain/card.ts'

const PROFILE_TYPES = new Set(['semantic', 'procedural'])

/** The group heading line, with the canonical predicate embedded for parsing. */
export function groupHeading(group: CardGroup): string {
  return `### ${group.title} (predicate: ${group.predicate})`
}

/** Render a card to the full user.md Markdown document. */
export function renderUserMd(card: EntityCard): string {
  const lines: string[] = []
  lines.push(`# User Profile: ${card.entityName}`)
  lines.push('')
  lines.push('## 核心摘要')
  if (card.summary.length === 0) {
    lines.push('- （暂无画像）')
  } else {
    for (const s of card.summary) lines.push(`- ${s}`)
  }
  lines.push('')
  lines.push('## 详细偏好')

  const groups = card.groups.filter(g => g.facts.some(f => PROFILE_TYPES.has(f.type)))
  if (groups.length === 0) {
    lines.push('- （暂无偏好）')
  } else {
    for (const group of groups) {
      lines.push('')
      lines.push(groupHeading(group))
      for (const fact of group.facts) {
        if (!PROFILE_TYPES.has(fact.type)) continue
        lines.push(`- ${fact.content}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}
