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
export type OutboxOp = 'index' | 'unindex'

export type OutboxState = 'pending' | 'done' | 'failed' | 'dead'

export interface OutboxEntry {
  readonly id: string
  readonly op: OutboxOp
  readonly factId: string
  readonly scope: string
  readonly attempts: number
  readonly state: OutboxState
  /** Epoch ms after which the worker may retry (exponential backoff). */
  readonly nextAttemptAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastError?: string
}

/** Exponential-backoff configuration for retrying outbox entries. */
export interface BackoffPolicy {
  /** How many attempts before an entry graduates to the DLQ. */
  readonly maxRetries: number
  /** Base delay for the first retry, ms. */
  readonly baseMs: number
  /** Multiplier per retry (1.X). */
  readonly factor: number
  /** Hard ceiling on any single delay, ms. */
  readonly capMs: number
}

/** Backoff for the n-th attempt (1-indexed). Grows exponentially, capped. */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number): number {
  const ms = policy.baseMs * Math.pow(policy.factor, Math.max(0, attempt - 1))
  return Math.min(ms, policy.capMs)
}

/** A retry is due when `now` has passed the entry's backoff horizon. Both
 *  brand-new (`pending`) and previously-failed (`failed`) entries remain
 *  retryable; only `done` / `dead` are terminal. */
export function isDue(entry: OutboxEntry, now: number): boolean {
  return (entry.state === 'pending' || entry.state === 'failed') && now >= entry.nextAttemptAt
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  maxRetries: 5,
  baseMs: 50,
  factor: 2,
  capMs: 5_000,
}
