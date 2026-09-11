import { describe, expect, it } from 'vitest'
import {
  InMemoryVectorBackend,
  InMemoryGraphBackend,
  InMemoryObjectBackend,
  defaultIndexBackends,
} from '../src/infrastructure/index-backends'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})

function build(content: string, id = 'fact_x'): ReturnType<typeof buildFact> {
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

describe('in-memory derived backends', () => {
  it('defaultIndexBackends registers the standard triple', () => {
    const backends = defaultIndexBackends()
    expect(backends.map(b => b.name).sort()).toEqual(['graph', 'object', 'vector'])
  })

  it('upsert / remove keep them in sync by fact id (idempotent remove)', async () => {
    const vector = new InMemoryVectorBackend()
    const graph = new InMemoryGraphBackend()
    const object = new InMemoryObjectBackend()
    const fact = build('素食偏好')

    await vector.upsert(fact)
    await graph.upsert(fact)
    await object.upsert(fact)
    expect(await vector.count()).toBe(1)
    expect(await graph.count()).toBe(1)
    expect(await object.count()).toBe(1)
    expect(vector.has(fact.id) && graph.has(fact.id) && object.has(fact.id)).toBe(true)

    await vector.remove(fact.id)
    await vector.remove(fact.id) // idempotent second remove
    await graph.remove(fact.id)
    await object.remove(fact.id)
    expect(await vector.count()).toBe(0)
    expect(await graph.count()).toBe(0)
    expect(await object.count()).toBe(0)
  })

  it('health reports availability; injectFault makes upsert throw', async () => {
    const vector = new InMemoryVectorBackend()
    expect(vector.health().ok).toBe(true)
    vector.injectFault(1)
    await expect(vector.upsert(build('x'))).rejects.toThrow('injected')
    vector.setHealthy(false)
    expect(vector.health().ok).toBe(false)
    await expect(vector.upsert(build('y'))).rejects.toThrow('unavailable')
  })
})
