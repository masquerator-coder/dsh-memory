/**
 * Predicate canonicalization contract.
 *
 * The semantic key is built from `canonical_predicate`, so two *distinct*
 * predicates canonicalizing onto the same string means two different
 * assertions share one `semantic_key` — the second one silently supersedes (or
 * is dropped in favour of) the first. These tests lock the non-collision
 * property for the plugin's primary (Chinese) input, which the previous
 * `[^a-z0-9_]` strip violated by folding every non-ASCII predicate to `____`.
 */
import { describe, expect, it } from 'vitest'
import { canonicalizePredicate, normalizePredicateText } from '../src/domain/predicate'

describe('canonicalizePredicate — non-collision', () => {
  it('keeps non-ASCII predicates distinct (opposite meanings must not merge)', () => {
    const likes = canonicalizePredicate('喜欢瑜伽')
    const dislikes = canonicalizePredicate('讨厌瑜伽')
    expect(likes).not.toBe(dislikes)
    expect(likes).toBe('喜欢瑜伽')
    expect(dislikes).toBe('讨厌瑜伽')
  })

  it('preserves CJK characters instead of erasing them', () => {
    expect(canonicalizePredicate('爱吃甜食')).toBe('爱吃甜食')
    expect(canonicalizePredicate('部署在阿里云')).toBe('部署在阿里云')
    // No unknown predicate may reduce to a run of underscores.
    for (const p of ['喜欢瑜伽', '讨厌瑜伽', '爱吃甜食', '部署在阿里云', 'x']) {
      expect(canonicalizePredicate(p)).not.toMatch(/^_+$/)
    }
  })

  it('preserves accented latin letters and digits', () => {
    expect(canonicalizePredicate('préfère')).toBe('préfère')
    expect(canonicalizePredicate('排名第2')).toBe('排名第2')
  })

  it('folds whitespace and separator punctuation only', () => {
    expect(canonicalizePredicate('runs marathons')).toBe('runs_marathons')
    expect(canonicalizePredicate('uses-tool')).toBe('uses_tool')
    expect(canonicalizePredicate('  spaced  out  ')).toBe('spaced_out')
  })

  it('still maps registered aliases onto their canonical predicate', () => {
    expect(canonicalizePredicate('喜欢素食')).toBe('prefers_diet')
    expect(canonicalizePredicate('likes_diet')).toBe('prefers_diet')
    expect(canonicalizePredicate('位于')).toBe('located_in')
  })

  it('is deterministic for a batch of distinct predicates', () => {
    const inputs = ['喜欢瑜伽', '讨厌瑜伽', '爱吃甜食', '部署在阿里云', 'préfère', 'uses-tool', 'speaks']
    const outputs = inputs.map(canonicalizePredicate)
    expect(new Set(outputs).size).toBe(new Set(inputs.map(normalizePredicateText)).size)
  })
})
