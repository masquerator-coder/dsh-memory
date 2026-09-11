import { describe, expect, it } from 'vitest'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import {
  InMemoryVectorBackend,
  InMemoryGraphBackend,
  InMemoryObjectBackend,
  composeIndexRead,
} from '../src/infrastructure/index-backends'
import { recall } from '../src/application/recall'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({ retrieval: { topK: 10, maxTokens: 800 } })

function makeFact(content: string, id: string, over: Partial<RawAssertion> = {}): ReturnType<typeof buildFact> {
  const res = new EntityResolver()
  res.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  res.upsert({ id: 'concept:go', type: 'concept', name: 'Go 语言', aliases: ['Go', 'Go 语言'] })
  res.upsert({ id: 'concept:pgsql', type: 'concept', name: 'PostgreSQL', aliases: ['PostgreSQL'] })
  res.upsert({ id: 'concept:shanghai', type: 'concept', name: '上海', aliases: ['上海'] })
  const assertion: RawAssertion = {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'uses_technology',
    object: { type: 'concept', name: 'Go 语言' },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
  return buildFact(assertion, { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: id })
}

describe('composeIndexRead', () => {
  it('binds search to the vector backend and graph to the graph backend', async () => {
    const vector = new InMemoryVectorBackend()
    const graph = new InMemoryGraphBackend()
    const read = composeIndexRead([vector, graph, new InMemoryObjectBackend()])
    expect(read.capabilities.search).toBe(true)
    expect(read.capabilities.graph).toBe(true)

    // Degenerate: no vector → search off; no graph → graph off.
    const none = composeIndexRead([new InMemoryObjectBackend()])
    expect(none.capabilities.search).toBe(false)
    expect(none.capabilities.graph).toBe(false)
    expect(await none.search('x', [], 5)).toEqual([])
  })
})

describe('InMemoryVectorBackend search (vector-space read)', () => {
  it('ranks the semantically closer fact above a distant one', async () => {
    const vector = new InMemoryVectorBackend()
    await vector.upsert(makeFact('Alice 使用 Go 语言做后端服务', 'v1'))
    await vector.upsert(makeFact('Alice 喜欢户外徒步和登山', 'v2'))

    const hits = await vector.search('Go 语言后端', ['go', '语言', '后端'], 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].factId).toBe('v1')
    expect(hits[0].relevance).toBeGreaterThan(0)
  })
})

describe('InMemoryGraphBackend reads (§7.4)', () => {
  it('graphNeighbors respects the relation whitelist; graphFactIds returns touching facts', async () => {
    const graph = new InMemoryGraphBackend()
    await graph.upsert(makeFact('Alice 使用 Go 语言', 'g1', { predicate: 'uses_technology' }))
    // A second fact linking to a different concept with a distinct predicate.
    await graph.upsert(makeFact('Alice 位于上海', 'g2', { predicate: 'located_in', object: { type: 'concept', name: '上海' } }))

    const fact = await graph.graphFactIds('user:alice', 10)
    expect([...fact].sort()).toEqual(['g1', 'g2'])

    // Whitelist only uses_technology → neighbor 'concept:go' reachable, '上海' not.
    const tech = await graph.graphNeighbors('user:alice', ['uses_technology'])
    expect(tech).toContain('concept:go')
    expect(tech).not.toContain('concept:shanghai')
    const all = await graph.graphNeighbors('user:alice', [])
    expect(all.length).toBeGreaterThanOrEqual(2)
  })
})

describe('recall routes to the derived backends when a read is supplied', () => {
  it('uses vector search for candidates and graph for expansion', async () => {
    const repo = new JsonFileMemoryRepository()
    const vector = new InMemoryVectorBackend()
    const graph = new InMemoryGraphBackend()

    const seeded = makeFact('Alice 使用 Go 语言做后端', 'seed')
    const related = makeFact('Go 语言生态有 gin 框架', 'rel', { subject: { type: 'concept', name: 'Go 语言' } })
    await repo.put(seeded)
    await repo.put(related)
    await vector.upsert(seeded)
    await vector.upsert(related)
    await graph.upsert(seeded)
    await graph.upsert(related)

    const read = composeIndexRead([vector, graph, new InMemoryObjectBackend()])
    const result = await recall(policy, repo, { query: 'Go 后端', scope: 'session:abc', read, now: 2000 })
    expect(result.length).toBeGreaterThan(0)
    // At least the seed is surfaced.
    expect(result.map(r => r.fact.id)).toContain('seed')
  })

  it('keeps the KV lexical fallback when no read is supplied (unchanged path)', async () => {
    const repo = new JsonFileMemoryRepository()
    await repo.put(makeFact('Alice 使用 Go 语言做后端', 'seed'))
    const result = await recall(policy, repo, { query: 'Go 后端', scope: 'session:abc', now: 2000 })
    expect(result.map(r => r.fact.id)).toContain('seed')
  })
})
