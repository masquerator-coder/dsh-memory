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
export interface CanonicalEntity {
  /** Namespaced canonical id, e.g. `user:alice`. */
  readonly id: string
  /** Entity type namespace, e.g. `user`. */
  readonly type: string
  /** Display name. */
  readonly name: string
  /** All renderings (aliases) that resolve here. */
  readonly aliases: readonly string[]
}

export interface ResolvedEntity {
  /** What the caller supplied, for provenance. */
  readonly mention: string
  /** Resolved canonical id, or `nil:<hash>` when unresolvable. */
  readonly id: string
  /** Resolution confidence 0..1. */
  readonly confidence: number
  readonly status: 'resolved' | 'fuzzy' | 'unknown'
}

export interface ResolveOptions {
  /** Restrict matching to one type namespace, e.g. `user`. */
  readonly type?: string
  /** Optional fuzzy matcher; when absent, only exact equality is used. */
  readonly fuzzyMatch?: (a: string, b: string) => number
  /** Minimum fuzzy score to auto-merge (default 0.9). */
  readonly threshold?: number
}

/** Levenshtein-distance based similarity in [0,1]; 1 = identical. */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev.splice(0, prev.length, ...curr)
  }
  const distance = prev[b.length]
  return 1 - distance / Math.max(a.length, b.length)
}

/**
 * Deterministic alias-based entity index. Holds per-type canonical entities
 * and resolves mentions without external dependencies.
 */
export class EntityResolver {
  private readonly byId = new Map<string, CanonicalEntity>()
  private readonly byType = new Map<string, Map<string, CanonicalEntity>>()

  /** Register or update one canonical entity (and its aliases). */
  upsert(entity: CanonicalEntity): void {
    this.byId.set(entity.id, entity)
    let typed = this.byType.get(entity.type)
    if (typed === undefined) {
      typed = new Map()
      this.byType.set(entity.type, typed)
    }
    typed.set(entity.id, entity)
  }

  /** Merge another resolver's entities into this one. */
  loadAll(entities: Iterable<CanonicalEntity>): void {
    for (const entity of entities) this.upsert(entity)
  }

  /** All canonical ids currently known. */
  ids(): IterableIterator<CanonicalEntity> {
    return this.byId.values()
  }

  /** Look up a canonical entity by canonical id. */
  byCanonicalId(id: string): CanonicalEntity | undefined {
    return this.byId.get(id)
  }

  /** Exact alias-table resolution (case-insensitive, normalized). */
  resolveExact(mention: string, type?: string): CanonicalEntity | undefined {
    const norm = normalizeMention(mention)
    for (const entity of this.byId.values()) {
      if (type !== undefined && entity.type !== type) continue
      if (entity.id.toLowerCase() === norm || entity.aliases.some(a => normalizeMention(a) === norm)) {
        return entity
      }
    }
    return undefined
  }

  /**
   * Resolve a mention following the deterministic path. Returns `unknown`
   * rather than throwing so extraction can degrade under missing dictionary
   * entries; a caller that needs a strict id should handle `status`.
   */
  resolve(mention: string, options: ResolveOptions = {}): ResolvedEntity {
    const exact = this.resolveExact(mention, options.type)
    if (exact !== undefined) return { mention, id: exact.id, confidence: 1, status: 'resolved' }

    if (options.fuzzyMatch !== undefined && options.type !== undefined) {
      const threshold = options.threshold ?? 0.9
      let best: { entity: CanonicalEntity; score: number } | undefined
      const typed = this.byType.get(options.type)
      if (typed !== undefined) {
        for (const entity of typed.values()) {
          const score = options.fuzzyMatch(normalizeMention(mention), normalizeMention(entity.name))
          if (score >= threshold && (best === undefined || score > best.score)) best = { entity, score }
        }
      }
      if (best !== undefined) {
        return { mention, id: best.entity.id, confidence: best.score, status: 'fuzzy' }
      }
    }

    return { mention, id: `nil:${hashMention(mention)}`, confidence: 0, status: 'unknown' }
  }
}

/** Lowercase + collapse whitespace. */
export function normalizeMention(mention: string): string {
  return mention.trim().replace(/[\s]+/g, ' ').toLowerCase()
}

// Pure JS stable hash (djb2) so `nil:` ids are reproducible without crypto.
function hashMention(mention: string): string {
  let hash = 5381
  const norm = normalizeMention(mention)
  for (let i = 0; i < norm.length; i += 1) {
    hash = ((hash << 5) + hash + norm.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}
