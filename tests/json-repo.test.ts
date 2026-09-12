import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('listScopeIncludingGlobal merges scope + global but listScope stays exact', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, [
      '会话内事实',
    ])
    // Add a global-scoped fact alongside the session-scoped one.
    const res = resolver()
    const globalFact = buildFact(raw('全局共享事实', { scope: 'global' }), {
      resolver: res,
      forgetting: policy.forgetting,
      defaultPrivacy: 'private',
      now: 1000,
      idOverride: 'id-global-1',
    })
    await repo.put(globalFact)

    // Exact scope: only the session fact.
    const exact = await repo.listScope('session:abc')
    expect(exact.map(f => f.content)).toEqual(['会话内事实'])
    // Including global: both, deduplicated.
    const merged = await repo.listScopeIncludingGlobal('session:abc')
    expect(merged.map(f => f.content).sort()).toEqual(['会话内事实', '全局共享事实'].sort())

    // scope==='global' path is a passthrough to the exact global scope.
    expect((await repo.listScopeIncludingGlobal('global')).length).toBe(1)
  })

  it('recall query admits global-scoped facts under a session scope filter', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, ['会话内事实'])
    const res = resolver()
    const globalFact = buildFact(raw('全局偏好用 Go', { scope: 'global' }), {
      resolver: res,
      forgetting: policy.forgetting,
      defaultPrivacy: 'private',
      now: 1000,
      idOverride: 'id-global-2',
    })
    await repo.put(globalFact)

    // The query path applies the shared read gate, which lets global facts
    // through even though the filter scope is a session.
    const hits = await repo.query({ scope: 'session:abc', status: ['active'] }, ['Go'], [])
    expect(hits.map(h => h.fact.content)).toContain('全局偏好用 Go')
  })

  it('delete removes the fact and its indexes', async () => {
    const repo = new JsonFileMemoryRepository()
    await seed(repo, ['事实 A'])
    const [fact] = await repo.snapshotFacts()
    await repo.delete(fact.id)
    expect(await repo.get(fact.id)).toBeUndefined()
    expect((await repo.stats()).total).toBe(0)
  })

  it('quarantines a corrupt document instead of overwriting every memory', async () => {
    const dir = await tempDir()
    const file = join(dir, 'facts.json')
    const original = '{"facts":{"keep-me":{"id":"keep-me"'
    await writeFile(file, original, 'utf8')

    const repo = new JsonFileMemoryRepository(file)
    // Must not throw: a rejection here used to leave an empty in-memory store
    // pointed at a good-on-disk file, and the next write wiped it.
    await expect(repo.open()).resolves.toBeUndefined()
    const issue = repo.openIssue
    expect(issue?.kind).toBe('corrupt')
    expect(issue?.backupPath).toBeDefined()

    await seed(repo, ['Alice 偏好素食'])
    // The original bytes are preserved, untouched, in the quarantine copy.
    expect(await readFile(issue!.backupPath!, 'utf8')).toBe(original)
    // …and the live file holds only the new fact.
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { facts: Record<string, unknown> }
    expect(Object.keys(persisted.facts)).toEqual([...Object.keys(persisted.facts)].filter(k => k !== 'keep-me'))
    expect(JSON.stringify(persisted)).not.toContain('keep-me')
  })

  it('recovers from a failed write instead of poisoning every later operation', async () => {
    const dir = await tempDir()
    const file = join(dir, 'facts.json')
    // Make the atomic temp write fail: a *directory* at the temp path.
    await mkdir(`${file}.tmp`, { recursive: true })
    const repo = new JsonFileMemoryRepository(file)
    await repo.open()

    await expect(seed(repo, ['第一次写入'])).rejects.toThrow()
    // The failed write must leave no phantom fact, and reads must stay usable —
    // previously the rejected chain made them throw the stale write error
    // forever.
    await expect(repo.stats()).resolves.toEqual({ active: 0, total: 0 })

    await rm(`${file}.tmp`, { recursive: true, force: true })
    await seed(repo, ['第二次写入'])
    const facts = await repo.snapshotFacts()
    expect(facts.map(f => f.content)).toEqual(['第二次写入'])
  })

  it('refuses writes when the previous document could not be read at all', async () => {
    const dir = await tempDir()
    // A directory as the data file: readable neither as a document nor safely
    // movable, so the store must go read-only rather than overwrite it.
    const repo = new JsonFileMemoryRepository(dir)
    await expect(repo.open()).resolves.toBeUndefined()
    expect(repo.openIssue?.kind).toBe('unreadable')
    expect(repo.isReadOnly).toBe(true)
    await expect(seed(repo, ['不应写入'])).rejects.toThrow(/refusing to write/)
  })
})
