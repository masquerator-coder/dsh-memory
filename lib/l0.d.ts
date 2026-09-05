/**
 * dsh-memory — L0 episodic condensation (session → episode summary).
 *
 * The zero-LLM skeleton is the default and never degrades the core loop. When an
 * LLM is available and configured, L0 uses it as an ENHANCEMENT that falls back to
 * the pure-rule summarizer on any failure (route absent, stream error, timeout,
 * aborted, non-stop finish). The episodic store itself (`episodes` + `ep_fts`) is
 * written through {@link MemoryStore.addEpisode}; this module is the bridge from a
 * completed agent turn to that write.
 *
 * This module is deliberately side-effect-free at its core: every "decide + shape"
 * function is pure (testable without dsh). Only the dsh-touching seams
 * (LLM stream, store write) are injected by the caller / tests.
 */
import type { MemoryStore } from './store.js';
/** A session event enriched to what L0 needs. Loosely typed so dsh's strongly-typed
 * SessionEvent union and test fakes both satisfy it. */
export interface TurnTextSource {
    readonly type?: string;
    /** Data may be a union (UserMessage | turn/end | ...); L0 peeks at known shapes. */
    readonly data?: {
        readonly content?: readonly unknown[];
        readonly turn?: number;
        readonly reason?: {
            readonly kind?: string;
        };
    } | Record<string, never> | null;
    /** Text of the event's first text block, when it is a message-like event. */
    readonly text?: string;
}
export declare const DEFAULT_L0_MAX_TOKENS = 400;
export declare const DEFAULT_L0_TIMEOUT_MS = 8000;
/**
 * Extract the conversational text of one turn from an event list.
 * Accepts any iterable of unknown (dsh's strongly-typed SessionEvent[] and test
 * fakes both flow in); L0 peeks at the loose {@link TurnTextSource} shape at
 * runtime. Scans events whose type denotes a user/agent message and whose data
 * carries a content block array; returns their concatenated "text: " lines.
 * Pure — tests pass a fabricated event array.
 */
export declare function collectTurnTexts(events: readonly unknown[], turn: number | undefined): string[];
/**
 * Extract the distinct tool names invoked during one turn, in first-call order,
 * from an event list. Pure — scans `tool/call` events scoped to `turn` and
 * dedupes by name. Returns [] when no tools were called. Feed the result to
 * JSON.stringify for the episode's `tools_used` column.
 */
export declare function collectTurnTools(events: readonly unknown[], turn: number | undefined): string[];
/** Remove consecutive duplicates (rapid repeated chunks collapse). Pure. */
export declare function dedupe(texts: readonly string[]): string[];
/**
 * Pure-rule summarizer (zero LLM). Collapses repeated lines, keeps up to the first
 * N distinct lines, truncates to a char cap, and joins with newlines. This is the
 * guaranteed fallback and the default when `summarize: 'rules'`.
 */
export declare function summarizeRules(texts: readonly string[], cap?: number): string;
/**
 * True when a summarized episode has enough signal to be worth persisting
 * (avoids writing empty/stub episodes for trivial turns).
 */
export declare function episodeWorthWriting(summary: string): boolean;
/**
 * Minimal structural envelope for the dsh LLM stream seam, so tests can stub it
 * without importing @deepseek-ai/dsh-llm. The real caller adapts ctx.llm.stream
 * into this shape (text deltas only). See index.ts for the concrete adapter.
 */
export interface LlmStreamSeam {
    stream(options: {
        provider: string;
        model: string;
        messages: {
            role: string;
            content: {
                type: string;
                text: string;
            }[];
        }[];
        system?: string;
        maxTokens?: number;
        signal?: AbortSignal;
    }): AsyncIterable<{
        type?: string;
        text?: string;
    }>;
}
/**
 * Try LLM summarization; on any failure return null so the caller falls back to
 * {@link summarizeRules}. Pure w.r.t. persistence — only awaits the injected stream.
 */
export declare function summarizeLlm(llm: LlmStreamSeam, opts: {
    provider: string;
    model: string;
    text: string;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<string | null>;
/**
 * Run L0 for one completed turn: collect its texts, produce a summary (LLM
 * enhanced when configured AND the route is resolvable; otherwise rules), and if
 * worth persisting write an episode. The store write is idempotent via contentId.
 *
 * Returns the written episode (or null when skipped). Never throws to the caller —
 * L0 must not break the host turn lifecycle. P2-7 (review 2026-08-30): program
 * errors (disk full, DB closed/corrupt) used to vanish into the same `return
 * null` as a business skip; the optional `onError` callback now receives them so
 * the host can leave a durable trace (index.ts wires console.warn). Returning
 * null unchanged keeps the fire-and-forget contract.
 */
export declare function runL0(store: MemoryStore, input: {
    events: readonly unknown[];
    turn: number | undefined;
    summarize: 'rules' | 'llm';
    llm?: LlmStreamSeam | null;
    provider?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionId: string;
    toolsUsed?: string;
    topic?: string;
    /** P2-7: invoked with any program error caught at this boundary (never throws). */
    onError?: (err: unknown) => void;
}): Promise<unknown>;
/** True when an event is a completed turn/end — the L0 trigger predicate. */
export declare function isCompletedTurnEnd(ev: unknown): boolean;
/**
 * M5 (2026-08-30): session-level LLM consolidation ("idle settle"). Turn-end
 * keeps realtime rule summaries (zero LLM); when a session has been idle ≥
 * l0IdleMinutes, the host calls this to upgrade the freshest pending episode to
 * a single full-session LLM summary — the "one LLM call after the dust settles"
 * shape of REFINE-REDESIGN.md §3.1. If no LLM/route is present, or nothing was
 * worth writing, returns null (no duplicate row). Pure w.r.t. persistence —
 * only awaits the injected stream + two store writes.
 */
export declare function condenseSession(store: MemoryStore, input: {
    texts: string[];
    llm?: LlmStreamSeam | null;
    provider?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionId: string;
    topic?: string;
}): Promise<unknown>;
