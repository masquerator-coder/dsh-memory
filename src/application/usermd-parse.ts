/**
 * user.md parser (design §8.4). Turns an edited Markdown document back into
 * structured `{ predicate, content }` lines. It is deliberately tolerant: it
 * ignores the template headings (`#`, `##`) and any non-bullet prose, and only
 * records bullet lines that sit under a `### <label> (predicate: <p>)` group.
 * Lines outside any predicate group are skipped rather than invented.
 *
 * @module dsh-memory/application/usermd-parse
 */
import type { ParsedUserMd, UserMdLine } from '../domain/usermd.ts'

const H1_RE = /^#\s+(.+)$/
const H3_RE = /^###\s+(.+?)(?:\s*\(predicate:\s*([^)]+)\))?\s*$/
const BULLET_RE = /^\s*[-*]\s+(.+)$/

/** Parse a user.md Markdown document into structured lines. */
export function parseUserMd(markdown: string): ParsedUserMd {
  const lines = markdown.split(/\r?\n/)
  let entity: string | undefined
  let predicate: string | undefined
  let heading: string | undefined
  const out: UserMdLine[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue

    const h1 = line.match(H1_RE)
    if (h1 !== null && h1 !== undefined) {
      entity = h1[1].trim()
      continue
    }
    const h3 = line.match(H3_RE)
    if (h3 !== null && h3 !== undefined) {
      heading = h3[1].trim()
      predicate = (h3[2] ?? '').trim() || undefined
      continue
    }
    // `##` section headers (核心摘要 / 详细偏好) don't carry predicates — skip.
    if (/^#{2}\s+/.test(line)) continue

    const bullet = line.match(BULLET_RE)
    if (bullet !== null && bullet !== undefined) {
      const content = bullet[1].trim()
      if (content.length === 0 || content.startsWith('<!--')) continue
      if (predicate === undefined) continue // ignore bullets outside a group
      out.push({ predicate, heading, content })
    }
  }
  return { entity, lines: out }
}
