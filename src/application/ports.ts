/**
 * Application-layer ports. `application` depends on these interfaces, not on a
 * concrete store, honoring the design dependency rule (infrastructure
 * implements repository interfaces; application never imports infrastructure).
 *
 * @module dsh-memory/application/ports
 */
import type { AtomicFact, FactUpdate, PrivacyLevel, FactType, IndexState } from '../domain/fact.ts'
import type { OutboxEntry, OutboxOp } from '../domain/outbox.ts'

/** Filter applied to recall candidates before ranking. */
export interface FactFilter {
  readonly scope?: string
  readonly status?: readonly string[]
  readonly privacy?: readonly PrivacyLevel[]
  readonly pii?: boolean
  /** Only facts whose type is in this set. */
  readonly types?: readonly FactType[]
  /** Only facts not expired as of this epoch ms. */
  readonly now?: number
  /**
   * Only facts whose index_state is in this set. Recall requests it as
   * `['ready']` when the deployment has configured pluggable backends and
   * therefore honors the eventual-consistency barrier (design §7.2). When no
   * backend is configured, the service omits this and all facts pass.
   */
  readonly indexState?: readonly IndexState[]
}

export interface RecallCandidate {
  readonly fact: AtomicFact
  /** Textual/semantic relevance in [0,1]. */
  readonly relevance: number
  /** Whether the fact was reached via graph expansion. */
  readonly viaGraph: boolean
}

export interface StoreStats {
  readonly active: number
  readonly total: number
}

/**
 * The durable memory store boundary: KV main records + semantic-key index +
 * adjacency index + lexical embedding. A conforming store also handles
 * persistence and is safe for concurrent read/write within one process.
 */
export interface MemoryRepository {
  /** Upsert a complete fact (main record). */
  put(fact: AtomicFact): Promise<void>
  /** Read one fact by id. */
  get(id: string): Promise<AtomicFact | undefined>
  /** All facts for a scope. */
  listScope(scope: string): Promise<AtomicFact[]>
  /** Facts matching a canonical semantic_key. */
  bySemanticKey(key: string): Promise<AtomicFact[]>
  /** Highest-version fact for a semantic_key (for conflict resolution). */
  latestBySemanticKey(key: string): Promise<AtomicFact | undefined>
  /** Remove a fact by id (hard delete / tombstone). */
  delete(id: string): Promise<void>
  /**
   * Find recall candidates by lexical overlap, expanded across the graph.
   * The store returns raw candidates; application ranks and budgets them.
   */
  query(filter: FactFilter, queryTerms: readonly string[], graphSeedIds: readonly string[]): Promise<RecallCandidate[]>
  /** Adjacent canonical entity ids of a subject/object within depth. */
  neighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>
  /** Facts whose subject or object is a given canonical entity id. */
  byEntity(entityId: string, filter: FactFilter): Promise<AtomicFact[]>
  /** Basic counts for health/observability. */
  stats(): Promise<StoreStats>
  /** Persist in-flight buffers/state (no-op when already flushed on each put). */
  flush?(): Promise<void>
}

/**
 * Durable, replay-safe outbox the write path appends to (§7.2). Implementations
 * may persist it beside the KV main records. All mutations are serialized; reads
 * may observe a consistent snapshot. Idempotency is guaranteed by keying on
 * `(op, factId)` — appending the same logical change twice is coalesced.
 */
export interface OutboxStore {
  /** Record an index/unindex change for a fact (coalesces `(op, factId)`). */
  append(op: OutboxOp, factId: string, scope: string): Promise<void>
  /** Entries that are pending and whose backoff horizon has passed. */
  pendingDue(now: number, limit: number): Promise<OutboxEntry[]>
  /** Read one entry (undefined when absent). */
  get(entryId: string): Promise<OutboxEntry | undefined>
  /** Mark an entry successfully applied. */
  markDone(entryId: string): Promise<OutboxEntry | undefined>
  /** Record a retryable failure and bump the attempt/backoff. */
  markFailed(entryId: string, error: string, nextAttemptAt: number): Promise<OutboxEntry | undefined>
  /** Move a permanently-failing entry to the dead-letter log. */
  markDead(entryId: string): Promise<OutboxEntry | undefined>
  /** Remove an entry entirely (garbage-collect after done / dead). */
  remove(entryId: string): Promise<void>
  /** Counts for health / observability. */
  stats(): Promise<OutboxStats>
  /** Drop every entry (tests / scope-wipe). */
  clear(): Promise<void>
}

export interface OutboxStats {
  readonly pending: number
  readonly done: number
  readonly failed: number
  readonly dead: number
  readonly total: number
}

/**
 * A pluggable derived index (vector / graph / object stand-in) kept consistent
 * by the IndexWorker. Real providers (HNSW vector DB, Neo4j/Kùzu graph store,
 * object store) implement the same contract; the shipped code ships in-memory
 * implementations so the outbox/Saga machinery is exercised end-to-end without
 * an external dependency (P3 "backends real-ized" later by swapping these).
 */
export interface DerivedIndexBackend {
  /** Stable identity, e.g. `vector` / `graph` / `object`. */
  readonly name: string
  /** Which read capabilities this backend offers (vector search / graph hops). */
  readonly capabilities: IndexCapabilities
  /** Index a fact (updates by factId; idempotent). */
  upsert(fact: AtomicFact): Promise<void>
  /** Read-side: semantic/vector recall over indexed facts. */
  search(queryText: string, queryTerms: readonly string[], topK: number): Promise<SearchHit[]>
  /** Read-side: adjacent canonical entity ids (graph expansion, §7.4). */
  graphNeighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>
  /** Read-side: fact ids whose subject/object is a canonical entity. */
  graphFactIds(entityId: string, topK: number): Promise<readonly string[]>
  /** Remove a fact by id (idempotent; no-op when absent). */
  remove(factId: string): Promise<void>
  /** Optional full rebuild hook (schema migration / model change). */
  rebuild?(facts: AtomicFact[]): Promise<void>
  /** Whether the backend is reachable / healthy for the worker. */
  health(): { ok: boolean; detail?: string }
  /** Current entry count (observability). */
  count(): Promise<number>
}

/** Which read operations a derived backend can serve on the recall path. */
export interface IndexCapabilities {
  /** Backend can answer `search` (a real vector store, not just KV fallback). */
  readonly search: boolean
  /** Backend can answer `graphNeighbors` / `graphFactIds` (a real graph store). */
  readonly graph: boolean
}

/** One vector-recall hit from a derived backend. */
export interface SearchHit {
  readonly factId: string
  /** Reuse in [0,1]. */
  readonly relevance: number
}

/**
 * Read-only recall source bound to the derived backends. When a deployment has
 * registered a searchable vector backend and/or graph backend, the service passes
 * this to {@link recall} so the read path genuinely queries the plugin's vector
 * recall and graph expansion stores instead of only the KV's lexical index
 * (P3 "vector/graph storage realized").
 */
export interface IndexRead {
  readonly capabilities: IndexCapabilities
  search(queryText: string, queryTerms: readonly string[], topK: number): Promise<SearchHit[]>
  graphNeighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>
  graphFactIds(entityId: string, topK: number): Promise<readonly string[]>
}
