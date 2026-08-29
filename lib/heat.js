export const DAY_MS = 86_400_000;
/** Heat thresholds (review-verified against exponential decay). */
export const DEMOTE_HEAT = 0.05; // ≈ one forgetDays unaccessed
export const ARCHIVE_HEAT = 0.01; // ≈ 1.54 × forgetDays unaccessed
/** ln(20) — so e^(-λ·forgetDays) = 0.05 exactly. */
const LN20 = Math.log(20);
export const DEFAULT_FORGET_DAYS = {
    env: 365,
    lesson: 180,
    decision: 90,
    general: 60,
};
export function resolveForgetDays(partial) {
    const out = { ...DEFAULT_FORGET_DAYS };
    if (partial) {
        if (partial.env !== undefined)
            out.env = partial.env;
        if (partial.lesson !== undefined)
            out.lesson = partial.lesson;
        if (partial.decision !== undefined)
            out.decision = partial.decision;
        if (partial.general !== undefined)
            out.general = partial.general;
    }
    return out;
}
/** preference facts are as stable as env — same forget-days bucket. */
const KIND_TO_FORGET = {
    preference: 'env',
    env: 'env',
    lesson: 'lesson',
    decision: 'decision',
    general: 'general',
};
/** Per-kind decay λ (per day). user layer → 0 (never decays). */
export function lambdaOf(kind, forgetDays) {
    return LN20 / forgetDays[KIND_TO_FORGET[kind]];
}
/** Frequency boost: log-scale so a few recalls matter, many don't swamp. */
export function freqBoost(windowFreq) {
    return 1 + Math.log1p(windowFreq);
}
/** heat = e^(-λ·Δt) × (1 + ln(1 + window_freq)). user layer pinned to 1. */
export function heatOf(e, forgetDays, now = Date.now()) {
    if (e.layer === 'user')
        return 1;
    const lambda = lambdaOf(e.kind, forgetDays);
    const dtDays = Math.max(0, (now - e.last_accessed) / DAY_MS);
    return Math.exp(-lambda * dtDays) * freqBoost(e.window_freq);
}
/** Auto-demote tier0→tier1: cold (≈ forgetDays unaccessed) + not top-importance. */
export function shouldDemote(e, forgetDays, now = Date.now()) {
    if (e.layer === 'user' || e.archived || e.tier !== 0)
        return false;
    if (e.importance >= 5)
        return false;
    return heatOf(e, forgetDays, now) <= DEMOTE_HEAT;
}
/** Soft-archive: colder (≈ 1.54 × forgetDays) + low importance. */
export function shouldArchive(e, forgetDays, now = Date.now()) {
    if (e.layer === 'user' || e.archived)
        return false;
    if (e.importance >= 4)
        return false;
    return heatOf(e, forgetDays, now) <= ARCHIVE_HEAT;
}
/**
 * Hard-delete gate (all conditions must hold — the importance gate is the real
 * "can we afford to delete this" check, heat only got it into the candidate set).
 *
 * @param hasPendingCorrection true when a failure_memories trail still references
 *   this entry's content (corrected-once → likely to change again → extend life).
 */
export function shouldDelete(e, observeDays, hasPendingCorrection, now = Date.now()) {
    if (e.layer === 'user')
        return false; // user layer is immortal
    if (e.importance >= 5)
        return false; // top-importance never hard-deleted (demote at most)
    if (!e.archived || e.archived_at === undefined)
        return false;
    if (now - e.archived_at < observeDays * DAY_MS)
        return false;
    if (e.importance >= 3)
        return false;
    if (e.quality >= 60)
        return false;
    if (hasPendingCorrection)
        return false;
    return true;
}
