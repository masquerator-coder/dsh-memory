/**
 * dsh-memory — L1/L2 LLM-decided consolidation (episode → stable facts, then
 * semantic merge/arbitration). Mirrors l0.ts: the core decide+shape functions
 * are pure (testable without dsh); only the LLM stream and store writes are
 * injected by the caller.
 *
 * Hard constraints honored here:
 *  - These are BACKGROUND ENHANCEMENTS. They never gate recall, and a dead /
 *    missing LLM degrades cleanly: L1 marks the episode `extracted=2` (skip,
 *    no pure-rule extraction — episode text is already compressed, rule
 *    extraction would be noise); L2 simply does not merge. The core store /
 *    recall / forget loop is untouched and never says "waiting on the model".
 *  - Every LLM decision is audited into `refine_runs` (route, status, decisions).
 *  - Background runs have no session context, so a route (provider/model) must
 *    be supplied explicitly; there is no request-header to fall back on.
 */
import type { MemoryStore } from './store.js'
import { contentId } from './store.js'
import type { LlmStreamSeam } from './l0.js'
import type { Epistemic, Importance, Kind, MemoryOp } from './types.js'

export const DEFAULT_REFINE_MAX_TOKENS = 800
export const DEFAULT_REFINE_TIMEOUT_MS = 10000
const REFINE_BATCH_LIMIT = 20

const KINDS: readonly Kind[] = ['preference', 'env', 'lesson', 'decision', 'general']
const EPISTEMICS: readonly Epistemic[] = ['observed', 'inferred', 'subjective']
const ACTIONS = new Set(['merge', 'keep', 'drop', 'correct'])

/** One stable fact extracted from an episode by L1. */
export interface ExtractedFact {
  content: string
  kind?: Kind
  importance?: Importance
  epistemic?: Epistemic
  topic?: string
}

/** One consolidation verdict over a semantic cluster by L2. */
export interface L2Verdict {
  action: 'merge' | 'keep' | 'drop' | 'correct'
  targetIds?: string[]
  content?: string
  kind?: Kind
}

function stripFence(text: string): string {
  const m = text.trim().match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return m ? m[1].trim() : text.trim()
}

function parseJsonArray<T>(text: string): unknown[] | null {
  let arr: unknown
  try { arr = JSON.parse(stripFence(text)) } catch { return null }
  return Array.isArray(arr) ? arr : null
}

/**
 * Parse L1 model output into facts. Tolerant: strips markdown fences, skips
 * malformed members, clamps importance, narrows kind/epistemic to the closed
 * sets. Returns a (possibly empty) array on a structurally valid JSON array,
 * or null on a parse failure (→ treated as degraded).
 */
export function parseL1Json(text: string): ExtractedFact[] | null {
  const arr = parseJsonArray(text)
  if (arr === null) return null
  const facts: ExtractedFact[] = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const content = typeof it.content === 'string' ? it.content.trim() : ''
    if (!content) continue
    const kind = typeof it.kind === 'string' && (KINDS as readonly string[]).includes(it.kind) ? it.kind as Kind : undefined
    let importance: Importance | undefined
    if (typeof it.importance === 'number' && Number.isFinite(it.importance)) {
      importance = Math.min(5, Math.max(1, Math.round(it.importance))) as Importance
    }
    const epistemic = typeof it.epistemic === 'string' && (EPISTEMICS as readonly string[]).includes(it.epistemic)
      ? it.epistemic as Epistemic : undefined
    const topic = typeof it.topic === 'string' && it.topic.trim() ? it.topic.trim() : undefined
    facts.push({ content, ...(kind ? { kind } : {}), ...(importance ? { importance } : {}), ...(epistemic ? { epistemic } : {}), ...(topic ? { topic } : {}) })
  }
  return facts.length > 0 ? facts : []
}

/** Parse L2 model output into verdicts. Empty-but-valid → [] (keep all). */
export function parseL2Json(text: string): L2Verdict[] | null {
  const arr = parseJsonArray(text)
  if (arr === null) return null
  const verdicts: L2Verdict[] = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const action = it.action
    if (typeof action !== 'string' || !ACTIONS.has(action)) continue
    const ids = Array.isArray(it.targetIds)
      ? (it.targetIds as unknown[]).filter(id => typeof id === 'string' && id.length > 0).map(String)
      : []
    if (ids.length === 0 && action !== 'keep') continue
    const content = typeof it.content === 'string' && it.content.trim() ? it.content.trim() : undefined
    const kind = typeof it.kind === 'string' && (KINDS as readonly string[]).includes(it.kind) ? it.kind as Kind : undefined
    verdicts.push({
      action: action as L2Verdict['action'],
      ...(ids.length ? { targetIds: ids } : {}),
      ...(content ? { content } : {}),
      ...(kind ? { kind } : {}),
    })
  }
  return verdicts.length > 0 ? verdicts : []
}

