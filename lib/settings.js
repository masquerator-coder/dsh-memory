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
 * The R3-i auto-maintenance controls (identityAuto / identityIntervalMs) were
 * removed 2026-09-02 with the user.md auto-maintenance feature — user.md is
 * human-authored and human-maintained like soul.md, so there is nothing to
 * configure.
 */
import z from '@deepseek-ai/schemastery';
export const memorySettingsSchema = z.object({
    enabled: z.boolean(),
    forgetEnabled: z.boolean(),
    refineIntervalMs: z.number(),
    peakHourSuppress: z.boolean(),
    lessonDraftEnabled: z.boolean(),
    lessonInstantJudge: z.boolean(),
    lessonUseLlm: z.boolean(),
});
/** Hard defaults (used as the base layer's floor; cordis config overrides these,
 *  then the settings user layer overrides cordis config). */
export const MEMORY_SETTINGS_DEFAULTS = {
    enabled: true,
    forgetEnabled: true,
    refineIntervalMs: 3600_000,
    peakHourSuppress: true,
    lessonDraftEnabled: true,
    lessonInstantJudge: true,
    lessonUseLlm: true,
};
