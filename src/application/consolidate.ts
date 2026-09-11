/**
 * Consolidate engine — async, P0 scope: expiry sweep + same-key dedup merge.
 * Runs on a timer (see service). Each pass is interruptible by budget; a pass
 * never blocks the synchronous recall/remember path.
 *
 * Design §5.3 (deferral of entity-card aggregation, summarization, and schema
 * migration to P1+).
 *
 * @module dsh-memory/application/consolidate
 */
import type { AtomicFact, MemoryEvent } from '../domain/fact.ts'
import { isExpired } from '../domain/policies.ts'
import type { MemoryRepository } from './ports.ts'

export interface ConsolidateReport {
  readonly expired: number
  readonly merged: number
  readonly events: MemoryEvent[]
  /** Facts this pass moved out of `active` — callers should cascade-unindex. */
  readonly inactivated: readonly { readonly factId: string; readonly scope: string }[]
}

/**
 * Expire facts whose ttl elapsed in one scope and merge duplicate semantic
 * keys (marking the lower-confidence / older duplicate `superseded`).
 */
export async function consolidateScope(
  repo: MemoryRepository,
  scope: string,
  now = Date.now(),
  budget = 500,
): Promise<ConsolidateReport> {
  const events: MemoryEvent[] = []
  const inactivated: { factId: string; scope: string }[] = []
  let expired = 0
  let merged = 0
  const facts = await repo.listScope(scope)

  let processed = 0
  for (const fact of facts) {
    if (processed >= budget) break
    processed += 1
    if (fact.status !== 'active') continue
    if (isExpired(fact, now)) {
      await repo.put({ ...fact, status: 'expired', updated_at: now })
      expired += 1
      inactivated.push({ factId: fact.id, scope: fact.scope })
      events.push({ kind: 'fact_expired', factId: fact.id, scope: fact.scope })
      continue
    }
    // Same-key merge: if an active version with a higher version exists for the
    // same semantic key, mark the older one superseded.
    const latest = await repo.latestBySemanticKey(fact.semantic_key)
    if (latest !== undefined && latest.id !== fact.id && latest.status === 'active'
      && latest.version > fact.version) {
      await repo.put({ ...fact, status: 'superseded', updated_at: now })
      merged += 1
      inactivated.push({ factId: fact.id, scope: fact.scope })
      events.push({ kind: 'fact_superseded', factId: fact.id, byFactId: latest.id, scope: fact.scope })
    }
  }
  return { expired, merged, events, inactivated }
}

/** Type-only re-export so callers can annotate sweeps. */
export type { AtomicFact }
