import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/domain/fact.d.ts
/** Memory type — decides retrieval source, forgetting policy, and sort weight. */
type FactType = 'semantic' | 'episodic' | 'procedural' | 'working';
/** Lifecycle status of a fact. */
type FactStatus = 'active' | 'superseded' | 'archived' | 'expired' | 'pending_review' | 'pending_indexing' | 'index_failed';
/** Derived-index consistency state of a fact (§7.2). */
type IndexState = 'ready' | 'pending_indexing' | 'index_failed';
/** Privacy tier — decides default retrieval filter and redaction. */
type PrivacyLevel = 'public' | 'private' | 'confidential' | 'secret';
/** Where a fact came from; drives source credibility. */
type SourceType = 'conversation' | 'user_edit' | 'tool_result' | 'llm_infer' | 'external_doc';
/** One end of the canonical subject—predicate—object core of a fact. */
interface FactEntity {
  /** Namespaced canonical type, e.g. `user`, `project`, `concept`, `diet`. */
  readonly type: string;
  /** Canonical id within the type namespace, e.g. `user:alice`. */
  readonly id: string;
  /** Best display name. */
  readonly name: string;
  /** Alternate renderings that resolve to this canonical id. */
  readonly aliases?: readonly string[];
}
/** Source attribution of a fact (research agents depend on this). */
interface FactSource {
  readonly type: SourceType;
  /** Origin identifier, e.g. `session:<id>` or `user.md`. */
  readonly uri?: string;
  /** Extracting model/author when known. */
  readonly extracted_by?: string;
  /** Source credibility 0..1; `user_edit` is always 1.0. */
  readonly credibility: number;
}
/** Procedural fact steps (P1 program memory shape; P0 stores steps as content). */
interface ProceduralStep {
  readonly id: string;
  readonly tool: string;
  readonly depends_on?: readonly string[];
  readonly parallel_group?: string | null;
  readonly on_failure?: 'abort' | 'rollback' | 'continue';
  readonly retry?: {
    readonly max?: number;
    readonly backoff?: 'fixed' | 'exponential';
  };
  readonly rollback?: string | null;
}
/** Qualifiers that constrain a fact to avoid over-generalization. */
interface FactQualifiers {
  /** RFC3339 or date string the assertion became valid. */
  readonly valid_from?: string | null;
  /** RFC3339 or date string the assertion ceased to be valid. */
  readonly valid_to?: string | null;
  readonly location?: string;
  readonly context?: string;
  readonly condition?: string;
  /** Episodic facts: when the event happened. */
  readonly event_time?: string;
  /** Additional, non-key qualifiers carried verbatim. */
  readonly [extra: string]: unknown;
}
/** Fully-expanded atomic fact as persisted (P0). */
interface AtomicFact {
  readonly schema_version: string;
  readonly id: string;
  readonly subject: FactEntity;
  readonly predicate: string;
  /** Normalized predicate (see predicate registry). */
  readonly canonical_predicate: string;
  readonly object: FactEntity;
  readonly qualifiers?: FactQualifiers;
  /** Stable dedup key — same semantic_key ⇒ same assertion. */
  readonly semantic_key: string;
  /** Natural-language rendering injected into the prompt. */
  readonly content: string;
  readonly type: FactType;
  /** Isolation boundary, e.g. a conversation/session id. */
  readonly scope: string;
  readonly source: FactSource;
  /** Procedural memories (P2): ordered execution steps (§3.12). */
  readonly steps?: readonly ProceduralStep[];
  /** Preconditions that must hold before the procedure runs. */
  readonly preconditions?: readonly string[];
  /** Projection of `steps[*].tool` for cheap retrieval, when steps are set. */
  readonly tool_chain?: readonly string[];
  /** Historical success rate 0..1, when known. */
  readonly success_rate?: number;
  readonly confidence: number;
  readonly version: number;
  readonly supersedes?: string;
  readonly status: FactStatus;
  readonly privacy: PrivacyLevel;
  readonly pii: boolean;
  /** Time-to-live; ISO duration string like `180d`, or null for no expiry. */
  readonly ttl?: string | null;
  readonly entities: readonly string[];
  readonly tags?: readonly string[];
  readonly index_state: IndexState;
  /** Unix epoch ms when the fact was first stored. */
  readonly created_at: number;
  /** Unix epoch ms of the last version bump. */
  readonly updated_at: number;
  /** Unix epoch ms when the fact expires, when ttl is set. */
  readonly expires_at?: number | null;
}
/** One emitted domain event (see docs/events.md). */
type MemoryEvent = {
  readonly kind: 'fact_stored';
  readonly factId: string;
  readonly scope: string;
} | {
  readonly kind: 'fact_superseded';
  readonly factId: string;
  readonly byFactId: string;
  readonly scope: string;
} | {
  readonly kind: 'fact_archived';
  readonly factId: string;
  readonly scope: string;
} | {
  readonly kind: 'fact_expired';
  readonly factId: string;
  readonly scope: string;
} | {
  readonly kind: 'consolidate_requested';
  readonly scope: string;
};
//#endregion
//#region src/config.d.ts
interface Config {
  /** Where facts persist (JSON document). Empty string → in-memory only. */
  dataFile?: string;
  /** Path to the rendered `user.md` view (design §8). Empty → not persisted. */
  userMdFile?: string;
  profile?: string;
  /** Whether to inject recalled facts as system context each step. */
  injectContext?: boolean;
  /** Whether the session/event fast-channel capture is enabled. */
  captureEnabled?: boolean;
  /** Whether session/event capture may call the LLM for extraction. */
  llmExtractionEnabled?: boolean;
  retrieval?: {
    topK?: number;
    maxTokens?: number;
    timeoutMs?: number;
    versions?: 'active' | 'all';
    graph?: {
      maxDepth?: number;
      maxSeedEntities?: number;
      maxFanoutPerEntity?: number;
      maxCandidates?: number;
      relationWhitelist?: string[];
    };
    ranking?: {
      w1?: number;
      w2?: number;
      w3?: number;
      w4?: number;
      w5?: number;
    };
  };
  extraction?: {
    provider?: string;
    model?: string;
    maxTokens?: number;
    batchWindowMs?: number;
    fallback?: 'store_raw_event' | 'ignore';
    selfContainmentCheck?: {
      enabled?: boolean;
      timeoutMs?: number;
    };
    triggers?: string[];
    ruleConfidence?: number;
  };
  forgetting?: Partial<Record<FactType, {
    ttl?: string | null;
    lambda?: number;
  }>>;
  privacy?: {
    default?: PrivacyLevel;
    retrievalFilter?: PrivacyLevel[];
    secretRequiresExplicitAuth?: boolean;
    piiRedaction?: boolean;
  };
  consolidation?: {
    enabled?: boolean;
    incrementalIntervalMs?: number;
    batchSize?: number;
  };
  indexing?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    requireReadyIndex?: boolean;
    maxRetries?: number;
    backoffBaseMs?: number;
    backoffFactor?: number;
    backoffCapMs?: number;
  };
}
declare const Config: z<Config>;
//#endregion
//#region src/domain/entity.d.ts
/**
 * Entity resolver — maps entity mentions to canonical namespace-qualified ids
 * via an alias table and type-scoped fuzzy matching.
 *
 *   mention ─▶ ① exact canonical alias match ─▶ ② type-scoped fuzzy
 *                        │                              │
 *                        ▼                              ▼
 *                    canonical id            threshold match → auto merge,
 *                                            else pending_review
 *
 * In P0 the resolver is deterministic and dependency-free (exact + normalized
 * exact matching and optional edit-distance fuzzy). LLM/embedding-based
 * disambiguation is a later seam (`mergeStrategy` hook).
 *
 * @module dsh-memory/domain/entity
 */
