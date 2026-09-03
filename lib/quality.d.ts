/** dsh-memory — quality filter. Pure, side-effect-free heuristic 0–100. */
import type { MemoryEntry } from './types.js';
/** Longest-common-substring length (DP, O(n·m) time, O(m) space); guarded for large inputs. */
export declare function longestCommonSubstr(a: string, b: string): number;
/** 0 = identical, 1 = disjoint; drives duplicate-cost penalty. */
export declare function contentSimilarity(a: string, b: string): number;
/** Tokenize into significant tokens: alphanumeric runs (English) + CJK chars
 *  and bigrams (the gap unicode61 leaves for CJK). Shared tokens are what make
 *  a RE-WORDED duplicate recognizable even when its openers diverge. */
export declare function tokenize(s: string): Set<string>;
/** Token containment: |a∩b| / min(|a|,|b|) — the fraction of the shorter
 *  entry's vocabulary the other one shares. 0 = nothing shared, 1 = subset. */
export declare function tokenContain(a: string, b: string): number;
/** Aperture gate for CANDIDATE grouping only (L2 cross-topic + one-shot
 *  migration): treat two rows as "possibly the same fact reworded" on a shared
 *  token mass AND a contiguous run. Loose by design — the downstream judge
 *  (LLM via L2, or the human reviewing an archive manifest) decides the actual
 *  merge. Never used for the write-time auto-merge, which stays strict
 *  (SIM_DUP / contentSimilarity) so distinct facts are not collapsed blindly. */
export declare function isNearDupCandidate(a: string, b: string): boolean;
export declare function qualityScore(content: string, existing: readonly MemoryEntry[]): number;
export declare const LOW_QUALITY = 30;
export declare function isLowQuality(score: number): boolean;
