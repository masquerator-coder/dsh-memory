/**
 * Policy types — configuration-driven, shared across personal / research
 * profiles. Policies are plain data derived from plugin Config, never hardcoded
 * behavior, so a deployment can switch Profile without changing code.
 *
 * @module dsh-memory/domain/policies
 */
import type { FactType, PrivacyLevel } from './fact.ts'

/** Retrieval budget — the hard cost floors a recall may work within. */
export interface RetrievalPolicy {
  readonly topK: number
  readonly maxTokens: number
  /** Hard ceiling on synchronous recall, ms (degrade after this). */
  readonly timeoutMs: number
  readonly graph: {
    readonly maxDepth: number
    readonly maxSeedEntities: number
    readonly maxFanoutPerEntity: number
    readonly maxCandidates: number
    readonly relationWhitelist: readonly string[]
  }
  readonly ranking: {
    readonly w1: number // relevance
    readonly w2: number // confidence
    readonly w3: number // credibility
    readonly w4: number // recency
    readonly w5: number // graph_score
  }
}

/** Extraction / fast-channel policy. */
export interface ExtractionPolicy {
  readonly model?: string
  readonly provider?: string
  readonly maxTokens: number
  readonly batchWindowMs: number
  /** When LLM is unavailable, keep raw events (never drop facts silently). */
  readonly fallback: 'store_raw_event' | 'ignore'
  readonly selfContainmentCheck: {
    readonly enabled: boolean
    readonly timeoutMs: number
  }
  /** Fast-channel rule triggers (memory verbs). */
  readonly triggers: readonly string[]
  /** Confidence assigned to rule-captured (not LLM) facts. */
  readonly ruleConfidence: number
}

/** Forgetting policy per memory type. */
export interface ForgettingPolicy {
  readonly semantic: { readonly ttl: string | null; readonly lambda: number }
  readonly episodic: { readonly ttl: string | null; readonly lambda: number }
  readonly procedural: { readonly ttl: string | null; readonly lambda: number }
  readonly working: { readonly ttl: string | null; readonly lambda: number }
}

/** Privacy policy. */
export interface PrivacyPolicy {
  readonly default: PrivacyLevel
  /** Privacy levels a plain retrieval may return. */
  readonly retrievalFilter: readonly PrivacyLevel[]
  readonly secretRequiresExplicitAuth: boolean
  readonly piiRedaction: boolean
}

/** Consolidation schedule (P0: expiry sweep only). */
export interface ConsolidationPolicy {
  readonly incrementalIntervalMs: number
  readonly batchSize: number
  readonly enabled: boolean
}

/**
 * Outbox / Saga indexing policy (design §7.2) — how the IndexWorker keeps the
 * derived backends consistent and whether recall honors the index barrier.
 */
export interface IndexingPolicy {
  /** Master switch: emit outbox entries and run the worker. */
  readonly enabled: boolean
  /** Worker pull interval, ms. */
  readonly pollIntervalMs: number
  /** Exponential-backoff config for retrying outbox entries. */
  readonly backoff: { readonly maxRetries: number; readonly baseMs: number; readonly factor: number; readonly capMs: number }
  /**
   * When true, recall only reads facts whose `index_state` is `ready`. Effective
   * only when at least one derived backend is registered; with none it is forced
   * off so a backend-free deployment behaves exactly as before (all facts `ready`).
   */
  readonly requireReadyIndex: boolean
}

/** The flat resolved policy object for one deployment. */
export interface MemoryPolicy {
  readonly profile: string
  readonly retrieval: RetrievalPolicy
  readonly extraction: ExtractionPolicy
  readonly forgetting: ForgettingPolicy
  readonly privacy: PrivacyPolicy
  readonly consolidation: ConsolidationPolicy
  readonly indexing: IndexingPolicy
}

/** Expiry computation — a fact is expired once its expires_at has passed. */
export function isExpired(fact: { readonly expires_at?: number | null }, now: number): boolean {
  return fact.expires_at !== null && fact.expires_at !== undefined && now >= fact.expires_at
}

/**
 * Exponential time decay, mapping an age to a recency score in (0,1].
 *   recency_score = exp(-lambda * ageDays)
 * Semantic memory barely decays (tiny lambda); episodic decays faster.
 */
export function recencyScore(lambda: number, ageMs: number): number {
  if (ageMs <= 0) return 1
  const ageDays = ageMs / 86_400_000
  return Math.exp(-lambda * ageDays)
}

/** Parse an ISO-like TTL string (`180d`, `12h`, `30m`, `1y`) into milliseconds. */
export function parseTtlMs(ttl: string | null | undefined): number | null {
  if (ttl === null || ttl === undefined || ttl === '') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)\s*$/i.exec(ttl)
  if (match === null) {
    // Tolerate plain day count.
    const days = Number(ttl)
    if (Number.isFinite(days)) return days * 86_400_000
    return null
  }
  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const perUnit: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  }
  return amount * perUnit[unit]
}

/** Default thresholds used by the fuzzy entity merger when none are given. */
export const DEFAULT_FUZZY_THRESHOLD = 0.9
