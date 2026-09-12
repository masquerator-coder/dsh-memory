/**
 * Fast-channel capture (design §4.2 / §6.4 mode B).
 *
 * The fast channel is a deterministic, zero-LLM gate in front of the store: a
 * configured trigger phrase fires, or the message merely looks fact-worthy.
 * Before this was wired, every direct user message was persisted as a
 * `stated` fact regardless of content, which contradicts the documented
 * behaviour and silently grows the memory store with raw conversation.
 */
import { describe, expect, it } from 'vitest'
import { buildPolicy } from '../src/build-policy'
import { Config } from '../src/config'
import { EntityResolver } from '../src/domain/entity'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo'
import { ScopeQueue } from '../src/infrastructure/queue'
import { MemoryService } from '../src/service'

const policy = buildPolicy({})

interface Harness {
  svc: MemoryService
  repo: JsonFileMemoryRepository
  queue: ScopeQueue
  accepted(text: string): boolean
  drain(scope: string): Promise<void>
  stored(scope: string): Promise<string[]>
}

async function harness(overrides: {
  captureEnabled?: boolean
  policy?: ReturnType<typeof buildPolicy>
} = {}): Promise<Harness> {
  const repo = new JsonFileMemoryRepository()
  await repo.open()
  const queue = new ScopeQueue()
  const activePolicy = overrides.policy ?? policy
  const svc = new MemoryService({
    repo,
    resolver: new EntityResolver(),
    policy: () => activePolicy,
    queue,
    llmExtractionEnabled: false,
    captureEnabled: overrides.captureEnabled ?? true,
  })
  return {
    svc,
    repo,
    queue,
    accepted: (text: string) => svc.extractAndRemember({ text, scope: 's' }).accepted,
    drain: scope => queue.whenDrained(scope),
    stored: async scope => (await repo.listScope(scope)).filter(f => f.status === 'active').map(f => f.content),
  }
}

describe('fast-channel gate', () => {
  it('ignores an ordinary message (no trigger, nothing fact-worthy)', async () => {
    const h = await harness()
    expect(h.accepted('帮我把 README 的第 3 节改一下')).toBe(false)
    await h.drain('s')
    expect(await h.stored('s')).toEqual([])
  })

  it('captures a triggered message with the trigger phrase stripped', async () => {
    const h = await harness()
    expect(h.accepted('记住，项目部署在阿里云 ACK')).toBe(true)
    await h.drain('s')
    expect(await h.stored('s')).toEqual(['项目部署在阿里云 ACK'])
  })

  it('captures a preference trigger', async () => {
    const h = await harness()
    expect(h.accepted('我的偏好是简洁回答，不要客套')).toBe(true)
    await h.drain('s')
    expect(await h.stored('s')).toEqual(['简洁回答，不要客套'])
  })

  it('captures a fact-worthy message without a trigger', async () => {
    const h = await harness()
    expect(h.accepted('这个版本是 v2.3')).toBe(true)
    await h.drain('s')
    expect(await h.stored('s')).toEqual(['这个版本是 v2.3'])
  })

  it('does nothing when capture is disabled', async () => {
    const h = await harness({ captureEnabled: false })
    expect(h.accepted('记住，项目部署在阿里云 ACK')).toBe(false)
    await h.drain('s')
    expect(await h.stored('s')).toEqual([])
  })

  it('honours extraction.fallback = ignore', async () => {
    const h = await harness({ policy: buildPolicy(Config({ extraction: { fallback: 'ignore' } })) })
    expect(h.accepted('记住，项目部署在阿里云 ACK')).toBe(true)
    await h.drain('s')
    expect(await h.stored('s')).toEqual([])
  })

  it('stores no raw secrets or identifiers (§12.7)', async () => {
    const h = await harness()
    expect(h.accepted('记住，我的身份证是 110105199003078272，手机号 13800138000')).toBe(true)
    await h.drain('s')
    const stored = await h.stored('s')
    expect(stored).toHaveLength(1)
    expect(stored[0]).not.toContain('110105199003078272')
    expect(stored[0]).not.toContain('13800138000')
    expect(stored[0]).toContain('<<id>>')
    const [fact] = await h.repo.listScope('s')
    expect(fact.pii).toBe(true)
  })

  it('uses the configured triggers', async () => {
    const h = await harness({ policy: buildPolicy(Config({ extraction: { triggers: ['笔记'] } })) })
    expect(h.accepted('记住，项目部署在阿里云 ACK')).toBe(false)
    expect(h.accepted('笔记 项目部署在阿里云 ACK')).toBe(true)
    await h.drain('s')
    expect(await h.stored('s')).toEqual(['项目部署在阿里云 ACK'])
  })

  it('rejects a pasted terminal dump even when it has a trigger or version text', async () => {
    const h = await harness()
    const dump = [
      'PS D:\\Apps\\deepseek-harness> pnpm test',
      '$ vitest run',
      ' Test Files  16 passed (16)',
      '      Tests  84 passed (84)',
      'PS D:\\Apps\\deepseek-harness>',
    ].join('\n')
    // Contains a trigger and digits — but because it is a multi-line terminal
    // transcript it must NOT be captured as durable memory.
    expect(h.accepted(dump)).toBe(false)
    await h.drain('s')
    expect(await h.stored('s')).toEqual([])
  })
})