/** Build the L1 system + framed user prompt (JSON-framed input prevents leakage). */
export function buildL1Prompt(summary: string, toolsUsed?: string): { system: string; user: string } {
  const system =
    'You are the L1 extractor of an AI memory system. From one episodic session summary, ' +
    'extract only STABLE, reusable facts: durable preferences, environment facts, lessons, decisions. ' +
    'Return ONLY a JSON array — no prose, no markdown fence, no preamble. Each element: ' +
    '{"content": string, "kind": "preference|env|lesson|decision|general", "importance": 1-5, ' +
    '"epistemic": "observed|inferred|subjective", "topic": string}. content must be concise, plain, ' +
    'and standalone. Drop ephemeral chit-chat and one-off details. If nothing durable, return []. ' +
    'Be compact; avoid ellipses; mark uncertainty honestly via epistemic.'
  const user = `Session summary:\n${JSON.stringify(summary)}${toolsUsed ? `\nTools used: ${toolsUsed}` : ''}`
  return { system, user }
}

/** Build the L2 system + framed user prompt over a cluster of candidate facts. */
export function buildL2Prompt(facts: { id: string; content: string; kind?: Kind; importance?: Importance }[]): { system: string; user: string } {
  const system =
    'You are the L2 consolidator of an AI memory system. From a JSON array of candidate memory facts, ' +
    'decide how to consolidate duplicates and contradictions. Return ONLY a JSON array of verdicts — ' +
    'no prose, no markdown fence. Each verdict: ' +
    '{"action": "merge|keep|drop|correct", "targetIds": ["..."], "content": string|absent, "kind": string|absent}. ' +
    'merge: several facts into one (provide merged content). keep: a fact stands (its targetId). ' +
    'drop: redundant or wrong (targetIds). correct: revise one fact (targetId + corrected content). ' +
    'Be conservative: only consolidate clear duplicates or contradictions; otherwise keep. ' +
    'Prefer dropping the more specific/superseded entry over inventing new text.'
  const user = `Candidate facts:\n${JSON.stringify(facts)}`
  return { system, user }
}

/** Stream an LLM call to a trimmed text string, enforcing a timeout via AbortController. */
async function llmText(
  seam: LlmStreamSeam,
  opts: { provider: string; model: string; system: string; user: string; maxTokens?: number; timeoutMs?: number },
): Promise<string | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_REFINE_TIMEOUT_MS)
  try {
    const chunks: string[] = []
    for await (const chunk of seam.stream({
      provider: opts.provider,
      model: opts.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: opts.user }] }],
      system: opts.system,
      maxTokens: opts.maxTokens ?? DEFAULT_REFINE_MAX_TOKENS,
      signal: ac.signal,
    })) {
      const text = (chunk as { text?: string } | undefined)?.text
      if (typeof text === 'string' && text.length > 0) chunks.push(text)
    }
    const text = chunks.join('').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

export interface RefineInput {
  llm?: LlmStreamSeam | null
  provider?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
  retryDegraded?: boolean
  sessionId?: string
  limit?: number
}

/**
 * Run L1 extraction over pending episodes. Per episode: LLM decides the stable
 * facts (or that there are none); approved facts are written through
 * store.batch (so dedup/quality/tier apply) and the episode is marked
 * extracted=1. A missing/failed route or unparseable output marks extracted=2
 * (degraded-skip) with an audit row. Budget overflow falls back to writing
 * facts one-at-a-time so a tier-0 squeeze never loses facts silently.
 * Never throws to the caller.
 */
