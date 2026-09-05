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
export declare const DEFAULT_REFRESH_INTERVAL_MS: number;
export declare const DEFAULT_FETCH_TIMEOUT_MS = 5000;
/**
 * Internet time endpoints tried in order until one succeeds. Each must return
 * JSON with a UTC epoch field:
 *   worldtimeapi.org/api/ip        → .unixtime      (integer seconds)
 *   timeapi.io Time/current/zone   → .epochSeconds  (integer seconds)
 * The request-local converse (request-local date) is NOT used — we only read
 * the UTC epoch so the SYSTEM timezone decides the rendered date.
 */
export declare const TIME_ENDPOINTS: readonly string[];
/** Where the authoritative instant came from. */
export type TimeSourceKind = 'internet' | 'local';
/** A synchronously-readable, extrapolated current instant. */
export interface InstantSnapshot {
    /** Current epoch milliseconds. */
    epochMs: number;
    /** 'internet' when anchored to a network pin, 'local' otherwise. */
    source: TimeSourceKind;
}
export interface TimeSourceOptions {
    /** ms between background internet pins. Default {@link DEFAULT_REFRESH_INTERVAL_MS}. */
    refreshIntervalMs?: number;
    /** per-request fetch timeout ms. Default {@link DEFAULT_FETCH_TIMEOUT_MS}. */
    fetchTimeoutMs?: number;
    /** endpoint list (override for tests / host-restricted networks). */
    endpoints?: readonly string[];
    /** injectable fetch (tests). Default globalThis.fetch. */
    fetchImpl?: typeof fetch;
    /** injectable local clock (tests). Default Date.now. */
    now?: () => number;
    /** local-clock onError hook (tests / diagnostics). */
    onError?: (err: unknown) => void;
}
/**
 * Reads the authoritative UTC epoch from the first reachable endpoint.
 * Resolves `null` when every endpoint fails (caller degrades to local).
 */
export declare function fetchInternetEpochMs(endpoints?: readonly string[], timeoutMs?: number, fetchImpl?: typeof fetch): Promise<number | null>;
/**
 * Cached internet-anchored clock. One background refresh pins the true epoch
 * and records the implied system clock-skew; `current()` then returns
 * `localNow() + skew` synchronously. Until the first successful pin (or after
 * all refreshes fail), skew is 0 and the source is 'local'.
 */
export declare class TimeSource {
    private skewMs;
    private source;
    private readonly refreshIntervalMs;
    private readonly fetchTimeoutMs;
    private readonly endpoints;
    private readonly fetchImpl;
    private readonly nowFn;
    private readonly onError?;
    private timer;
    private disposed;
    /** true while a refresh fetch is in flight (prevents overlapping pins). */
    private refreshing;
    constructor(opts?: TimeSourceOptions);
    /** Synchronous current instant — safe to call from the section thunk. */
    current(): InstantSnapshot;
    /** Kick the background refresh loop (immediate first pin, then periodic). */
    start(): void;
    /** Stop the periodic loop (does not cancel an in-flight pin). */
    dispose(): void;
    private schedule;
    /** One pin attempt; resolves true when an internet anchor was (re)established. */
    refresh(): Promise<boolean>;
}
/** Resolve the CURRENT SYSTEM timezone id via Intl; fall back to 'UTC' if the
 *  host lacks ICU data so we never throw on render. */
export declare function resolveSystemTimeZone(): string;
/**
 * Format a date-only string for `epochMs` in `timeZone` (or the system zone).
 * e.g. `2026年9月5日 星期六`. Deterministic and TZ-explicit for the model.
 */
export declare function formatLocalDate(epochMs: number, timeZone?: string): string;
/** The injected section text. Byte-stable for a full calendar day; empty when
 *  the feature is disabled. Declared as data, not instruction (P0-5 spirit). */
export declare function renderDateSection(enabled: boolean, snap: InstantSnapshot, timeZone?: string): string;
