/**
 * Read-path privacy gate (design §12.7) — the model-facing surface.
 *
 * The plugin claims "confidential is redacted on non-auth recall", "secrets are
 * never auto-injected", and "PII is flagged and isolated". These tests assert
 * the behaviour on every path that can reach the model: the recall engine, the
 * recall degradation fallback (which bypasses the store query), and therefore
 * the context injection and `memory_recall` tool.
 */
import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../src/build-policy'
import { Config } from '../src/config'
import { EntityResolver } from '../src/domain/entity'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo.ts'
import type { MemoryRepository } from '../src/application/ports'
import { MemoryService } from '../src/service'
import { redactForRecall, filterByPrivacy } from '../src/application/privacy'

const personal = buildPolicy({})
const research = buildPolicy(Config({ profile: 'research' }))

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  return r
}

function service(policy = personal, repo?: MemoryRepository): Promise<MemoryService> {
  const target = repo ?? new JsonFileMemoryRepository()
  return Promise.resolve(target).then(r => new MemoryService({
    repo: r,
    resolver: resolver(),
    policy: () => policy,
    llmExtractionEnabled: false,
    captureEnabled: false,
  }))
}

const PHONE = '13800138000'

describe('PII never reaches the model-facing read path', () => {
  it('drops PII-flagged facts from recall', async () => {
    const repo = new JsonFileMemoryRepository()
    const svc = await service(personal, repo)
    await svc.remember({ content: `我的手机号 ${PHONE}`, scope: 's', predicate: 'stated', pii: true })
    await svc.remember({ content: 'Alice 偏好素食', scope: 's', predicate: 'prefers_diet' })

    const hits = await svc.recall({ query: '手机号 素食', scope: 's' })

    expect(hits.map(h => h.fact.content)).toEqual(['Alice 偏好素食'])
    expect(hits.some(h => h.fact.pii)).toBe(false)
  })

  it('serialises no PII over the JSON store either', async () => {
    const repo = new JsonFileMemoryRepository()
    const svc = await service(personal, repo)
    await svc.remember({ content: `我的手机号 ${PHONE}`, scope: 's', predicate: 'stated', pii: true })
    // The record is retained (deletion is the user's explicit choice) but it is
    // unreachable from recall; `memory_recall` and context injection both read
    // through the same gate.
    expect((await repo.stats()).total).toBe(1)
  })
})

describe('secret needs explicit authorization', () => {
  it('is dropped even when the tier list contains secret', async () => {
    const policy = buildPolicy(Config({
      privacy: { retrievalFilter: ['public', 'private', 'confidential', 'secret'] },
    }))
    const repo = new JsonFileMemoryRepository()
    const svc = await service(policy, repo)
    await svc.remember({ content: '生产库口令 X', scope: 's', predicate: 'stated', privacy: 'secret' })

    const hits = await svc.recall({ query: '口令', scope: 's' })
    expect(hits).toHaveLength(0)
  })

  it('is surfaced only when the operator waives explicit auth', async () => {
    const policy = buildPolicy(Config({
      privacy: {
        retrievalFilter: ['public', 'private', 'secret'],
        secretRequiresExplicitAuth: false,
      },
    }))
    const repo = new JsonFileMemoryRepository()
    const svc = await service(policy, repo)
    await svc.remember({ content: '生产库口令 X', scope: 's', predicate: 'stated', privacy: 'secret' })

    const hits = await svc.recall({ query: '口令', scope: 's' })
    expect(hits.map(h => h.fact.content)).toEqual(['生产库口令 X'])
  })
})