/** Canonical entity record held in the alias index. */
interface CanonicalEntity {
  /** Namespaced canonical id, e.g. `user:alice`. */
  readonly id: string;
  /** Entity type namespace, e.g. `user`. */
  readonly type: string;
  /** Display name. */
  readonly name: string;
  /** All renderings (aliases) that resolve here. */
  readonly aliases: readonly string[];
}
interface ResolvedEntity {
  /** What the caller supplied, for provenance. */
  readonly mention: string;
  /** Resolved canonical id, or `nil:<hash>` when unresolvable. */
  readonly id: string;
  /** Resolution confidence 0..1. */
  readonly confidence: number;
  readonly status: 'resolved' | 'fuzzy' | 'unknown';
}
interface ResolveOptions {
  /** Restrict matching to one type namespace, e.g. `user`. */
  readonly type?: string;
  /** Optional fuzzy matcher; when absent, only exact equality is used. */
  readonly fuzzyMatch?: (a: string, b: string) => number;
  /** Minimum fuzzy score to auto-merge (default 0.9). */
  readonly threshold?: number;
}
/**
 * Deterministic alias-based entity index. Holds per-type canonical entities
 * and resolves mentions without external dependencies.
 */
declare class EntityResolver {
  private readonly byId;
  private readonly byType;
  /** Register or update one canonical entity (and its aliases). */
  upsert(entity: CanonicalEntity): void;
  /** Merge another resolver's entities into this one. */
  loadAll(entities: Iterable<CanonicalEntity>): void;
  /** All canonical ids currently known. */
  ids(): IterableIterator<CanonicalEntity>;
  /** Look up a canonical entity by canonical id. */
  byCanonicalId(id: string): CanonicalEntity | undefined;
  /** Exact alias-table resolution (case-insensitive, normalized). */
  resolveExact(mention: string, type?: string): CanonicalEntity | undefined;
  /**
   * Resolve a mention following the deterministic path. Returns `unknown`
   * rather than throwing so extraction can degrade under missing dictionary
   * entries; a caller that needs a strict id should handle `status`.
   */
  resolve(mention: string, options?: ResolveOptions): ResolvedEntity;
}
//#endregion
//#region src/domain/policies.d.ts
/** Which fact versions a recall may read (profile difference §10.2). */
type VersionRetention = 'active' | 'all';
/** Retrieval budget — the hard cost floors a recall may work within. */
interface RetrievalPolicy {
  readonly topK: number;
  readonly maxTokens: number;
  /** Hard ceiling on synchronous recall, ms (degrade after this). */
  readonly timeoutMs: number;
  /** Which versions to consider: personal reads only `active`; research may
   *  read all versions (including `superseded`) for evolution/contradiction. */
  readonly versions: VersionRetention;
  readonly graph: {
    readonly maxDepth: number;
    readonly maxSeedEntities: number;
    readonly maxFanoutPerEntity: number;
    readonly maxCandidates: number;
    readonly relationWhitelist: readonly string[];
  };
  readonly ranking: {
    readonly w1: number;
    readonly w2: number;
    readonly w3: number;
    readonly w4: number;
    readonly w5: number;
  };
}
/** Extraction / fast-channel policy. */
interface ExtractionPolicy {
  readonly model?: string;
  readonly provider?: string;
  readonly maxTokens: number;
  readonly batchWindowMs: number;
  /** When LLM is unavailable, keep raw events (never drop facts silently). */
  readonly fallback: 'store_raw_event' | 'ignore';
  readonly selfContainmentCheck: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
  };
  /** Fast-channel rule triggers (memory verbs). */
  readonly triggers: readonly string[];
  /** Confidence assigned to rule-captured (not LLM) facts. */
  readonly ruleConfidence: number;
}
/** Forgetting policy per memory type. */
interface ForgettingPolicy {
  readonly semantic: {
    readonly ttl: string | null;
    readonly lambda: number;
  };
  readonly episodic: {
    readonly ttl: string | null;
    readonly lambda: number;
  };
  readonly procedural: {
    readonly ttl: string | null;
    readonly lambda: number;
  };
  readonly working: {
    readonly ttl: string | null;
    readonly lambda: number;
  };
}
/** Privacy policy. */
interface PrivacyPolicy {
  readonly default: PrivacyLevel;
  /** Privacy levels a plain retrieval may return. */
  readonly retrievalFilter: readonly PrivacyLevel[];
  readonly secretRequiresExplicitAuth: boolean;
  readonly piiRedaction: boolean;
}
/** Consolidation schedule (P0: expiry sweep only). */
interface ConsolidationPolicy {
  readonly incrementalIntervalMs: number;
  readonly batchSize: number;
  readonly enabled: boolean;
}
/**
 * Outbox / Saga indexing policy (design §7.2) — how the IndexWorker keeps the
 * derived backends consistent and whether recall honors the index barrier.
 */
