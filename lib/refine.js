import { contentId } from './store.js';
export const DEFAULT_REFINE_MAX_TOKENS = 800;
export const DEFAULT_REFINE_TIMEOUT_MS = 10000;
const REFINE_BATCH_LIMIT = 20;
/** R2 (review 2026-08-30): an episode whose facts keep being rejected (e.g.
 *  tier-0 budget permanently overflowed) is retried at most this many times,
 *  then marked degraded — never an infinite per-cycle LLM loop. */
export const L1_MAX_WRITE_RETRIES = 3;
const KINDS = ['preference', 'env', 'lesson', 'decision', 'general'];
const EPISTEMICS = ['observed', 'inferred', 'subjective'];
const ACTIONS = new Set(['merge', 'keep', 'drop', 'correct']);
/**
 * Resolve the route for a background L1/L2 pass. Precedence: explicit config →
 * route learned from a live session request-header → host default model
 * (`agentDefaultModel.currentSelection()`), else null (caller degrades).
 * Pure: no dsh, no I/O. Returns a route only when both halves are present.
 */
export function resolveRefineRoute(explicit, learned, hostDefault) {
    for (const src of [explicit, learned, hostDefault]) {
        if (src?.provider && src?.model)
            return { provider: src.provider, model: src.model };
    }
    return null;
}
/** M8: true when `now` (in cfg.timeZone) falls inside any suppression window or
 *  the `suppressLeadMinutes` immediately before one. Pure — no I/O, testable. */
export function isSuppressedRaw(now, cfg, tzHour, tzMinute) {
    const mins = tzHour * 60 + tzMinute;
    const lead = cfg.suppressLeadMinutes ?? 0;
    for (const w of cfg.suppressWindows) {
        const [sh, sm] = String(w.start).split(':').map(Number);
        const [eh, em] = String(w.end).split(':').map(Number);
        if (!Number.isFinite(sh) || !Number.isFinite(eh))
            continue;
        const start = sh * 60 + (Number.isFinite(sm) ? sm : 0);
        const end = eh * 60 + (Number.isFinite(em) ? em : 0);
        if (mins >= start - lead && mins < end)
            return true;
    }
    return false;
}
/** M8: resolve hour/minute in cfg.timeZone then delegate to {@link isSuppressedRaw}.
 *  Falls back to UTC wall-clock on an unknown/invalid timeZone. */
export function isSuppressed(now, cfg) {
    if (!cfg.suppressWindows || cfg.suppressWindows.length === 0)
        return false;
    let hour = now.getUTCHours();
    let minute = now.getUTCMinutes();
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
        for (const p of parts) {
            if (p.type === 'hour')
                hour = Number(p.value);
            if (p.type === 'minute')
                minute = Number(p.value);
        }
    }
    catch {
        /* unknown timeZone → keep UTC wall-clock; caller still gets a deterministic gate */
    }
    return isSuppressedRaw(now, cfg, hour, minute);
}
function stripFence(text) {
    const m = text.trim().match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return m ? m[1].trim() : text.trim();
}
function parseJsonArray(text) {
    let arr;
    try {
        arr = JSON.parse(stripFence(text));
    }
    catch {
        return null;
    }
    return Array.isArray(arr) ? arr : null;
}
/**
 * Parse L1 model output into facts. Tolerant: strips markdown fences, skips
 * malformed members, clamps importance, narrows kind/epistemic to the closed
 * sets. Returns a (possibly empty) array on a structurally valid JSON array,
 * or null on a parse failure (→ treated as degraded).
 */
