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
    description: '读取当前用户的画像摘要（聚合的原子事实视图）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const v = value as { summary?: string }
        return [{ type: 'text', text: v.summary ?? '（暂无画像）' }]
      },
    },
    async execute(_args, exec) {
      const svc = memory(tc)
      const scope = scopeOf(exec, fallbackScope)
      const facts = await svc.repo.listScope(scope)
      const active = facts.filter(f => f.status === 'active')
      const summary = active.slice(0, 30).map(f => `- ${f.content}`).join('\n')
      return { count: active.length, summary }
    },
  })))

  return disposers
}
