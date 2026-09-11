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
export interface QueueStats {
  readonly pending: number
  readonly activeScopes: number
  readonly errored: number
}

interface Entry {
  readonly run: () => Promise<void>
}

export class ScopeQueue {
  private readonly scopes = new Map<string, Entry[]>()
  private readonly running = new Set<string>()
  private errored = 0

  constructor(private readonly maxParallelScopes = 4) {}

  /** Enqueue a task for a scope and start a worker when none is active there. */
  enqueue(scope: string, task: () => Promise<void>): void {
    const list = this.scopes.get(scope) ?? []
    list.push({ run: task })
    this.scopes.set(scope, list)
    void this.pump()
  }

  /** Optional discharge for tests: resolve once the given scope drains. */
  async whenDrained(scope: string): Promise<void> {
    while (true) {
      const list = this.scopes.get(scope)
      if ((list === undefined || list.length === 0) && !this.running.has(scope)) return
      await sleep(5)
    }
  }

  /** Wait until all scopes are idle (no queued or running tasks). */
  async idle(): Promise<void> {
    while (this.running.size > 0 || [...this.scopes.values()].some(l => l.length > 0)) {
      await sleep(5)
    }
  }

  stats(): QueueStats {
    let pending = 0
    for (const list of this.scopes.values()) pending += list.length
    return { pending, activeScopes: this.running.size, errored: this.errored }
  }

  private async pump(): Promise<void> {
    if (this.running.size >= this.maxParallelScopes) return
    // Start workers for idle scopes that have work.
    for (const [scope, list] of this.scopes) {
      if (this.running.has(scope) || list.length === 0) continue
      if (this.running.size >= this.maxParallelScopes) break
      void this.work(scope)
      if (this.running.size >= this.maxParallelScopes) break
    }
  }

  private async work(scope: string): Promise<void> {
    this.running.add(scope)
    try {
      while (true) {
        const list = this.scopes.get(scope)
        const entry = list?.shift()
        if (entry === undefined) break
        try {
          await entry.run()
        } catch {
          this.errored += 1
          // Backpressure: a failed task is recorded, never retried by the
          // queue — the caller decides on durability/retry.
        }
        if (list?.length === 0) this.scopes.delete(scope)
      }
    } finally {
      this.running.delete(scope)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
