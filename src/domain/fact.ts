/**
 * Atomic fact domain model — the single minimal data contract of the memory
 * system. Every memory — semantic, episodic, procedural — degrades to an
 * atomic fact. See `docs/atomic-fact.md` for the model's rationale.
 *
 * @module dsh-memory/domain/fact
 */

/** Schema version stamped into every fact; bump on breaking model changes. */
export const SCHEMA_VERSION = '1.0'

/** Memory type — decides retrieval source, forgetting policy, and sort weight. */
export type FactType = 'semantic' | 'episodic' | 'procedural' | 'working'

/** Lifecycle status of a fact. */
export type FactStatus =
  | 'active'
  | 'superseded'
  | 'archived'
  | 'expired'
  | 'pending_review'
  | 'pending_indexing'
  | 'index_failed'

/** Privacy tier — decides default retrieval filter and redaction. */
export type PrivacyLevel = 'public' | 'private' | 'confidential' | 'secret'

/** Where a fact came from; drives source credibility. */
export type SourceType = 'conversation' | 'user_edit' | 'tool_result' | 'llm_infer' | 'external_doc'

/** One end of the canonical subject—predicate—object core of a fact. */
export interface FactEntity {
  /** Namespaced canonical type, e.g. `user`, `project`, `concept`, `diet`. */
  readonly type: string
  /** Canonical id within the type namespace, e.g. `user:alice`. */
  readonly id: string
  /** Best display name. */
  readonly name: string
  /** Alternate renderings that resolve to this canonical id. */
  readonly aliases?: readonly string[]
}

/** Source attribution of a fact (research agents depend on this). */
export interface FactSource {
  readonly type: SourceType
  /** Origin identifier, e.g. `session:<id>` or `user.md`. */
  readonly uri?: string
  /** Extracting model/author when known. */
  readonly extracted_by?: string
  /** Source credibility 0..1; `user_edit` is always 1.0. */
  readonly credibility: number
}

/** Procedural fact steps (P1 program memory shape; P0 stores steps as content). */
export interface ProceduralStep {
  readonly id: string
  readonly tool: string
  readonly depends_on?: readonly string[]
  readonly parallel_group?: string | null
  readonly on_failure?: 'abort' | 'rollback' | 'continue'
  readonly retry?: { readonly max?: number; readonly backoff?: 'fixed' | 'exponential' }
  readonly rollback?: string | null
}

/** Qualifiers that constrain a fact to avoid over-generalization. */
export interface FactQualifiers {
  /** RFC3339 or date string the assertion became valid. */
  readonly valid_from?: string | null
  /** RFC3339 or date string the assertion ceased to be valid. */
  readonly valid_to?: string | null
  readonly location?: string
  readonly context?: string
  readonly condition?: string
  /** Episodic facts: when the event happened. */
  readonly event_time?: string
  /** Additional, non-key qualifiers carried verbatim. */
  readonly [extra: string]: unknown
}

/** Fully-expanded atomic fact as persisted (P0). */
export interface AtomicFact {
  readonly schema_version: string
  readonly id: string
  readonly subject: FactEntity
  readonly predicate: string
  /** Normalized predicate (see predicate registry). */
  readonly canonical_predicate: string
  readonly object: FactEntity
  readonly qualifiers?: FactQualifiers
  /** Stable dedup key — same semantic_key ⇒ same assertion. */
  readonly semantic_key: string
  /** Natural-language rendering injected into the prompt. */
  readonly content: string
  readonly type: FactType
  /** Isolation boundary, e.g. a conversation/session id. */
  readonly scope: string
  readonly source: FactSource
  /** Procedural memories (P2): ordered execution steps (§3.12). */
  readonly steps?: readonly ProceduralStep[]
  /** Preconditions that must hold before the procedure runs. */
  readonly preconditions?: readonly string[]
  /** Projection of `steps[*].tool` for cheap retrieval, when steps are set. */
  readonly tool_chain?: readonly string[]
  /** Historical success rate 0..1, when known. */
  readonly success_rate?: number
  readonly confidence: number
  readonly version: number
  readonly supersedes?: string
  readonly status: FactStatus
  readonly privacy: PrivacyLevel
  readonly pii: boolean
  /** Time-to-live; ISO duration string like `180d`, or null for no expiry. */
  readonly ttl?: string | null
  readonly entities: readonly string[]
  readonly tags?: readonly string[]
  readonly index_state: 'ready' | 'pending_indexing' | 'index_failed'
  /** Unix epoch ms when the fact was first stored. */
  readonly created_at: number
  /** Unix epoch ms of the last version bump. */
  readonly updated_at: number
  /** Unix epoch ms when the fact expires, when ttl is set. */
  readonly expires_at?: number | null
}

/** The subset of a fact a consumer may update through a version bump. */
export interface FactUpdate {
  readonly content?: string
  readonly confidence?: number
  readonly qualifiers?: FactQualifiers
  readonly object?: FactEntity
}

/** One emitted domain event (see docs/events.md). */
export type MemoryEvent =
  | { readonly kind: 'fact_stored'; readonly factId: string; readonly scope: string }
  | { readonly kind: 'fact_superseded'; readonly factId: string; readonly byFactId: string; readonly scope: string }
  | { readonly kind: 'fact_archived'; readonly factId: string; readonly scope: string }
  | { readonly kind: 'fact_expired'; readonly factId: string; readonly scope: string }
  | { readonly kind: 'consolidate_requested'; readonly scope: string }
