import { describe, expect, it } from 'vitest'
import { consolidateScope } from '../src/application/consolidate'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, supersedeFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})

function resolver() {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  r.upsert({ id: 'concept:veg', type: 'concept', name: '素食', aliases: ['素食'] })
  return r
}

function raw(content: string, over: Partial<RawAssertion> = {}): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
}

describe('consolidateScope', () => {
  it('expires facts past their ttl', async () => {
    const repo = new JsonFileMemoryRepository()
    const res = resolver()
    // Short ttl: build a fact with a manual expiry far in the past.
    const fact = buildFact(raw('过期的事实'), { resolver: res, forgetting: { ...policy.forgetting, semantic: { ttl: '1m', lambda: 0 } }, defaultPrivacy: 'private', now: 1000, idOverride: 'exp' })
    await repo.put({ ...fact, expires_at: 500 })
    const report = await consolidateScope(repo, 'session:abc', 1000)
    expect(report.expired).toBe(1)
    const stored = await repo.get('exp')
    expect(stored?.status).toBe('expired')
  })

  it('merges duplicate semantic keys keeping the newer version', async () => {
    const repo = new JsonFileMemoryRepository()
    const res = resolver()
    const base = buildFact(raw('事实版本一'), { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: 'v1' })
    await repo.put(base)
    const next = supersedeFact(base, raw('事实版本二'), { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 2000 })
    await repo.put(next)
    // same key now has v1 (active) and v2 (active); consolidate marks v1 superseded.
    const report = await consolidateScope(repo, 'session:abc', 5000)
    expect(report.merged).toBeGreaterThan(0)
    const v1 = await repo.get('v1')
    expect(v1?.status).toBe('superseded')
  })
})
