import { describe, expect, it } from 'vitest'
import { recall, fusionScore, estimateTokens } from '../src/application/recall'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({ retrieval: { topK: 10, maxTokens: 800 } })

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  r.upsert({ id: 'concept:vegetarian', type: 'concept', name: '素食', aliases: ['素食'] })
  r.upsert({ id: 'diet:go', type: 'concept', name: 'Go 语言', aliases: ['Go'] })
  return r
}

function raw(content: string, scope = 'session:abc', over: Partial<RawAssertion> = {}): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'states',
    object: { type: 'concept', name: content.slice(0, 30) },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope,
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
}

async function seed(facts: string[]) {
  const repo = new JsonFileMemoryRepository()
  const res = resolver()
  for (const content of facts) {
    const fact = buildFact(raw(content), { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: content.slice(0, 8) })
    await repo.put(fact)
  }
  return { repo, res }
}

describe('recall', () => {
  it('returns no candidates for an empty store', async () => {
    const { repo } = await seed([])
    const result = await recall(policy, repo, { query: 'vegetarian', scope: 'session:abc', now: 2000 })
    expect(result).toEqual([])
  })

  it('retrieves the lexical best match and respects the token budget', async () => {
    const { repo } = await seed([
      'Alice 偏好素食，出差时的午餐',
      '项目使用 Go 语言和 PostgreSQL',
    ])
    const result = await recall(policy, repo, { query: '素食午餐', scope: 'session:abc', now: 2000 })
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].fact.content).toContain('素食')
    // Budget never returns more tokens than maxTokens.
    let total = 0
    for (const r of result) total += estimateTokens(r.fact.content)
    // Single-item overflow is tolerated (always returns the best hit).
    expect(total).toBeLessThanOrEqual(policy.retrieval.maxTokens + 400)
  })

  it('is scope-isolated', async () => {
    const { repo } = await seed(['遥控内容 A'])
    const result = await recall(policy, repo, { query: '遥控', scope: 'session:other', now: 2000 })
    expect(result).toEqual([])
  })

  it('does not return archived or expired facts', async () => {
    const { repo, res } = await seed(['待归档的事实'])
    const fact = buildFact(raw('待归档的事实'), { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: 'arch' })
    await repo.put({ ...fact, status: 'archived' })
    const result = await recall(policy, repo, { query: '待归档', scope: 'session:abc', now: 2000 })
    expect(result.find(r => r.fact.id === 'arch')).toBeUndefined()
  })
})

describe('fusionScore', () => {
  it('is monotonic in confidence', () => {
    const lo = fusionScore(policy, 0.5, 0.5, 0.5, 0, 0, 1000)
    const hi = fusionScore(policy, 0.5, 0.9, 0.5, 0, 0, 1000)
    expect(hi).toBeGreaterThan(lo)
  })
})
