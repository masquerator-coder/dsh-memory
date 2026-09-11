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
import type { MemoryRepository, OutboxStore, IndexRead } from './application/ports.ts'
import type { RawAssertion } from './domain/factory.ts'
import type { EntityCard, CardOptions } from './domain/card.ts'
import { buildEntityCard } from './application/card.ts'
import { normalizeProcedure } from './domain/procedural.ts'
import { buildFact } from './domain/factory.ts'
import { parseUserMd } from './application/usermd-parse.ts'
import { renderUserMd } from './application/usermd-render.ts'
import { diffUserMdEdits } from './application/usermd-sync.ts'
import type { UserMdLine } from './domain/usermd.ts'
import { rememberOne, type StoreOutcome } from './application/remember.ts'
import { recall, type RecallQuery, type ScoredMemory } from './application/recall.ts'
import { consolidateScope } from './application/consolidate.ts'
import { scanPii } from './application/privacy.ts'
import { ScopeQueue } from './infrastructure/queue.ts'
import { composeIndexRead } from './infrastructure/index-backends.ts'
import { withTimeout } from './util/timeout.ts'
import type { IndexWorker } from './application/index-worker.ts'
import { Metrics, TraceBuffer, MetricKeys, type TraceSpan } from './application/observability.ts'

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
  /** Procedural payload (P2-3): structured steps for `type: 'procedural'`. */
  procedure?: { steps?: unknown[]; preconditions?: string[]; success_rate?: number }
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
  readonly indexing: {
    readonly enabled: boolean
    readonly backends: number
    readonly degraded: boolean
    readonly detail?: string
  }
  readonly outbox: { pending: number; dead: number } | undefined
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
  /** Outbox journal + IndexWorker (P3 §7.2). When set, writes publish to the
   *  outbox and the worker keeps the pluggable derived backends consistent. */
  readonly outbox?: OutboxStore
  readonly worker?: IndexWorker
  /** Observability sinks (design §11). Default to new in-process instances. */
  readonly metrics?: Metrics
  readonly trace?: TraceBuffer
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
  private readonly outbox?: OutboxStore
  private readonly worker?: IndexWorker
  private readonly metric: Metrics
  private readonly trace: TraceBuffer
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
    this.outbox = options.outbox
    this.worker = options.worker
    this.metric = options.metrics ?? new Metrics()
    this.trace = options.trace ?? new TraceBuffer(200, this.now)
  }

  policy(): MemoryPolicy {
    return this.policyRef()
  }

  /**
   * Whether the deployment uses the outbox/Saga write path: indexing enabled
   * AND at least one pluggable derived backend is registered. With zero backends
   * the behavior is byte-for-byte that of P0 (all facts immediately `ready`).
   */
  get useOutbox(): boolean {
    const pol = this.policyRef()
    return pol.indexing.enabled && (this.worker?.backendCount ?? 0) > 0
  }

  /** Read source bound to the registered derived backends (P3: recall really
   *  queries vector/graph storage when present). Memoized per policy snapshot. */
  private _indexRead: IndexRead | undefined
  get indexRead(): IndexRead | undefined {
    const count = this.worker?.backendCount ?? 0
    if (count === 0) return undefined
    if (this._indexRead === undefined) {
      this._indexRead = composeIndexRead(this.worker!.backendsSnapshot)
    }
    return this._indexRead
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
      this.emit(report.events)
      for (const f of report.inactivated) await this.publishUnindex(f.factId, f.scope)
    }
    this.metric.incr(MetricKeys.expired, expired)
    this.metric.incr(MetricKeys.merged, merged)
    return { expired, merged }
  }

  private emit(events: MemoryEvent[]): void {
    if (events.length > 0) this.onEvents?.(events)
  }

  /**
   * Synchronous-budget, degradation-safe recall (design §5.2). Returns cached
   * scope facts when the store is slow, never throwing. When the outbox write
   * path is active, only `index_state = ready` facts are read (the
   * eventual-consistency barrier, §7.2).
   */
  async recall(query: RecallQuery): Promise<ScoredMemory[]> {
    const policy = this.policy()
    const start = performance.now()
    const span = this.trace.start('recall', { scope: query.scope })
    try {
      const run = recall(policy, this.repo, {
        ...query,
        requireReadyIndex: this.useOutbox && policy.indexing.requireReadyIndex,
        read: this.indexRead,
      })
      const result = await withTimeout(run, policy.retrieval.timeoutMs, async () => {
        // Degradation: return any active scope facts (cheap list) rather than
        // nothing, without re-running the full pipeline. Version-aware for research.
        const statuses = policy.retrieval.versions === 'all' ? ['active', 'superseded'] : ['active']
        const fallback = await this.repo.listScope(query.scope)
        return fallback
          .filter(f => statuses.includes(f.status) && !isExpired(f, this.now()))
          .map(f => ({ fact: f, score: 0, relevance: 0 }))
          .slice(0, query.topK ?? policy.retrieval.topK)
      })
      const elapsed = performance.now() - start
      this.metric.incr(MetricKeys.recall)
      this.metric.record('memory.recall', elapsed)
      if (policy.retrieval.timeoutMs > 0 && elapsed >= policy.retrieval.timeoutMs) {
        this.metric.incr(MetricKeys.recallTimeout)
      }
      span.finish(true)
      return result
    } catch (error) {
      this.metric.incr(MetricKeys.recall)
      this.metric.incr(MetricKeys.recallTimeout)
      span.finish(false, String(error instanceof Error ? error.message : error))
      throw error
    }
  }

  /**
   * Build the aggregated entity card for one canonical entity (design §3.13).
   * Runs within the retrieval budget; on timeout it degrades to an empty card
   * rather than blocking the caller.
   */
  async getCard(entityId: string, options: CardOptions = {}): Promise<EntityCard> {
    const policy = this.policy()
    const run = buildEntityCard(this.repo, entityId, options)
    return withTimeout(run, policy.retrieval.timeoutMs, async () => ({
      entityId,
      entityName: entityId,
      entityType: 'entity',
      updatedAt: 0,
      count: 0,
      summary: [],
      groups: [],
    }))
  }

  /**
   * Resolve the primary "user" entity id of a scope (most-frequency heuristic)
   * and render its card to the user.md Markdown view (design §8.5). Returns an
   * empty-document string when the scope has no user-typed facts.
   */
  async renderUserMd(scope: string): Promise<string> {
    const entityId = await this.primaryUserEntityId(scope)
    if (entityId === undefined) return renderUserMd({ entityId: 'user', entityName: '用户', entityType: 'user', updatedAt: 0, count: 0, summary: [], groups: [] })
    const card = await this.getCard(entityId)
    return renderUserMd(card)
  }

  /**
   * Apply an edited user.md document back to the underlying atomic facts
   * (design §8.4): parse → diff → add / supersede / archive. All writes are
   * `source=user_edit` (credibility 1.0) so they always win conflicts.
   * Returns a summary of what was written.
   */
  async applyUserMdEdits(scope: string, markdown: string): Promise<{ added: number; superseded: number; archived: number }> {
    const parsed = parseUserMd(markdown)
    // Baseline: the intersection of comment entries with current active facts.
    const facts = (await this.repo.listScope(scope)).filter(f => f.status === 'active')
    const actions = diffUserMdEdits(parsed.lines, { facts })

    const now = this.now()
    const policy = this.policy()
    let added = 0
    let superseded = 0
    let archived = 0

    for (const action of actions) {
      if (action.kind === 'archive') {
        await this.forget(action.factId, 'archive')
        archived += 1
        continue
      }
      // add / supersede both create a user_edit fact.
      const victim = action.kind === 'supersede' ? await this.repo.get(action.factId) : undefined
      const assertion = this.userEditAssertion(scope, action.line, now)
      if (victim !== undefined && victim.status === 'active') {
        const next = buildFact(assertion, { resolver: this.resolver, forgetting: policy.forgetting, defaultPrivacy: policy.privacy.default, now })
        await this.repo.put({ ...victim, status: 'superseded', updated_at: now })
        await this.repo.put({ ...next, version: victim.version + 1, supersedes: victim.id, created_at: victim.created_at })
        this.emit([{ kind: 'fact_superseded', factId: victim.id, byFactId: next.id, scope }])
        await this.publishIndexedFact(next)
        await this.publishUnindex(victim.id, scope)
        superseded += 1
      } else {
        const outcome = await rememberOne(this.deps(), assertion)
        await this.publishOutcome(outcome)
        added += 1
      }
    }

    this.recordScope(scope)
    return { added, superseded, archived }
  }

  private userEditAssertion(scope: string, line: UserMdLine, now: number): RawAssertion {
    return {
      subject: { type: 'user', name: '用户' },
      predicate: line.predicate,
      object: { type: 'concept', name: line.content.slice(0, 60) },
      content: line.content,
      type: 'semantic',
      confidence: 0.95,
      privacy: this.policy().privacy.default,
      pii: false,
      scope,
      source: { type: 'user_edit', uri: 'user.md', credibility: 1 },
    }
  }

  private async primaryUserEntityId(scope: string): Promise<string | undefined> {
    const facts = await this.repo.listScope(scope)
    let best: string | undefined
    let bestCount = 0
    const counts = new Map<string, number>()
    for (const fact of facts) {
      if (fact.status !== 'active' || fact.pii) continue
      if (fact.subject.type !== 'user') continue
      const n = (counts.get(fact.subject.id) ?? 0) + 1
      counts.set(fact.subject.id, n)
      if (n > bestCount) {
        bestCount = n
        best = fact.subject.id
      }
    }
    return best
  }

  /** Explicitly remember a fact from raw content (tool path). */
  async remember(input: RememberInput): Promise<StoreOutcome> {
    const policy = this.policy()
    const source = { type: 'tool_result' as const, uri: input.source?.uri, credibility: 0.9 }
    const procedure = input.procedure !== undefined
      ? normalizeProcedure(input.procedure as Parameters<typeof normalizeProcedure>[0])
      : undefined
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
      steps: procedure?.steps,
      preconditions: procedure?.preconditions,
      tool_chain: procedure?.tool_chain,
      success_rate: procedure?.success_rate,
    }
    const outcome = await rememberOne(this.deps(), assertion)
    this.emit(outcome.events)
    this.recordScope(input.scope)
    await this.publishOutcome(outcome)
    this.metric.incr(MetricKeys.remember)
    this.trace.start('remember', { scope: input.scope, factId: outcome.stored.id }).finish(true)
    return outcome
  }

  /** Forget one fact: archive (soft) or delete (hard tombstone). */
  async forget(factId: string, mode: ForgettingMode): Promise<void> {
    const fact = await this.repo.get(factId)
    if (fact === undefined) throw new Error(`memory: no fact "${factId}"`)
    this.trace.start('forget', { factId, scope: fact.scope }).finish(true)
    if (mode === 'delete') {
      await this.repo.delete(factId)
      this.emit([{ kind: 'fact_archived', factId, scope: fact.scope }])
      await this.publishUnindex(factId, fact.scope)
      this.metric.incr(MetricKeys.forget)
      return
    }
    await this.repo.put({ ...fact, status: 'archived', updated_at: this.now() })
    this.emit([{ kind: 'fact_archived', factId, scope: fact.scope }])
    await this.publishUnindex(factId, fact.scope)
    this.metric.incr(MetricKeys.forget)
  }

  /** Cascade-delete every fact in a scope (design §12.7 forgetting rights). */
  async forgetAll(scope: string): Promise<ForgetAllReport> {
    const facts = await this.repo.listScope(scope)
    for (const fact of facts) {
      await this.repo.delete(fact.id)
      await this.publishUnindex(fact.id, scope)
    }
    const events: MemoryEvent[] = facts.map(f => ({ kind: 'fact_archived', factId: f.id, scope }))
    this.emit(events)
    this.metric.incr(MetricKeys.forgetAll, facts.length)
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
    await this.publishOutcome(outcome)
    this.metric.incr(MetricKeys.link)
    return outcome
  }

  /** Run a consolidation pass over one scope. */
  async consolidate(scope: string): Promise<{ expired: number; merged: number }> {
    const report = await consolidateScope(this.repo, scope, this.now())
    this.emit(report.events)
    this.metric.incr(MetricKeys.expired, report.expired)
    this.metric.incr(MetricKeys.merged, report.merged)
    for (const f of report.inactivated) await this.publishUnindex(f.factId, f.scope)
    return { expired: report.expired, merged: report.merged }
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
      this.metric.incr(MetricKeys.extractAttempt)
      try {
        assertions = await this.extract(pii.redacted)
        if (assertions !== undefined && assertions.length > 0) this.metric.incr(MetricKeys.extractSuccess)
        else this.metric.incr(MetricKeys.extractFail)
      } catch {
        assertions = undefined
        this.metric.incr(MetricKeys.extractFail)
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
      await this.publishOutcome(outcome)
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
    const indexingEnabled = this.useOutbox
    const degraded = this.worker?.degraded()
    let outbox: Health['outbox']
    try {
      outbox = this.outbox !== undefined
        ? await this.outbox.stats()
        : { pending: 0, dead: 0 }
    } catch {
      outbox = undefined
    }
    const backends = this.worker?.backendCount ?? 0
    let ok = store !== undefined
    if (indexingEnabled) ok = ok && (degraded?.ok !== false)
    return {
      ok,
      queue: this.queue.stats(),
      store,
      llmExtraction: this.llmExtractionEnabled,
      llmAvailable: this.extract !== undefined,
      indexing: {
        enabled: indexingEnabled,
        backends,
        degraded: degraded?.ok === false,
        detail: degraded?.ok === false ? degraded.detail : undefined,
      },
      outbox,
    }
  }

  /** Observability metrics (design §11): store + outbox + backends + counters. */
  async metrics(): Promise<{ stored: number; active: number; outboxPending: number; outboxDead: number; indexedBackends: Record<string, number>; counters: Record<string, number> }> {
    const stats = await this.repo.stats()
    const outboxStats = this.outbox !== undefined ? await this.outbox.stats() : { pending: 0, dead: 0 }
    const indexedBackends: Record<string, number> = {}
    for (const backend of this.worker?.backendsSnapshot ?? []) {
      indexedBackends[backend.name] = await backend.count()
    }
    return {
      stored: stats.total,
      active: stats.active,
      outboxPending: outboxStats.pending,
      outboxDead: outboxStats.dead,
      indexedBackends,
      counters: this.metric.snapshot(),
    }
  }

  /** Most recent trace spans (design §12.4 end-to-end trail), newest first. */
  traces(n = 20): readonly TraceSpan[] {
    return this.trace.recent(n)
  }

  /**
   * Run the index worker until the outbox drains (up to `tickLimit` per sweep).
   * Used by tests and by the background loop's manual trigger; safe to no-op when
   * outbox/Saga is not configured.
   */
  async drainIndexing(tickLimit = 100): Promise<{ swept: number; remaining: number }> {
    if (!this.useOutbox || this.worker === undefined || this.outbox === undefined) return { swept: 0, remaining: 0 }
    const report = await this.worker.tick(this.now(), tickLimit)
    this.metric.incr(MetricKeys.indexTick, report.attempted)
    this.metric.incr(MetricKeys.indexApplied, report.indexed + report.unindexed)
    this.metric.incr(MetricKeys.indexDead, report.dead)
    const stats = await this.outbox.stats()
    return { swept: report.attempted, remaining: stats.pending }
  }

  /**
   * Publish a write outcome to the outbox when the Saga write path is active.
   * The stored active fact is flagged `pending_indexing` (so recall skips it until
   * the worker confirms) and an `index` entry is queued; a superseded fact gets an
   * `unindex` entry so its derived copies are removed (§7.2, §7.3).
   */
  private async publishOutcome(outcome: StoreOutcome): Promise<void> {
    if (!this.useOutbox || this.outbox === undefined) return
    await this.publishIndexedFact(outcome.stored)
    if (outcome.superseded !== undefined) {
      await this.outbox.append('unindex', outcome.superseded, outcome.stored.scope)
    }
  }

  /** Queue an `index` entry and flag an active fact `pending_indexing`. */
  private async publishIndexedFact(fact: AtomicFact): Promise<void> {
    if (!this.useOutbox || this.outbox === undefined) return
    if (fact.status === 'active') {
      await this.repo.put({ ...fact, index_state: 'pending_indexing' })
      await this.outbox.append('index', fact.id, fact.scope)
    }
  }

  /** Queue a tombstone/unindex entry when the Saga write path is active. */
  private async publishUnindex(factId: string, scope: string): Promise<void> {
    if (!this.useOutbox || this.outbox === undefined) return
    await this.outbox.append('unindex', factId, scope)
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
