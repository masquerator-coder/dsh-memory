import { describe, expect, it } from 'vitest'
import { buildEntityCard } from '../src/application/card'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice', 'alice'] })
  r.upsert({ id: 'diet:vegetarian', type: 'concept', name: '素食', aliases: ['素食'] })
  r.upsert({ id: 'diet:keto', type: 'concept', name: '生酮', aliases: ['生酮'] })
  r.upsert({ id: 'lang:go', type: 'concept', name: 'Go 语言', aliases: ['Go'] })
  return r
}

function raw(over: Partial<RawAssertion>): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content: 'Alice 偏好素食',
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
}

async function seed(facts: RawAssertion[]) {
  const repo = new JsonFileMemoryRepository()
  const res = resolver()
  const now = 1000
  let i = 0
  for (const a of facts) {
    const fact = buildFact(a, { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: now + i, idOverride: `id${i}` })
    await repo.put(fact)
    i += 1
  }
  return { repo, res }
}

describe('buildEntityCard', () => {
  it('returns an empty card for an unknown entity', async () => {
    const { repo } = await seed([])
    const card = await buildEntityCard(repo, 'user:nobody')
    expect(card.count).toBe(0)
    expect(card.summary).toEqual([])
    expect(card.groups).toEqual([])
    expect(card.entityId).toBe('user:nobody')
  })

  it('groups facts by canonical predicate and orders by confidence', async () => {
    const { repo } = await seed([
      raw({ predicate: 'prefers_diet', content: 'Alice 偏好素食', confidence: 0.5 }),
      raw({ predicate: 'prefers_diet', object: { type: 'concept', name: '生酮' }, content: 'Alice 偏好生酮', confidence: 0.9 }),
      raw({ predicate: 'uses_technology', object: { type: 'concept', name: 'Go 语言' }, content: 'Alice 使用 Go 语言', confidence: 0.8 }),
    ])
    const card = await buildEntityCard(repo, 'user:alice')
    expect(card.entityName).toBe('Alice')
    expect(card.count).toBe(3)
    expect(card.groups.map(g => g.predicate).sort()).toEqual(['prefers_diet', 'uses_technology'])
    const diet = card.groups.find(g => g.predicate === 'prefers_diet')!
    // Higher confidence first within the group.
    expect(diet.facts[0].content).toBe('Alice 偏好生酮')
    expect(diet.facts[1].content).toBe('Alice 偏好素食')
  })

  it('caps the summary to the token budget and always includes the first line', async () => {
    const { repo } = await seed(
      Array.from({ length: 20 }, (_, i) => raw({ content: `Alice 偏好项编号 ${i}`, confidence: 1 - i / 40 })),
    )
    const card = await buildEntityCard(repo, 'user:alice', { summaryTokens: 40 })
    expect(card.summary.length).toBeGreaterThan(0)
    // Never exceeds the budget after the first line.
    let tokens = 0
    card.summary.forEach((line, idx) => {
      tokens += Math.ceil(line.length / 4)
      if (idx > 0) expect(tokens).toBeLessThanOrEqual(40)
    })
  })

  it('excludes secrets unless requested and drops PII by default', async () => {
    const { repo } = await seed([
      raw({ content: 'Alice 偏好素食', privacy: 'private', pii: false }),
      raw({ content: 'Alice 的秘密口令', privacy: 'secret', pii: true }),
    ])
    const card = await buildEntityCard(repo, 'user:alice')
    expect(card.count).toBe(1)
    expect(card.summary[0]).toContain('素食')
  })
})