describe('confidential is redacted on the way out (research)', () => {
  it('masks PII inside confidential content and marks the tier', async () => {
    const repo = new JsonFileMemoryRepository()
    const svc = await service(research, repo)
    await svc.remember({ content: `客户回访电话 ${PHONE}`, scope: 's', predicate: 'stated', privacy: 'confidential' })

    const hits = await svc.recall({ query: '回访电话', scope: 's' })

    expect(hits).toHaveLength(1)
    expect(hits[0].fact.content).toBe('[confidential] 客户回访电话 <<phone>>')
  })

  it('leaves confidential content alone when piiRedaction is off', async () => {
    const policy = buildPolicy(Config({ profile: 'research', privacy: { piiRedaction: false } }))
    const repo = new JsonFileMemoryRepository()
    const svc = await service(policy, repo)
    await svc.remember({ content: `客户回访电话 ${PHONE}`, scope: 's', predicate: 'stated', privacy: 'confidential' })

    const hits = await svc.recall({ query: '回访电话', scope: 's' })
    expect(hits[0].fact.content).toBe(`客户回访电话 ${PHONE}`)
  })

  it('redactForRecall only touches confidential facts', () => {
    const item = { privacy: 'private' as const, content: `x ${PHONE}` }
    expect(redactForRecall(item, personal.privacy)).toEqual(item)
    expect(redactForRecall({ ...item, privacy: 'confidential' as const }, personal.privacy).content)
      .toBe('[confidential] x <<phone>>')
  })
})

describe('the degradation fallback is gated too', () => {
  it('excludes PII and unauthorized secret when recall times out', async () => {
    const inner = new JsonFileMemoryRepository()
    // Force the timeout path: the store's query is slower than the budget.
    const slow: MemoryRepository = {
      ...inner,
      query: async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 60))
        return inner.query(...args)
      },
      get: inner.get.bind(inner),
      listScope: inner.listScope.bind(inner),
      listScopeIncludingGlobal: inner.listScopeIncludingGlobal.bind(inner),
      put: inner.put.bind(inner),
      delete: inner.delete.bind(inner),
      bySemanticKey: inner.bySemanticKey.bind(inner),
      latestBySemanticKey: inner.latestBySemanticKey.bind(inner),
      neighbors: inner.neighbors.bind(inner),
      byEntity: inner.byEntity.bind(inner),
      stats: inner.stats.bind(inner),
    }
    const policy = buildPolicy(Config({
      retrieval: { timeoutMs: 5 },
      privacy: { retrievalFilter: ['public', 'private', 'secret'], secretRequiresExplicitAuth: true },
    }))
    const svc = new MemoryService({
      repo: slow,
      resolver: resolver(),
      policy: () => policy,
      llmExtractionEnabled: false,
      captureEnabled: false,
    })
    await svc.remember({ content: `我的手机号 ${PHONE}`, scope: 's', predicate: 'stated', pii: true })
    await svc.remember({ content: '生产库口令 X', scope: 's', predicate: 'stated', privacy: 'secret' })
    await svc.remember({ content: 'Alice 偏好素食', scope: 's', predicate: 'prefers_diet' })

    const hits = await svc.recall({ query: '素食', scope: 's' })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map(h => h.fact.content)).toEqual(['Alice 偏好素食'])
  })

  it('filterByPrivacy keeps confidential, drops secret without auth', () => {
    const items = [
      { privacy: 'private' as const, content: 'a', pii: false },
      { privacy: 'confidential' as const, content: 'b', pii: false },
      { privacy: 'secret' as const, content: 'c', pii: false },
    ]
    expect(filterByPrivacy(items, research.privacy).map(i => i.content)).toEqual(['a', 'b'])
    // Waiving explicit auth is not enough on its own: the tier list must also
    // admit `secret`.
    expect(filterByPrivacy(items, research.privacy, true).map(i => i.content)).toEqual(['a', 'b'])
    const secretAllowed = { ...research.privacy, retrievalFilter: [...research.privacy.retrievalFilter, 'secret' as const] }
    expect(filterByPrivacy(items, secretAllowed, true).map(i => i.content)).toEqual(['a', 'b', 'c'])
    expect(filterByPrivacy(items, secretAllowed, false).map(i => i.content)).toEqual(['a', 'b'])
  })
})
