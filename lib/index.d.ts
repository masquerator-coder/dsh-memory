/**
 * dsh-memory-v3 — Cordis plugin entry (bundle-declarative, section-provider + tools).
 *
 * Three-layer consolidating memory: episodic (session summaries) + semantic
 * (durable facts with dual-signal heat) + active forgetting (three-level
 * ladder). Tier-0 memory is a systemPrompt.section re-evaluated at every
 * assembly; the memory / memory_recall tools write & retrieve the global store.
 *
 * L1/L2 LLM condensation is dormant in v3 — the core store/recall/forget loop
 * is zero-LLM (pure functions + rule-based), so it never degrades when the
 * host LLM is unavailable.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ForgetDays } from './types.js';
export declare const name = "memory";
export declare const inject: readonly ["tools", "systemPrompt"];
/** Plugin configuration. Every field optional; defaults applied in {@link apply}. */
export interface Config {
    memoryHome?: string;
    enableInjection?: boolean;
    budgetTier0?: number;
    budgetUser?: number;
    budgetMemory?: number;
    importanceThreshold?: number;
    epistemicWeighting?: boolean;
    /** Run periodic active forgetting (demote/archive/hard-delete). Default true. */
    forgetEnabled?: boolean;
    /** Expected time-to-forget (days) per kind. */
    forgetDays?: Partial<ForgetDays>;
    /** Frequency sliding window (days). Default 30. */
    windowDays?: number;
    /** Episodes older than this (days) are archived. Default 180. */
    episodeRetentionDays?: number;
    /** Observation window (days) between archive and hard-delete. Default 30. */
    forgetObserveDays?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): void;
