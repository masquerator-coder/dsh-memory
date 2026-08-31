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
 *   identityAuto         auto-maintain user.md from user-layer memories
 *   identityIntervalMs   identity maintenance cadence (ms)
 *   refineIntervalMs     L1/L2 condensation scan cadence (ms)
 *   peakHourSuppress     M8 peak-hour LLM suppression switch
 */
import z from '@deepseek-ai/schemastery'

/** Memory settings exposed to the settings UI (subset of the full Config). */
export interface MemorySettings {
  enabled: boolean
  forgetEnabled: boolean
  identityAuto: boolean
  identityIntervalMs: number
  refineIntervalMs: number
  peakHourSuppress: boolean
}

export const memorySettingsSchema = z.object({
  enabled: z.boolean(),
  forgetEnabled: z.boolean(),
  identityAuto: z.boolean(),
  identityIntervalMs: z.number(),
  refineIntervalMs: z.number(),
  peakHourSuppress: z.boolean(),
})

/** Hard defaults (used as the base layer's floor; cordis config overrides these,
 *  then the settings user layer overrides cordis config). */
export const MEMORY_SETTINGS_DEFAULTS: MemorySettings = {
  enabled: true,
  forgetEnabled: true,
  // 2026-08-31 (user.md 人写权威化): default OFF. user.md is a human-authored,
  // decisive portrait like soul.md — the plugin must not auto-append user-layer
  // memories into it (reintroduces the double-presentation + KV-prefix churn we
  // removed from tier0 injection). User-layer memories still accumulate for
  // recall; flipping this back on restores the old auto-maintenance behavior.
  identityAuto: false,
  identityIntervalMs: 6 * 3600_000,
  refineIntervalMs: 3600_000,
  peakHourSuppress: true,
}