export function parseL1Json(text) {
    const arr = parseJsonArray(text);
    if (arr === null)
        return null;
    const facts = [];
    for (const item of arr) {
        if (item === null || typeof item !== 'object')
            continue;
        const it = item;
        const content = typeof it.content === 'string' ? it.content.trim() : '';
        if (!content)
            continue;
        const kind = typeof it.kind === 'string' && KINDS.includes(it.kind) ? it.kind : undefined;
        let importance;
        if (typeof it.importance === 'number' && Number.isFinite(it.importance)) {
            importance = Math.min(5, Math.max(1, Math.round(it.importance)));
        }
        const epistemic = typeof it.epistemic === 'string' && EPISTEMICS.includes(it.epistemic)
            ? it.epistemic : undefined;
        const topic = typeof it.topic === 'string' && it.topic.trim() ? it.topic.trim() : undefined;
        facts.push({ content, ...(kind ? { kind } : {}), ...(importance ? { importance } : {}), ...(epistemic ? { epistemic } : {}), ...(topic ? { topic } : {}) });
    }
    return facts.length > 0 ? facts : [];
}
/** Parse L2 model output into verdicts. Empty-but-valid → [] (keep all). */
export function parseL2Json(text) {
    const arr = parseJsonArray(text);
    if (arr === null)
        return null;
    const verdicts = [];
    for (const item of arr) {
        if (item === null || typeof item !== 'object')
            continue;
        const it = item;
        const action = it.action;
        if (typeof action !== 'string' || !ACTIONS.has(action))
            continue;
        const ids = Array.isArray(it.targetIds)
            ? it.targetIds.filter(id => typeof id === 'string' && id.length > 0).map(String)
            : [];
        if (ids.length === 0 && action !== 'keep')
            continue;
        const content = typeof it.content === 'string' && it.content.trim() ? it.content.trim() : undefined;
        const kind = typeof it.kind === 'string' && KINDS.includes(it.kind) ? it.kind : undefined;
        verdicts.push({
            action: action,
            ...(ids.length ? { targetIds: ids } : {}),
            ...(content ? { content } : {}),
            ...(kind ? { kind } : {}),
        });
    }
    return verdicts.length > 0 ? verdicts : [];
}
/** Build the L1 system + framed user prompt (JSON-framed input prevents leakage). */
export function buildL1Prompt(summary, toolsUsed) {
    const system = 'You are the L1 extractor of an AI memory system. From one episodic session summary, ' +
        'extract only STABLE, reusable facts: durable preferences, environment facts, lessons, decisions. ' +
        'Return ONLY a JSON array — no prose, no markdown fence, no preamble. Each element: ' +
        '{"content": string, "kind": "preference|env|lesson|decision|general", "importance": 1-5, ' +
        '"epistemic": "observed|inferred|subjective", "topic": string}. content must be concise, plain, ' +
        'and standalone. Drop ephemeral chit-chat and one-off details. If nothing durable, return []. ' +
        'Be compact; avoid ellipses; mark uncertainty honestly via epistemic.';
    const user = `Session summary:\n${JSON.stringify(summary)}${toolsUsed ? `\nTools used: ${toolsUsed}` : ''}`;
    return { system, user };
}
/** Build the L2 system + framed user prompt over a cluster of candidate facts. */
export function buildL2Prompt(facts) {
    const system = 'You are the L2 consolidator of an AI memory system. From a JSON array of candidate memory facts, ' +
        'decide how to consolidate duplicates and contradictions. Return ONLY a JSON array of verdicts — ' +
        'no prose, no markdown fence. Each verdict: ' +
        '{"action": "merge|keep|drop|correct", "targetIds": ["..."], "content": string|absent, "kind": string|absent}. ' +
        'merge: several facts into one (provide merged content). keep: a fact stands (its targetId). ' +
        'drop: redundant or wrong (targetIds). correct: revise one fact (targetId + corrected content). ' +
        'Be conservative: only consolidate clear duplicates or contradictions; otherwise keep. ' +
        'Prefer dropping the more specific/superseded entry over inventing new text.';
    const user = `Candidate facts:\n${JSON.stringify(facts)}`;
    return { system, user };
}
/** Stream an LLM call to a trimmed text string, enforcing a timeout via AbortController. */
async function llmText(seam, opts) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_REFINE_TIMEOUT_MS);
    try {
        const chunks = [];
        for await (const chunk of seam.stream({
            provider: opts.provider,
            model: opts.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: opts.user }] }],
            system: opts.system,
            maxTokens: opts.maxTokens ?? DEFAULT_REFINE_MAX_TOKENS,
            signal: ac.signal,
        })) {
            const text = chunk?.text;
            if (typeof text === 'string' && text.length > 0)
                chunks.push(text);
        }
        const text = chunks.join('').trim();
        return text.length > 0 ? text : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
