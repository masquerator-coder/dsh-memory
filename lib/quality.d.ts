/** dsh-memory — quality filter. Pure, side-effect-free heuristic 0–100. */
import type { MemoryEntry } from './types.js';
/** Longest-common-substring length (DP, O(n·m) time, O(m) space); guarded for large inputs. */
export declare function longestCommonSubstr(a: string, b: string): number;
/** 0 = identical, 1 = disjoint; drives duplicate-cost penalty. */
export declare function contentSimilarity(a: string, b: string): number;
export declare function qualityScore(content: string, existing: readonly MemoryEntry[]): number;
export declare const LOW_QUALITY = 30;
export declare const DEGRADED_HIGH = 60;
export declare function isLowQuality(score: number): boolean;
/** Injection weight multiplier (0 = never injected; degraded entries down-weighted). */
export declare function weightOf(score: number): number;
