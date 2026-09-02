/**
 * dsh-memory — Cordis plugin entry (bundle-declarative, section-provider + tools).
 *
 * Three-layer consolidating memory: episodic (session summaries) + semantic
 * (durable facts with dual-signal heat) + active forgetting (three-level
 * ladder). Tier-0 memory is a systemPrompt.section re-evaluated at every
 * assembly; the memory / memory_recall tools write & retrieve the global store.
 *
 * L1/L2 LLM condensation runs on a background timer (LLM-decided, audited into
 * `refine_runs`); the core store/recall/forget loop is zero-LLM (pure functions
 * + rule-based), so it never degrades when the host LLM is unavailable. Routes
 * for the background passes auto-resolve when not configured explicitly.
 *
 * M5–M9 (2026-08-30, see docs/REFINE-REDESIGN.md):
 *   M5 L0 session settle  — turn-end keeps realtime RULE summaries (zero LLM);
 *                           the LLM upgrade is deferred to an idle-settle pass
 *                           (one call per session after l0IdleMinutes idle).
 *   M6 L1 event kick      — a new episode schedules a short-delay refine pass;
 *                           the periodic timer remains as a fallback.
 *   M7 L2 incremental     — clusters whose members changed since the last
 *                           audit are the only ones re-LLM'd (l2_refined).
 *   M8 peak-hour gate     — L1/L2 LLM passes skip during suppressWindows.
 *   M9 identity blocks    — constant soul.md / user.md sections, KV friendly.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ForgetDays } from './types.js';
/**
 * Minimal shape of the host's default-model service (declared here so the
 * plugin compiles standalone; the real `@deepseek-ai/dsh-agent-default-model`
 * package augments Context at runtime and is required via `inject`).
 */
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentDefaultModel?: {
            currentSelection(): {
                provider?: string;
                model?: string;
                reasoningEffort?: string;
            };
        };
        /** dsh settings service (host-provided). Optional so the plugin still
         *  compiles/runs where the seam is absent; when present we register the
         *  `memory` namespace for live settings-UI configuration. */
        settings?: {
            register<T>(ns: string, schema: z<T>, options?: {
                base?: Partial<T>;
                applies?: 'live' | 'restart';
            }): {
                get(): T;
                watch(callback: (next: T, prev: T) => void): () => void;
                update(patch: object): Promise<void>;
                replace(section: object): Promise<void>;
            };
        };
    }
}
export declare const name = "memory";
export declare const inject: readonly ["tools", "systemPrompt", "llm", "agentDefaultModel", "settings"];
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
    /** L0 episodic condensation mode: 'llm' (default = idle-settle LLM upgrade) | 'rules' (pure). */
    l0Summarize?: 'rules' | 'llm';
    /** Optional explicit LLM route pair for L0 (must be set together). */
    l0Provider?: string;
    l0Model?: string;
    /** L0 output-token cap. Default 400. */
    l0MaxTokens?: number;
    /** L0 LLM deadline ms. Default 8000. */
    l0TimeoutMs?: number;
    /** L1 episodic→semantic extraction (LLM-decided). Default true. */
    l1Enabled?: boolean;
    /** L2 semantic merge/arbitration (LLM-decided). Default true. */
    l2Enabled?: boolean;
    /** M7: only re-LLM a cluster whose members changed since last audit. Default true. */
    l2Incremental?: boolean;
    /** Explicit route pair for L1. Optional: auto-resolves (learned session route → host default model). */
    l1Provider?: string;
    l1Model?: string;
    /** L1 output-token cap. Default 800. */
    l1MaxTokens?: number;
    /** L1 LLM deadline ms. Default 10000. */
    l1TimeoutMs?: number;
    /** Explicit route pair for L2 (same as L1: explicit when enabled). */
    l2Provider?: string;
    l2Model?: string;
    /** L2 output-token cap. Default 800. */
    l2MaxTokens?: number;
    /** L2 LLM deadline ms. Default 10000. */
    l2TimeoutMs?: number;
    /** Background refine scan interval ms. Default 1h. */
    refineIntervalMs?: number;
    /** Minimum members for an L2 cluster to be offered to the LLM. Default 2. */
    l2MinCluster?: number;
    /** Whether L1 retries LLM-degraded episodes (extracted=2) on later passes. Default false. */
    l1RetryDegraded?: boolean;
    /** M5: session idle (min) before the LLM settle upgrades its episode. Default 30. */
    l0IdleMinutes?: number;
    /** M5: idle-settle check cadence (min). Default 5. */
    checkMinutes?: number;
    /** M8: peak-hour LLM suppression windows ("HH:MM", same-day). Default Beijing 09–12 / 14–18. */
    suppressWindows?: {
        start: string;
        end: string;
    }[];
    /** M8: also suppress for these minutes before each window opens. Default 15. */
    suppressLeadMinutes?: number;
    /** M8: timezone the suppression windows are expressed in. Default 'Asia/Shanghai'. */
    timeZone?: string;
    /** M9: inject constant soul.md / user.md identity sections. Default true. */
    enableIdentity?: boolean;
    /** R3-total: master memory switch. false → new sessions inject no memory
     *  (clean sessions) and background condensation/forgetting stop; the memory /
     *  memory_recall tools stay available for explicit use. Default true. */
    enabled?: boolean;
    /** Lesson pipeline master switch (DESIGN §2.6). Default true. */
    lessonDraftEnabled?: boolean;
    /** replace 现场即时判定 (DESIGN §2.6). false → only the periodic pass promotes. Default true. */
    lessonInstantJudge?: boolean;
    /** lessonUseLlm=false → pure-rule template promotion (no LLM). Default true. */
    lessonUseLlm?: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): void;
