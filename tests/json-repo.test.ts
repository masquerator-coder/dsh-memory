import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { EntityResolver } from '../src/domain/entity'
import { buildFact, type RawAssertion } from '../src/domain/factory'
import { buildPolicy } from '../src/build-policy'

const policy = buildPolicy({})
const temps: string[] = []

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
  temps.length = 0
})

function raw(content: string, over: Partial<RawAssertion> = {}): RawAssertion {
  return {
    subject: { type: 'user', name: 'Alice' },
    predicate: 'states',
    object: { type: 'concept', name: content.slice(0, 20) },
    content,
    type: 'semantic',
    confidence: 0.8,
    scope: 'session:abc',
    source: { type: 'conversation', credibility: 0.7 },
    ...over,
  }
}

function resolver() {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  return r
}

async function seed(repo: JsonFileMemoryRepository, contents: string[]) {
  const res = resolver()
  for (const content of contents) {
    const fact = buildFact(raw(content), { resolver: res, forgetting: policy.forgetting, defaultPrivacy: 'private', now: 1000, idOverride: `id-${content.slice(0, 6)}` })
    await repo.put(fact)
  }
}

describe('JsonFileMemoryRepository', () => {
  it('persists across reopen (round-trip)', async () => {
    const dir = await tempDir()
    const file = join(dir, 'facts.json')
    const repo = new JsonFileMemoryRepository(file)
    await repo.open()
    await seed(repo, ['Alice 偏好素食'])
    await repo.snapshotFacts()

    const reopened = new JsonFileMemoryRepository(file)
    await reopened.open()
    const facts = await reopened.snapshotFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('Alice 偏好素食')
  })

  it('queries by lexical term across content/entities/tags', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, ['项目使用 Go 语言', 'Alice 偏好素食'])
    const results = await repo.query({ scope: 'session:abc', status: ['active'] }, ['素食'], [])
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].fact.content).toContain('素食')
  })

  it('scopes queries and neighbors', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, ['Alice 偏好素食'])
    const other = await repo.listScope('session:zzz')
    expect(other).toEqual([])
    const [fact] = await repo.snapshotFacts()
    // The subject resolved to user:alice (registered), so its neighbors include
    // the fact's object id (nil: when no concept alias is registered).
    const neighbors = await repo.neighbors('user:alice', [])
    expect(neighbors).toContain(fact.object.id)
  })

  it('delete removes the fact and its indexes', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, ['事实 A'])
    const [fact] = await repo.snapshotFacts()
    await repo.delete(fact.id)
    expect(await repo.get(fact.id)).toBeUndefined()
    expect((await repo.stats()).total).toBe(0)
  })
})
