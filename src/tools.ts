/**
 * dsh-memory — model-facing tools.
 *  - `memory`        list / add / replace / remove on the GLOBAL semantic store.
 *  - `memory_recall` search semantic + episodic pools (scope: semantic|episodic|all).
 *
 * The model-supplied values are validated at this boundary (pick/tierOf/
 * importanceOf helpers) instead of being trusted. presentCall/presentResult
 * are pure-UI card surfaces — they never touch the model context, which is the
 * `execute` return text alone.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolCallKind, type ToolCallView, type ToolResult, type ToolResultView } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store.js'
import { formatEntries, formatEpisodes, recallEmptyLabel, writeFailed, writeVerdictLabel } from './format.js'
import type { ApplyResult, Epistemic, Importance, Kind, Layer, MemoryOp, OpAction, Tier } from './types.js'

const ACTION_VERBS: Record<OpAction, string> = {
  add: '记入',
  replace: '纠正',
  remove: '删除',
  list: '查看',
}

const LAYERS: readonly Layer[] = ['user', 'memory']
const KINDS: readonly Kind[] = ['preference', 'env', 'lesson', 'decision', 'general']
const EPISTEMICS: readonly Epistemic[] = ['observed', 'inferred', 'subjective']
const ACTIONS: readonly OpAction[] = ['add', 'replace', 'remove', 'list']
const SCOPES: readonly string[] = ['semantic', 'episodic', 'all']
/** Upper bound on entries a model-facing listing can dump into context (P2-33). */
const LIST_LIMIT = 50
/** Recall topK clamp: 1..50 (P2-33). */
const TOPK_MAX = 50
/** A4 (2026-09-01): max content length for memory add/replace — prevents single
 *  huge entries from bloating DB + FTS and slowing findCanonical full scans. */
const MAX_CONTENT_LENGTH = 2000

/** Narrow an untrusted model-supplied string to a closed set; undefined = absent/invalid. */
function pick<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

function tierOf(value: unknown): Tier | undefined {
  return value === 0 || value === 1 ? value : undefined
}

/** Clamp instead of rejecting: a model sending 7 clearly means "max importance". */
function importanceOf(value: unknown): Importance | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(5, Math.max(1, Math.round(value))) as Importance
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function summarizeResult(store: MemoryStore): string {
  const u = store.usage()
  return `当前记忆 ${store.count()} 条,核心占用 ${u.pct}%(${u.total}字符)。`
}

export interface RegisterOpts {
  epistemicWeighting?: boolean
}

