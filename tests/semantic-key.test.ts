import { describe, expect, it } from 'vitest'
import {
  buildSemanticKey,
  canonicalJson,
  canonicalizeQualifiers,
  qualifierSignature,
} from '../src/domain/semantic-key'

describe('semantic-key', () => {
  it('produces a stable 64-hex key', () => {
    const key = buildSemanticKey('user:alice', 'prefers_diet', 'diet:vegetarian', qualifierSignature('semantic', undefined))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).toBe(buildSemanticKey('user:alice', 'prefers_diet', 'diet:vegetarian', qualifierSignature('semantic', undefined)))
  })

  it('is identical for equal triples regardless of qualifier key order', () => {
    const a = qualifierSignature('semantic', { condition: '工作日午餐', location: '上海' })
    const b = qualifierSignature('semantic', { location: '上海', condition: '工作日午餐' })
    expect(a).toBe(b)
  })

  it('excludes time.valid_from from semantic identity but includes event_time for episodic', () => {
    const semantic = qualifierSignature('semantic', { time: { valid_from: '2026-09-01' }, condition: 'x' })
    const semanticNoDate = qualifierSignature('semantic', { condition: 'x' })
    expect(semantic).toBe(semanticNoDate)

    const epsA = qualifierSignature('episodic', { event_time: '2026-09-05T10:00:00Z' })
    const epsB = qualifierSignature('episodic', {})
    expect(epsA).not.toBe(epsB)
  })

  it('normalizes ISO date strings', () => {
    expect(canonicalizeQualifiers({ condition: 'x' }, 'semantic')).toEqual({ condition: 'x' })
    // A date-looking string is normalized to ISO.
    const c = canonicalizeQualifiers({ event_time: '2026-09-05' }, 'episodic')
    expect(c).toEqual({ event_time: '2026-09-05T00:00:00.000Z' })
  })

  it('canonicalJson sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}')
  })

  it('drops empty values from qualifiers and keeps key ones', () => {
    const c = canonicalizeQualifiers({ condition: '', context: '出差' }, 'semantic')
    expect(c).toEqual({ context: '出差' })
  })
})
