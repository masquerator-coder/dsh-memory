import { describe, expect, it } from 'vitest'
import { normalizeProcedure, stepsFromContent } from '../src/domain/procedural'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { EntityResolver } from '../src/domain/entity'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})
const resolver = new EntityResolver()

describe('normalizeProcedure', () => {
  it('builds steps from string lines', () => {
    const p = normalizeProcedure({ steps: ['跑测试', '灰度发布', '全量发布'] })
    expect(p.steps.map(s => s.tool)).toEqual(['跑测试', '灰度发布', '全量发布'])
    expect(p.steps[0].id).toBe('step_0')
    expect(p.tool_chain).toEqual(['跑测试', '灰度发布', '全量发布'])
  })

  it('carries tool / depends_on / rollback / on_failure from structured input', () => {
    const p = normalizeProcedure({
      steps: [
        { id: 't', tool: 'ci.run', rollback: null },
        { id: 'c', tool: 'k8s.canary', depends_on: ['t'], on_failure: 'rollback', rollback: 'k8s.rollback' },
      ],
    })
    expect(p.steps[1].depends_on).toEqual(['t'])
    expect(p.steps[1].on_failure).toBe('rollback')
    expect(p.steps[1].rollback).toBe('k8s.rollback')
  })

  it('drops dependency references to unknown steps', () => {
    const p = normalizeProcedure({
      steps: [{ id: 'a', tool: 'x', depends_on: ['missing'] }],
    })
    expect(p.steps[0].depends_on).toEqual([])
  })

  it('clamps success_rate to [0,1] and sanitizes retry', () => {
    const p = normalizeProcedure({
      steps: [{ id: 'a', tool: 'x', retry: { max: 2, backoff: 'exponential' } }],
      success_rate: 1.7,
    })
    expect(p.success_rate).toBe(1)
    expect(p.steps[0].retry).toEqual({ max: 2, backoff: 'exponential' })
  })
})

describe('stepsFromContent (P0 migration)', () => {
  it('recognizes numbered/Markdown step lines as a procedure', () => {
    const steps = stepsFromContent('部署流程：\n1. 跑测试\n2. 灰度发布\n3. 全量发布')
    expect(steps.length).toBe(3)
    expect(steps[0].tool).toBe('跑测试')
  })

  it('flags a plain single-line content as non-procedural', () => {
    expect(stepsFromContent('Alice 偏好素食')).toEqual([])
  })
})

describe('procedural fact wiring', () => {
  it('persists normalized steps and derives tool_chain on the fact', () => {
    const normalized = normalizeProcedure({ steps: ['跑测试', '灰度发布'] })
    const assertion: RawAssertion = {
      subject: { type: 'user', name: '用户' },
      predicate: 'deploy_procedure',
      object: { type: 'procedure', name: '发布流程' },
      content: '发布流程：先跑测试再灰度',
      type: 'procedural',
      confidence: 0.8,
      scope: 'session:abc',
      source: { type: 'tool_result', credibility: 0.9 },
      steps: normalized.steps,
      preconditions: normalized.preconditions,
      tool_chain: normalized.tool_chain,
      success_rate: normalized.success_rate,
    }
    const fact = buildFact(assertion, {
      resolver,
      forgetting: policy.forgetting,
      defaultPrivacy: 'private',
      now: 1000,
    })
    expect(fact.type).toBe('procedural')
    expect(fact.steps?.length).toBe(2)
    expect(fact.tool_chain).toEqual(['跑测试', '灰度发布'])
    // Procedural payload does NOT participate in the semantic key; changing
    // only the steps must not change the identity.
    const other = buildFact({ ...assertion, steps: [{ id: 's', tool: '其他' }] }, {
      resolver,
      forgetting: policy.forgetting,
      defaultPrivacy: 'private',
      now: 1000,
    })
    expect(other.semantic_key).toBe(fact.semantic_key)
  })
})
