import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/domain/fact.d.ts
/** Memory type — decides retrieval source, forgetting policy, and sort weight. */
type FactType = 'semantic' | 'episodic' | 'procedural' | 'working';
/** Lifecycle status of a fact. */
type FactStatus = 'active' | 'superseded' | 'archived' | 'expired' | 'pending_review' | 'pending_indexing' | 'index_failed';
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
  readonly index_state: 'ready' | 'pending_indexing' | 'index_failed';
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
/** Retrieval budget — the hard cost floors a recall may work within. */
interface RetrievalPolicy {
  readonly topK: number;
  readonly maxTokens: number;
  /** Hard ceiling on synchronous recall, ms (degrade after this). */
  readonly timeoutMs: number;
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
/** The flat resolved policy object for one deployment. */
interface MemoryPolicy {
  readonly profile: string;
  readonly retrieval: RetrievalPolicy;
  readonly extraction: ExtractionPolicy;
  readonly forgetting: ForgettingPolicy;
  readonly privacy: PrivacyPolicy;
  readonly consolidation: ConsolidationPolicy;
}
//#endregion
//#region src/application/ports.d.ts
/** Filter applied to recall candidates before ranking. */
interface FactFilter {
  readonly scope?: string;
  readonly status?: readonly string[];
  readonly privacy?: readonly PrivacyLevel[];
  readonly pii?: boolean;
  /** Only facts whose type is in this set. */
  readonly types?: readonly FactType[];
  /** Only facts not expired as of this epoch ms. */
  readonly now?: number;
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
  /** Scope ids that have seen writes — drives the background consolidate sweep. */
  private readonly scopes;
  constructor(options: MemoryServiceOptions);
  policy(): MemoryPolicy;
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
   * scope facts when the store is slow, never throwing.
   */
  recall(query: RecallQuery): Promise<ScoredMemory[]>;
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
   * The session/event entry point: fast-channel capture, then background
   * extraction + storage (enqueued, never blocking the caller).
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
  /** Observability metrics (design §11). */
  metrics(): Promise<{
    stored: number;
    active: number;
  }>;
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