interface IndexingPolicy {
  /** Master switch: emit outbox entries and run the worker. */
  readonly enabled: boolean;
  /** Worker pull interval, ms. */
  readonly pollIntervalMs: number;
  /** Exponential-backoff config for retrying outbox entries. */
  readonly backoff: {
    readonly maxRetries: number;
    readonly baseMs: number;
    readonly factor: number;
    readonly capMs: number;
  };
  /**
   * When true, recall only reads facts whose `index_state` is `ready`. Effective
   * only when at least one derived backend is registered; with none it is forced
   * off so a backend-free deployment behaves exactly as before (all facts `ready`).
   */
  readonly requireReadyIndex: boolean;
}
/** The flat resolved policy object for one deployment. */
interface MemoryPolicy {
  readonly profile: string;
  /** Typed profile kind (personal / research) — the differences converge here. */
  readonly profileKind: 'personal' | 'research';
  readonly retrieval: RetrievalPolicy;
  readonly extraction: ExtractionPolicy;
  readonly forgetting: ForgettingPolicy;
  readonly privacy: PrivacyPolicy;
  readonly consolidation: ConsolidationPolicy;
  readonly indexing: IndexingPolicy;
}
//#endregion
//#region src/domain/outbox.d.ts
/**
 * Outbox event model — the durable, replay-safe log that guarantees eventual
 * consistency across the plugin's backing stores (design §7.2).
 *
 * Write-path contract: every fact mutation that must be propagated to a derived
 * backend (vector / graph / object) appends one OutboxEntry in the same logical
 * write as the KV main record. A background IndexWorker
 * (`application/index-worker`) applies entries to each registered backend, then
 * marks the fact's `index_state` `ready`. Retries use exponential backoff; a
 * permanently-failing entry graduates to the dead-letter log (DLQ) and the fact
 * is flagged `index_failed` so recall can skip it (§7.2).
 *
 * Idempotency: an entry is keyed by `(op, factId)`, and the backends upsert /
 * remove by fact id, so re-applying an already-handled entry is a no-op —
 * replay is safe without a distributed coordinator (§12.2).
 *
 * @module dsh-memory/domain/outbox
 */
/** What to do to the derived backends for one fact. */
type OutboxOp = 'index' | 'unindex';
type OutboxState = 'pending' | 'done' | 'failed' | 'dead';
interface OutboxEntry {
  readonly id: string;
  readonly op: OutboxOp;
  readonly factId: string;
  readonly scope: string;
  readonly attempts: number;
  readonly state: OutboxState;
  /** Epoch ms after which the worker may retry (exponential backoff). */
  readonly nextAttemptAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}
