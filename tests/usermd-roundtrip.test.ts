/**
 * `user.md` round-trip through the service (design §8.4/§8.5).
 *
 * The view is derived from an entity card, so importing it back must be a
 * no-op when nothing changed. Diffing against *every* active fact in the scope
 * instead of the facts the view can represent made a plain re-save archive
 * everything the view cannot show — other entities' facts, PII facts, and facts
 * outside the retrieval privacy tier.
 */
import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../src/build-policy'
import { Config } from '../src/config'
import { EntityResolver } from '../src/domain/entity'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { MemoryService } from '../src/service'

const policy = buildPolicy({})

function resolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  return r
}

async function makeService(): Promise<{ svc: MemoryService; repo: JsonFileMemoryRepository }> {
  const repo = new JsonFileMemoryRepository()
  await repo.open()
  const svc = new MemoryService({
    repo,
    resolver: resolver(),
    policy: () => policy,
    llmExtractionEnabled: false,
    captureEnabled: false,
  })
  return { svc, repo }
}

/** Seed a scope with facts the view shows and facts it deliberately hides. */
async function seedMixed(svc: MemoryService): Promise<void> {
  await svc.remember({ content: 'Alice 偏好素食', scope: 's1', predicate: 'prefers_diet' })
  // Hidden: PII-flagged.
  await svc.remember({ content: 'Alice 的手机号 13800138000', scope: 's1', predicate: 'stated', pii: true })
  // Hidden: another entity's fact.
  await svc.remember({
    content: '项目部署在阿里云 ACK',
    scope: 's1',
    predicate: 'deployed_on',
    subject: { type: 'project', name: 'demo', id: 'project:demo' },
  })
  // Hidden: outside the retrieval privacy tier.
  await svc.remember({ content: 'Alice 的私密笔记', scope: 's1', predicate: 'stated', privacy: 'confidential' })
}

async function activeContents(repo: JsonFileMemoryRepository, scope: string): Promise<string[]> {
  return (await repo.listScope(scope)).filter(f => f.status === 'active').map(f => f.content).sort()
}

describe('user.md round-trip (service)', () => {
  it('is a no-op when the rendered view is re-applied unchanged', async () => {
    const { svc, repo } = await makeService()
    await seedMixed(svc)
    const before = await activeContents(repo, 's1')
    expect(before).toHaveLength(4)

    const md = await svc.renderUserMd('s1')
    const report = await svc.applyUserMdEdits('s1', md)

    expect(report).toEqual({ added: 0, superseded: 0, archived: 0 })
    expect(await activeContents(repo, 's1')).toEqual(before)
  })

  it('still applies a real edit while leaving hidden facts alone', async () => {
    const { svc, repo } = await makeService()
    await seedMixed(svc)
    const md = await svc.renderUserMd('s1')
    // Edit the preference line (also present in the summary section, which the
    // parser ignores because it carries no predicate).
    const edited = md.split('\n')
      .map(line => (line === '- Alice 偏好素食' ? '- Alice 偏好素食（不吃香菜）' : line))
      .join('\n')

    const report = await svc.applyUserMdEdits('s1', edited)

    expect(report).toEqual({ added: 0, superseded: 1, archived: 0 })
    const active = await activeContents(repo, 's1')
    expect(active).toContain('Alice 偏好素食（不吃香菜）')
    expect(active).not.toContain('Alice 偏好素食')
    // The three facts the view cannot show survive untouched.
    expect(active).toContain('Alice 的手机号 13800138000')
    expect(active).toContain('项目部署在阿里云 ACK')
    expect(active).toContain('Alice 的私密笔记')
  })

  it('never archives facts the view hides, even from an empty view', async () => {
    const { svc, repo } = await makeService()
    // A scope whose only facts are invisible to the view: the rendered document
    // has no preferences at all.
    await svc.remember({ content: 'Alice 的手机号 13800138000', scope: 's2', predicate: 'stated', pii: true })
    await svc.remember({ content: 'Alice 的私密笔记', scope: 's2', predicate: 'stated', privacy: 'confidential' })
    const md = await svc.renderUserMd('s2')
    expect(md).toContain('（暂无偏好）')

    const report = await svc.applyUserMdEdits('s2', md)

    expect(report.archived).toBe(0)
    expect(await activeContents(repo, 's2')).toHaveLength(2)
  })

  it('research profile: confidential defaults stay visible instead of wiping the profile', async () => {
    // Under `profile: research` the default privacy is `confidential`, so a card
    // whose tier list came from a hardcoded ['public','private'] rendered as
    // "no preferences" — and the write-back then archived every fact.
    const repo = new JsonFileMemoryRepository()
    await repo.open()
    const svc = new MemoryService({
      repo,
      resolver: resolver(),
      policy: () => buildPolicy(Config({ profile: 'research' })),
      llmExtractionEnabled: false,
      captureEnabled: false,
    })
    await svc.remember({ content: 'Alice 偏好素食', scope: 'r1', predicate: 'prefers_diet' })
    await svc.remember({ content: 'Alice 使用 Go 语言', scope: 'r1', predicate: 'uses_technology' })

    const md = await svc.renderUserMd('r1')
    expect(md).toContain('Alice 偏好素食')
    expect(md).not.toContain('（暂无偏好）')

    const report = await svc.applyUserMdEdits('r1', md)
    expect(report).toEqual({ added: 0, superseded: 0, archived: 0 })
    expect(await activeContents(repo, 'r1')).toHaveLength(2)
  })
})
