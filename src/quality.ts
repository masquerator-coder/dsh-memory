/** dsh-memory-v3 — quality filter. Pure, side-effect-free heuristic 0–100. */
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
  return longestCommonSubstr(a, b) / Math.min(a.length, b.length)
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
export const DEGRADED_HIGH = 60

export function isLowQuality(score: number): boolean {
  return score <= LOW_QUALITY
}

/** Injection weight multiplier (0 = never injected; degraded entries down-weighted). */
export function weightOf(score: number): number {
  if (score >= DEGRADED_HIGH) return 1
  if (score <= LOW_QUALITY) return 0
  return score / 100
}
