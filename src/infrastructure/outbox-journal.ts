/**
 * In-process Outbox journal — the shipped implementation of {@link OutboxStore}.
 *
 * It serializes all mutations through an internal promise chain so the fast
 * channel and the background worker never interleave a partial read-modify.
 * Entries are keyed by `(op, factId)` so appending the same logical change twice
 * is coalesced (idempotency, design §12.2). The journal is in-memory for P0/P3,
 * matching the plugin's single-process local positioning; the {@link OutboxStore}
 * interface is the seam a durable log (SQLite / PostgreSQL) can implement later.
 *
 * @module dsh-memory/infrastructure/outbox-journal
 */
import type {
  OutboxOp,
  OutboxEntry,
} from '../domain/outbox.ts'
import { isDue } from '../domain/outbox.ts'
import type { OutboxStats, OutboxStore } from '../application/ports.ts'

export class OutboxJournal implements OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>()
  /** `op:factId` → entry id (coalescing / idempotency index). */
  private readonly byOpFact = new Map<string, string>()
  private chain: Promise<void> = Promise.resolve()
  private seq = 0
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, () => task())
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  append(op: OutboxOp, factId: string, scope: string): Promise<void> {
    return this.enqueue(async () => {
      const key = `${op}:${factId}`
      const existingId = this.byOpFact.get(key)
      if (existingId !== undefined) {
        const existing = this.entries.get(existingId)
        // Coalesce re-appends of the same pending change; re-index of an already
        // done entry is a fresh requirement (still safe to re-run — idempotent).
        if (existing !== undefined && existing.state === 'pending') return
      }
      const stamp = this.now()
      this.seq += 1
      const entry: OutboxEntry = {
        id: `ob_${this.seq}_${stamp}`,
        op,
        factId,
        scope,
        attempts: 0,
        state: 'pending',
        nextAttemptAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      }
      this.entries.set(entry.id, entry)
      this.byOpFact.set(key, entry.id)
    })
  }

  pendingDue(now: number, limit: number): Promise<OutboxEntry[]> {
    return this.enqueue(async () => {
      const due: OutboxEntry[] = []
      for (const entry of this.entries.values()) {
        // `failed` entries are due-for-retry once their backoff horizon passes.
        if ((entry.state === 'pending' || entry.state === 'failed') && isDue(entry, now)) {
          due.push(entry)
          if (due.length >= limit) break
        }
      }
      return due
    })
  }

  get(entryId: string): Promise<OutboxEntry | undefined> {
    return this.enqueue(async () => this.entries.get(entryId))
  }

  markDone(entryId: string): Promise<OutboxEntry | undefined> {
    return this.enqueue(async () => {
      const entry = this.entries.get(entryId)
      if (entry === undefined) return undefined
      const next: OutboxEntry = {
        ...entry,
        state: 'done',
        updatedAt: this.now(),
        lastError: undefined,
      }
      this.entries.set(entryId, next)
      return next
    })
  }

  markFailed(entryId: string, error: string, nextAttemptAt: number): Promise<OutboxEntry | undefined> {
    return this.enqueue(async () => {
      const entry = this.entries.get(entryId)
      if (entry === undefined) return undefined
      const next: OutboxEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        state: 'failed',
        nextAttemptAt,
        updatedAt: this.now(),
        lastError: error,
      }
      this.entries.set(entryId, next)
      return next
    })
  }

  markDead(entryId: string): Promise<OutboxEntry | undefined> {
    return this.enqueue(async () => {
      const entry = this.entries.get(entryId)
      if (entry === undefined) return undefined
      const next: OutboxEntry = {
        ...entry,
        state: 'dead',
        updatedAt: this.now(),
      }
      this.entries.set(entryId, next)
      return next
    })
  }

  remove(entryId: string): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.entries.get(entryId)
      if (entry === undefined) return
      this.entries.delete(entryId)
      this.byOpFact.delete(`${entry.op}:${entry.factId}`)
    })
  }

  stats(): Promise<OutboxStats> {
    return this.enqueue(async () => {
      let pending = 0
      let done = 0
      let failed = 0
      let dead = 0
      for (const entry of this.entries.values()) {
        if (entry.state === 'pending') pending += 1
        else if (entry.state === 'done') done += 1
        else if (entry.state === 'failed') failed += 1
        else dead += 1
      }
      return { pending, done, failed, dead, total: this.entries.size }
    })
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.entries.clear()
      this.byOpFact.clear()
    })
  }

  /** Test/observability accessor: snapshot of all entries. */
  snapshot(): Promise<OutboxEntry[]> {
    return this.enqueue(async () => [...this.entries.values()])
  }
}
