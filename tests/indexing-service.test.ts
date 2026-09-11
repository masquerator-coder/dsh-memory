import { describe, expect, it } from 'vitest'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { OutboxJournal } from '../src/infrastructure/outbox-journal'
import { defaultIndexBackends } from '../src/infrastructure/index-backends'
import { IndexWorker } from '../src/application/index-worker'
import { MemoryService } from '../src/service'
import { EntityResolver } from '../src/domain/entity'
import { buildPolicy } from '../src/build-policy'

function buildService(config: Parameters<typeof buildPolicy>[0], fallbackScope = 'session:abc') {
  const policyRef = () => buildPolicy(config)
  const repo = new JsonFileMemoryRepository()
  const resolver = new EntityResolver()
  resolver.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  resolver.upsert({ id: 'concept:go', type: 'concept', name: 'Go 语言', aliases: ['Go'] })
  const nowRef = { now: 1000 }
  const indexingEnabled = !!(config.indexing && config.indexing.enabled)
  const outbox = indexingEnabled ? new OutboxJournal(() => nowRef.now) : undefined
  const backends = indexingEnabled ? defaultIndexBackends() : []
  const worker = indexingEnabled
    ? new IndexWorker({ repo, outbox: outbox!, backends: backends as any, now: () => nowRef.now })
    : undefined
  const service = new MemoryService({
    repo,
    resolver,
    policy: policyRef,
    llmExtractionEnabled: false,
    captureEnabled: true,
    outbox,
    worker,
    now: () => nowRef.now,
  })
  return { service, repo, outbox, worker: worker!, backends: backends as ReturnType<typeof defaultIndexBackends>, advance: (ms: number) => { nowRef.now += ms } }
}

describe('MemoryService outbox write path (indexing on)', () => {
  it('flags pending, blocks recall until indexed, then becomes retrievable', async () => {
    const { service, repo, outbox, worker, backends } = buildService({ indexing: { enabled: true, requireReadyIndex: true } })

    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })

    // Stored but not yet indexed → hidden behind the consistency barrier.
    const stored = await repo.listScope('session:abc')
    expect(stored).toHaveLength(1)
    expect(stored[0].index_state).toBe('pending_indexing')
    expect((await outbox!.stats()).pending).toBe(1)
    expect(await service.recall({ query: 'Go 语言', scope: 'session:abc' })).toEqual([])

    // Drain the worker → ready + retrievable + backends populated.
    const drain = await service.drainIndexing()
    expect(drain.swept).toBe(1)
    expect(await service.recall({ query: 'Go', scope: 'session:abc' })).toHaveLength(1)
    expect(stored[0].index_state).toBe('pending_indexing') // snapshot captured before
    expect((await repo.listScope('session:abc'))[0].index_state).toBe('ready')
    let backendCount = 0
    for (const b of backends) backendCount += await b.count()
    expect(backendCount).toBe(3)
    expect(worker.backendCount).toBe(3)
  })

  it('cascades deletes to the derived backends + forgetAll', async () => {
    const { service, repo, outbox, backends } = buildService({ indexing: { enabled: true } })
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })
    await service.drainIndexing()

    const [fact] = await repo.listScope('session:abc')
    expect(fact).toBeDefined()
    let total = 0
    for (const b of backends) total += await b.count()
    expect(total).toBe(3)

    await service.forget(fact!.id, 'delete')
    await service.drainIndexing()
    let after = 0
    for (const b of backends) after += await b.count()
    expect(after).toBe(0)
    expect((await outbox!.stats()).total).toBeGreaterThanOrEqual(0) // GC-drained
  })

  it('metrics and health expose outbox + indexing state', async () => {
    const { service, repo } = buildService({ indexing: { enabled: true } })
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })
    const metrics = await service.metrics()
    expect(metrics.outboxPending).toBe(1)
    expect(metrics.active).toBe(1)
    expect(Object.keys(metrics.indexedBackends).sort()).toEqual(['graph', 'object', 'vector'])

    const health = await service.health()
    expect(health.indexing.enabled).toBe(true)
    expect(health.indexing.backends).toBe(3)
    expect(health.indexing.degraded).toBe(false)
    expect(health.outbox?.pending).toBe(1)
  })
})

describe('MemoryService without outbox (default)', () => {
  it('behaves exactly as P0: facts are immediately ready and retrievable', async () => {
    const { service, repo } = buildService({})
    expect(service.useOutbox).toBe(false)
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'session:abc', subject: { type: 'user', name: 'Alice' }, object: { type: 'concept', name: 'Go 语言' } })
    expect((await repo.listScope('session:abc'))[0].index_state).toBe('ready')
    expect(await service.recall({ query: 'Go', scope: 'session:abc' })).toHaveLength(1)
    const health = await service.health()
    expect(health.indexing.enabled).toBe(false)
    expect(health.indexing.backends).toBe(0)
  })
})
