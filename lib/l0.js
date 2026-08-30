export const DEFAULT_L0_MAX_TOKENS = 400;
export const DEFAULT_L0_TIMEOUT_MS = 8000;
const SUMMARY_CHAR_CAP = 1400;
/** Smallest "message has real content" check — skips empty/whitespace-only text. */
function usable(text) {
    return typeof text === 'string' && text.trim().length > 0;
}
/**
 * Extract the conversational text of one turn from an event list.
 * Accepts any iterable of unknown (dsh's strongly-typed SessionEvent[] and test
 * fakes both flow in); L0 peeks at the loose {@link TurnTextSource} shape at
 * runtime. Scans events whose type denotes a user/agent message and whose data
 * carries a content block array; returns their concatenated "text: " lines.
 * Pure — tests pass a fabricated event array.
 */
export function collectTurnTexts(events, turn) {
    const TEXT_TYPES = new Set(['user/message', 'agent/message', 'agent/text', 'user/text']);
    const out = [];
    for (const raw of events) {
        const ev = raw;
        if (turn !== undefined) {
            const d = ev.data;
            if (d && typeof d.turn === 'number' && d.turn !== turn)
                continue;
        }
        const type = ev.type;
        if (!type)
            continue;
        if (TEXT_TYPES.has(type)) {
            // Prefer top-level text (optimal case); else fall through to content blocks.
            if (usable(ev.text)) {
                out.push(ev.text.trim());
                continue;
            }
        }
        // Fall back: any event carrying a content[] with a text block (e.g. folded shapes).
        const blocks = ev.data?.content;
        if (Array.isArray(blocks)) {
            for (const b of blocks) {
                const block = b;
                if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                    out.push(block.text.trim());
                    break;
                }
            }
        }
    }
    return dedupe(out);
}
/**
 * Extract the distinct tool names invoked during one turn, in first-call order,
 * from an event list. Pure — scans `tool/call` events scoped to `turn` and
 * dedupes by name. Returns [] when no tools were called. Feed the result to
 * JSON.stringify for the episode's `tools_used` column.
 */
