/**
 * Recall engine — the read path. Implements the design's retrieval pipeline:
 *
 *   vector recall → filter → semantic-key dedup → graph expansion → fusion
 *   ranking → token-budget boxing.
 *
 * In P0 the "vector" recall is the repository's lexical BM25 query; the engine
 * is deliberately store-agnostic and ranks + budgets. It runs within a
 * synchronous budget (timeout) enforced by the caller.
 *
 * @module dsh-memory/application/recall
 */
import type { AtomicFact, FactType } from '../domain/fact.ts'
import type { MemoryPolicy } from '../domain/policies.ts'
import { recencyScore } from '../domain/policies.ts'
import type { MemoryRepository } from './ports.ts'
import type { FactFilter } from './ports.ts'

/**
 * Fallback decay lambda when no memory type is supplied (kept conservative,
 * equivalent to the procedural placeholder from P0 so direct scalar calls
 * without a typed fact remain stable).
 */
const DEFAULT_DECAY_LAMBDA = 0.005

export interface RecallQuery {
  readonly query: string
  readonly scope: string
  readonly topK?: number
  readonly maxTokens?: number
  readonly now?: number
  readonly excludeIds?: readonly string[]
  /**
   * When true, only `index_state = ready` facts are considered (the outward
   * signal of the outbox/Saga eventual-consistency barrier, §7.2). Called by the
   * service with the resolved policy value.
   */
  readonly requireReadyIndex?: boolean
}

export interface ScoredMemory {
  readonly fact: AtomicFact
  readonly score: number
  readonly relevance: number
}

/** Rough token estimate for the rendered content block. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Normalize a raw query into lexical terms (CJK stays char-level). */
export function queryTerms(query: string): string[] {
  const cjkRe = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
  const cjk = query.match(cjkRe) ?? []
  const ascii = (query.replace(cjkRe, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? [])
  return [...ascii, ...cjk].slice(0, 64)
}

/**
 * Run a recall against the store. Dedupes by semantic_key (highest score
 * survives), optionally expands along the graph, fuses the ranking, and boxes
 * the result to a token budget (sorting before truncation, never truncating
 * before sorting).
 */
export async function recall(
  policy: MemoryPolicy,
  repo: MemoryRepository,
  q: RecallQuery,
): Promise<ScoredMemory[]> {
  const now = q.now ?? Date.now()
  const topK = q.topK ?? policy.retrieval.topK
  const maxTokens = q.maxTokens ?? policy.retrieval.maxTokens
  const filter: FactFilter = {
    scope: q.scope,
    status: ['active'],
    privacy: policy.privacy.retrievalFilter,
    now,
    // Outbox barrier: read only facts the derived backends have confirmed.
    indexState: q.requireReadyIndex === true ? ['ready'] : undefined,
  }

  const terms = queryTerms(q.query)
  const candidates = await repo.query(filter, terms, [])

  // Seed entities for graph expansion: subject/object of the top candidates.
  const ranked = fusionSort(policy, candidates, now)
  const top = ranked.slice(0, policy.retrieval.graph.maxSeedEntities)

  const seedEntities = new Set<string>()
  for (const { fact } of top) {
    seedEntities.add(fact.subject.id)
    if (fact.object?.id !== undefined) seedEntities.add(fact.object.id)
  }

  // Read the relation whitelist once.
  const whitelist = policy.retrieval.graph.relationWhitelist
  const expanded = new Set<string>()
  const visited = new Set<string>(seedEntities)
  let frontier = [...seedEntities].slice(0, policy.retrieval.graph.maxSeedEntities)
  for (let depth = 0; depth < policy.retrieval.graph.maxDepth && frontier.length > 0; depth += 1) {
    const next = new Set<string>()
    let fan = 0
    for (const entity of frontier) {
      if (fan >= policy.retrieval.graph.maxCandidates) break
      const neighbors = await repo.neighbors(entity, whitelist)
      for (const n of neighbors) {
        if (visited.has(n)) continue
        visited.add(n)
        next.add(n)
        fan += 1
        if (fan >= policy.retrieval.graph.maxFanoutPerEntity) break
      }
    }
    frontier = [...next]
  }
  // Collect facts touching the expanded entity set as graph extensions.
  const graphCandidates: typeof candidates = []
  for (const entity of visited) {
    const facts = await repo.byEntity(entity, filter)
    for (const fact of facts) {
      const already = candidates.some(c => c.fact.id === fact.id)
      if (!already) graphCandidates.push({ fact, relevance: 0, viaGraph: true })
    }
    if (graphCandidates.length > policy.retrieval.graph.maxCandidates) break
  }

  const all = [...candidates, ...graphCandidates]
  const deduped = dedupBySemanticKey(all)

  // Sort by fused score (graph facts get their small w5 graph increment).
  const fused = fusionSort(policy, deduped.map(c => ({ fact: c.fact, relevance: c.relevance, viaGraph: c.viaGraph })), now)

  // Token-budget boxing: sort first, then pack until budget runs out.
  const result: ScoredMemory[] = []
  let tokens = 0
  for (const c of fused) {
    const fact = c.fact
    if (q.excludeIds?.includes(fact.id)) continue
    const t = estimateTokens(fact.content)
    // Always allow the single best result even if it exceeds the budget.
    if (result.length > 0 && tokens + t > maxTokens) break
    result.push({ fact, score: c.score, relevance: c.relevance })
    tokens += t
    if (result.length >= topK) break
  }
  return result
}

/** Per-memory-type recency decay lambda (design §3.10). Semantic barely decays, episodic faster. */
export function decayLambda(policy: MemoryPolicy, type: FactType): number {
  const f = policy.forgetting[type]
  return f?.lambda ?? DEFAULT_DECAY_LAMBDA
}

/**
 * Fusion-ranking normalization (design §3.10 scoring weights).
 * Recency is exponentially decayed using the per-memory-type lambda from the
 * forgetting policy, not a fixed placeholder — so episodic facts sink faster
 * than semantic ones as they age. `ageMs` is the fact's age in ms (now −
 * updated_at); recency = exp(−lambda · ageDays).
 */
export function fusionScore(
  policy: MemoryPolicy,
  relevance: number,
  confidence: number,
  credibility: number,
  ageMs: number,
  graphScore: number,
  factType?: FactType,
): number {
  const { w1, w2, w3, w4, w5 } = policy.retrieval.ranking
  const lambda = factType !== undefined ? decayLambda(policy, factType) : DEFAULT_DECAY_LAMBDA
  const recency = recencyScore(lambda, ageMs)
  return w1 * relevance
    + w2 * confidence
    + w3 * credibility
    + w4 * recency
    + w5 * graphScore
}

interface Candidate { fact: AtomicFact; relevance: number; viaGraph: boolean }

/** Apply fusion ranking and return sorted (desc) candidates. */
function fusionSort(policy: MemoryPolicy, candidates: Candidate[], now: number): (Candidate & { score: number })[] {
  return candidates
    .map(c => {
      const score = fusionScore(
        policy,
        c.relevance,
        c.fact.confidence,
        c.fact.source.credibility,
        now - c.fact.updated_at, // age in ms
        c.viaGraph ? 0.5 : 0,
        c.fact.type,
      )
      return { ...c, score }
    })
    .sort((a, b) => b.score - a.score)
}

/** Merge facts sharing a semantic_key, keeping the highest relevance. */
function dedupBySemanticKey(candidates: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const c of candidates) {
    const prev = byKey.get(c.fact.semantic_key)
    if (prev === undefined || c.relevance > prev.relevance) byKey.set(c.fact.semantic_key, c)
  }
  return [...byKey.values()]
}