/** Exponential-backoff configuration for retrying outbox entries. */
interface BackoffPolicy {
  /** How many attempts before an entry graduates to the DLQ. */
  readonly maxRetries: number;
  /** Base delay for the first retry, ms. */
  readonly baseMs: number;
  /** Multiplier per retry (1.X). */
  readonly factor: number;
  /** Hard ceiling on any single delay, ms. */
  readonly capMs: number;
}
//#endregion
//#region src/application/ports.d.ts
/** Filter applied to recall candidates before ranking. */
interface FactFilter {
  readonly scope?: string;
  readonly status?: readonly string[];
  readonly privacy?: readonly PrivacyLevel[];
  /** Selector: only PII-flagged facts. See `excludePii` for the inverse. */
  readonly pii?: boolean;
  /**
   * Drop PII-flagged facts. The model-facing read path sets this: PII is
   * detected and flagged at capture time (§12.7) and must never be
   * auto-injected into the prompt or a tool result.
   */
  readonly excludePii?: boolean;
  /**
   * Drop `secret` facts regardless of the tier list — surfacing them requires
   * explicit authorization (§12.7), which the plugin only models as
   * `privacy.secretRequiresExplicitAuth: false`.
   */
  readonly excludeSecret?: boolean;
  /** Only facts whose type is in this set. */
  readonly types?: readonly FactType[];
  /** Only facts not expired as of this epoch ms. */
  readonly now?: number;
  /**
   * Only facts whose index_state is in this set. Recall requests it as
   * `['ready']` when the deployment has configured pluggable backends and
   * therefore honors the eventual-consistency barrier (design §7.2). When no
   * backend is configured, the service omits this and all facts pass.
   */
  readonly indexState?: readonly IndexState[];
}
interface RecallCandidate {
  readonly fact: AtomicFact;
  /** Textual/semantic relevance in [0,1]. */
  readonly relevance: number;
  /** Whether the fact was reached via graph expansion. */
  readonly viaGraph: boolean;
}
interface StoreStats {
  readonly active: number;
  readonly total: number;
}
/**
 * The durable memory store boundary: KV main records + semantic-key index +
 * adjacency index + lexical embedding. A conforming store also handles
 * persistence and is safe for concurrent read/write within one process.
 */
interface MemoryRepository {
  /** Upsert a complete fact (main record). */
  put(fact: AtomicFact): Promise<void>;
  /** Read one fact by id. */
  get(id: string): Promise<AtomicFact | undefined>;
  /** All facts for a scope. */
  listScope(scope: string): Promise<AtomicFact[]>;
  /**
   * All facts for a scope **plus** the `global` scope (deduplicated). The read
   * side uses this so `global` facts — which are shared across sessions — are
   * never hidden from a session-scoped profile/recall. The plain `listScope` is
   * kept exact-scope so `forgetAll`/consolidation never touch `global`.
   */
  listScopeIncludingGlobal(scope: string): Promise<AtomicFact[]>;
  /** Facts matching a canonical semantic_key. */
  bySemanticKey(key: string): Promise<AtomicFact[]>;
  /** Highest-version fact for a semantic_key (for conflict resolution). */
  latestBySemanticKey(key: string): Promise<AtomicFact | undefined>;
  /** Remove a fact by id (hard delete / tombstone). */
  delete(id: string): Promise<void>;
  /**
   * Find recall candidates by lexical overlap, expanded across the graph.
   * The store returns raw candidates; application ranks and budgets them.
   */
  query(filter: FactFilter, queryTerms: readonly string[], graphSeedIds: readonly string[]): Promise<RecallCandidate[]>;
  /** Adjacent canonical entity ids of a subject/object within depth. */
  neighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>;
  /** Facts whose subject or object is a given canonical entity id. */
  byEntity(entityId: string, filter: FactFilter): Promise<AtomicFact[]>;
  /** Basic counts for health/observability. */
  stats(): Promise<StoreStats>;
  /** Persist in-flight buffers/state (no-op when already flushed on each put). */
  flush?(): Promise<void>;
}
/**
 * Durable, replay-safe outbox the write path appends to (§7.2). Implementations
 * may persist it beside the KV main records. All mutations are serialized; reads
 * may observe a consistent snapshot. Idempotency is guaranteed by keying on
 * `(op, factId)` — appending the same logical change twice is coalesced.
 */
interface OutboxStore {
  /** Record an index/unindex change for a fact (coalesces `(op, factId)`). */
  append(op: OutboxOp, factId: string, scope: string): Promise<void>;
  /** Entries that are pending and whose backoff horizon has passed. */
  pendingDue(now: number, limit: number): Promise<OutboxEntry[]>;
  /** Read one entry (undefined when absent). */
  get(entryId: string): Promise<OutboxEntry | undefined>;
  /** Mark an entry successfully applied. */
  markDone(entryId: string): Promise<OutboxEntry | undefined>;
  /** Record a retryable failure and bump the attempt/backoff. */
  markFailed(entryId: string, error: string, nextAttemptAt: number): Promise<OutboxEntry | undefined>;
  /** Move a permanently-failing entry to the dead-letter log. */
  markDead(entryId: string): Promise<OutboxEntry | undefined>;
  /** Remove an entry entirely (garbage-collect after done / dead). */
  remove(entryId: string): Promise<void>;
  /** Counts for health / observability. */
  stats(): Promise<OutboxStats>;
  /** Drop every entry (tests / scope-wipe). */
  clear(): Promise<void>;
}
interface OutboxStats {
  readonly pending: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
  readonly total: number;
}
/**
 * A pluggable derived index (vector / graph / object stand-in) kept consistent
 * by the IndexWorker. Real providers (HNSW vector DB, Neo4j/Kùzu graph store,
 * object store) implement the same contract; the shipped code ships in-memory
 * implementations so the outbox/Saga machinery is exercised end-to-end without
 * an external dependency (P3 "backends real-ized" later by swapping these).
 */
