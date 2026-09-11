/**
 * Application-layer ports. `application` depends on these interfaces, not on a
 * concrete store, honoring the design dependency rule (infrastructure
 * implements repository interfaces; application never imports infrastructure).
 *
 * @module dsh-memory/application/ports
 */
import type { AtomicFact, FactUpdate, PrivacyLevel, FactType } from '../domain/fact.ts'

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
