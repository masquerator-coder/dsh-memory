/**
 * Derived-index backends (vector / graph / object) with a real read path.
 *
 * These implement {@link DerivedIndexBackend} — the pluggable storage the
 * Outbox + IndexWorker keep consistent (P3 round 1) AND the read side the recall
 * engine now actually queries (P3 round 2 "vector/graph storage realized").
 *
 * - `InMemoryVectorBackend` is a genuine sparse vector-space index: it embeds
 *   each fact's content+entities+tags into a TF-IDF-weighted term vector of
 *   character n-grams and answers `search` by cosine similarity. A deployed ANN
 *   store (HNSW / qdrant) implements the same {@link DerivedIndexBackend} and the
 *   recall path consumes it unchanged.
 * - `InMemoryGraphBackend` is a real entity-adjacency store serving
 *   `graphNeighbors` / `graphFactIds` for graph expansion (§7.4). Neo4j / Kùzu
 *   plug in through the same port.
 * - `InMemoryObjectBackend` stores the full record (source-of-truth projection).
 *
 * Each carries a fault-injection seam (`injectFault`, `setHealthy`) used by the
 * fault-injection tests (§12.8).
 *
 * @module dsh-memory/infrastructure/index-backends
 */
import type { AtomicFact } from '../domain/fact.ts'
import type {
  DerivedIndexBackend,
  IndexCapabilities,
  IndexRead,
  SearchHit,
} from '../application/ports.ts'

const NO_CAP: IndexCapabilities = { search: false, graph: false }

/** Shared bookkeeping for the in-memory backends. */
abstract class BaseBackend implements DerivedIndexBackend {
  abstract readonly name: string
  readonly capabilities: IndexCapabilities = NO_CAP
  protected healthy = true
  protected faultRemaining = 0

  injectFault(n = 1): void {
    this.faultRemaining = Math.max(0, n)
  }

  setHealthy(ok: boolean): void {
    this.healthy = ok
  }

  protected gate(): void {
    if (!this.healthy) throw new Error(`${this.name} backend unavailable`)
    if (this.faultRemaining > 0) {
      this.faultRemaining -= 1
      throw new Error(`${this.name} backend write failed (injected)`)
    }
  }

  async search(_queryText: string, _queryTerms: readonly string[], _topK: number): Promise<SearchHit[]> {
    return []
  }

  async graphNeighbors(_entityId: string, _relationWhitelist: readonly string[]): Promise<readonly string[]> {
    return []
  }

  async graphFactIds(_entityId: string, _topK: number): Promise<readonly string[]> {
    return []
  }

  async remove(factId: string): Promise<void> {
    this.gate()
    this.removeInternal(factId)
  }

  protected abstract removeInternal(factId: string): void

  async rebuild(facts: AtomicFact[]): Promise<void> {
    for (const f of facts) this.gate()
  }

  health(): { ok: boolean; detail?: string } {
    return this.healthy ? { ok: true } : { ok: false, detail: 'unavailable (injected)' }
  }

  abstract count(): Promise<number>
  abstract upsert(fact: AtomicFact): Promise<void>
}

/* ---------------------------------------------------------------- features */