interface DerivedIndexBackend {
  /** Stable identity, e.g. `vector` / `graph` / `object`. */
  readonly name: string;
  /** Which read capabilities this backend offers (vector search / graph hops). */
  readonly capabilities: IndexCapabilities;
  /** Index a fact (updates by factId; idempotent). */
  upsert(fact: AtomicFact): Promise<void>;
  /** Read-side: semantic/vector recall over indexed facts. */
  search(queryText: string, queryTerms: readonly string[], topK: number): Promise<SearchHit[]>;
  /** Read-side: adjacent canonical entity ids (graph expansion, §7.4). */
  graphNeighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>;
  /** Read-side: fact ids whose subject/object is a canonical entity. */
  graphFactIds(entityId: string, topK: number): Promise<readonly string[]>;
  /** Remove a fact by id (idempotent; no-op when absent). */
  remove(factId: string): Promise<void>;
  /** Optional full rebuild hook (schema migration / model change). */
  rebuild?(facts: AtomicFact[]): Promise<void>;
  /** Whether the backend is reachable / healthy for the worker. */
  health(): {
    ok: boolean;
    detail?: string;
  };
  /** Current entry count (observability). */
  count(): Promise<number>;
}
/** Which read operations a derived backend can serve on the recall path. */
interface IndexCapabilities {
  /** Backend can answer `search` (a real vector store, not just KV fallback). */
  readonly search: boolean;
  /** Backend can answer `graphNeighbors` / `graphFactIds` (a real graph store). */
  readonly graph: boolean;
}
/** One vector-recall hit from a derived backend. */
interface SearchHit {
  readonly factId: string;
  /** Reuse in [0,1]. */
  readonly relevance: number;
}
/**
 * Read-only recall source bound to the derived backends. When a deployment has
 * registered a searchable vector backend and/or graph backend, the service passes
 * this to {@link recall} so the read path genuinely queries the plugin's vector
 * recall and graph expansion stores instead of only the KV's lexical index
 * (P3 "vector/graph storage realized").
 */
interface IndexRead {
  readonly capabilities: IndexCapabilities;
  search(queryText: string, queryTerms: readonly string[], topK: number): Promise<SearchHit[]>;
  graphNeighbors(entityId: string, relationWhitelist: readonly string[]): Promise<readonly string[]>;
  graphFactIds(entityId: string, topK: number): Promise<readonly string[]>;
}
//#endregion
//#region src/domain/factory.d.ts
/** Raw extraction input accepted by the Remember engine / factory. */
interface RawAssertion {
  subject: {
    type: string;
    name: string;
    id?: string;
  };
  predicate: string;
  object: {
    type: string;
    name: string;
    id?: string;
  };
  content: string;
  type: FactType;
  confidence: number;
  /** Procedural payload (P2-3): structured steps / preconditions / tool_chain. */
  steps?: readonly ProceduralStep[];
  preconditions?: readonly string[];
  tool_chain?: readonly string[];
  success_rate?: number;
  qualifiers?: FactQualifiers;
  privacy?: PrivacyLevel;
  pii?: boolean;
  tags?: readonly string[];
  scope: string;
  source: FactSource;
}
//#endregion
//#region src/domain/card.d.ts
/** A single grouped fact within a card, aligned to the user.md line model. */
interface CardFact {
  readonly id: string;
  /** Canonical predicate (the group key). */
  readonly predicate: string;
  /** Human-readable predicate label (from the registry synonym entry). */
  readonly label: string;
  /** The fact's natural-language content, as rendered in the view. */
  readonly content: string;
  readonly confidence: number;
  readonly privacy: AtomicFact['privacy'];
  readonly pii: boolean;
  readonly type: AtomicFact['type'];
  readonly updated_at: number;
  /** Procedural payload (P2-3), present only for procedural facts. */
  readonly steps?: readonly ProceduralStep[];
  readonly tool_chain?: readonly string[];
}
/** One predicate group of an entity card. */
interface CardGroup {
  readonly predicate: string;
  readonly title: string;
  /** Facts in this group, ordered by confidence then recency (desc). */
  readonly facts: CardFact[];
}
/** Options accepted by the card aggregation engine. */
interface CardOptions {
  /** Only facts at or above this privacy tier (subset-preserving). */
  readonly privacy?: readonly AtomicFact['privacy'][];
  /** Cap on the number of summary lines. */
  readonly summaryMax?: number;
  /** Cap on the summary's estimated token footprint (design §8.5: ≤200). */
  readonly summaryTokens?: number;
  /** Exclude facts flagged as PII from the rendered card (default true). */
  readonly redactPii?: boolean;
}
/**
 * A fully-aggregated entity card. `summary` is the deterministic headline set
 * (fits `summaryTokens`), `groups` is the full per-predicate breakdown.
 */