export async function runRefineL1(store: MemoryStore, input: RefineInput = {}): Promise<{
  processed: number
  degraded: number
  factsWritten: number
  runIds: number[]
}> {
  const stats = { processed: 0, degraded: 0, factsWritten: 0, runIds: [] as number[] }
  const episodes = store.listEpisodesForRefine({ retryDegraded: input.retryDegraded, limit: input.limit ?? REFINE_BATCH_LIMIT })
  const hasRoute = Boolean(input.llm && input.provider && input.model)
  const route = input.provider && input.model ? `${input.provider}/${input.model}` : undefined
  for (const ep of episodes) {
    try {
      let facts: ExtractedFact[] | null = null
      let status: 'ok' | 'degraded' = 'ok'
      if (!hasRoute) {
        status = 'degraded'
      } else {
        const prompt = buildL1Prompt(ep.summary, ep.tools_used)
        const sha = contentId(`${ep.id}\n${ep.summary}`)
        const raw = await llmText(input.llm!, {
          provider: input.provider!, model: input.model!, system: prompt.system, user: prompt.user,
          maxTokens: input.maxTokens, timeoutMs: input.timeoutMs,
        })
        facts = raw === null ? null : parseL1Json(raw)
        if (raw === null || facts === null) status = 'degraded'
      }
      if (status === 'degraded' || facts === null) {
        store.markEpisodeExtracted(ep.id, 2)
        store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: '[]', status: 'degraded' })
        stats.degraded += 1
        stats.processed += 1
        stats.runIds.push(0)
        continue
      }
      if (facts.length === 0) {
        store.markEpisodeExtracted(ep.id, 1)
        store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: '[]', status: 'ok' })
        stats.processed += 1
        stats.runIds.push(0)
        continue
      }
      // Write facts (dedup/quality/tier via batch); on tier-0 overflow retry 1-by-1.
      const ops: MemoryOp[] = facts.map(f => ({ action: 'add', layer: 'memory', content: f.content, ...(f.kind ? { kind: f.kind } : {}), ...(f.importance ? { importance: f.importance } : {}), ...(f.epistemic ? { epistemic: f.epistemic } : {}), ...(f.topic ? { topic: f.topic } : {}) }))
      const batchRes = store.batch(ops, input.sessionId)
      let wrote = batchRes.applied.length
      if (batchRes.overflowed) {
        // tier-0 budget squeeze: persist what fits, fact-by-fact (nothing lost silently).
        let any = false
        for (const op of ops) {
          if (store.batch([op], input.sessionId).applied.length) any = true
        }
        if (any) wrote = ops.length
      }
      if (wrote > 0) store.markEpisodeExtracted(ep.id, 1) // else leave extracted=0 to retry later
      const runId = store.writeRefineRun({ level: 1, sourceId: ep.id, promptSha: contentId(`${ep.id}\n${ep.summary}`), route, decisions: JSON.stringify(facts), status: 'ok' })
      stats.factsWritten += wrote
      stats.processed += 1
      stats.runIds.push(runId)
    } catch {
      store.markEpisodeExtracted(ep.id, 2)
      store.writeRefineRun({ level: 1, sourceId: ep.id, route, decisions: '[]', status: 'error' })
      stats.degraded += 1
      stats.processed += 1
      stats.runIds.push(0)
    }
  }
  return stats
}

/**
 * Run L2 consolidation over semantic clusters. Each cluster goes to the LLM for
 * merge/keep/drop/correct verdicts; applied verdicts rewrite the store through
 * batch (merge = add merged + archive originals; drop = archive; correct =
 * replace — all soft/reversible). A missing route skips L2 entirely (core stays
 * untouched); a per-cluster failure logs a degraded run without touching data.
 * Never throws to the caller.
 */
export async function runRefineL2(store: MemoryStore, input: RefineInput & { minCluster?: number } = {}): Promise<{
  clusters: number
  degraded: number
  verdictsApplied: number
  runIds: number[]
}> {
  const stats = { clusters: 0, degraded: 0, verdictsApplied: 0, runIds: [] as number[] }
  if (!input.llm || !input.provider || !input.model) return stats
  const route = `${input.provider}/${input.model}`
  const clusters = store.semanticClusters({ min: input.minCluster ?? 2, limit: input.limit ?? REFINE_BATCH_LIMIT })
  for (const cluster of clusters) {
    try {
      const prompt = buildL2Prompt(cluster.facts)
      const raw = await llmText(input.llm, {
        provider: input.provider, model: input.model, system: prompt.system, user: prompt.user,
        maxTokens: input.maxTokens, timeoutMs: input.timeoutMs,
      })
      const verdicts = raw === null ? null : parseL2Json(raw)
      if (raw === null || verdicts === null) {
        store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: '[]', status: 'degraded' })
        stats.clusters += 1
        stats.degraded += 1
        stats.runIds.push(0)
        continue
      }
      const ops: MemoryOp[] = []
      const applied: L2Verdict[] = []
      for (const v of verdicts) {
        const ids = (v.targetIds ?? []).filter(id => store.get(id))
        if (v.action === 'merge' && v.content && ids.length > 0) {
          // Add the merged fact; if its content dedups onto one of the source
          // ids (contentId collide), that source IS the merged entry after the
          // upsert — remove only the OTHER sources so the merged fact survives.
          const mergedId = contentId(v.content)
          ops.push({ action: 'add', layer: 'memory', content: v.content, topic: cluster.topic, ...(v.kind ? { kind: v.kind } : {}) })
          for (const id of ids) if (id !== mergedId) ops.push({ action: 'remove', id })
          applied.push(v)
        } else if (v.action === 'drop' && ids.length > 0) {
          for (const id of ids) ops.push({ action: 'remove', id })
          applied.push(v)
        } else if (v.action === 'correct' && v.content && ids.length > 0) {
          ops.push({ action: 'replace', id: ids[0], content: v.content, ...(v.kind ? { kind: v.kind } : {}) })
          applied.push(v)
        }
        // keep → no-op
      }
      if (ops.length > 0) store.batch(ops, input.sessionId ?? 'l2-refine')
      store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: JSON.stringify(applied), status: 'ok' })
      stats.clusters += 1
      stats.verdictsApplied += applied.length
      stats.runIds.push(0)
    } catch {
      store.writeRefineRun({ level: 2, sourceId: cluster.seedId, promptSha: contentId(JSON.stringify(cluster.facts)), route, decisions: '[]', status: 'error' })
      stats.clusters += 1
      stats.degraded += 1
      stats.runIds.push(0)
    }
  }
  return stats
}
