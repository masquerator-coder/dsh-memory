import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../src/build-policy'
import { parseTtlMs, recencyScore } from '../src/domain/policies'

describe('buildPolicy', () => {
  it('applies design defaults when config is empty', () => {
    const p = buildPolicy({})
    expect(p.profile).toBe('personal')
    expect(p.retrieval.topK).toBe(20)
    expect(p.retrieval.maxTokens).toBe(800)
    expect(p.retrieval.timeoutMs).toBe(80)
    expect(p.retrieval.ranking.w1).toBeGreaterThan(0)
    expect(p.privacy.default).toBe('private')
    expect(p.privacy.retrievalFilter).toEqual(['public', 'private'])
    expect(p.forgetting.semantic.ttl).toBe('365d')
    expect(p.forgetting.episodic.lambda).toBe(0.02)
  })

  it('honors overridden values', () => {
    const p = buildPolicy({ retrieval: { topK: 5 }, privacy: { default: 'confidential' } })
    expect(p.retrieval.topK).toBe(5)
    expect(p.privacy.default).toBe('confidential')
  })
})

describe('parseTtlMs', () => {
  it('parses ISO-ish durations', () => {
    expect(parseTtlMs('90d')).toBe(90 * 86_400_000)
    expect(parseTtlMs('12h')).toBe(12 * 3_600_000)
    expect(parseTtlMs('1y')).toBe(31_536_000_000)
    expect(parseTtlMs(null)).toBeNull()
    expect(parseTtlMs('')).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseTtlMs('not-a-ttl')).toBeNull()
  })
})

describe('recencyScore', () => {
  it('is 1 for zero age and decays exponentially', () => {
    expect(recencyScore(0.001, 0)).toBe(1)
    const one = recencyScore(0.02, 86_400_000) // 1 day, lambda 0.02
    expect(one).toBeCloseTo(Math.exp(-0.02), 5)
    expect(recencyScore(0.02, 30 * 86_400_000)).toBeLessThan(recencyScore(0.02, 86_400_000))
  })
})
