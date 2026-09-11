import { describe, expect, it } from 'vitest'
import { MemoryService } from '../src/service'
import { Metrics, TraceBuffer, MetricKeys } from '../src/application/observability'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildPolicy } from '../src/build-policy'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import type { FactFilter, RecallCandidate } from '../src/application/ports'

function makeService(repo: JsonFileMemoryRepository, config: Parameters<typeof buildPolicy>[0] = {}) {
  const resolver = new EntityResolver()
  resolver.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  resolver.upsert({ id: 'concept:go', type: 'concept', name: 'Go 语言', aliases: ['Go', 'Go 语言'] })
  const metrics = new Metrics()
  const trace = new TraceBuffer(200, () => nowClock)
  let nowClock = 1000
  const service = new MemoryService({
    repo,
    resolver,
    policy: () => buildPolicy(config),
    llmExtractionEnabled: false,
    captureEnabled: true,
    metrics,
    trace,
    now: () => nowClock,
  })
  return { service, metrics, trace, resolver, advance: (n: number) => { nowClock += n } }
}

function raw(content: string): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'uses_technology',
    object: { type: 'concept', name: 'Go 语言' },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
  }
}

/** Repo whose lexical query is slow → trips the recall timeout/degradation. */
class SlowRepo extends JsonFileMemoryRepository {
  async query(filter: FactFilter, queryTerms: readonly string[], graphSeedIds: readonly string[]): Promise<RecallCandidate[]> {
    await new Promise(resolve => setTimeout(resolve, 40))
    return super.query(filter, queryTerms, graphSeedIds)
  }
}

describe('observability metrics', () => {
  it('counts writes and recall and records recall latency', async () => {
    const repo = new JsonFileMemoryRepository()
    const { service, metrics } = makeService(repo)
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })
    await service.recall({ query: 'Go', scope: 'session:abc' })

    expect(metrics.counter(MetricKeys.remember)).toBe(1)
    expect(metrics.counter(MetricKeys.recall)).toBe(1)
    expect(metrics.counter(MetricKeys.recallTimeout)).toBe(0)
    expect(metrics.avgMs('memory.recall')).toBeGreaterThanOrEqual(0)
    const snap = metrics.snapshot()
    expect(snap['memory.remember']).toBe(1)
  })

  it('tracks forgetting counters on forget/consolidate', async () => {
    const repo = new JsonFileMemoryRepository()
    const { service, metrics, resolver } = makeService(repo)
    const built = buildFact(raw('Alice 使用 Go 语言'), { resolver, forgetting: buildPolicy({}).forgetting, defaultPrivacy: 'private', now: 1000 })
    await repo.put(built)
    await service.forget(built.id, 'archive')
    expect(metrics.counter(MetricKeys.forget)).toBe(1)
  })

  it('records an end-to-end trace span for recall/remember and exposes recent()', async () => {
    const repo = new JsonFileMemoryRepository()
    const { service, trace } = makeService(repo)
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })
    await service.recall({ query: 'Go', scope: 'session:abc' })

    const recent = trace.recent(10)
    const names = recent.map(s => s.name)
    expect(names).toContain('remember')
    expect(names).toContain('recall')
    const recallSpan = recent.find(s => s.name === 'recall')
    expect(recallSpan?.ok).toBe(true)
    expect(recallSpan?.ms).toBeGreaterThanOrEqual(0)
    // Newest first.
    expect(recent[0].name).toBe('recall')
  })
})

describe('recall timeout degradation + fault injection', () => {
  it('returns the fallback instead of throwing, and counts a timeout', async () => {
    const repo = new SlowRepo()
    const { service, metrics, resolver } = makeService(repo, { retrieval: { timeoutMs: 5, topK: 5 } })
    const built = buildFact(raw('Alice 使用 Go 语言'), { resolver, forgetting: buildPolicy({}).forgetting, defaultPrivacy: 'private', now: 1000 })
    await repo.put(built)

    const result = await service.recall({ query: 'Go', scope: 'session:abc', now: 1500 })
    // Degradation path returned active scope facts, did not throw.
    expect(Array.isArray(result)).toBe(true)
    expect(metrics.counter(MetricKeys.recall)).toBe(1)
    expect(metrics.counter(MetricKeys.recallTimeout)).toBeGreaterThanOrEqual(1)
  })
})
