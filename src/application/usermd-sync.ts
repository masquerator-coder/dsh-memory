/**
 * user.md ↔ atomic-fact write-back engine (design §8.4). Diffs an edited
 * Markdown view (parsed into lines) against the current active facts and
 * yields explicit `add` / `supersede` / `archive` actions the caller applies
 * through `rememberOne` / `forget`.
 *
 * Reconciliation is per canonical predicate: for each predicate, a line whose
 * content exactly matches a current active fact is a no-op; a changed or new
 * line supersedes an existing fact in that group (user edit always wins), or
 * is added when the group is empty; and any current fact not represented by an
 * unchanged line is archived. Because `user_edit` carries `credibility = 1.0`,
 * the resulting writes always displace lower-credibility conversation facts
 * (§8.4, §12.6 concurrent-edit / user-priority rule).
 *
 * @module dsh-memory/application/usermd-sync
 */
import type { AtomicFact } from '../domain/fact.ts'
import type { UserMdLine, UserEditAction } from '../domain/usermd.ts'

const PROFILE_TYPES = new Set(['semantic', 'procedural'])

export interface SyncDeps {
  /** Current active facts that appear in the profile (semantic/procedural). */
  readonly facts: readonly AtomicFact[]
}

/**
 * Diff edited lines against the current facts. Every line is classified as
 * unchanged / add / supersede; every fact not covered by an unchanged line is
 * archived.
 */
export function diffUserMdEdits(lines: readonly UserMdLine[], deps: SyncDeps): UserEditAction[] {
  const actions: UserEditAction[] = []
  // Group an already-consumed flag per fact so a line of identical content
  // maps to exactly one fact even when duplicates exist.
  const consumed = new Set<string>()
  const byPredicate = new Map<string, AtomicFact[]>()
  for (const fact of deps.facts) {
    if (fact.status !== 'active') continue
    if (!PROFILE_TYPES.has(fact.type)) continue
    const bucket = byPredicate.get(fact.canonical_predicate)
    if (bucket === undefined) byPredicate.set(fact.canonical_predicate, [fact])
    else bucket.push(fact)
  }

  for (const line of lines) {
    const bucket = byPredicate.get(line.predicate)
    const match = bucket?.find(f => f.content === line.content && !consumed.has(f.id))
    if (match !== undefined) {
      consumed.add(match.id)
      continue // unchanged
    }
    // Changed or new line: supersede the first unconsumed fact in this group,
    // else add a brand-new fact.
    const victim = bucket?.find(f => !consumed.has(f.id))
    if (victim !== undefined) {
      consumed.add(victim.id)
      actions.push({ kind: 'supersede', factId: victim.id, line })
    } else {
      actions.push({ kind: 'add', line })
    }
  }

  // Anything unconsumed is gone from the edited view → archive.
  for (const fact of deps.facts) {
    if (fact.status !== 'active') continue
    if (!PROFILE_TYPES.has(fact.type)) continue
    if (!consumed.has(fact.id)) actions.push({ kind: 'archive', factId: fact.id })
  }
  return actions
}
