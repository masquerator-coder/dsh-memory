/**
 * dsh-memory — real-world date source + system-prompt renderer.
 *
 * Solves "the LLM doesn't know today's date": inject the current real-world
 * date into the system prompt at session start. Two requirements drive the
 * design:
 *
 *  1. real time comes from the INTERNET (authoritative), not the model's
 *     training cutoff;
 *  2. the displayed date uses the CURRENT SYSTEM timezone (the local clock
 *     knows the zone; the network only needs to pin the physical instant).
 *
 * Contract with the synchronous section thunk:
 *  - `systemPrompt.section({ text })` re-evaluates at every assembly and must
 *    return synchronously, so we can't `await` a fetch inside it.
 *  - `TimeSource` therefore keeps a background-cached authoritative anchor and
 *    extrapolates it with the local clock for the (short) window until the
 *    next refresh. The network pins the true epoch once per refresh; the
 *    measured clock-skew is then applied continuously until the next pin,
 *    so drift over the refresh interval is negligible.
 *
 * Robustness: every internet fetch is tried against a small endpoint list with
 * a per-request timeout; if all fail (offline / DNS / blocked / proxy), the
 * source degrades to the local clock — the LLM ALWAYS sees a date, just marked
 * as local when the network is unreachable.
 *
 * KV-cache friendliness: the renderer emits DATE ONLY (no time-of-day), so the
 * section text is byte-stable within a calendar day and the prefix rides the
 * host's KV cache after the first build — matching the plugin's "constant-ish
 * section" convention rather than churning every assembly.
 */
export const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min between internet pins
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;
/**
 * Internet time endpoints tried in order until one succeeds. Each must return
 * JSON with a UTC epoch field:
 *   worldtimeapi.org/api/ip        → .unixtime      (integer seconds)
 *   timeapi.io Time/current/zone   → .epochSeconds  (integer seconds)
 * The request-local converse (request-local date) is NOT used — we only read
 * the UTC epoch so the SYSTEM timezone decides the rendered date.
 */
export const TIME_ENDPOINTS = [
    'https://worldtimeapi.org/api/ip',
    'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
];
/**
 * Reads the authoritative UTC epoch from the first reachable endpoint.
 * Resolves `null` when every endpoint fails (caller degrades to local).
 */
export async function fetchInternetEpochMs(endpoints = TIME_ENDPOINTS, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function')
        return null;
    for (const url of endpoints) {
        try {
            // AbortSignal.timeout is available in Node ≥17.3; the caller's runtime is
            // known to be modern (peer: node >=22.5), but guard in case of shims.
            const controller = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? { signal: AbortSignal.timeout(timeoutMs) }
                : {};
            const res = await fetchImpl(url, { ...controller });
            if (!res.ok)
                continue;
            const body = await res.json();
            const secs = Number(body?.unixtime ?? body?.epochSeconds ?? body?.unixtime_ms ?? body?.milliseconds);
            if (Number.isFinite(secs) && secs > 0) {
                // unixtime/epochSeconds are seconds; milliseconds fields already ms.
                const ms = secs > 1e12 ? secs : secs * 1000;
                if (Number.isFinite(ms) && ms > 0)
                    return ms;
            }
        }
        catch {
            // try the next endpoint
        }
    }
    return null;
}
/**
 * Cached internet-anchored clock. One background refresh pins the true epoch
 * and records the implied system clock-skew; `current()` then returns
 * `localNow() + skew` synchronously. Until the first successful pin (or after
 * all refreshes fail), skew is 0 and the source is 'local'.
 */
export class TimeSource {
    skewMs = 0;
    source = 'local';
    refreshIntervalMs;
    fetchTimeoutMs;
    endpoints;
    fetchImpl;
    nowFn;
    onError;
    timer;
    disposed = false;
    /** true while a refresh fetch is in flight (prevents overlapping pins). */
    refreshing = false;
    constructor(opts = {}) {
        this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
        this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
        this.endpoints = opts.endpoints ?? TIME_ENDPOINTS;
        this.fetchImpl = opts.fetchImpl;
        this.nowFn = opts.now ?? Date.now;
        this.onError = opts.onError;
    }
    /** Synchronous current instant — safe to call from the section thunk. */
    current() {
        return { epochMs: this.nowFn() + this.skewMs, source: this.source };
    }
    /** Kick the background refresh loop (immediate first pin, then periodic). */
    start() {
        if (this.disposed)
            return;
        void this.refresh();
        this.schedule();
    }
    /** Stop the periodic loop (does not cancel an in-flight pin). */
    dispose() {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    schedule() {
        if (this.disposed)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
            this.schedule();
        }, this.refreshIntervalMs);
        this.timer.unref?.();
    }
    /** One pin attempt; resolves true when an internet anchor was (re)established. */
    async refresh() {
        if (this.refreshing || this.disposed)
            return this.source === 'internet';
        this.refreshing = true;
        try {
            const epochMs = await fetchInternetEpochMs(this.endpoints, this.fetchTimeoutMs, this.fetchImpl);
            if (epochMs !== null) {
                this.skewMs = epochMs - this.nowFn();
                this.source = 'internet';
                return true;
            }
        }
        catch (err) {
            this.onError?.(err);
        }
        finally {
            this.refreshing = false;
        }
        return this.source === 'internet';
    }
}
/** Resolve the CURRENT SYSTEM timezone id via Intl; fall back to 'UTC' if the
 *  host lacks ICU data so we never throw on render. */
export function resolveSystemTimeZone() {
    try {
        const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
    }
    catch {
        return 'UTC';
    }
}
/**
 * Format a date-only string for `epochMs` in `timeZone` (or the system zone).
 * e.g. `2026年9月5日 星期六`. Deterministic and TZ-explicit for the model.
 */
export function formatLocalDate(epochMs, timeZone = resolveSystemTimeZone()) {
    try {
        const dtf = new Intl.DateTimeFormat('zh-CN', {
            timeZone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
        });
        return dtf.format(new Date(epochMs));
    }
    catch {
        // unparseable timeZone (bad ICU build) → drop to UTC to keep rendering safe
        const dtf = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
        return dtf.format(new Date(epochMs));
    }
}
/** The injected section text. Byte-stable for a full calendar day; empty when
 *  the feature is disabled. Declared as data, not instruction (P0-5 spirit). */
export function renderDateSection(enabled, snap, timeZone = resolveSystemTimeZone()) {
    if (!enabled)
        return '';
    const date = formatLocalDate(snap.epochMs, timeZone);
    const srcLine = snap.source === 'internet'
        ? '> 日期来源：互联网授时校准（权威）。时区：' + timeZone
        : '> 日期来源：本机时钟（互联网授时暂不可用，以本机为准）。时区：' + timeZone;
    return ('# 当前真实世界日期\n' +
        `今天是 ${date}。\n` +
        srcLine + '\n' +
        '> 上述日期为真实世界日期，非模型训练截止知识；涉及『今天』/『今天星期几』/日期相关判断时以此为准。');
}
