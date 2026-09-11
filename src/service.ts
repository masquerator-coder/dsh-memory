/**
 * MemoryService — the public programmatic API consumers use via `ctx.memory`.
 * Coordinates the repositories, engines, and background queue while staying a
 * plain object (not a Cordis Service subclass) so unit tests can drive it
 * without a host — the entry `apply()` registers it as the `memory` service.
 *
 * Design §5, §6. Exposed via `ctx.set('memory', service)` and injected as
 * `inject: ['memory']`.
 *
 * @module dsh-memory/service
 */
import type { AtomicFact, MemoryEvent } from './domain/fact.ts'
import type { EntityResolver } from './domain/entity.ts'
import type { MemoryPolicy } from './domain/policies.ts'
import { isExpired } from './domain/policies.ts'
import type { MemoryRepository } from './application/ports.ts'
import type { RawAssertion } from './domain/factory.ts'
import { rememberOne, type StoreOutcome } from './application/remember.ts'
import { recall, type RecallQuery, type ScoredMemory } from './application/recall.ts'
import { consolidateScope } from './application/consolidate.ts'
import { scanPii } from './application/privacy.ts'
import { ScopeQueue } from './infrastructure/queue.ts'
import { withTimeout } from './util/timeout.ts'

/** Optional LLM extraction callback supplied by the adapter (main LLM never extracts). */
export type ExtractFunction = (text: string) => Promise<RawAssertion[]>

/** One explicit write request from a tool. */
export interface RememberInput {
  content: string
  scope: string
  subject?: { type?: string; name?: string; id?: string }
  predicate?: string
  object?: { type?: string; name?: string; id?: string }
  type?: AtomicFact['type']
  confidence?: number
  privacy?: AtomicFact['privacy']
  pii?: boolean
  source?: { uri?: string }
}

export type ForgettingMode = 'archive' | 'delete'

export interface ForgetAllReport {
  readonly scope: string
  readonly deleted: number
  readonly events: MemoryEvent[]
}

export interface Health {
  readonly ok: boolean
  readonly queue: { pending: number; activeScopes: number; errored: number }
  readonly store: { active: number; total: number } | undefined
  readonly llmExtraction: boolean
  readonly llmAvailable: boolean
}

export interface MemoryServiceOptions {
  readonly repo: MemoryRepository
  readonly resolver: EntityResolver
  readonly policy: () => MemoryPolicy
  readonly queue?: ScopeQueue
  readonly extract?: ExtractFunction
  /** Master switch for LLM-backed extraction (from config). */
  readonly llmExtractionEnabled: boolean
  /** Master switch for session fast-channel capture (from config). */
  readonly captureEnabled: boolean
  readonly now?: () => number
  readonly onEvents?: (events: MemoryEvent[]) => void
}

export class MemoryService {
  readonly repo: MemoryRepository
  readonly resolver: EntityResolver
  private readonly policyRef: () => MemoryPolicy
  private readonly queue: ScopeQueue
  private readonly extract?: ExtractFunction
  private readonly llmExtractionEnabled: boolean
  private readonly captureEnabled: boolean
  private readonly now: () => number
  private readonly onEvents?: (events: MemoryEvent[]) => void
  /** Scope ids that have seen writes — drives the background consolidate sweep. */
  private readonly scopes = new Set<string>()

  constructor(options: MemoryServiceOptions) {
    this.repo = options.repo
    this.resolver = options.resolver
    this.policyRef = options.policy
    this.queue = options.queue ?? new ScopeQueue()
    this.extract = options.extract
    this.llmExtractionEnabled = options.llmExtractionEnabled
    this.captureEnabled = options.captureEnabled
    this.now = options.now ?? Date.now
    this.onEvents = options.onEvents
  }

  policy(): MemoryPolicy {
    return this.policyRef()
  }

  /** Record a scope that has had activity (for the sweep). */
  recordScope(scope: string): void {
    this.scopes.add(scope)
  }

  /** All scopes observed so far. */
  knownScopes(): string[] {
    return [...this.scopes]
  }

  /** Run a consolidate pass over every observed scope. */
  async consolidateAll(now?: number): Promise<{ expired: number; merged: number }> {
    const stamp = now ?? this.now()
    let expired = 0
    let merged = 0
    for (const scope of this.scopes) {
      const report = await consolidateScope(this.repo, scope, stamp)
      expired += report.expired
      merged += report.merged
    }
    return { expired, merged }
  }

  private emit(events: MemoryEvent[]): void {
    if (events.length > 0) this.onEvents?.(events)
  }

  /**
   * Synchronous-budget, degradation-safe recall (design §5.2). Returns cached
   * scope facts when the store is slow, never throwing.
   */
  async recall(query: RecallQuery): Promise<ScoredMemory[]> {
    const policy = this.policy()
    const run = recall(policy, this.repo, query)
    return withTimeout(run, policy.retrieval.timeoutMs, async () => {
      // Degradation: return any active scope facts (cheap list) rather than
      // nothing, without re-running the full pipeline.
      const fallback = await this.repo.listScope(query.scope)
      return fallback
        .filter(f => f.status === 'active' && !isExpired(f, this.now()))
        .map(f => ({ fact: f, score: 0, relevance: 0 }))
        .slice(0, query.topK ?? policy.retrieval.topK)
    })
  }