/**
 * Run L1 extraction over pending episodes. Per episode: LLM decides the stable
 * facts (or that there are none); approved facts are written through
 * store.batch (so dedup/quality/tier apply) and the episode is marked
 * extracted=1. A missing/failed route or unparseable output marks extracted=2
 * (degraded-skip) with an audit row. Budget overflow falls back to writing
 * facts one-at-a-time so a tier-0 squeeze never loses facts silently.
 * R2 (review 2026-08-30): an episode whose facts are persistently rejected
 * (budget) is retried at most L1_MAX_WRITE_RETRIES times, then degraded —
 * never an infinite per-cycle LLM loop; its audit rows read 'ok-noop'.
 * Never throws to the caller.
 */
export async function runRefineL1(store, input = {}) {
    const stats = { processed: 0, degraded: 0, factsWritten: 0, runIds: [] };
    const episodes = store.listEpisodesForRefine({ retryDegraded: input.retryDegraded, limit: input.limit ?? REFINE_BATCH_LIMIT });
    const hasRoute = Boolean(input.llm && input.provider && input.model);
    const route = input.provider && input.model ? `${input.provider}/${input.model}` : undefined;
    for (const ep of episodes) {
        try {
            let facts = null;
            let status = 'ok';
            if (!hasRoute) {
                status = 'degraded';
            }
            else {
                const prompt = buildL1Prompt(ep.summary, ep.tools_used);
                const sha = contentId(`${ep.id}\n${ep.summary}`);
                const raw = await llmText(input.llm, {
                    provider: input.provider, model: input.model, system: prompt.system, user: prompt.user,
                    maxTokens: input.maxTokens, timeoutMs: input.timeoutMs,
                });
                facts = raw === null ? null : parseL1Json(raw);
                if (raw === null || facts === null)
                    status = 'degraded';
            }
            if (status === 'degraded' || facts === null) {
                store.markEpisodeExtracted(ep.id, 2);
                // R6 (review 2026-08-30): return the REAL audit row id (was sentinel 0,
                // which pointed at nothing and broke traceability).
                stats.runIds.push(store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: '[]', status: 'degraded' }));
                stats.degraded += 1;
                stats.processed += 1;
                continue;
            }
            if (facts.length === 0) {
                store.markEpisodeExtracted(ep.id, 1);
                stats.runIds.push(store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: '[]', status: 'ok' }));
                stats.processed += 1;
                continue;
            }
            // Write facts (dedup/quality/tier via batch); on tier-0 overflow retry 1-by-1.
            const ops = facts.map(f => ({ action: 'add', layer: 'memory', content: f.content, ...(f.kind ? { kind: f.kind } : {}), ...(f.importance ? { importance: f.importance } : {}), ...(f.epistemic ? { epistemic: f.epistemic } : {}), ...(f.topic ? { topic: f.topic } : {}) }));
            const batchRes = store.batch(ops, input.sessionId);
            let wrote = batchRes.applied.length;
            if (batchRes.overflowed) {
                // tier-0 budget squeeze: persist what fits, fact-by-fact (nothing lost silently).
                let any = 0;
                for (const op of ops) {
                    if (store.batch([op], input.sessionId).applied.length)
                        any += 1;
                }
                if (any > 0)
                    wrote = any; // P2-31: report actual facts written, not the full batch size
            }
            if (wrote > 0) {
                store.markEpisodeExtracted(ep.id, 1);
            }
            else if (store.refineAttemptCount(ep.id) + 1 >= L1_MAX_WRITE_RETRIES) {
                // R2 (review 2026-08-30): facts permanently rejected (budget) — stop the
                // infinite retry loop, degrade the episode so later passes skip it.
                store.markEpisodeExtracted(ep.id, 2);
                stats.degraded += 1;
            } // else: leave extracted=0 to retry later (bounded by the check above)
            // R2: audit must tell a no-op write apart from a real one — 'ok' used to
            // mask an every-cycle LLM call that wrote nothing.
            const runId = store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: JSON.stringify(facts), status: wrote > 0 ? 'ok' : 'ok-noop' });
            stats.factsWritten += wrote;
            stats.processed += 1;
            stats.runIds.push(runId);
        }
        catch {
            store.markEpisodeExtracted(ep.id, 2);
            stats.runIds.push(store.writeRefineRun({ level: 1, sourceId: ep.id, route, decisions: '[]', status: 'error' }));
            stats.degraded += 1;
            stats.processed += 1;
        }
    }
    return stats;
}
/**
 * Run L2 consolidation over semantic clusters. Each cluster goes to the LLM for
 * merge/keep/drop/correct verdicts; applied verdicts rewrite the store through
 * batch (merge = add merged + archive originals; drop = archive; correct =
 * replace — all soft/reversible). A missing route skips L2 entirely (core stays
 * untouched); a per-cluster failure logs a degraded run without touching data.
 * Never throws to the caller.
 */
