/**
 * In-memory derived-index backends (vector / graph / object stand-ins).
 *
 * These implement the {@link DerivedIndexBackend} contract so the Outbox + IndexWorker
 * machinery (P3) is exercised end-to-end without an external dependency. Each is a
 * plain Map kept in sync by the worker: `upsert` writes, `remove` deletes. A real
 * deployment plugs in an ANN vector DB, a graph store (Neo4j / Kùzu), or object
 * storage by implementing the same interface — the worker, outbox, and `index_state`
 * transitions are backend-agnostic. Each carry a small fault-injection seam
 * (`failNextCalls`) used by the fault-injection tests (design §12.8, P3 #4).
 *
 * @module dsh-memory/infrastructure/index-backends
 */
import type { AtomicFact } from '../domain/fact.ts'
import type { DerivedIndexBackend } from '../application/ports.ts'

interface MemoryBackendState {
  upsert(fact: AtomicFact): void
  remove(factId: string): void
  size(): number
}

/** Shared bookkeeping for the three in-memory backends. */
abstract class BaseBackend implements DerivedIndexBackend {
  abstract readonly name: string
  protected abstract store(): MemoryBackendState
  /** Fault injection: reject the next N upsert/remove calls. */
  protected faultRemaining = 0
  protected healthy = true

  /** Make the next `n` mutations throw (fault injection). */
  injectFault(n = 1): void {
    this.faultRemaining = Math.max(0, n)
  }

  /** Force the backend permanently unhealthy (worker must skip / DLQ). */
  setHealthy(ok: boolean): void {
    this.healthy = ok
  }

  protected gate(): void {
    if (!this.healthy) throw new Error(`${this.name} backend unavailable`)
    if (this.faultRemaining > 0) {
      this.faultRemaining -= 1
      throw new Error(`${this.name} backend write failed (injected)`)
    }
  }

  async upsert(fact: AtomicFact): Promise<void> {
    this.gate()
    this.store().upsert(fact)
  }

  async remove(factId: string): Promise<void> {
    this.gate()
    this.store().remove(factId)
  }

  async rebuild(facts: AtomicFact[]): Promise<void> {
    for (const f of facts) this.gate() // rebuild is one batch of upserts
    for (const f of facts) this.store().upsert(f)
  }

  health(): { ok: boolean; detail?: string } {
    return this.healthy ? { ok: true } : { ok: false, detail: 'unavailable (injected)' }
  }

  async count(): Promise<number> {
    return this.store().size()
  }
}

/** Vector analog: fact content + entity/tag terms, keyed by fact id. */
export class InMemoryVectorBackend extends BaseBackend {
  readonly name = 'vector'
  private readonly items = new Map<string, unknown>()
  protected store(): MemoryBackendState {
    return {
      upsert: (fact) => { this.items.set(fact.id, { content: fact.content, entities: fact.entities }) },
      remove: (id) => { this.items.delete(id) },
      size: () => this.items.size,
    }
  }
  /** Test accessor. */
  has(id: string): boolean {
    return this.items.has(id)
  }
}

/** Graph analog: subject/object entity adjacency, keyed by fact id. */
export class InMemoryGraphBackend extends BaseBackend {
  readonly name = 'graph'
  private readonly edges = new Map<string, { from: string; to: string }>()
  protected store(): MemoryBackendState {
    return {
      upsert: (fact) => {
        this.edges.set(fact.id, { from: fact.subject.id, to: fact.object?.id ?? '' })
      },
      remove: (id) => { this.edges.delete(id) },
      size: () => this.edges.size,
    }
  }
  has(id: string): boolean {
    return this.edges.has(id)
  }
}

/** Object analog: full fact payload (source-of-truth projection to aux store). */
export class InMemoryObjectBackend extends BaseBackend {
  readonly name = 'object'
  private readonly blobs = new Map<string, AtomicFact>()
  protected store(): MemoryBackendState {
    return {
      upsert: (fact) => { this.blobs.set(fact.id, fact) },
      remove: (id) => { this.blobs.delete(id) },
      size: () => this.blobs.size,
    }
  }
  has(id: string): boolean {
    return this.blobs.has(id)
  }
}

/** Convenience: register the standard triple of in-memory backends. */
export function defaultIndexBackends(): DerivedIndexBackend[] {
  return [new InMemoryVectorBackend(), new InMemoryGraphBackend(), new InMemoryObjectBackend()]
}