  /** Explicitly remember a fact from raw content (tool path). */
  async remember(input: RememberInput): Promise<StoreOutcome> {
    const policy = this.policy()
    const source = { type: 'tool_result' as const, uri: input.source?.uri, credibility: 0.9 }
    const assertion: RawAssertion = {
      subject: {
        type: input.subject?.type ?? 'user',
        name: input.subject?.name ?? '用户',
        id: input.subject?.id,
      },
      predicate: input.predicate ?? 'states',
      object: {
        type: input.object?.type ?? 'concept',
        name: input.object?.name ?? input.content.slice(0, 60),
        id: input.object?.id,
      },
      content: input.content,
      type: input.type ?? 'semantic',
      confidence: input.confidence ?? 0.75,
      privacy: input.privacy ?? policy.privacy.default,
      pii: input.pii ?? false,
      scope: input.scope,
      source,
    }
    const outcome = await rememberOne(this.deps(), assertion)
    this.emit(outcome.events)
    this.recordScope(input.scope)
    return outcome
  }

  /** Forget one fact: archive (soft) or delete (hard tombstone). */
  async forget(factId: string, mode: ForgettingMode): Promise<void> {
    const fact = await this.repo.get(factId)
    if (fact === undefined) throw new Error(`memory: no fact "${factId}"`)
    if (mode === 'delete') {
      await this.repo.delete(factId)
      this.emit([{ kind: 'fact_archived', factId, scope: fact.scope }])
      return
    }
    await this.repo.put({ ...fact, status: 'archived', updated_at: this.now() })
    this.emit([{ kind: 'fact_archived', factId, scope: fact.scope }])
  }

  /** Cascade-delete every fact in a scope (design §12.7 forgetting rights). */
  async forgetAll(scope: string): Promise<ForgetAllReport> {
    const facts = await this.repo.listScope(scope)
    for (const fact of facts) await this.repo.delete(fact.id)
    const events: MemoryEvent[] = facts.map(f => ({ kind: 'fact_archived', factId: f.id, scope }))
    this.emit(events)
    return { scope, deleted: facts.length, events }
  }

  /** Establish a typed relation between two entities (graph edge, §7.4). */
  async link(fromId: string, toId: string, relation: string): Promise<StoreOutcome> {
    const policy = this.policy()
    const from = await this.repo.get(fromId)
    const to = await this.repo.get(toId)
    const fromEntity = from?.subject.id ?? from?.object.id ?? fromId
    const toEntity = to?.subject.id ?? to?.object.id ?? toId
    const assertion: RawAssertion = {
      subject: { type: 'entity', name: fromId, id: fromEntity },
      predicate: relation,
      object: { type: 'entity', name: toId, id: toEntity },
      content: `${fromId} ${relation} ${toId}`,
      type: 'semantic',
      confidence: 0.85,
      scope: from?.scope ?? to?.scope ?? 'global',
      source: { type: 'tool_result', credibility: 0.85 },
    }
    const outcome = await rememberOne(this.deps(), assertion)
    this.emit(outcome.events)
    return outcome
  }

  /** Run a consolidation pass over one scope. */
  async consolidate(scope: string): Promise<{ expired: number; merged: number }> {
    return consolidateScope(this.repo, scope, this.now())
  }

  /**
   * The session/event entry point: fast-channel capture, then background
   * extraction + storage (enqueued, never blocking the caller).
   */
  extractAndRemember(input: { text: string; scope: string; sourceUri?: string }): { accepted: boolean } {
    // Fast channel: deterministic-rule capture (mode B) always applies first.
    const accepted = this.captureEnabled
    if (accepted) {
      this.queue.enqueue(input.scope, () => this.slowPath(input))
    }
    return { accepted }
  }

  private async slowPath(input: { text: string; scope: string; sourceUri?: string }): Promise<void> {
    const policy = this.policy()
    const source = { type: 'conversation' as const, uri: input.sourceUri, credibility: 0.7 }
    // PII scan: flag/isolate sensitive content before it reaches memory.
    const pii = scanPii(input.text)

    let assertions: RawAssertion[] | undefined
    if (this.extract !== undefined && this.llmExtractionEnabled) {
      try {
        assertions = await this.extract(pii.redacted)
      } catch {
        assertions = undefined
      }
    }

    if (assertions === undefined || assertions.length === 0) {
      if (policy.extraction.fallback === 'ignore' || input.text.trim().length === 0) return
      // fallback 'store_raw_event': persist a low-confidence semantic fact so
      // nothing is silently lost (design §12 backpressure / degradation).
      assertions = [{
        subject: { type: 'user', name: '用户' },
        predicate: 'stated',
        object: { type: 'concept', name: input.text.slice(0, 80) },
        content: input.text,
        type: 'semantic',
        confidence: policy.extraction.ruleConfidence,
        privacy: policy.privacy.default,
        pii: pii.detected,
        scope: input.scope,
        source,
      }]
    } else if (pii.detected) {
      assertions = assertions.map(a => ({ ...a, pii: true }))
    }

    for (const assertion of assertions) {
      const outcome = await rememberOne(this.deps(), { ...assertion, source: assertion.source })
      this.emit(outcome.events)
    }
    this.recordScope(input.scope)
  }

  /** Health check (design §12.4). */
  async health(): Promise<Health> {
    let store: Health['store']
    try {
      store = await this.repo.stats()
    } catch {
      store = undefined
    }
    const policy = this.policy()
    return {
      ok: store !== undefined,
      queue: this.queue.stats(),
      store,
      llmExtraction: this.llmExtractionEnabled,
      llmAvailable: this.extract !== undefined,
    }
  }

  /** Observability metrics (design §11). */
  async metrics(): Promise<{ stored: number; active: number }> {
    const stats = await this.repo.stats()
    return { stored: stats.total, active: stats.active }
  }

  private deps(): { repo: MemoryRepository; resolver: EntityResolver; forgetting: MemoryPolicy['forgetting']; defaultPrivacy: AtomicFact['privacy'] } {
    const policy = this.policy()
    return {
      repo: this.repo,
      resolver: this.resolver,
      forgetting: policy.forgetting,
      defaultPrivacy: policy.privacy.default,
    }
  }
}
