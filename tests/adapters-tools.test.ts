/**
 * Tools adapter (`src/adapters/tools.ts`) — the model-facing tool surface.
 *
 * No test imported this module before, which is how a `head || '…' + body`
 * precedence bug survived: `read_user_profile` silently dropped every per-topic
 * group whenever a summary existed, contradicting the README.
 *
 * The Cordis context is faked: `defineTool` is a pure schema compiler, so a
 * registry stub that captures definitions is enough to exercise `render` and
 * `execute` end to end against a real `MemoryService`.
 */
import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../src/build-policy'
import { EntityResolver } from '../src/domain/entity'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { MemoryService } from '../src/service'
import { registerMemoryTools } from '../src/adapters/tools'
import type { Context } from '@deepseek-ai/cordis'

const policy = buildPolicy({})

interface ToolLike {
  name: string
  output: { render: (args: unknown, value: unknown) => { type: string; text: string }[] }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

const PHONE = '13800138000'

async function harness(): Promise<{
  tools: Map<string, ToolLike>
  svc: MemoryService
  repo: JsonFileMemoryRepository
  exec: unknown
}> {
  const repo = new JsonFileMemoryRepository()
  await repo.open()
  const resolver = new EntityResolver()
  resolver.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  const svc = new MemoryService({
    repo,
    resolver,
    policy: () => policy,
    llmExtractionEnabled: false,
    captureEnabled: false,
  })
  const tools = new Map<string, ToolLike>()
  const ctx = {
    tools: {
      register: (tool: ToolLike) => {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    get: (name: string) => (name === 'memory' ? svc : undefined),
  } as unknown as Context
  registerMemoryTools({ ctx, fallbackScope: 'global' })
  // A tool call with no agent session resolves to the fallback scope.
  return { tools, svc, repo, exec: {} }
}

describe('registerMemoryTools', () => {
  it('registers the six documented tools', async () => {
    const { tools } = await harness()
    expect([...tools.keys()].sort()).toEqual([
      'memory_forget', 'memory_forget_all', 'memory_link',
      'memory_recall', 'memory_remember', 'read_user_profile',
    ])
  })
})

describe('read_user_profile rendering', () => {
  it('renders the summary AND every per-topic group', async () => {
    const { tools } = await harness()
    const tool = tools.get('read_user_profile')!
    const value = {
      entityId: 'user:alice',
      count: 2,
      summary: ['Alice 偏好素食'],
      groups: [
        { title: 'prefers_diet', lines: ['Alice 偏好素食'] },
        { title: 'uses_technology', lines: ['Alice 使用 Go 语言'] },
      ],
    }
    const [block] = tool.output.render({}, value)
    expect(block.text).toContain('Alice 偏好素食')
    expect(block.text).toContain('uses_technology')
    expect(block.text).toContain('Alice 使用 Go 语言')
  })

  it('falls back to a placeholder for an empty profile', async () => {
    const { tools } = await harness()
    const [block] = tools.get('read_user_profile')!.output.render({}, { summary: [], groups: [] })
    expect(block.text).toBe('（暂无画像）')
  })

  it('reports an empty topic instead of an empty result', async () => {
    const { tools, svc } = await harness()
    await svc.remember({ content: 'Alice 偏好素食', scope: 'global', predicate: 'prefers_diet', subject: { type: 'user', name: 'Alice' } })
    const card = await tools.get('read_user_profile')!.execute({ topic: 'speaks' }, {}) as {
      groups: { title: string; lines: string[] }[]
    }
    expect(card.groups).toEqual([{ title: 'speaks', lines: ['（该主题暂无偏好）'] }])
  })

  it('returns the aggregated card from execute', async () => {
    const { tools, svc } = await harness()
    await svc.remember({ content: 'Alice 偏好素食', scope: 'global', predicate: 'prefers_diet', subject: { type: 'user', name: 'Alice' } })
    const card = await tools.get('read_user_profile')!.execute({}, {}) as { groups: { title: string; lines: string[] }[] }
    expect(card.groups.map(g => g.title)).toContain('prefers_diet')
    expect(card.groups[0].lines).toContain('Alice 偏好素食')
  })
})

describe('memory_remember / memory_recall privacy', () => {
  it('redacts PII before storing and flags the fact', async () => {
    const { tools, repo } = await harness()
    const tool = tools.get('memory_remember')!
    await tool.execute({ content: `我的手机号 ${PHONE}` }, {})
    const [fact] = await repo.listScope('global')
    expect(fact.content).not.toContain(PHONE)
    expect(fact.content).toContain('<<phone>>')
    expect(fact.pii).toBe(true)
  })

  it('never returns a PII fact from memory_recall', async () => {
    const { tools } = await harness()
    await tools.get('memory_remember')!.execute({ content: `我的手机号 ${PHONE}` }, {})
    await tools.get('memory_remember')!.execute({ content: 'Alice 偏好素食' }, {})
    const hits = await tools.get('memory_recall')!.execute({ query: '手机号 素食' }, {}) as { content: string }[]
    expect(hits.map(h => h.content)).toEqual(['Alice 偏好素食'])
  })

  it('renders an empty recall result as a placeholder', async () => {
    const { tools } = await harness()
    const [block] = tools.get('memory_recall')!.output.render({ query: 'x' }, [])
    expect(block.text).toBe('（无相关记忆）')
  })
})
