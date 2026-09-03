/**
 * dsh-memory — settings namespace (R3-ui 2026-08-31).
 *
 * The subset of the plugin config exposed in the dsh settings UI. The backend
 * registers this under the `memory` settings namespace via `ctx.settings`;
 * the settings document's user layer overrides the cordis-config `base` (the
 * settings layer merge is the dsh settings provider's, not ours — this module
 * only owns the schema + shape so both halves share one contract).
 *
 * Fields are the ones a user can reasonably toggle on a settings page:
 *   enabled              master memory switch (clean sessions when false)
 *   forgetEnabled        active-forgetting switch (pause demote/archive/hard-delete)
 *   refineIntervalMs     L1/L2 condensation scan cadence (ms)
 *   peakHourSuppress     M8 peak-hour LLM suppression switch
 *
 * R10 (2026-09-03): refine-model selection. `auto` follows the existing route
 * chain (session request-header → host default model, plus cordis-config
 * l1/l2/l0Provider when set); `manual` pins L1/L2/lesson/settle condensation
 * to one explicit provider+model chosen in the settings panel. A manual entry
 * with an empty provider or model falls back to auto (never hard-degrades).
 *
 * The R3-i auto-maintenance controls (identityAuto / identityIntervalMs) were
 * removed 2026-09-02 with the user.md auto-maintenance feature — user.md is
 * human-authored and human-maintained like soul.md, so there is nothing to
 * configure.
 */
import z from '@deepseek-ai/schemastery';
/** Manual/auto refine-model mode (R10). */
export type RefineModelMode = 'auto' | 'manual';
/** Memory settings exposed to the settings UI (subset of the full Config). */
export interface MemorySettings {
    enabled: boolean;
    forgetEnabled: boolean;
    refineIntervalMs: number;
    peakHourSuppress: boolean;
    /** lesson pipeline master switch (DESIGN §2.6). false → recordFailure still
     *  audits, drafts stay in lesson_drafts, but no promote pass runs. */
    lessonDraftEnabled: boolean;
    /** replace 现场即时判定 (DESIGN §2.6). false → only the periodic pass promotes. */
    lessonInstantJudge: boolean;
    /** lessonUseLlm=false → pure-rule template promotion (degraded fallback, no LLM). */
    lessonUseLlm: boolean;
    /** R10: 'auto' → follow the existing route chain; 'manual' → pin to the pair
     *  below. Incomplete manual (empty provider/model) falls back to auto. */
    refineModelMode: RefineModelMode;
    refineModelProvider: string;
    refineModel: string;
}
export declare const memorySettingsSchema: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    forgetEnabled: z<boolean, boolean>;
    refineIntervalMs: z<number, number>;
    peakHourSuppress: z<boolean, boolean>;
    lessonDraftEnabled: z<boolean, boolean>;
    lessonInstantJudge: z<boolean, boolean>;
    lessonUseLlm: z<boolean, boolean>;
    refineModelMode: z<"auto" | "manual", "auto" | "manual">;
    refineModelProvider: z<string, string>;
    refineModel: z<string, string>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    forgetEnabled: z<boolean, boolean>;
    refineIntervalMs: z<number, number>;
    peakHourSuppress: z<boolean, boolean>;
    lessonDraftEnabled: z<boolean, boolean>;
    lessonInstantJudge: z<boolean, boolean>;
    lessonUseLlm: z<boolean, boolean>;
    refineModelMode: z<"auto" | "manual", "auto" | "manual">;
    refineModelProvider: z<string, string>;
    refineModel: z<string, string>;
}>>;
/** Hard defaults (used as the base layer's floor; cordis config overrides these,
 *  then the settings user layer overrides cordis config). */
export declare const MEMORY_SETTINGS_DEFAULTS: MemorySettings;
