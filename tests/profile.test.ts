import { describe, expect, it } from 'vitest'
import { buildPolicy, resolveProfileKind } from '../src/build-policy'
import { Config } from '../src/config'
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

/**
 * Regression guard for the wiring, not the table: Cordis resolves the config
 * through the exported schema *before* `apply()`, so a `.default()` on any
 * profile-dependent key makes `undefined` impossible and silently freezes every
 * profile on the personal values.
 */
describe('profile differences survive the real config path', () => {
  it('leaves profile-dependent keys unset in the schema', () => {
    const parsed = Config({ profile: 'research' })
    expect(parsed.retrieval?.versions).toBeUndefined()
    expect(parsed.retrieval?.graph?.maxDepth).toBeUndefined()
    expect(parsed.retrieval?.graph?.maxFanoutPerEntity).toBeUndefined()
    expect(parsed.retrieval?.graph?.maxCandidates).toBeUndefined()
    expect(parsed.forgetting?.semantic?.ttl).toBeUndefined()
    expect(parsed.forgetting?.semantic?.lambda).toBeUndefined()
    expect(parsed.privacy?.default).toBeUndefined()
    // schemastery materializes an absent array as `[]`; buildPolicy must read
    // that as "unset" (see nonEmpty).
    expect(parsed.privacy?.retrievalFilter).toEqual([])
  })

  it('research applies its §10.2 differences after schema resolution', () => {
    const research = buildPolicy(Config({ profile: 'research' }))
    expect(research.profileKind).toBe('research')
    expect(research.retrieval.versions).toBe('all')
    expect(research.retrieval.graph.maxDepth).toBe(3)
    expect(research.retrieval.graph.maxFanoutPerEntity).toBe(60)
    expect(research.retrieval.graph.maxCandidates).toBe(400)
    expect(research.forgetting.semantic.ttl).toBe('730d')
    expect(research.forgetting.semantic.lambda).toBe(0.0001)
    expect(research.forgetting.episodic.ttl).toBe('365d')
    expect(research.privacy.default).toBe('confidential')
    expect(research.privacy.retrievalFilter).toContain('confidential')
  })

  it('personal keeps its P0 defaults after schema resolution', () => {
    const personal = buildPolicy(Config({}))
    expect(personal.retrieval.versions).toBe('active')
    expect(personal.retrieval.graph.maxFanoutPerEntity).toBe(30)
    expect(personal.forgetting.semantic.ttl).toBe('365d')
    expect(personal.privacy.default).toBe('private')
    expect(personal.privacy.retrievalFilter).toEqual(['public', 'private'])
  })

  it('an explicit value still wins over the profile default', () => {
    const explicit = buildPolicy(Config({
      profile: 'research',
      retrieval: { versions: 'active', graph: { maxDepth: 2, maxFanoutPerEntity: 10, maxCandidates: 50 } },
      forgetting: { semantic: { ttl: '30d', lambda: 0.05 } },
      privacy: { default: 'private', retrievalFilter: ['public'] },
    }))
    expect(explicit.retrieval.versions).toBe('active')
    expect(explicit.retrieval.graph.maxDepth).toBe(2)
    expect(explicit.retrieval.graph.maxFanoutPerEntity).toBe(10)
    expect(explicit.forgetting.semantic.ttl).toBe('30d')
    expect(explicit.forgetting.semantic.lambda).toBe(0.05)
    expect(explicit.privacy.default).toBe('private')
    expect(explicit.privacy.retrievalFilter).toEqual(['public'])
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
