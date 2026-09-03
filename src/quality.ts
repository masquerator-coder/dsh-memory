/** dsh-memory — quality filter. Pure, side-effect-free heuristic 0–100. */
import type { MemoryEntry } from './types.js'

const META_RE = /(记忆|记住|别忘了|记得|memory)/i
const WEAK_RE = /(临时|一次性|应该记得|别忘|不太重要)/i

/** Longest-common-substring length (DP, O(n·m) time, O(m) space); guarded for large inputs. */
export function longestCommonSubstr(a: string, b: string): number {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 0
  if (n * m > 200_000) {
    // Large inputs: fall back to containment heuristic (cheap, good enough for dedup).
    if (a.includes(b) || b.includes(a)) return Math.min(n, m)
    return 0
  }
  const dp = new Array<number>(m + 1).fill(0)
  let best = 0
  for (let i = 1; i <= n; i += 1) {
    let prev = 0
    for (let j = 1; j <= m; j += 1) {
      const tmp = dp[j]!
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1
      else dp[j] = 0
      if (dp[j]! > best) best = dp[j]!
      prev = tmp
    }
  }
  return best
}

/** 0 = identical, 1 = disjoint; drives duplicate-cost penalty. */
export function contentSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const lcs = longestCommonSubstr(a, b)
  const maxLen = Math.max(a.length, b.length)
  const minLen = Math.min(a.length, b.length)
  if (maxLen / minLen > 2) return 0
  return lcs / maxLen
}

/** Tokenize into significant tokens: alphanumeric runs (English) + CJK chars
 *  and bigrams (the gap unicode61 leaves for CJK). Shared tokens are what make
 *  a RE-WORDED duplicate recognizable even when its openers diverge. */
export function tokenize(s: string): Set<string> {
  const t = new Set<string>()
  const low = s.toLowerCase()
  for (const m of low.matchAll(/[a-z0-9]+/g)) t.add(m[0])
  for (const m of low.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seq = m[0]
    if (seq.length === 1) t.add(seq)
    for (let i = 0; i < seq.length - 1; i++) t.add(seq.slice(i, i + 2))
  }
  return t
}

/** Token containment: |a∩b| / min(|a|,|b|) — the fraction of the shorter
 *  entry's vocabulary the other one shares. 0 = nothing shared, 1 = subset. */
export function tokenContain(a: string, b: string): number {
  const A = tokenize(a), B = tokenize(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / Math.min(A.size, B.size)
}

/** Aperture gate for CANDIDATE grouping only (L2 cross-topic + one-shot
 *  migration): treat two rows as "possibly the same fact reworded" on a shared
 *  token mass AND a contiguous run. Loose by design — the downstream judge
 *  (LLM via L2, or the human reviewing an archive manifest) decides the actual
 *  merge. Never used for the write-time auto-merge, which stays strict
 *  (SIM_DUP / contentSimilarity) so distinct facts are not collapsed blindly. */
export function isNearDupCandidate(a: string, b: string): boolean {
  const l = contentSimilarity(a, b)
  if (l >= 0.85) return true
  if (l >= 0.55 && tokenContain(a, b) >= 0.55) return true
  return false
}

export function qualityScore(content: string, existing: readonly MemoryEntry[]): number {
  const c = content.trim()
  let s = 100
  if (c.length < 15) s -= 35
  if (META_RE.test(c)) s -= 25
  if (WEAK_RE.test(c)) s -= 10
  for (const e of existing) {
    if (e.archived) continue
    if (contentSimilarity(e.content, c) >= 0.85) {
      s -= 30
      break
    }
  }
  return Math.max(0, Math.min(100, s))
}

export const LOW_QUALITY = 30

export function isLowQuality(score: number): boolean {
  return score <= LOW_QUALITY
}

// weightOf (quality → injection-weight multiplier) removed 2026-09-03 as dead
// code (audit L2): the injection path no longer uses a quality weight, and
// DEGRADED_HIGH had no other consumer. Recoverable from git history if a
// future calibration pass needs the curve.