interface EntityCard {
  readonly entityId: string;
  readonly entityName: string;
  readonly entityType: string;
  /** Epoch ms of the newest fact contributing to the card. */
  readonly updatedAt: number;
  readonly count: number;
  readonly summary: string[];
  readonly groups: CardGroup[];
}
//#endregion
//#region src/application/remember.d.ts
/** How a raw assertion resolved against the existing store. */
interface StoreOutcome {
  readonly stored: AtomicFact;
  /** Id of the fact this one superseded, when any. */
  readonly superseded?: string;
  /** Id of an existing same-key fact we kept instead. */
  readonly retained?: string;
  readonly events: MemoryEvent[];
}
//#endregion
//#region src/application/recall.d.ts
interface RecallQuery {
  readonly query: string;
  readonly scope: string;
  readonly topK?: number;
  readonly maxTokens?: number;
  readonly now?: number;
  readonly excludeIds?: readonly string[];
  /**
   * When true, only `index_state = ready` facts are considered (the outward
   * signal of the outbox/Saga eventual-consistency barrier, §7.2). Called by the
   * service with the resolved policy value.
   */
  readonly requireReadyIndex?: boolean;
  /**
   * Optional derived-index read source (P3 vector/graph realization). When a
   * searchable vector backend is available it drives the semantic recall stage;
   * when a graph backend is available it drives graph expansion. Absent (or with
   * no capability), recall falls back to the KV repo's lexical BM25 / adjacency.
   */
  readonly read?: IndexRead;
  /**
   * Drop PII-flagged facts from the result (default `true` — the read path is
   * model-facing and PII is flagged at capture time, §12.7). Set `false` only
   * for an explicit, non-model-facing inspection path.
   */
  readonly excludePii?: boolean;
  /**
   * Drop `secret` facts regardless of the tier list. The service passes the
   * inverse of `privacy.secretRequiresExplicitAuth`.
   */
  readonly excludeSecret?: boolean;
}
interface ScoredMemory {
  readonly fact: AtomicFact;
  readonly score: number;
  readonly relevance: number;
}
//#endregion
//#region src/infrastructure/queue.d.ts
/**
 * In-process serialized task queue, keyed by memory scope.
 *
 * Guarantees the design's ordering invariant (§12.1): a scope's supersede chain
 * is deterministic because one scope's tasks run strictly FIFO and never
 * overlap. Tasks for different scopes may run in parallel up to
 * `maxParallelScopes`. Backpressure (§12.5) drops nothing silently — a queued
 * task is always eventually run unless disposed.
 *
 * @module dsh-memory/infrastructure/queue
 */