export function registerMemoryTools(ctx: Context, store: MemoryStore, opts: RegisterOpts = {}): void {
  const objectOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { content: { type: 'string', required: true } },
    } as const,
    render: (_args: unknown, value: { content?: string } | undefined): { type: 'text'; text: string }[] =>
      [{ type: 'text', text: String(value?.content ?? '') }],
  }

  // presentCall/presentResult: the tool-call card is the UI's memory-action
  // surface. `presentCall` names every pending call with a Chinese action
  // phrase; `presentResult` turns the completed card into a verdict line.
  const callCard = (title: string, kind: ToolCallKind, rawInput?: string): ToolCallView => ({
    card: 'generic', title, kind, ...(rawInput ? { rawInput } : {}),
  })

  const resultCard = (title: string, opts: { isError?: boolean } = {}): ToolResultView => ({
    // `content` deliberately omitted → UI falls back to execute's raw result.
    card: 'generic',
    title: opts.isError ? '记忆操作未完成' : title,
  })

  /** Extract the leading text block of a tool result, or '' when none. */
  const textOf = (result: ToolResult): string => {
    const block = result.content[0]
    return block?.type === 'text' ? block.text : ''
  }

  // ---- memory (write) ------------------------------------------------------
  const memoryTool = defineTool({
    name: 'memory',
    description:
      '持久记忆。action=list 查看;add 记稳定事实(用户偏好/环境/可复用约定),replace 纠正(需 id),remove 删除(需 id,force=true 物理删除否则软归档)。layer=user 记用户事项,memory 记观察。importance 1-5,kind 自动推断。写入即时全局生效。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | replace | remove' },
      layer: { type: 'string', description: 'user|memory(默认 memory)' },
      kind: { type: 'string', description: 'preference|env|lesson|decision|general' },
      tier: { type: 'number', description: '0=常驻核心 1=可召回(默认自动)' },
      topic: { type: 'string', description: '短标签 ≤40 字' },
      id: { type: 'string', description: 'replace/remove 必需' },
      content: { type: 'string', description: '事实正文' },
      importance: { type: 'number', description: '1-5,影响注入' },
      epistemic: { type: 'string', description: 'observed|inferred|subjective(默认 observed)：inferred/subjective 在召回加权时降低' },
      force: { type: 'boolean', description: 'remove 时 true=物理删除,false=软归档' },
    },
    output: objectOutput,
    async execute(args, exec) {
      const rawAction = str(args.action) ?? ''
      if (rawAction === 'list') {
        return { content: formatEntries(store.list({ includeLowQuality: false }).slice(0, LIST_LIMIT)) }
      }
      const action = pick(ACTIONS, rawAction)
      if (!action) return { content: `[FAIL] 未知 action "${rawAction}";可选 list|add|replace|remove。${summarizeResult(store)}` }

      const op: MemoryOp = {
        action,
        layer: pick(LAYERS, args.layer),
        kind: pick(KINDS, args.kind),
        tier: tierOf(args.tier),
        topic: str(args.topic),
        id: str(args.id),
        content: str(args.content),
        importance: importanceOf(args.importance),
        epistemic: pick(EPISTEMICS, args.epistemic),
        force: args.force === true,
      }
      // A4 (2026-09-01): clamp content length at tool boundary to prevent
      // single huge entries from bloating DB + FTS and slowing findCanonical.
      if ((action === 'add' || action === 'replace') && op.content && op.content.length > MAX_CONTENT_LENGTH) {
        return { content: `[FAIL] 未完成: 记忆内容过长（最多 ${MAX_CONTENT_LENGTH} 字符）。${summarizeResult(store)}` }
      }
      const sid = str(exec.agent?.session?.id)
      let res: ApplyResult
      try {
        res = store.batch([op], sid)
      } catch (err) {
        // P2-35: the write path shouldn't be allowed to throw past the tool surface.
        return { content: `[FAIL] 未完成: 记忆写入异常: ${err instanceof Error ? err.message : String(err)}。${summarizeResult(store)}` }
      }
      if (res.overflowed) return { content: `[FAIL] 记忆预算已满;本次未写入。当前核心(${res.usage.pct}%):\n${formatEntries(res.entries.filter(e => e.tier === 0))}\n请先用 memory replace/remove 整合后再写。` }
      if (res.rejected.length > 0) return { content: `[FAIL] 未完成: ${res.rejected.map(r => r.reason).join('; ')}。${summarizeResult(store)}` }
      const demoteNote = res.demoted.length > 0
        ? `（${res.demoted.length}条已有记忆因预算降级至 tier1：未注入常驻区，但可经 memory_recall 召回）`
        : ''
      // P2-9 (review 2026-08-30): a low-quality write is NOT an ordinary "已记入" —
      // it is recorded but excluded from injection and default recall. Telling the
      // model bare "成功" recreated the archived-entry silent-failure class.
      const lq = res.lowQuality?.length ?? 0
      const lowQualityNote = lq > 0
        ? `（注意:${lq}条因内容过短或高度重复被判为低质:已记入,但默认不注入、不参与常规召回;如需生效请用更完整的表述 replace）`
        : ''
      return { content: `已${ACTION_VERBS[action]}。${demoteNote}${lowQualityNote}${summarizeResult(store)}` }
    },
    presentCall(args) {
      const action = str(args.action) ?? ''
      if (action === 'list') return callCard('查看记忆', 'search', str(args.topic) ?? '')
      const verb = action === 'add' ? '记入记忆' : action === 'replace' ? '纠正记忆' : action === 'remove' ? '删除记忆' : '记忆操作'
      return callCard(verb, action === 'remove' ? 'delete' : 'edit', str(args.content) ?? str(args.id) ?? str(args.topic) ?? '')
    },
    presentResult(args, result): ToolResultView | undefined {
      const text = textOf(result)
      if (result.isError || writeFailed(text)) {
        return resultCard(text, { isError: true })
      }
      const action = str(args.action) ?? ''
      if (action === 'list') return resultCard('记忆清单')
      return resultCard(writeVerdictLabel(action))
    },
  })

  // ---- memory_recall (search, three-level) ---------------------------------
  const recallTool = defineTool({
    name: 'memory_recall',
    description: '检索全局持久记忆(跨会话)。scope=semantic 检索稳定事实;episodic 检索历史会话情景;all(默认)两者都检索。给中文词/片段返回相关记忆。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词/中文片段' },
      topK: { type: 'number', description: '返回条数上限(默认8)' },
      scope: { type: 'string', description: 'semantic|episodic|all(默认 all)' },
    },
    output: objectOutput,
    async execute(args, _exec) {
      const query = str(args.query) ?? ''
      let topK = 8
      if (typeof args.topK === 'number' && Number.isFinite(args.topK)) topK = Math.max(1, Math.min(TOPK_MAX, Math.floor(args.topK))) // P2-33: clamp
      const scope = pick(SCOPES, args.scope) ?? 'all'
      const parts: string[] = []
      if (scope === 'semantic' || scope === 'all') {
        const hits = store.recall(query, { topK, epistemicWeighting: opts.epistemicWeighting ?? true })
        if (hits.length > 0) parts.push('语义记忆:\n' + formatEntries(hits.map(h => h.entry)))
      }
      if (scope === 'episodic' || scope === 'all') {
        const hits = store.recallEpisodes(query, { topK })
        if (hits.length > 0) parts.push('情景记忆(历史会话):\n' + formatEpisodes(hits.map(h => h.episode)))
      }
      return { content: parts.length > 0 ? parts.join('\n\n') : '无匹配记忆。' }
    },
    presentCall(args) {
      return callCard('检索记忆', 'search', str(args.query) ?? '')
    },
    presentResult(_args, result): ToolResultView | undefined {
      const text = textOf(result)
      // P2-32: a surface-level '无匹配记忆。' (or empty) is a genuine miss — it must
      // reach the "no match" card branch, not always render as a hit.
      const empty = text.trim() === '' || text.trim() === '无匹配记忆。'
      return resultCard(result.isError || empty ? recallEmptyLabel() : '检索结果', { isError: result.isError })
    },
  })

  ctx.tools.register(memoryTool)
  ctx.tools.register(recallTool)
}
