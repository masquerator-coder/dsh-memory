import { describe, expect, it } from 'vitest'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { OutboxJournal } from '../src/infrastructure/outbox-journal'
import {
  InMemoryVectorBackend,
  InMemoryGraphBackend,
  InMemoryObjectBackend,
} from '../src/infrastructure/index-backends'
import { IndexWorker } from '../src/application/index-worker'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})

function makeFact(content: string, id = 'fact_1', status: any = 'active'): ReturnType<typeof buildFact> {
  const res = new EntityResolver()
  const assertion: RawAssertion = {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
  }
  return buildFact(assertion, { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: id })
}

/** Wire a repo + journal + three backends + worker with a controllable clock. */
function rig(over: ConstructorParameters<typeof IndexWorker>[0]['backoff'] = {}) {
  const repo = new JsonFileMemoryRepository()
  const outbox = new OutboxJournal(() => clock)
  let clock = 1000
  const vector = new InMemoryVectorBackend()
  const graph = new InMemoryGraphBackend()
  const object = new InMemoryObjectBackend()
  const backends = [vector, graph, object]
  const worker = new IndexWorker({ repo, outbox, backends, backoff: over, now: () => clock })
  return { repo, outbox, worker, vector, graph, object, setClock: (t: number) => { clock = t } }
}

describe('IndexWorker outbox/Saga', () => {
  it('indexes a pending fact into every backend and flips it to ready', async () => {
    const { repo, outbox, worker, vector, graph, object } = rig()
    const fact = makeFact('素食偏好')
    await repo.put({ ...fact, index_state: 'pending_indexing' })
    await outbox.append('index', fact.id, fact.scope)

    const report = await worker.tick(1000)
    expect(report.indexed).toBe(1)
    expect(report.failed).toBe(0)

    const stored = await repo.get(fact.id)
    expect(stored?.index_state).toBe('ready')
    expect(vector.has(fact.id)).toBe(true)
    expect(graph.has(fact.id)).toBe(true)
    expect(object.has(fact.id)).toBe(true)
    // GC: the entry is removed after success.
    expect((await outbox.stats()).total).toBe(0)
  })

  it('unindexes a forgotten fact from every backend (tombstone cascade)', async () => {
    const { repo, outbox, worker, vector, graph, object } = rig()
    const fact = makeFact('要遗忘')
    await repo.put(fact)
    await outbox.append('index', fact.id, fact.scope)
    await worker.tick(1000)
    expect(vector.has(fact.id)).toBe(true)

    // Tombstone: archive the KV fact and publish an unindex entry.
    await repo.put({ ...fact, status: 'archived', updated_at: 1100 })
    await outbox.append('unindex', fact.id, fact.scope)
    const report = await worker.tick(1100)
    expect(report.unindexed).toBe(1)
    expect(vector.has(fact.id)).toBe(false)
    expect(graph.has(fact.id)).toBe(false)
    expect(object.has(fact.id)).toBe(false)
  })

  it('treats an index entry for a vanished/non-active fact as a no-op success', async () => {
    const { repo, outbox, worker, vector } = rig()
    const fact = makeFact('gone')
    await repo.put(fact)
    await outbox.append('index', fact.id, fact.scope)
    await repo.delete(fact.id) // removed before the worker ran
    const report = await worker.tick(1000)
    expect(report.indexed).toBe(1)
    expect(vector.has(fact.id)).toBe(false)
    expect((await outbox.stats()).total).toBe(0)
  })

  it('retries a transient backend failure with backoff and then succeeds', async () => {
    const { repo, outbox, worker, vector, setClock } = rig({ baseMs: 50, factor: 2, capMs: 1000, maxRetries: 5 })
    const fact = makeFact('重试')
    await repo.put({ ...fact, index_state: 'pending_indexing' })
    await outbox.append('index', fact.id, fact.scope)

    vector.injectFault(1) // first write fails
    const first = await worker.tick(1000)
    expect(first.failed).toBe(1)
    expect(first.indexed).toBe(0)
    // Fact stays pending; entry scheduled for retry.
    expect((await repo.get(fact.id))?.index_state).toBe('pending_indexing')
    expect((await outbox.stats()).failed).toBe(1)

    // Advance clock past the backoff horizon and retry — now it succeeds.
    setClock(2000)
    const second = await worker.tick(2000)
    expect(second.indexed).toBe(1)
    expect((await repo.get(fact.id))?.index_state).toBe('ready')
    expect(vector.has(fact.id)).toBe(true)
  })

  it('graduates to the DLQ and flags index_failed after retries are exhausted', async () => {
    const { repo, outbox, worker, vector, graph, object } = rig({ baseMs: 10, factor: 2, capMs: 100, maxRetries: 2 })
    const fact = makeFact('失败')
    await repo.put({ ...fact, index_state: 'pending_indexing' })
    await outbox.append('index', fact.id, fact.scope)

    // Every backend down — persistent outage that exhausts retries → DLQ.
    vector.setHealthy(false)
    graph.setHealthy(false)
    object.setHealthy(false)
    await worker.tick(1000)
    await worker.tick(1200) // attempt 2 >= maxRetries → dead
    const stats = await outbox.stats()
    expect(stats.dead).toBe(1)
    expect((await repo.get(fact.id))?.index_state).toBe('index_failed')
    expect(worker.degraded().ok).toBe(false)
  })

  it('skips unhealthy backends without burning retries, and surfaces degradation', async () => {
    const { repo, outbox, worker, vector, object, setClock } = rig({ maxRetries: 5 })
    const fact = makeFact('部分降级')
    await repo.put({ ...fact, index_state: 'pending_indexing' })
    await outbox.append('index', fact.id, fact.scope)

    object.setHealthy(false) // one backend down
    const report = await worker.tick(1000)
    // Two healthy backends still indexed it; the down one was skipped.
    expect(report.indexed).toBe(1)
    expect(report.skippedUnhealthy).toBe(1)
    expect(worker.backendCount).toBe(3)
    expect(worker.degraded().ok).toBe(false)
    expect(vector.has(fact.id)).toBe(true)
    expect((await repo.get(fact.id))?.index_state).toBe('ready')
  })

  it('with zero backends indexing trivially succeeds (immediately consistent)', async () => {
    const repo = new JsonFileMemoryRepository()
    const outbox = new OutboxJournal(() => 1000)
    const worker = new IndexWorker({ repo, outbox, backends: [], now: () => 1000 })
    const fact = makeFact('空后端')
    await repo.put(fact)
    await outbox.append('index', fact.id, fact.scope)
    const report = await worker.tick(1000)
    expect(report.attempted).toBe(1)
    expect(report.indexed).toBe(1) // no backends ⇒ nothing to propagate; success
    expect((await repo.get(fact.id))?.index_state).toBe('ready')
  })
})
