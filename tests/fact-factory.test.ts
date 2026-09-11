import { describe, expect, it } from 'vitest'
import { buildFact, supersedeFact, type RawAssertion } from '../src/domain/factory'
import { EntityResolver } from '../src/domain/entity'
import { buildPolicy } from '../src/build-policy'
import { canonicalizePredicate } from '../src/domain/predicate'

const forgetting = buildPolicy({}).forgetting

function assertion(over: Partial<RawAssertion> = {}): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content: 'Alice 偏好素食',
    type: 'semantic',
    confidence: 0.85,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
}

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice', 'alice'] })
  r.upsert({ id: 'concept:vegetarian', type: 'concept', name: '素食', aliases: ['素食', 'vegetarian'] })
  return r
}

describe('buildFact', () => {
  it('normalizes subject/object ids and canonical predicate', () => {
    const fact = buildFact(assertion(), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 0, idOverride: 'fact_x' })
    expect(fact.id).toBe('fact_x')
    expect(fact.subject.id).toBe('user:alice')
    expect(fact.object.id).toBe('concept:vegetarian')
    expect(fact.canonical_predicate).toBe('prefers_diet')
    expect(fact.status).toBe('active')
    expect(fact.version).toBe(1)
    expect(fact.privacy).toBe('private')
  })

  it('computes an expiry from the semantic TTL', () => {
    const fact = buildFact(assertion(), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 1_000_000, idOverride: 'x' })
    expect(fact.expires_at).toBe(1_000_000 + (365 * 86_400_000))
  })

  it('keeps same-assertion semantic keys equal across alias spellings', () => {
    const a = buildFact(assertion({ object: { type: 'concept', name: '素食' } }), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 0, idOverride: 'a' })
    const b = buildFact(assertion({ object: { type: 'concept', name: 'vegetarian' } }), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 0, idOverride: 'b' })
    expect(a.semantic_key).toBe(b.semantic_key)
  })
})

describe('supersedeFact', () => {
  it('raises the version and preserves created_at', () => {
    const prior = buildFact(assertion(), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 100, idOverride: 'old' })
    const next = supersedeFact(prior, assertion({ content: 'Alice 现在偏好海鲜' }), { resolver: resolver(), forgetting, defaultPrivacy: 'private', now: 200 })
    expect(next.version).toBe(2)
    expect(next.supersedes).toBe('old')
    expect(next.created_at).toBe(100)
    expect(next.updated_at).toBe(200)
  })
})

describe('canonicalizePredicate', () => {
  it('maps synonyms to one canonical form', () => {
    expect(canonicalizePredicate('likes_diet')).toBe('prefers_diet')
    expect(canonicalizePredicate('enjoys_diet')).toBe('prefers_diet')
    expect(canonicalizePredicate('喜欢素食')).toBe('prefers_diet')
  })

  it('passes unknown predicates through normalized', () => {
    const x = canonicalizePredicate('runs marathons')
    expect(x).toBe('runs_marathons')
  })
})
