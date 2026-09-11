import { describe, expect, it } from 'vitest'
import { buildPolicy, resolveProfileKind } from '../src/build-policy'
import { recall } from '../src/application/recall'
import { rememberOne } from '../src/application/remember'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import type { RawAssertion } from '../src/domain/factory'

describe('resolveProfileKind', () => {
  it('maps research strings onto the research profile, everything else personal', () => {
    expect(resolveProfileKind('research')).toBe('research')
    expect(resolveProfileKind('research-agent')).toBe('research')
    expect(resolveProfileKind('personal')).toBe('personal')
    expect(resolveProfileKind(undefined)).toBe('personal')
    expect(resolveProfileKind('custom')).toBe('personal')
  })
})

describe('buildPolicy profile differences (§10.2)', () => {
  it('research: all-version retrieval, larger fan-out, weaker decay/longer TTL, looser privacy', () => {
    const research = buildPolicy({ profile: 'research' })
    expect(research.profileKind).toBe('research')
    expect(research.retrieval.versions).toBe('all')
    expect(research.retrieval.graph.maxFanoutPerEntity).toBe(60)
    expect(research.retrieval.graph.maxDepth).toBe(3)
    // weaker decay (keeps history) + longer TTL
    expect(research.forgetting.semantic.lambda).toBe(0.0001)
    expect(research.forgetting.semantic.ttl).toBe('730d')
    expect(research.forgetting.episodic.lambda).toBe(0.005)
    // research may surface confidential evidence
    expect(research.privacy.retrievalFilter).toContain('confidential')
  })

  it('personal keeps exact P0 defaults', () => {
    const personal = buildPolicy({})
    expect(personal.profileKind).toBe('personal')
    expect(personal.retrieval.versions).toBe('active')
    expect(personal.retrieval.graph.maxFanoutPerEntity).toBe(30)
    expect(personal.retrieval.graph.maxDepth).toBe(2)
    expect(personal.forgetting.semantic.lambda).toBe(0.001)
    expect(personal.forgetting.semantic.ttl).toBe('365d')
    expect(personal.privacy.retrievalFilter).not.toContain('confidential')
  })
})

function assertion(credibility: number, content: string, over: Partial<RawAssertion> = {}): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility },
    ...over,
  }
}

async function supersededPair() {
  const repo = new JsonFileMemoryRepository()
  const resolver = new EntityResolver()
  resolver.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  resolver.upsert({ id: 'concept:vegetarian', type: 'concept', name: '素食', aliases: ['素食'] })
  const personalPolicy = buildPolicy({})
  const researchPolicy = buildPolicy({ profile: 'research' })
  const deps = { repo, resolver, forgetting: personalPolicy.forgetting, defaultPrivacy: personalPolicy.privacy.default }
  await rememberOne(deps, assertion(0.5, '旧说法'))
  const second = await rememberOne(deps, assertion(0.9, '新说法'))
  return { repo, resolver, personalPolicy, researchPolicy, supersededId: second.superseded! }
}

describe('all-version retrieval (research) vs active-only (personal)', () => {
  it('research recalls superseded versions; personal collapses to active', async () => {
    const { repo, resolver, personalPolicy, researchPolicy, supersededId } = await supersededPair()

    // Personal: only the active new version surfaces.
    const personal = await recall(personalPolicy, repo, { query: '素食', scope: 'session:abc' })
    expect(personal.map(r => r.fact.status)).not.toContain('superseded')
    expect(personal.map(r => r.fact.id)).not.toContain(supersededId)

    // Research: both versions surface for evolution/contradiction analysis.
    const research = await recall(researchPolicy, repo, { query: '素食', scope: 'session:abc' })
    expect(research.map(r => r.fact.id)).toContain(supersededId)
    expect(research.map(r => r.fact.id).length).toBeGreaterThanOrEqual(2)
  })
})
