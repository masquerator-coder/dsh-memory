/**
 * Entity card domain types — the aggregation of an entity's atomic facts into
 * a structured profile (design §3.13 / §8.3): the card is the read model the
 * system uses; `user.md` is one renderable export of it.
 *
 * A card groups an entity's active, retrieval-visible facts by canonical
 * predicate, and exposes a deterministic summary (the first-class lines that
 * fit a token budget) for cheap injection. Cards are pure read models — they
 * are recomputed on demand and never stored, so they can neither drift from
 * the underlying facts nor be edited independently.
 *
 * @module dsh-memory/domain/card
 */
import type { AtomicFact, ProceduralStep } from './fact.ts'

/** A single grouped fact within a card, aligned to the user.md line model. */
export interface CardFact {
  readonly id: string
  /** Canonical predicate (the group key). */
  readonly predicate: string
  /** Human-readable predicate label (from the registry synonym entry). */
  readonly label: string
  /** The fact's natural-language content, as rendered in the view. */
  readonly content: string
  readonly confidence: number
  readonly privacy: AtomicFact['privacy']
  readonly pii: boolean
  readonly type: AtomicFact['type']
  readonly updated_at: number
  /** Procedural payload (P2-3), present only for procedural facts. */
  readonly steps?: readonly ProceduralStep[]
  readonly tool_chain?: readonly string[]
}

/** One predicate group of an entity card. */
export interface CardGroup {
  readonly predicate: string
  readonly title: string
  /** Facts in this group, ordered by confidence then recency (desc). */
  readonly facts: CardFact[]
}

/** Options accepted by the card aggregation engine. */
export interface CardOptions {
  /** Only facts at or above this privacy tier (subset-preserving). */
  readonly privacy?: readonly AtomicFact['privacy'][]
  /** Cap on the number of summary lines. */
  readonly summaryMax?: number
  /** Cap on the summary's estimated token footprint (design §8.5: ≤200). */
  readonly summaryTokens?: number
  /** Exclude facts flagged as PII from the rendered card (default true). */
  readonly redactPii?: boolean
}

/**
 * A fully-aggregated entity card. `summary` is the deterministic headline set
 * (fits `summaryTokens`), `groups` is the full per-predicate breakdown.
 */
export interface EntityCard {
  readonly entityId: string
  readonly entityName: string
  readonly entityType: string
  /** Epoch ms of the newest fact contributing to the card. */
  readonly updatedAt: number
  readonly count: number
  readonly summary: string[]
  readonly groups: CardGroup[]
}

/** Estimate the token footprint of a word/CJK-ish line (shared, rough). */
export function lineTokens(line: string): number {
  return Math.ceil(line.length / 4)
}