export async function runRefineL2(store, input = {}) {
    const stats = { clusters: 0, degraded: 0, verdictsApplied: 0, runIds: [] };
    if (!input.llm || !input.provider || !input.model)
        return stats;
    const route = `${input.provider}/${input.model}`;
    // P2-dedup (2026-08-31): beyond the by-topic clusters, also adjudicate
    // cross-topic near-duplicate groups (a fact reworded into a different topic
    // string would otherwise never be co-audited). Dead ids from prior merges are
    // filtered when verdicts are applied, so overlap is safe (idempotent).
    const clusters = [
        ...store.semanticClusters({ min: input.minCluster ?? 2, limit: input.limit ?? REFINE_BATCH_LIMIT, incremental: input.incremental === true }),
        ...store.crossTopicNearDupGroups({ min: 2, limit: 4 }),
    ];
    for (const cluster of clusters) {
        try {
            const prompt = buildL2Prompt(cluster.facts);
            const raw = await llmText(input.llm, {
                provider: input.provider, model: input.model, system: prompt.system, user: prompt.user,
                maxTokens: input.maxTokens, timeoutMs: input.timeoutMs,
            });
            const verdicts = raw === null ? null : parseL2Json(raw);
            if (raw === null || verdicts === null) {
                stats.runIds.push(store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: '[]', status: 'degraded' }));
                stats.clusters += 1;
                stats.degraded += 1;
                continue;
            }
            const ops = [];
            const applied = [];
            for (const v of verdicts) {
                const ids = (v.targetIds ?? []).filter(id => store.get(id));
                if (v.action === 'merge' && v.content && ids.length > 0) {
                    // P1-1 (review 2026-08-31): probe WHERE the add will actually land
                    // BEFORE deciding who gets removed. store.add merges a near-duplicate
                    // (contentSimilarity >= SIM_DUP) into the canonical row and keeps THAT
                    // row's id — the merged fact survives AS the canonical row, not under
                    // contentId(v.content). The old `id !== mergedId` guard only covered
                    // the exact-collision case, so a near-duplicate merge archived the
                    // very row it had just updated (merge result silently lost).
                    // Survivors = the canonical row the add will upsert + exact-content id.
                    const canonical = store.findCanonical(v.content, 'memory');
                    const survivors = new Set([contentId(v.content)]);
                    if (canonical)
                        survivors.add(canonical.id);
                    ops.push({ action: 'add', layer: 'memory', content: v.content, topic: cluster.topic, authoritative: true, ...(v.kind ? { kind: v.kind } : {}) });
                    for (const id of ids)
                        if (!survivors.has(id))
                            ops.push({ action: 'remove', id });
                    applied.push(v);
                }
                else if (v.action === 'drop' && ids.length > 0) {
                    for (const id of ids)
                        ops.push({ action: 'remove', id });
                    applied.push(v);
                }
                else if (v.action === 'correct' && v.content && ids.length > 0) {
                    ops.push({ action: 'replace', id: ids[0], content: v.content, ...(v.kind ? { kind: v.kind } : {}) });
                    applied.push(v);
                }
                // keep → no-op
            }
            if (ops.length > 0)
                store.batch(ops, input.sessionId ?? 'l2-refine');
            const runId = store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: JSON.stringify(applied), status: 'ok' });
            stats.clusters += 1;
            stats.verdictsApplied += applied.length;
            stats.runIds.push(runId); // P2-30: keep the real audit row id on the success path (was hard-coded 0)
            // M7: mark this topic audited at now — a degraded/failed pass does NOT
            // record, so the cluster stays eligible once the LLM recovers.
            store.upsertL2Refined(cluster.topic);
        }
        catch {
            // A3 (2026-09-01): writeRefineRun may throw if DB is closed — don't let
            // audit failure escape and break the "Never throws" contract.
            try {
                stats.runIds.push(store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: '[]', status: 'error' }));
            }
            catch { /* audit write failed, count only */ }
            stats.clusters += 1;
            stats.degraded += 1;
        }
    }
    return stats;
}
