/**
 * Remember engine — the write path. Applies the design's dedup / conflict /
 * supersede rules before persisting, so the store never silently drops facts:
 * a same-semantic-key assertion becomes a version bump (supersede), never an
 * unreported overwrite.
 *
 * Per-scope ordering: caller serializes per scope (see queue) to keep a
 * supersede chain deterministic (§12.1).
 *
 * @module dsh-memory/application/remember
 */
import type { AtomicFact, FactSource, FactType, MemoryEvent } from '../domain/fact.ts'
import type { EntityResolver } from '../domain/entity.ts'
import { buildFact, supersedeFact, type RawAssertion } from '../domain/factory.ts'
import type { ForgettingPolicy } from '../domain/policies.ts'
import type { MemoryRepository } from './ports.ts'

/** How a raw assertion resolved against the existing store. */
export interface StoreOutcome {
  readonly stored: AtomicFact
  /** Id of the fact this one superseded, when any. */
  readonly superseded?: string
  /** Id of an existing same-key fact we kept instead. */
  readonly retained?: string
  readonly events: MemoryEvent[]
}

export interface RememberDeps {
  readonly repo: MemoryRepository
  readonly resolver: EntityResolver
  readonly forgetting: ForgettingPolicy
  readonly defaultPrivacy: AtomicFact['privacy']
}

/**
 * Higher take-precedence comparison for same-semantic-key conflicts.
 * `user_edit` (credibility 1.0) beats everything; then higher credibility,
 * then higher confidence, then more recent updated_at.
 */
function incomingWins(incoming: AtomicFact, existing: AtomicFact): boolean {
  const inCred = incoming.source.credibility
  const exCred = existing.source.credibility
  if (inCred !== exCred) return inCred > exCred
  if (incoming.confidence !== existing.confidence) return incoming.confidence > existing.confidence
  return incoming.updated_at >= existing.updated_at
}

/** Build a complete fact from a raw assertion, using the shared deps. */
function build(deps: RememberDeps, input: RawAssertion): AtomicFact {
  return buildFact(input, {
    resolver: deps.resolver,
    forgetting: deps.forgetting,
    defaultPrivacy: deps.defaultPrivacy,
  })
}

/** Store one raw assertion with conflict resolution. Returns the outcome. */
export async function rememberOne(
  deps: RememberDeps,
  input: RawAssertion,
): Promise<StoreOutcome> {
  const built = build(deps, input)
  const existing = await deps.repo.latestBySemanticKey(built.semantic_key)

  // No conflict: brand-new assertion.
  if (existing === undefined) {
    await deps.repo.put(built)
    return { stored: built, events: [{ kind: 'fact_stored', factId: built.id, scope: built.scope }] }
  }

  // Same semantic key exists. Only supersede when both are active and the
  // incoming assertion genuinely displaces it; otherwise keep the winner.
  if (incomingWins(built, existing)) {
    const next = supersedeFact(existing, input, {
      resolver: deps.resolver,
      forgetting: deps.forgetting,
      defaultPrivacy: deps.defaultPrivacy,
    })
    // Mark the old one superseded in the store before writing the new version.
    await deps.repo.put({ ...existing, status: 'superseded', updated_at: next.updated_at })
    await deps.repo.put(next)
    return {
      stored: next,
      superseded: existing.id,
      events: [
        { kind: 'fact_superseded', factId: existing.id, byFactId: next.id, scope: existing.scope },
        { kind: 'fact_stored', factId: next.id, scope: next.scope },
      ],
    }
  }

  // Existing wins; keep it and report retention (no-op store).
  return {
    stored: existing,
    retained: existing.id,
    events: [],
  }
}

/** Source credibility is carried on the fact; this is a typed accessor. */
export function sourceCredibility(source: FactSource): number {
  return source.credibility
}
