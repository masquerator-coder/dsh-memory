/**
 * Predicate registry — normalizes equivalent predicate spellings to one
 * canonical form so that `prefers_diet`, `enjoys_diet`, and `喜欢素食` collapse
 * onto the same canonical predicate and therefore the same semantic identity.
 *
 * The registry is intentionally conservative: vector-similarity is only ever a
 * suggestion, never an auto-merge. Unknown predicates pass through verbatim
 * (lowercased, whitespace folded) so we never lose a fact to an incomplete
 * dictionary — including non-ASCII predicates, which are the common case for
 * this plugin's primary (Chinese) input. Two distinct predicates must never
 * canonicalize onto the same key, or two different assertions would share one
 * `semantic_key` and silently supersede each other.
 *
 * @module dsh-memory/domain/predicate
 */

export interface PredicateEntry {
  /** Canonical predicate that owners may rely on in joins / graph edges. */
  readonly canonical: string
  /** Stable edge weight suggestion 0..1 (graph fan-out pruning input). */
  readonly weight: number
  /** Whether edges carrying this predicate should be treated as symmetric. */
  readonly symmetric?: boolean
}

/** Static synonym table built from the design's example canonical set. */
const SYNONYMS: ReadonlyArray<readonly [canonical: string, aliases: readonly string[]]> = [
  ['prefers_diet', ['prefers_diet', 'likes_diet', 'enjoys_diet', '喜欢素食', '爱吃', '饮食偏好']],
  ['uses_tool', ['uses_tool', 'uses', 'uses_tooling', '使用工具']],
  ['uses_technology', ['uses_technology', 'uses_tech', 'uses_stack', '使用技术栈', '技术栈是']],
  ['located_in', ['located_in', 'lives_in', 'based_in', '位于', '生活在']],
  ['works_at', ['works_at', 'employed_at', 'works_for', '任职于', '公司']],
  ['works_with', ['works_with', 'collaborates_with', '合作']],
  ['is_a', ['is_a', 'is', '职业是', '是']],
  ['speaks', ['speaks', 'speaks_language', '母语']],
  ['deployed_on', ['deployed_on', 'deployed_at', '部署在', '运行在']],
  ['uses_orm', ['uses_orm', 'orm', 'ORM']],
  ['uses_database', ['uses_database', 'database', '数据库']],
  ['has_theme', ['has_theme', 'persona', '风格', '偏好回答']],
]

const LOOKUP = new Map<string, PredicateEntry>()
for (const [canonical, aliases] of SYNONYMS) {
  const entry: PredicateEntry = { canonical, weight: 0.8 }
  for (const alias of aliases) LOOKUP.set(alias.toLowerCase(), entry)
}

/** Lowercase + collapse inner whitespace and trim outer whitespace. */
export function normalizePredicateText(input: string): string {
  return input.trim().replace(/[\s]+/g, ' ').toLowerCase()
}

/**
 * Canonicalize a raw predicate into its normalized canonical form.
 *
 * Known aliases collapse onto their registered canonical predicate. Unknown
 * predicates keep every letter/digit of any script (`\p{L}`/`\p{N}`) — only
 * whitespace runs and separator punctuation are folded to `_` — so distinct
 * predicates stay distinct (`喜欢瑜伽` ≠ `讨厌瑜伽`) instead of all collapsing
 * onto `____`, which would give semantically opposite facts one semantic key.
 *
 * @param predicate - the natural predicate from extraction.
 * @returns the canonical predicate string.
 */
export function canonicalizePredicate(predicate: string): string {
  const key = normalizePredicateText(predicate)
  const entry = LOOKUP.get(key)
  if (entry !== undefined) return entry.canonical
  // Unknown predicates pass through lowercased, with whitespace and separator
  // punctuation folded — never with the characters themselves discarded.
  // Deliberately no `_{2,}` collapsing: merging two spellings is worse than
  // keeping two distinct keys (a duplicate fact is recoverable, an overwrite
  // is not).
  return key.replace(/[\s]+/gu, '_').replace(/[^\p{L}\p{N}_]/gu, '_')
}

/** Metadata for a canonical predicate, defaulting benign values for unknowns. */
export function predicateEntry(canonicalPredicate: string): PredicateEntry {
  // Re-lookup by canonical name so registered metadata is used when present.
  return LOOKUP.get(canonicalPredicate.toLowerCase()) ?? { canonical: canonicalPredicate, weight: 0.8 }
}

/** Register an additional alias mapping (e.g. from user-defined profile). */
export function registerSynonym(canonical: string, ...aliases: string[]): void {
  const entry: PredicateEntry = { canonical, weight: 0.8 }
  for (const alias of aliases) LOOKUP.set(alias.toLowerCase(), entry)
}