interface QueueStats {
  readonly pending: number;
  readonly activeScopes: number;
  readonly errored: number;
}
declare class ScopeQueue {
  private readonly maxParallelScopes;
  private readonly scopes;
  private readonly running;
  private errored;
  constructor(maxParallelScopes?: number);
  /** Enqueue a task for a scope and start a worker when none is active there. */
  enqueue(scope: string, task: () => Promise<void>): void;
  /** Optional discharge for tests: resolve once the given scope drains. */
  whenDrained(scope: string): Promise<void>;
  /** Wait until all scopes are idle (no queued or running tasks). */
  idle(): Promise<void>;
  stats(): QueueStats;
  private pump;
  private work;
}
//#endregion
//#region src/application/index-worker.d.ts
interface IndexWorkerOptions {
  readonly repo: MemoryRepository;
  readonly outbox: OutboxStore;
  readonly backends: DerivedIndexBackend[];
  readonly backoff?: Partial<BackoffPolicy>;
  readonly now?: () => number;
  /** Fired after an entry is applied (success or DLQ) — observability seam. */
  readonly onApplied?: (factId: string, entryId: string, ok: boolean) => void;
}
interface IndexReport {
  attempted: number;
  indexed: number;
  unindexed: number;
  failed: number;
  dead: number;
  skippedUnhealthy: number;
}
declare class IndexWorker {
  private readonly repo;
  private readonly outbox;
  private readonly backends;
  private readonly backoff;
  private readonly now;
  private readonly onApplied?;
  private timer;
  private running;
  constructor(options: IndexWorkerOptions);
  /** Independent-process style: pull-driven single pass over due entries. */
  tick(now?: number, limit?: number): Promise<IndexReport>;
  /** Start a periodic pull loop. Returns a stop function. */
  start(intervalMs: number): () => void;
  stop(): void;
  dispose(): void;
  /** How many derived backends the worker keeps in sync. */
  get backendCount(): number;
  /** Shallow copy of the registered backends (observability / metrics). */
  get backendsSnapshot(): readonly DerivedIndexBackend[];
  /** Whether any target backend is reporting unhealthy (for health checks). */
  degraded(): {
    ok: boolean;
    detail?: string;
  };
  private applyEntry;
  /** One retryable failure: retry with backoff, or graduate to the DLQ + flag failure. */
  private failEntry;
  private markReady;
  private settleDone;
}
//#endregion
//#region src/application/observability.d.ts
/** In-process metrics registry: integer counters + latency histograms. */
declare class Metrics {
  private readonly counters;
  private readonly latencies;
  incr(name: string, n?: number): void;
  /** Record a latency sample (ms) for a metric. */
  record(name: string, ms: number): void;
  counter(name: string): number;
  /** Average latency for a metric, or undefined when no samples. */
  avgMs(name: string): number | undefined;
  /** Immutable snapshot for reporting / serialization. */
  snapshot(): Record<string, number>;
  reset(): void;
}
/** One traced span (a unit of execution along the memory pipeline). */
interface TraceSpan {
  readonly id: string;
  readonly name: string;
  readonly scope?: string;
  readonly factId?: string;
  readonly startAt: number;
  readonly endAt?: number;
  readonly ms?: number;
  readonly ok?: boolean;
  readonly detail?: string;
}
/** Handle returned by {@link TraceBuffer.start}; call {@link finish} to close. */
interface SpanHandle {
  readonly id: string;
  finish(ok: boolean, detail?: string): void;
}
/** Bounded ring of recent execution spans (§12.4 end-to-end trail). */
declare class TraceBuffer {
  private readonly capacity;
  private readonly now;
  private readonly spans;
  private seq;
  constructor(capacity?: number, now?: () => number);
  start(name: string, meta?: {
    scope?: string;
    factId?: string;
  }): SpanHandle;
  /** Most recent spans, newest first, up to `n`. */
  recent(n?: number): readonly TraceSpan[];
  get length(): number;
}
//#endregion
//#region src/service.d.ts
/** Optional LLM extraction callback supplied by the adapter (main LLM never extracts). */
type ExtractFunction = (text: string) => Promise<RawAssertion[]>;
/** One explicit write request from a tool. */
interface RememberInput {
  content: string;
  scope: string;
  subject?: {
    type?: string;
    name?: string;
    id?: string;
  };
  predicate?: string;
  object?: {
    type?: string;
    name?: string;
    id?: string;
  };
  type?: AtomicFact['type'];
  confidence?: number;
  privacy?: AtomicFact['privacy'];
  pii?: boolean;
  source?: {
    uri?: string;
  };
  /** Procedural payload (P2-3): structured steps for `type: 'procedural'`. */
  procedure?: {
    steps?: unknown[];
    preconditions?: string[];
    success_rate?: number;
  };
}
type ForgettingMode = 'archive' | 'delete';
interface ForgetAllReport {
  readonly scope: string;
  readonly deleted: number;
  readonly events: MemoryEvent[];
}
interface Health {
  readonly ok: boolean;
  readonly queue: {
    pending: number;
    activeScopes: number;
    errored: number;
  };
  readonly store: {
    active: number;
    total: number;
  } | undefined;
  readonly llmExtraction: boolean;
  readonly llmAvailable: boolean;
  readonly indexing: {
    readonly enabled: boolean;
    readonly backends: number;
    readonly degraded: boolean;
    readonly detail?: string;
  };
  readonly outbox: {
    pending: number;
    dead: number;
  } | undefined;
}
interface MemoryServiceOptions {
  readonly repo: MemoryRepository;
  readonly resolver: EntityResolver;
  readonly policy: () => MemoryPolicy;
  readonly queue?: ScopeQueue;
  readonly extract?: ExtractFunction;
  /** Master switch for LLM-backed extraction (from config). */
  readonly llmExtractionEnabled: boolean;
  /** Master switch for session fast-channel capture (from config). */
  readonly captureEnabled: boolean;
  /** Outbox journal + IndexWorker (P3 §7.2). When set, writes publish to the
   *  outbox and the worker keeps the pluggable derived backends consistent. */
  readonly outbox?: OutboxStore;
  readonly worker?: IndexWorker;
  /** Observability sinks (design §11). Default to new in-process instances. */
  readonly metrics?: Metrics;
  readonly trace?: TraceBuffer;
  readonly now?: () => number;
  readonly onEvents?: (events: MemoryEvent[]) => void;
}
declare class MemoryService {
  readonly repo: MemoryRepository;
  readonly resolver: EntityResolver;
  private readonly policyRef;
  private readonly queue;
  private readonly extract?;
  private readonly llmExtractionEnabled;
  private readonly captureEnabled;
  private readonly now;
  private readonly onEvents?;
  private readonly outbox?;
  private readonly worker?;
  private readonly metric;
  private readonly trace;
  /** Scope ids that have seen writes — drives the background consolidate sweep. */
  private readonly scopes;
  constructor(options: MemoryServiceOptions);
  policy(): MemoryPolicy;
  /**
   * Whether the deployment uses the outbox/Saga write path: indexing enabled
   * AND at least one pluggable derived backend is registered. With zero backends
   * the behavior is byte-for-byte that of P0 (all facts immediately `ready`).
   */
  get useOutbox(): boolean;
  /** Read source bound to the registered derived backends (P3: recall really
   *  queries vector/graph storage when present). Memoized per policy snapshot. */
  private _indexRead;
  get indexRead(): IndexRead | undefined;
  /** Record a scope that has had activity (for the sweep). */
  recordScope(scope: string): void;
  /** All scopes observed so far. */
  knownScopes(): string[];
  /** Run a consolidate pass over every observed scope. */
  consolidateAll(now?: number): Promise<{
    expired: number;
    merged: number;
  }>;
  private emit;
  /**
   * Synchronous-budget, degradation-safe recall (design §5.2). Returns cached
   * scope facts when the store is slow, never throwing. When the outbox write
   * path is active, only `index_state = ready` facts are read (the
   * eventual-consistency barrier, §7.2).
   */
  recall(query: RecallQuery): Promise<ScoredMemory[]>;
  /**
   * Card options bound to the current policy: one privacy gate shared by the
   * entity card, `read_user_profile`, the rendered `user.md` view, and the
   * `user.md` write-back baseline. Without this the view would hide facts the
   * write-back would then archive as "deleted by the user" (§8.4).
   */
  private cardOptions;
  /**
   * Build the aggregated entity card for one canonical entity (design §3.13).
   * Runs within the retrieval budget; on timeout it degrades to an empty card
   * rather than blocking the caller.
   */
  getCard(entityId: string, options?: CardOptions): Promise<EntityCard>;
  /**
   * Resolve the primary "user" entity id of a scope (most-frequency heuristic)
   * and render its card to the user.md Markdown view (design §8.5). Returns an
   * empty-document string when the scope has no user-typed facts.
   */
  renderUserMd(scope: string): Promise<string>;
  /**
   * Apply an edited user.md document back to the underlying atomic facts
   * (design §8.4): parse → diff → add / supersede / archive. All writes are
   * `source=user_edit` (credibility 1.0) so they always win conflicts.
   * Returns a summary of what was written.
   */
  applyUserMdEdits(scope: string, markdown: string): Promise<{
    added: number;
    superseded: number;
    archived: number;
  }>;
  private userEditAssertion;
  private primaryUserEntityId;
  /** Explicitly remember a fact from raw content (tool path). */
  remember(input: RememberInput): Promise<StoreOutcome>;
  /** Forget one fact: archive (soft) or delete (hard tombstone). */
  forget(factId: string, mode: ForgettingMode): Promise<void>;
  /** Cascade-delete every fact in a scope (design §12.7 forgetting rights). */
  forgetAll(scope: string): Promise<ForgetAllReport>;
  /** Establish a typed relation between two entities (graph edge, §7.4). */
  link(fromId: string, toId: string, relation: string): Promise<StoreOutcome>;
  /** Run a consolidation pass over one scope. */
  consolidate(scope: string): Promise<{
    expired: number;
    merged: number;
  }>;
  /**
   * The session/event entry point (design §4.2 / §6.4 mode B): the fast channel
   * is a **deterministic, zero-LLM gate** — a message is captured only when a
   * configured trigger phrase fires, or when it looks fact-worthy (a
   * number/date/version/entity signal). Everything else is left alone; the
   * accepted capture is handed to the background queue, never blocking the
   * caller.
   *
   * @returns whether the message was accepted for capture.
   */
  extractAndRemember(input: {
    text: string;
    scope: string;
    sourceUri?: string;
  }): {
    accepted: boolean;
  };
  private slowPath;
  /** Health check (design §12.4). */
  health(): Promise<Health>;
  /** Observability metrics (design §11): store + outbox + backends + counters. */
  metrics(): Promise<{
    stored: number;
    active: number;
    outboxPending: number;
    outboxDead: number;
    indexedBackends: Record<string, number>;
    counters: Record<string, number>;
  }>;
  /** Most recent trace spans (design §12.4 end-to-end trail), newest first. */
  traces(n?: number): readonly TraceSpan[];
  /**
   * Run the index worker until the outbox drains (up to `tickLimit` per sweep).
   * Used by tests and by the background loop's manual trigger; safe to no-op when
   * outbox/Saga is not configured.
   */
  drainIndexing(tickLimit?: number): Promise<{
    swept: number;
    remaining: number;
  }>;
  /**
   * Publish a write outcome to the outbox when the Saga write path is active.
   * The stored active fact is flagged `pending_indexing` (so recall skips it until
   * the worker confirms) and an `index` entry is queued; a superseded fact gets an
   * `unindex` entry so its derived copies are removed (§7.2, §7.3).
   */
  private publishOutcome;
  /** Queue an `index` entry and flag an active fact `pending_indexing`. */
  private publishIndexedFact;
  /** Queue a tombstone/unindex entry when the Saga write path is active. */
  private publishUnindex;
  private deps;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-memory";
/** Required services — `llm` is optional (read via ctx.get), logger is builtin. */
declare const inject: readonly ["tools", "systemPrompt"];
/** Type augmentation so `ctx.memory` resolves for consumers. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService;
  }
}
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };