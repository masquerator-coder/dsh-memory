import { describe, expect, it } from 'vitest'
import { rememberOne } from '../src/application/remember'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice', 'alice'] })
  r.upsert({ id: 'concept:vegetarian', type: 'concept', name: '素食', aliases: ['素食', 'vegetarian'] })
  return r
}

function assertion(sourceCredibility: number, confidence: number, content = 'Alice 偏好素食'): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'prefers_diet',
    object: { type: 'concept', name: '素食' },
    content,
    type: 'semantic',
    confidence,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: sourceCredibility },
  }
}

async function setup() {
  const repo = new JsonFileMemoryRepository()
  const res = resolver()
  const deps = { repo, resolver: res, forgetting: policy.forgetting, defaultPrivacy: policy.privacy.default }
  const build = (input: RawAssertion) => buildFact(input, { resolver: res, forgetting: policy.forgetting, defaultPrivacy: policy.privacy.default, now: 1000 })
  return { repo, deps, build }
}

describe('rememberOne', () => {
  it('stores a brand-new assertion', async () => {
    const { repo, deps, build } = await setup()
    const outcome = await rememberOne(deps, assertion(0.7, 0.8))
    expect(outcome.superseded).toBeUndefined()
    expect(outcome.events).toContainEqual({ kind: 'fact_stored', factId: outcome.stored.id, scope: 'session:abc' })
    expect(await repo.get(outcome.stored.id)).toBeDefined()
    // build() exercises the factory wiring (kept referenced for parity).
    expect(build(assertion(0.7, 0.8)).semantic_key).toBe(outcome.stored.semantic_key)
  })

  it('supersedes an older same-key fact when the incoming has higher credibility', async () => {
    const { deps } = await setup()
    await rememberOne(deps, assertion(0.5, 0.8, '旧说法'))
    const outcome = await rememberOne(deps, assertion(0.9, 0.8, '新说法'))
    expect(outcome.superseded).toBeDefined()
    expect(outcome.stored.version).toBe(2)
    const old = await deps.repo.get(outcome.superseded!)
    expect(old?.status).toBe('superseded')
  })

  it('keeps the existing fact when the incoming is weaker', async () => {
    const { deps } = await setup()
    const first = await rememberOne(deps, assertion(0.9, 0.95, '强事实'))
    const outcome = await rememberOne(deps, assertion(0.5, 0.8, '弱事实'))
    expect(outcome.retained).toBe(first.stored.id)
    expect(outcome.superseded).toBeUndefined()
  })

  it('user_edit (credibility 1.0) always wins', async () => {
    const { deps } = await setup()
    await rememberOne(deps, assertion(0.9, 1.0, '对话强事实'))
    const userEdit = await rememberOne(deps, {
      ...assertion(1.0, 0.5, '用户手动编辑'),
      source: { type: 'user_edit', credibility: 1.0 },
    })
    expect(userEdit.superseded).toBeDefined()
  })
})
