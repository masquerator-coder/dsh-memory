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
 *   identityAuto         auto-maintain user.md from user-layer memories
 *   identityIntervalMs   identity maintenance cadence (ms)
 *   refineIntervalMs     L1/L2 condensation scan cadence (ms)
 *   peakHourSuppress     M8 peak-hour LLM suppression switch
 */
import z from '@deepseek-ai/schemastery';
/** Memory settings exposed to the settings UI (subset of the full Config). */
export interface MemorySettings {
    enabled: boolean;
    identityAuto: boolean;
    identityIntervalMs: number;
    refineIntervalMs: number;
    peakHourSuppress: boolean;
}
export declare const memorySettingsSchema: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    identityAuto: z<boolean, boolean>;
    identityIntervalMs: z<number, number>;
    refineIntervalMs: z<number, number>;
    peakHourSuppress: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    identityAuto: z<boolean, boolean>;
    identityIntervalMs: z<number, number>;
    refineIntervalMs: z<number, number>;
    peakHourSuppress: z<boolean, boolean>;
}>>;
/** Hard defaults (used as the base layer's floor; cordis config overrides these,
 *  then the settings user layer overrides cordis config). */
export declare const MEMORY_SETTINGS_DEFAULTS: MemorySettings;
