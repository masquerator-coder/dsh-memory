import { describe, expect, it } from 'vitest'
import {
  invariantFactHasScope,
  invariantSemanticKeyReproducible,
  withinBudget,
} from '../src/invariant'

describe('invariant', () => {
  it('accepts real semantic keys', () => {
    expect(invariantSemanticKeyReproducible('user:a', 'prefers_diet', 'diet:v', 'sig', 'a'.repeat(64))).toBe(true)
    expect(invariantSemanticKeyReproducible('user:a', 'prefers_diet', 'diet:v', '', 'short')).toBe(false)
  })

  it('requires a non-empty scope', () => {
    expect(invariantFactHasScope('session:abc')).toBe(true)
    expect(invariantFactHasScope('')).toBe(false)
  })

  it('bounds recall within budget', () => {
    expect(withinBudget(20, 20)).toBe(true)
    expect(withinBudget(21, 20)).toBe(false)
  })
})
