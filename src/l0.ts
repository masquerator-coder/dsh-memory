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
import type { MemoryStore } from './store.js'

/** A session event enriched to what L0 needs. Loosely typed so dsh's strongly-typed
 * SessionEvent union and test fakes both satisfy it. */
export interface TurnTextSource {
  readonly type?: string
  /** Data may be a union (UserMessage | turn/end | ...); L0 peeks at known shapes. */
  readonly data?: {
    readonly content?: readonly unknown[]
    readonly turn?: number
    readonly reason?: { readonly kind?: string }
  } | Record<string, never> | null
  /** Text of the event's first text block, when it is a message-like event. */
  readonly text?: string
}

/** Config-L0 knobs. All optional; defaults applied by the caller. */
export interface L0Options {
  /** 'llm' (default) uses ctx.llm when available with rule fallback; 'rules' is pure-rule only. */
  summarize?: 'rules' | 'llm'
  /** Explicit provider route; when absent L0 tries the session's request-header config. */
  provider?: string
  /** Explicit model id; must pair with provider. */
  model?: string
  /** Output-token cap for the LLM summarizer. Default 400. */
  maxTokens?: number
  /** End-to-end LLM deadline ms. Default 8000. */
  timeoutMs?: number
  /** Session id (used for episode provenance). */
  sessionId?: string
  /** Abort signal (host shutdown / turn cancellation). */
  signal?: AbortSignal
  /** Tool names used this turn, as a JSON string (episode.tools_used). */
  toolsUsed?: string
  /** Topic label for the episode (default 'general'). */
  topic?: string
}

export const DEFAULT_L0_MAX_TOKENS = 400
export const DEFAULT_L0_TIMEOUT_MS = 8000
const SUMMARY_CHAR_CAP = 1400

/** Smallest "message has real content" check — skips empty/whitespace-only text. */
function usable(text: string | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * Extract the conversational text of one turn from an event list.
 * Accepts any iterable of unknown (dsh's strongly-typed SessionEvent[] and test
 * fakes both flow in); L0 peeks at the loose {@link TurnTextSource} shape at
 * runtime. Scans events whose type denotes a user/agent message and whose data
 * carries a content block array; returns their concatenated "text: " lines.
 * Pure — tests pass a fabricated event array.
 */
export function collectTurnTexts(events: readonly unknown[], turn: number | undefined): string[] {
  const TEXT_TYPES = new Set(['user/message', 'agent/message', 'agent/text', 'user/text'])
  const out: string[] = []
  for (const raw of events) {
    const ev = raw as TurnTextSource
    if (turn !== undefined) {
      const d = ev.data as { turn?: number } | null | undefined
      if (d && typeof d.turn === 'number' && d.turn !== turn) continue
    }
    const type = ev.type
    if (!type) continue
    if (TEXT_TYPES.has(type)) {
      // Prefer top-level text (optimal case); else fall through to content blocks.
      if (usable(ev.text)) { out.push(ev.text!.trim()); continue }
    }
    // Fall back: any event carrying a content[] with a text block (e.g. folded shapes).
    const blocks = (ev.data as { content?: readonly unknown[] } | null | undefined)?.content
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const block = b as { type?: string; text?: string }
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
          out.push(block.text.trim())
          break
        }
      }
    }
  }
  return dedupe(out)
}

/** Remove consecutive duplicates (rapid repeated chunks collapse). Pure. */
export function dedupe(texts: readonly string[]): string[] {
  const out: string[] = []
  for (const t of texts) {
    if (out.length === 0 || out[out.length - 1] !== t) out.push(t)
  }
  return out
}

/**
 * Pure-rule summarizer (zero LLM). Collapses repeated lines, keeps up to the first
 * N distinct lines, truncates to a char cap, and joins with newlines. This is the
 * guaranteed fallback and the default when `summarize: 'rules'`.
 */
