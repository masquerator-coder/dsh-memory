/**
 * Tools adapter — the explicit memory-management surface the model can call
 * (design §4.3). Each `execute` is a thin delegation to `ctx.memory`; the model
 * never reasons about atomic facts itself — `memory_remember` forwards raw
 * content and the store does the extraction downstream.
 *
 * @module dsh-memory/adapters/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MemoryService } from '../service.ts'
import { scanPii } from '../application/privacy.ts'

/** Resolve the memory scope for a tool call: the agent session id when present. */
function scopeOf(exec: ToolRunContext, fallback: string): string {
  const sessionId = exec.agent?.session?.id
  return sessionId !== undefined ? sessionId : fallback
}

interface ToolContext {
  readonly ctx: Context
  readonly fallbackScope: string
}

function memory(tc: ToolContext): MemoryService {
  const svc = tc.ctx.get('memory') as MemoryService | undefined
  if (svc === undefined) throw new Error('memory service is not available')
  return svc
}

/**
 * Register all memory tools and return the disposers.
 */
export function registerMemoryTools(tc: ToolContext): (() => void)[] {
  const { ctx } = tc
  const disposers: (() => void)[] = []
  const fallbackScope = tc.fallbackScope

  disposers.push(ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '检索与查询相关的持久记忆原子事实。',
    parameters: {
      query: { type: 'string', required: true, description: '要检索的记忆查询' },
      topK: { type: 'integer', description: '返回条数上限（默认按策略）' },
    },
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
      render(_args, value) {
        const items = Array.isArray(value) ? value : []
        return [{ type: 'text', text: items.length === 0 ? '（无相关记忆）' : items.map((f: unknown) => `- ${(f as { content?: string }).content ?? ''}`).join('\n') }]
      },
    },
    async execute(args, exec) {
      const svc = memory(tc)
      const results = await svc.recall({ query: args.query, scope: scopeOf(exec, fallbackScope), topK: args.topK })
      return results.slice(0, args.topK ?? results.length).map(r => ({ id: r.fact.id, content: r.fact.content, confidence: r.fact.confidence, type: r.fact.type, scope: r.fact.scope }))
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '显式记住一条用户偏好、事实或决策。传入原始内容，系统会自行抽取为原子事实。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的原始内容' },
      scope: { type: 'string', description: '可选：记忆范围（默认当前会话）' },
      type: { type: 'string', enum: ['semantic', 'episodic', 'procedural', 'working'], description: '可选：记忆类型' },
      procedure: {
        type: 'object',
        additionalProperties: true,
        description: '可选：程序记忆的结构化步骤（tool/depends_on/rollback）；仅 type=procedural 时使用',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const v = value as { id?: string; superseded?: string }
        return [{ type: 'text', text: `已记住记忆 ${v.id ?? '(unknown)'}` }]
      },
    },
    async execute(args, exec) {
      const svc = memory(tc)
      const scope = args.scope ?? scopeOf(exec, fallbackScope)
      // Apply the PII scan on the explicit path too, so secrets never enter
      // memory unflagged (design default-security).
      const pii = scanPii(args.content)
      const outcome = await svc.remember({
        content: pii.redacted,
        scope,
        pii: pii.detected,
        privacy: pii.detected ? 'confidential' : undefined,
        type: args.type,
        procedure: args.procedure,
      })
      return { id: outcome.stored.id, superseded: outcome.superseded ?? null, retained: outcome.retained ?? null }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除或归档一条记忆。',
    parameters: {
      factId: { type: 'string', required: true, description: '记忆 ID' },
      mode: { type: 'string', enum: ['archive', 'delete'], description: 'archive=软归档，delete=硬删除' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render() {
        return [{ type: 'text', text: '已处理该记忆' }]
      },
    },
    async execute(args) {
      const svc = memory(tc)
      await svc.forget(args.factId, args.mode ?? 'archive')
      return { factId: args.factId, mode: args.mode ?? 'archive' }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'memory_forget_all',
    description: '级联删除某个范围的全部记忆（遗忘权）。',
    parameters: {
      scope: { type: 'string', required: true, description: '记忆范围' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render() {
        return [{ type: 'text', text: '已清空该范围记忆' }]
      },
    },
    async execute(args) {
      const svc = memory(tc)
      const report = await svc.forgetAll(args.scope)
      return { deleted: report.deleted, scope: report.scope }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'memory_link',
    description: '在两个实体之间建立一条关系边。',
    parameters: {
      fromId: { type: 'string', required: true, description: '来源实体/记忆 ID' },
      toId: { type: 'string', required: true, description: '目标实体/记忆 ID' },
      relation: { type: 'string', required: true, description: '关系谓词' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render() {
        return [{ type: 'text', text: '已建立关系' }]
      },
    },
    async execute(args) {
      const svc = memory(tc)
      const outcome = await svc.link(args.fromId, args.toId, args.relation)
      return { id: outcome.stored.id }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'read_user_profile',
    description: '读取当前用户的画像卡片（聚合的原子事实视图：核心摘要 + 按主题分组的详细偏好）。',
    parameters: {
      topic: { type: 'string', description: '可选：只看某一主题（谓词分组）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const v = value as { summary?: string[]; groups?: { title: string; lines: string[] }[] }
        const head = (v.summary ?? []).map(l => `- ${l}`).join('\n')
        const body = (v.groups ?? [])
          .map(g => `${g.title}\n${g.lines.map(l => `- ${l}`).join('\n')}`)
          .join('\n\n')
        // `head || '…' + body` used to drop every group whenever a summary
        // existed: `+` binds tighter than `||`.
        const sections = [head.length > 0 ? head : '（暂无画像）']
        if (body.length > 0) sections.push(body)
        return [{ type: 'text', text: sections.join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const svc = memory(tc)
      const scope = scopeOf(exec, fallbackScope)
      const entityId = await primaryUserEntity(svc, scope)
      const card = entityId === undefined
        ? { entityId: 'user', entityName: '用户', entityType: 'user', updatedAt: 0, count: 0, summary: [], groups: [] }
        : await svc.getCard(entityId)
      const topic = args.topic
      const matched = topic === undefined ? card.groups : card.groups.filter(g => g.title === topic)
      const groups = matched.map(g => ({ title: g.title, lines: g.facts.map(f => f.content) }))
      if (topic !== undefined && groups.length === 0) groups.push({ title: topic, lines: ['（该主题暂无偏好）'] })
      return { entityId: card.entityId, count: card.count, summary: card.summary, groups }
    },
  })))

  return disposers
}

/**
 * Deterministically pick the "current user" entity for a scope: the most
 * frequently asserted `user`-typed subject. Falls back to `undefined` when the
 * scope has no user-typed facts (an empty profile).
 */
async function primaryUserEntity(svc: MemoryService, scope: string): Promise<string | undefined> {
  // Include `global` facts so the shared/user card is not empty in a fresh session.
  const facts = await svc.repo.listScopeIncludingGlobal(scope)
  let best: string | undefined
  let bestCount = 0
  const counts = new Map<string, number>()
  for (const fact of facts) {
    if (fact.status !== 'active') continue
    if (fact.pii) continue
    if (fact.subject.type !== 'user') continue
    const n = (counts.get(fact.subject.id) ?? 0) + 1
    counts.set(fact.subject.id, n)
    if (n > bestCount) {
      bestCount = n
      best = fact.subject.id
    }
  }
  return best
}