export function collectTurnTools(events, turn) {
    const out = [];
    const seen = new Set();
    for (const raw of events) {
        const ev = raw;
        if (ev.type !== 'tool/call')
            continue;
        const d = ev.data;
        if (turn !== undefined && (!d || typeof d.turn !== 'number' || d.turn !== turn))
            continue;
        const name = d?.name;
        if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}
/** Remove consecutive duplicates (rapid repeated chunks collapse). Pure. */
export function dedupe(texts) {
    const out = [];
    for (const t of texts) {
        if (out.length === 0 || out[out.length - 1] !== t)
            out.push(t);
    }
    return out;
}
/**
 * Pure-rule summarizer (zero LLM). Collapses repeated lines, keeps up to the first
 * N distinct lines, truncates to a char cap, and joins with newlines. This is the
 * guaranteed fallback and the default when `summarize: 'rules'`.
 */
export function summarizeRules(texts, cap = SUMMARY_CHAR_CAP) {
    const seen = new Set();
    const kept = [];
    for (const t of texts) {
        const line = t.trim();
        if (line.length === 0 || seen.has(line))
            continue;
        seen.add(line);
        kept.push(line);
    }
    let out = kept.join('\n');
    if (out.length > cap)
        out = out.slice(0, cap);
    return out.trim();
}
/**
 * True when a summarized episode has enough signal to be worth persisting
 * (avoids writing empty/stub episodes for trivial turns).
 */
export function episodeWorthWriting(summary) {
    const s = summary.trim();
    return s.length > 8;
}
/**
 * Try LLM summarization; on any failure return null so the caller falls back to
 * {@link summarizeRules}. Pure w.r.t. persistence — only awaits the injected stream.
 */
export async function summarizeLlm(llm, opts) {
    try {
        if (!opts.provider || !opts.model)
            return null;
        // P1-10: enforce a real end-to-end timeout via AbortController (mirrors
        // refine.ts llmText). An external signal is honored too — whichever fires
        // first aborts the stream, so a runaway stream can never hang the process.
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_L0_TIMEOUT_MS);
        try {
            const system = 'You are the episodic summarizer of an AI memory system. ' +
                'Condense the supplied conversation turn into a concise, factual session-summary episode ' +
                '("what happened"), in the language of the conversation. Keep concrete facts, decisions, ' +
                'and tool actions; drop chit-chat and filler. Output plain text only — no markdown, no preamble.';
            const messages = [
                { role: 'user', content: [{ type: 'text', text: opts.text }] },
            ];
            const chunks = [];
            for await (const chunk of llm.stream({
                provider: opts.provider,
                model: opts.model,
                messages,
                system,
                maxTokens: opts.maxTokens ?? DEFAULT_L0_MAX_TOKENS,
                signal: ac.signal,
            })) {
                const t = chunk?.text;
                if (typeof t === 'string' && t.length > 0)
                    chunks.push(t);
            }
            const text = chunks.join('').trim();
            return text.length > 0 ? text : null;
        }
        finally {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
        }
    }
    catch {
        return null;
    }
}
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
export async function runL0(store, input) {
    try {
        const texts = collectTurnTexts(input.events, input.turn);
        if (texts.length === 0)
            return null;
        let summary;
        if (input.summarize === 'llm' && input.llm && input.provider && input.model) {
            summary = (await summarizeLlm(input.llm, {
                provider: input.provider,
                model: input.model,
                text: texts.join('\n'),
                maxTokens: input.maxTokens,
                timeoutMs: input.timeoutMs,
                signal: input.signal,
            })) ?? summarizeRules(texts);
        }
        else {
            summary = summarizeRules(texts);
        }
        if (!episodeWorthWriting(summary))
            return null;
        // tools_used: honor an explicit value, else auto-collect tool/call names.
        const toolsUsed = input.toolsUsed ?? JSON.stringify(collectTurnTools(input.events, input.turn));
        return store.addEpisode({
            sessionId: input.sessionId,
            summary,
            toolsUsed,
            topic: input.topic,
        });
    }
    catch (err) {
        // P2-7: business skips (no texts / not worth writing) return null above;
        // whatever lands HERE is a program error — hand it to the host trace.
        input.onError?.(err);
        return null;
    }
}
/** True when an event is a completed turn/end — the L0 trigger predicate. */
export function isCompletedTurnEnd(ev) {
    const e = ev;
    return e?.type === 'turn/end' && e.data?.reason?.kind === 'completed';
}
/**
 * M5 (2026-08-30): session-level LLM consolidation ("idle settle"). Turn-end
 * keeps realtime rule summaries (zero LLM); when a session has been idle ≥
 * l0IdleMinutes, the host calls this to upgrade the freshest pending episode to
 * a single full-session LLM summary — the "one LLM call after the dust settles"
 * shape of REFINE-REDESIGN.md §3.1. If no LLM/route is present, or nothing was
 * worth writing, returns null (no duplicate row). Pure w.r.t. persistence —
 * only awaits the injected stream + two store writes.
 */
export async function condenseSession(store, input) {
    if (!input.texts || input.texts.length === 0)
        return null;
    const joined = input.texts.join('\n');
    let summary = null;
    if (input.llm && input.provider && input.model) {
        summary = await summarizeLlm(input.llm, {
            provider: input.provider, model: input.model, text: joined,
            maxTokens: input.maxTokens, timeoutMs: input.timeoutMs, signal: input.signal,
        });
    }
    if (!summary || summary.trim().length === 0)
        return null;
    // Upgrade the freshest untouched episode (rule summary) in place if present —
    // avoids piling a second row for the same conversation.
    const last = store.lastEpisodeForSession(input.sessionId);
    if (last && last.extracted === 0) {
        store.replaceEpisodeSummary(last.id, summary);
        return last;
    }
    return store.addEpisode({ sessionId: input.sessionId, summary: summary.trim(), topic: input.topic });
}