export function summarizeRules(texts: readonly string[], cap = SUMMARY_CHAR_CAP): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const t of texts) {
    const line = t.trim()
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    kept.push(line)
  }
  let out = kept.join('\n')
  if (out.length > cap) out = out.slice(0, cap)
  return out.trim()
}

/**
 * True when a summarized episode has enough signal to be worth persisting
 * (avoids writing empty/stub episodes for trivial turns).
 */
export function episodeWorthWriting(summary: string): boolean {
  const s = summary.trim()
  return s.length > 8
}

/**
 * Minimal structural envelope for the dsh LLM stream seam, so tests can stub it
 * without importing @deepseek-ai/dsh-llm. The real caller adapts ctx.llm.stream
 * into this shape (text deltas only). See index.ts for the concrete adapter.
 */
export interface LlmStreamSeam {
  stream(options: {
    provider: string
    model: string
    messages: { role: string; content: { type: string; text: string }[] }[]
    system?: string
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type?: string; text?: string }>
}

/**
 * Try LLM summarization; on any failure return null so the caller falls back to
 * {@link summarizeRules}. Pure w.r.t. persistence — only awaits the injected stream.
 */
export async function summarizeLlm(
  llm: LlmStreamSeam,
  opts: { provider: string; model: string; text: string; maxTokens?: number; signal?: AbortSignal },
): Promise<string | null> {
  try {
    if (!opts.provider || !opts.model) return null
    const system =
      'You are the episodic summarizer of an AI memory system. ' +
      'Condense the supplied conversation turn into a concise, factual session-summary episode ' +
      '("what happened"), in the language of the conversation. Keep concrete facts, decisions, ' +
      'and tool actions; drop chit-chat and filler. Output plain text only — no markdown, no preamble.'
    const messages = [
      { role: 'user', content: [{ type: 'text', text: opts.text }] },
    ]
    const chunks: string[] = []
    for await (const chunk of llm.stream({
      provider: opts.provider,
      model: opts.model,
      messages,
      system,
      maxTokens: opts.maxTokens ?? DEFAULT_L0_MAX_TOKENS,
      signal: opts.signal,
    })) {
      const t = chunk?.text
      if (typeof t === 'string' && t.length > 0) chunks.push(t)
    }
    const text = chunks.join('').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Run L0 for one completed turn: collect its texts, produce a summary (LLM
 * enhanced when configured AND the route is resolvable; otherwise rules), and if
 * worth persisting write an episode. The store write is idempotent via contentId.
 *
 * Returns the written episode (or null when skipped). Never throws to the caller —
 * L0 must not break the host turn lifecycle.
 */
export async function runL0(
  store: MemoryStore,
  input: {
    events: readonly unknown[]
    turn: number | undefined
    summarize: 'rules' | 'llm'
    llm?: LlmStreamSeam | null
    provider?: string
    model?: string
    maxTokens?: number
    timeoutMs?: number
    signal?: AbortSignal
    sessionId: string
    toolsUsed?: string
    topic?: string
  },
): Promise<unknown> {
  try {
    const texts = collectTurnTexts(input.events, input.turn)
    if (texts.length === 0) return null

    let summary: string
    if (input.summarize === 'llm' && input.llm && input.provider && input.model) {
      summary = (await summarizeLlm(input.llm, {
        provider: input.provider,
        model: input.model,
        text: texts.join('\n'),
        maxTokens: input.maxTokens,
        signal: input.signal,
      })) ?? summarizeRules(texts)
    } else {
      summary = summarizeRules(texts)
    }

    if (!episodeWorthWriting(summary)) return null

    return store.addEpisode({
      sessionId: input.sessionId,
      summary,
      toolsUsed: input.toolsUsed,
      topic: input.topic,
    })
  } catch {
    return null
  }
}

/** True when an event is a completed turn/end — the L0 trigger predicate. */
export function isCompletedTurnEnd(ev: unknown): boolean {
  const e = ev as { type?: string; data?: { reason?: { kind?: string } } } | null
  return e?.type === 'turn/end' && e.data?.reason?.kind === 'completed'
}
