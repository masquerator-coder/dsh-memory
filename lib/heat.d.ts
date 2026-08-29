/**
 * dsh-memory-v3 — dual-signal heat model (exponential decay + frequency) and
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
/** heat = e^(-λ·Δt) × (1 + ln(1 + window_freq)). user layer pinned to 1. */
export declare function heatOf(e: Pick<MemoryEntry, 'layer' | 'kind' | 'last_accessed' | 'window_freq'>, forgetDays: ForgetDays, now?: number): number;
/** Auto-demote tier0→tier1: cold (≈ forgetDays unaccessed) + not top-importance. */
export declare function shouldDemote(e: MemoryEntry, forgetDays: ForgetDays, now?: number): boolean;
/** Soft-archive: colder (≈ 1.54 × forgetDays) + low importance. */
export declare function shouldArchive(e: MemoryEntry, forgetDays: ForgetDays, now?: number): boolean;
/**
 * Hard-delete gate (all conditions must hold — the importance gate is the real
 * "can we afford to delete this" check, heat only got it into the candidate set).
 *
 * @param hasPendingCorrection true when a failure_memories trail still references
 *   this entry's content (corrected-once → likely to change again → extend life).
 */
export declare function shouldDelete(e: MemoryEntry, observeDays: number, hasPendingCorrection: boolean, now?: number): boolean;
