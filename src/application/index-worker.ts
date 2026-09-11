/**
 * IndexWorker — the background Saga participant that keeps the derived backends
 * (vector / graph / object) eventually consistent with the KV main records.
 *
 * Flow (design §7.2): it polls the outbox for due entries; for `index` it reads
 * the fact from the repo and upserts it to every registered backend, then marks
 * the fact `index_state = ready`; for `unindex` (tombstone / archive / supersede /
 * cascade wipe) it removes the fact from every backend. Failures are retried with
 * exponential backoff; once retries are exhausted the entry graduates to the DLQ
 * and the fact is flagged `index_state = index_failed` so recall can skip it.
 *
 * Idempotent: backends upsert/remove by fact id, so a replayed entry is a no-op
 * (§12.2). Runs out-of-band — it never blocks the synchronous recall/remember path.
 *
 * @module dsh-memory/application/index-worker
 */
import type { AtomicFact } from '../domain/fact.ts'
import type {
  DerivedIndexBackend,
  MemoryRepository,
  OutboxStore,
} from './ports.ts'
import {
  backoffDelayMs,
  DEFAULT_BACKOFF,
  type BackoffPolicy,
  type OutboxEntry,
} from '../domain/outbox.ts'

export interface IndexWorkerOptions {
  readonly repo: MemoryRepository
  readonly outbox: OutboxStore
  readonly backends: DerivedIndexBackend[]
  readonly backoff?: Partial<BackoffPolicy>
  readonly now?: () => number
  /** Fired after an entry is applied (success or DLQ) — observability seam. */
  readonly onApplied?: (factId: string, entryId: string, ok: boolean) => void
}

export interface IndexReport {
  attempted: number
  indexed: number
  unindexed: number
  failed: number
  dead: number
  skippedUnhealthy: number
}

const HEALTHY_NAME = (b: DerivedIndexBackend): string => b.name

export class IndexWorker {
  private readonly repo: MemoryRepository
  private readonly outbox: OutboxStore
  private readonly backends: DerivedIndexBackend[]
  private readonly backoff: BackoffPolicy
  private readonly now: () => number
  private readonly onApplied?: (factId: string, entryId: string, ok: boolean) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  constructor(options: IndexWorkerOptions) {
    this.repo = options.repo
    this.outbox = options.outbox
    this.backends = options.backends
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff }
    this.now = options.now ?? Date.now
    this.onApplied = options.onApplied
  }

  /** Independent-process style: pull-driven single pass over due entries. */
  async tick(now = this.now(), limit = 100): Promise<IndexReport> {
    const report: IndexReport = { attempted: 0, indexed: 0, unindexed: 0, failed: 0, dead: 0, skippedUnhealthy: 0 }
    const entries = await this.outbox.pendingDue(now, limit)
    for (const entry of entries) {
      report.attempted += 1
      await this.applyEntry(entry, now, report)
    }
    return report
  }

  /** Start a periodic pull loop. Returns a stop function. */
  start(intervalMs: number): () => void {
    if (this.timer !== undefined) return () => {}
    this.running = true
    const loop = async (): Promise<void> => {
      if (!this.running) return
      try {
        await this.tick()
      } catch {
        // never let a worker error escape the timer
      }
      this.timer = setTimeout(() => void loop(), intervalMs)
    }
    this.timer = setTimeout(() => void loop(), 0)
    return () => this.stop()
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  dispose(): void {
    this.stop()
  }

  /** How many derived backends the worker keeps in sync. */
  get backendCount(): number {
    return this.backends.length
  }

  /** Shallow copy of the registered backends (observability / metrics). */
  get backendsSnapshot(): readonly DerivedIndexBackend[] {
    return [...this.backends]
  }

  /** Whether any target backend is reporting unhealthy (for health checks). */
  degraded(): { ok: boolean; detail?: string } {
    for (const b of this.backends) {
      const h = b.health()
      if (!h.ok) return { ok: false, detail: `${HEALTHY_NAME(b)}: ${h.detail ?? 'down'}` }
    }
    return { ok: true }
  }

  private async applyEntry(entry: OutboxEntry, now: number, report: IndexReport): Promise<void> {
    // Skip backends that are down so a single outage doesn't burn retries on the
    // whole batch; record it so health can surface the degradation.
    const live = this.backends.filter(b => b.health().ok)
    const skipped = this.backends.length - live.length
    report.skippedUnhealthy += skipped
    if (live.length === 0 && this.backends.length > 0) {
      await this.failEntry(entry, now, report, 'all backends down')
      return
    }

    try {
      if (entry.op === 'index') {
        const fact = await this.repo.get(entry.factId)
        if (fact === undefined || (fact.status !== 'active' && fact.status !== 'pending_review')) {
          // Nothing to index (deleted / no longer active) — no-op success.
          await this.settleDone(entry)
          report.indexed += 1
          return
        }
        for (const b of live) await b.upsert(fact)
        await this.markReady(fact)
        await this.settleDone(entry)
        report.indexed += 1
      } else {
        for (const b of live) await b.remove(entry.factId)
        await this.settleDone(entry)
        report.unindexed += 1
      }
      this.onApplied?.(entry.factId, entry.id, true)
    } catch (error) {
      this.onApplied?.(entry.factId, entry.id, false)
      await this.failEntry(entry, now, report, String(error instanceof Error ? error.message : error))
    }
  }

  /** One retryable failure: retry with backoff, or graduate to the DLQ + flag failure. */
  private async failEntry(entry: OutboxEntry, now: number, report: IndexReport, error: string): Promise<void> {
    const nextAttempt = entry.attempts + 1
    if (nextAttempt >= this.backoff.maxRetries) {
      await this.outbox.markDead(entry.id)
      if (entry.op === 'index') {
        const fact = await this.repo.get(entry.factId)
        if (fact !== undefined && fact.status === 'active') {
          await this.repo.put({ ...fact, index_state: 'index_failed', updated_at: now })
        }
      }
      report.dead += 1
      return
    }
    const delay = backoffDelayMs(this.backoff, nextAttempt)
    await this.outbox.markFailed(entry.id, error, now + delay)
    report.failed += 1
  }

  private async markReady(fact: AtomicFact): Promise<void> {
    if (fact.index_state === 'ready') return
    await this.repo.put({ ...fact, index_state: 'ready', updated_at: this.now() })
  }

  private async settleDone(entry: OutboxEntry): Promise<void> {
    await this.outbox.markDone(entry.id)
    // GC: remove finished entries so the journal doesn't grow unbounded.
    await this.outbox.remove(entry.id)
  }
}
