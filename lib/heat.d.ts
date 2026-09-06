/**
 * dsh-memory — dual-signal heat model (exponential decay + frequency) and
 * the pure decision functions for active forgetting.
 *
 *   heat = recency_weight × frequency_boost
 *     recency_weight  = e^(-λ·Δt)              Δt = days since last_accessed
 *     frequency_boost = 1 + ln(1 + window_freq) window_freq = recalls in the last N days
 *
 * λ is derived from the expected time-to-forget (forgetDays): λ = ln20 / forgetDays,
 * so a memory reaches heat ≈ 0.05 after ~forgetDays unaccessed. This replaces the
 * v2 power-law (whose tail was so long the 0.05 threshold took years) and the v2
 * age-day thresholds (30/90d) — heat itself now drives the decision, one coherent model.
 *
 * Two signals are separated on purpose (anti-mis-delete):
 *   heat       → "is this still active" → ranking, demotion, entering the forget candidate set
 *   importance → "can we afford to delete this" → the final deletion gate
 *
 * The user layer is immortal: λ = 0, never demoted, never deleted.
 */
import type { ForgetDays, Kind, MemoryEntry } from './types.js';
export declare const DAY_MS = 86400000;
/** Heat thresholds (review-verified against exponential decay). */
export declare const DEMOTE_HEAT = 0.05;
export declare const ARCHIVE_HEAT = 0.01;
export declare const DEFAULT_FORGET_DAYS: ForgetDays;
export declare function resolveForgetDays(partial?: Partial<ForgetDays>): ForgetDays;
/** Per-kind decay λ (per day). user layer → 0 (never decays). */
export declare function lambdaOf(kind: Kind, forgetDays: ForgetDays): number;
/** Frequency boost: log-scale so a few recalls matter, many don't swamp. */
export declare function freqBoost(windowFreq: number): number;
/** heat = e^(-λ·Δt) × (1 + ln(1 + window_freq)). user layer pinned to 1.
 *
 *  Audit fix (2026-09-07): the frequency boost used to read `window_freq`
 *  verbatim without checking whether the sliding window had expired. Because
 *  `touchAccess` only resets `window_freq` on the NEXT recall, an entry recalled
 *  often in one window then left cold kept its high freqBoost forever — lifting
 *  heat and stalling demotion long past where recency alone would have demoted
 *  it (e.g. general: 100 recalls then 90d quiet → heat 0.063 vs the 0.05 gate).
 *  Now, when `window_start` is set (>0) AND `windowMs` is supplied AND the window
 *  has elapsed, the boost uses freq 0. When `window_start` is absent/0 (no
 *  window yet — e.g. freshly written) or `windowMs` is omitted, the stored freq
 *  is used as before, so this stays backward-compatible with callers that only
 *  carry `window_freq`. */
export declare function heatOf(e: Pick<MemoryEntry, 'layer' | 'kind' | 'last_accessed' | 'window_freq' | 'window_start'>, forgetDays: ForgetDays, now?: number, windowMs?: number): number;
/** Auto-demote tier0→tier1: cold (≈ forgetDays unaccessed) + not top-importance.
 *  `windowMs` (optional, audit 2026-09-07) is forwarded to heatOf so an expired
 *  recall window's stale freq doesn't block demotion. Omitted → legacy heatOf
 *  (no window expiry check). */
export declare function shouldDemote(e: MemoryEntry, forgetDays: ForgetDays, now?: number, windowMs?: number): boolean;
/** Soft-archive: colder (≈ 1.54 × forgetDays) + low importance. */
export declare function shouldArchive(e: MemoryEntry, forgetDays: ForgetDays, now?: number, windowMs?: number): boolean;
/**
 * Hard-delete gate (all conditions must hold — the importance gate is the real
 * "can we afford to delete this" check, heat only got it into the candidate set).
 *
 * NOTE (P0-4): there is intentionally NO quality gate here. DESIGN §5.1's delete
 * threshold is heat + importance + observation + non-user + no pending correction;
 * `qualityScore` floors normal memories at 60+ (100 minus at most ~35), so a
 * `quality < 60` gate made hard-delete unreachable for every real entry — the
 * "库只增不减" goal would silently go unimplemented. Use heat/importance to gate.
 *
 * @param hasPendingCorrection true when a failure_memories trail still references
 *   this entry's content (corrected-once → likely to change again → extend life).
 */
export declare function shouldDelete(e: MemoryEntry, observeDays: number, hasPendingCorrection: boolean, now?: number): boolean;