/** Split into lowercase char n-grams (uni + bigram) for a sparse vector. */
function features(text: string): string[] {
  const cjkRe = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g
  const cjk = text.match(cjkRe) ?? []
  const ascii = (text.replace(cjkRe, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const units = [...ascii, ...cjk].filter(s => s.length > 0)
  const grams = new Set<string>()
  for (const unit of units) {
    for (const ch of unit) grams.add(ch)
    for (let i = 0; i < unit.length - 1; i += 1) grams.add(unit.slice(i, i + 2))
    grams.add(`#${unit}`) // word marker helps distinguish
  }
  return [...grams]
}

function factText(fact: AtomicFact): string {
  return [
    fact.content,
    fact.subject.name,
    fact.object?.name ?? '',
    fact.tags?.join(' ') ?? '',
  ].join(' ')
}

/* ------------------------------------------------------------ vector index */

interface VecEntry {
  readonly vec: ReadonlyMap<string, number> // term → tf-idf weight
  readonly norm: number
}

/** A real sparse vector-space index with TF-IDF weighting + cosine search. */
export class InMemoryVectorBackend extends BaseBackend {
  readonly name = 'vector'
  readonly capabilities: IndexCapabilities = { search: true, graph: false }
  private readonly items = new Map<string, VecEntry>()
  private readonly df = new Map<string, number>() // term → doc frequency

  async upsert(fact: AtomicFact): Promise<void> {
    this.gate()
    const prev = this.items.get(fact.id)
    if (prev !== undefined) this.remDf(fact.id)
    const terms = features(factText(fact))
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    // idf computed lazily at search time over the doc count; store raw tf here.
    this.items.set(fact.id, { vec: tf, norm: normOf(tf) })
  }

  protected removeInternal(factId: string): void {
    const prev = this.items.get(factId)
    if (prev === undefined) return
    this.remDf(factId)
    this.items.delete(factId)
  }

  private remDf(factId: string): void {
    const prev = this.items.get(factId)
    if (prev === undefined) return
    for (const t of prev.vec.keys()) {
      const n = (this.df.get(t) ?? 1) - 1
      if (n <= 0) this.df.delete(t)
      else this.df.set(t, n)
    }
  }

  async search(queryText: string, queryTerms: readonly string[], topK: number): Promise<SearchHit[]> {
    const n = this.items.size
    if (n === 0) return []
    const qVec = this.queryVector(queryText, n)
    const scored: { factId: string; score: number }[] = []
    for (const [factId, entry] of this.items) {
      let dot = 0
      for (const [term, qw] of qVec) {
        const dw = entry.vec.get(term)
        if (dw === undefined) continue
        const idf = Math.log(1 + n / (this.df.get(term) ?? 1))
        dot += qw * (dw * idf)
      }
      if (dot > 0) {
        const norm = normOf(qVec) || 1
        scored.push({ factId, score: dot / (entry.norm * norm) })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map(s => ({ factId: s.factId, relevance: s.score }))
  }

  private queryVector(text: string, n: number): Map<string, number> {
    const tf = new Map<string, number>()
    for (const t of features(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    const out = new Map<string, number>()
    for (const [t, c] of tf) {
      const idf = Math.log(1 + n / ((this.df.get(t) ?? 1) + 1))
      out.set(t, (c / 2) * idf)
    }
    return out
  }

  async count(): Promise<number> {
    return this.items.size
  }

  has(id: string): boolean {
    return this.items.has(id)
  }
}

function normOf(vec: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const v of vec.values()) sum += v * v
  return Math.sqrt(sum)
}

/* ------------------------------------------------------------- graph index */

interface Edge {
  readonly from: string
  readonly to: string
  readonly predicate: string
}

/** A real entity-adjacency store serving graph expansion reads (§7.4). */
export class InMemoryGraphBackend extends BaseBackend {
  readonly name = 'graph'
  readonly capabilities: IndexCapabilities = { search: false, graph: true }
  private readonly edges = new Map<string, Edge>()
  private readonly entityToFacts = new Map<string, Set<string>>()

  async upsert(fact: AtomicFact): Promise<void> {
    this.gate()
    this.edges.set(fact.id, { from: fact.subject.id, to: fact.object?.id ?? '', predicate: fact.canonical_predicate })
    for (const eid of new Set([fact.subject.id, fact.object?.id].filter(Boolean) as string[])) {
      let set = this.entityToFacts.get(eid)
      if (set === undefined) {
        set = new Set()
        this.entityToFacts.set(eid, set)
      }
      set.add(fact.id)
    }
  }

  protected removeInternal(factId: string): void {
    const edge = this.edges.get(factId)
    this.edges.delete(factId)
    if (edge === undefined) return
    for (const eid of new Set([edge.from, edge.to])) {
      const set = this.entityToFacts.get(eid)
      set?.delete(factId)
      if (set?.size === 0) this.entityToFacts.delete(eid)
    }
  }

  async graphFactIds(entityId: string, _topK: number): Promise<readonly string[]> {
    return [...(this.entityToFacts.get(entityId) ?? [])]
  }

  async graphNeighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]> {
    const out = new Set<string>()
    for (const edge of this.edges.values()) {
      if (relationWhitelist.length > 0 && !relationWhitelist.includes(edge.predicate)) continue
      if (edge.from === entityId && edge.to !== '') out.add(edge.to)
      if (edge.to === entityId) out.add(edge.from)
    }
    return [...out]
  }

  async count(): Promise<number> {
    return this.edges.size
  }

  has(id: string): boolean {
    return this.edges.has(id)
  }
}

/* ------------------------------------------------------------ object store */

/** Object store: full fact payload projection (§7.1). Read-only pass-through. */
export class InMemoryObjectBackend extends BaseBackend {
  readonly name = 'object'
  readonly capabilities: IndexCapabilities = { search: false, graph: false }
  private readonly blobs = new Map<string, AtomicFact>()

  async upsert(fact: AtomicFact): Promise<void> {
    this.gate()
    this.blobs.set(fact.id, fact)
  }

  protected removeInternal(factId: string): void {
    this.blobs.delete(factId)
  }

  async count(): Promise<number> {
    return this.blobs.size
  }

  has(id: string): boolean {
    return this.blobs.has(id)
  }
}

/** Register the standard triple of in-memory backends. */
export function defaultIndexBackends(): DerivedIndexBackend[] {
  return [new InMemoryVectorBackend(), new InMemoryGraphBackend(), new InMemoryObjectBackend()]
}

/**
 * Compose a single {@link IndexRead} bound to the first searchable vector backend
 * and the first graph backend found. Unused capabilities degrade to empty reads,
 * so a backend-free / capability-poor deployment keeps the KV fallback path.
 */
export function composeIndexRead(backends: readonly DerivedIndexBackend[]): IndexRead {
  const vector = backends.find(b => b.capabilities.search)
  const graph = backends.find(b => b.capabilities.graph)
  return {
    capabilities: {
      search: vector !== undefined,
      graph: graph !== undefined,
    },
    async search(queryText, queryTerms, topK) {
      if (vector === undefined) return []
      return vector.search(queryText, queryTerms, topK)
    },
    async graphNeighbors(entityId, relationWhitelist) {
      if (graph === undefined) return []
      return graph.graphNeighbors(entityId, relationWhitelist)
    },
    async graphFactIds(entityId, topK) {
      if (graph === undefined) return []
      return graph.graphFactIds(entityId, topK)
    },
  }
}
