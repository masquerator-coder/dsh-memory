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
import { readIdentityFiles } from './identity.js'
import type { ApplyResult, DraftSignal, Epistemic, Importance, Kind, Layer, MemoryDraft, MemoryOp, OpAction, Tier } from './types.js'

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
/** memory_drafts 动作联合(独立于 ACTIONS,兼容 pick 闭集约束)。 */
const DRAFT_ACTIONS: readonly string[] = ['list', 'promote', 'discard']
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
      '写/查全局持久记忆(跨会话)。action: list 查看;add 新增;replace 纠正(需 id);remove 删除(需 id,force=true 物理删除,否则软归档)。layer: user=用户事项,memory=观察。importance 1-5;kind 自动推断;写入即时全局生效。content 须为最精炼的单句「陈述事实」(如 User prefers concise responses),禁止写出祈使句/指令(如 Always respond concisely)。注意:运行时上下文/系统提示词/会话进度不属于可记录的用户事实,勿 add。',
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
      // overflowed 只在 enforceBudget 降级(demote)后仍超预算时发生——即"新增即
      // importance>=5 受保护核心"顶满常驻上限(普通 <5 事实本会降级为 tier1 保存,
      // 不会走这条拒绝路径)。文案据此只针对受保护核心给可操作引导,不再笼统说
      // "预算已满、请整合"(那会让模型误以为普通记忆也被拒)。
      if (res.overflowed) return { content: `[FAIL] 未写入: 常驻核心(importance≥5)占用已达上限(${res.usage.pct}%),降级已无法腾出空间——普通(importance<5)记忆本会自动降级保存,不受此拒。当前常驻核心:\n${formatEntries(res.entries.filter(e => e.tier === 0))}\n如需保存该受保护核心: 请用 memory replace 合并相近旧条目,或调低 importance 让其降级保存,再重试。` }
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
      // 收敛 usage 回显: 普通写不 echo 预算(避免每写一条就多一行结算噪声),
      // 仅在有降级(budget 紧张)时回显,让模型感知预算压力。
      const budgetNote = res.demoted.length > 0 ? summarizeResult(store) : ''
      return { content: `已${ACTION_VERBS[action]}。${demoteNote}${lowQualityNote}${budgetNote}` }
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

  // ---- user_profile: lazy read of user.md (2026-09-02) ----------------------
  // user.md is NOT injected into the system prompt by default (it only carries a
  // constant pointer); the model fetches the full portrait here when it actually
  // needs to know the user (identity / preferences / environment / habits).
  const userProfileTool = defineTool({
    name: 'memory_read_user',
    description:
      '读取用户画像(user.md)。画像内容默认不注入系统提示以节省上下文;当回答、决策或个性化确实需要了解用户(身份/偏好/工作环境/习惯)时,调用本工具获取完整画像。无参数。',
    parameters: {},
    output: objectOutput,
    async execute(_args, _exec) {
      const files = readIdentityFiles(store.dir)
      const u = (files.user ?? '').trim()
      if (!u) return { content: '用户画像(user.md)尚未维护或为空;如需建立,可在设置中编辑 user.md,或用 memory(layer=user) 记录用户事实。' }
      return { content: u }
    },
    presentCall() {
      return callCard('读取用户画像', 'search', 'user.md')
    },
    presentResult(_args, result): ToolResultView | undefined {
      const text = textOf(result)
      return resultCard('用户画像', { isError: result.isError })
    },
  })
  ctx.tools.register(userProfileTool)

  // MEMORY-TRIGGER (2026-09-08): event-driven sedimentation draft consumption.
  registerDraftTools(ctx, store, opts)
}

// ---- memory_drafts — 事件驱动沉淀兜底的消费侧 (MEMORY-TRIGGER 2026-09-08) ------
// turn-end 纯规则(零 LLM)捕获的草稿存于 memory_drafts;主会话得闲时用本工具
// 查看(list)、沉淀(promote,内部先查重再 memory add,守"写入必须闸门")或丢弃(discard)。
// 草稿本身不直接入语义层——promote 是唯一把它转成 memory 的通道,且参数(内容/kind/
// importance 等)仍由主会话把关并经 store.batch 校验(A4 长度、kind 枚举、重要性钳制)。

const DRAFT_SIGNAL_LABEL: Record<DraftSignal, string> = {
  user_confirm: '用户明确确认/强调',
  find_rootcause: '查证根因结论',
  decision_made: '确定技术决策',
  strong_hint: '强暗示(预留)',
}

function formatDrafts(drafts: MemoryDraft[]): string {
  if (drafts.length === 0) return '当前无待沉淀草稿。'
  return drafts.map((d) => {
    const label = DRAFT_SIGNAL_LABEL[d.signal] ?? d.signal
    const reason = d.reason ? `（${d.reason}）` : ''
    return (
      `[草稿#${d.id} ${label}${reason}]\n` +
      `  拟稿: ${d.draft}\n` +
      `  证据: ${d.source_text}\n` +
      `  提示: 认可则 memory add 写入(或直接 memory_drafts promote #${d.id});无价值则 memory_drafts discard #${d.id}`
    )
  }).join('\n\n')
}

function registerDraftTools(ctx: Context, store: MemoryStore, opts: RegisterOpts = {}): void {
  const objectOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { content: { type: 'string', required: true } },
    } as const,
    render: (_args: unknown, value: { content?: string } | undefined): { type: 'text'; text: string }[] =>
      [{ type: 'text', text: String(value?.content ?? '') }],
  }
  const callCard = (title: string, kind: ToolCallKind, rawInput?: string): ToolCallView => ({
    card: 'generic', title, kind, ...(rawInput ? { rawInput } : {}),
  })
  const resultCard = (title: string, opts: { isError?: boolean } = {}): ToolResultView => ({
    card: 'generic',
    title: opts.isError ? '草稿操作未完成' : title,
  })
  /** Extract the leading text block of a tool result, or '' when none. */
  const textOf = (result: ToolResult): string => {
    const block = result.content[0]
    return block?.type === 'text' ? block.text : ''
  }

  const draftTool = defineTool({
    name: 'memory_drafts',
    description:
      '处理 turn-end 纯规则捕获的"待沉淀技术经验草稿"(零 LLM 兜底,LLM 忙也不会丢)。' +
      'action: list 查看待沉淀草稿(pending);promote 确认后写入语义层(需 id+content,内部先查重再 memory add,kind/layer/importance 由本调用把关);discard 丢弃。' +
      '建议流程: list → 逐一审视 → 认可的 memory_drafts promote,无价值的 memory_drafts discard。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | promote | discard' },
      id: { type: 'number', description: 'promote/discard 指定草稿 id(来自 list)' },
      content: { type: 'string', description: 'promote 时: 写入语义层的事实陈述句(可基于草稿改写),须为精炼单句' },
      kind: { type: 'string', description: 'promote 时: preference|env|lesson|decision|general' },
      layer: { type: 'string', description: 'promote 时: user|memory(默认 memory)' },
      topic: { type: 'string', description: 'promote 时: 短标签 ≤40 字' },
      importance: { type: 'number', description: 'promote 时: 1-5' },
      epistemic: { type: 'string', description: 'promote 时: observed|inferred|subjective(默认 observed)' },
    },
    output: objectOutput,
    async execute(args, exec) {
      const action = pick(DRAFT_ACTIONS, str(args.action))
      if (action === 'list' || !action) {
        const drafts = store.listDrafts({ status: 'pending', limit: TOPK_MAX })
        return { content: formatDrafts(drafts) }
      }
      const id = typeof args.id === 'number' && Number.isFinite(args.id) ? Math.floor(args.id) : NaN
      if (!Number.isFinite(id)) {
        return { content: `[FAIL] 未完成: 缺少有效草稿 id(来自 memory_drafts list)。` }
      }
      const draft = store.getDraft(id)
      if (!draft || draft.status !== 'pending') {
        return { content: `[FAIL] 未完成: 草稿 #${id} 不存在或已处理(pending 才可操作)。` }
      }
      if (action === 'discard') {
        store.updateDraftStatus(id, 'discarded')
        return { content: `已丢弃草稿 #${id}(未写入语义层)。` }
      }
      // promote — 守闸门: 主会话把关内容/元数据,内部先查重,未命中才 add。
      const content = str(args.content)
      if (!content || content.trim().length === 0) {
        return { content: `[FAIL] 未完成: promote 需提供 content(写入语义层的事实陈述句)。草稿: ${draft.draft}` }
      }
      if (content.trim().length > MAX_CONTENT_LENGTH) {
        return { content: `[FAIL] 未完成: 记忆内容过长(最多 ${MAX_CONTENT_LENGTH} 字符)。` }
      }
      // 查重防线: 用内容召回库中相似记忆,命中则提示先 replace/合并,不自动覆盖。
      const hits = store.recall(content, { topK: 3, epistemicWeighting: opts.epistemicWeighting ?? true })
      if (hits.length > 0) {
        return {
          content:
            `[提示] 库中已有相似记忆,为避免重复,请先用 memory replace 合并或跳过(草稿 #${id} 仍为 pending):\n` +
            formatEntries(hits.map((h) => h.entry)),
        }
      }
      const op: MemoryOp = {
        action: 'add',
        layer: pick(LAYERS, args.layer),
        kind: pick(KINDS, args.kind),
        topic: str(args.topic),
        content,
        importance: importanceOf(args.importance),
        epistemic: pick(EPISTEMICS, args.epistemic),
      }
      const sid = str(exec.agent?.session?.id)
      let res: ApplyResult
      try {
        res = store.batch([op], sid)
      } catch (err) {
        return { content: `[FAIL] 未完成: 记忆写入异常: ${err instanceof Error ? err.message : String(err)}。草稿 #${id} 仍为 pending。` }
      }
      if (res.overflowed) {
        return { content: `[FAIL] 未写入: 常驻核心(importance≥5)占用已达上限(${res.usage.pct}%),降级无法腾出空间。草稿 #${id} 仍为 pending;可将 importance 调低或用 memory replace 合并再重试。` }
      }
      if (res.rejected.length > 0) {
        return { content: `[FAIL] 未完成: ${res.rejected.map((r) => r.reason).join('; ')}。草稿 #${id} 仍为 pending。` }
      }
      // 成功写入语义层 → 标记 promoted(草稿生命周期闭合)。
      store.updateDraftStatus(id, 'promoted')
      const lq = res.lowQuality?.length ?? 0
      const lowQualityNote = lq > 0
        ? `（注意:因内容过短或高度重复被判为低质:已记入,但默认不注入、不参与常规召回;如需生效请用更完整表述 replace）`
        : ''
      const demoteNote = res.demoted.length > 0 ? `（${res.demoted.length}条已有记忆因预算降级至 tier1）` : ''
      return { content: `已沉淀草稿 #${id}: 写入语义层。${demoteNote}${lowQualityNote}` }
    },
    presentCall(args) {
      const action = str(args.action) ?? 'list'
      if (action === 'list') return callCard('待沉淀草稿', 'search')
      if (action === 'discard') return callCard('丢弃草稿', 'delete', `#${String(args.id ?? '')}`)
      return callCard('沉淀草稿', 'edit', str(args.content) ?? `#${String(args.id ?? '')}`)
    },
    presentResult(_args, result): ToolResultView | undefined {
      const text = textOf(result)
      if (result.isError || writeFailed(text)) return resultCard(text, { isError: true })
      return resultCard('草稿操作')
    },
  })

  ctx.tools.register(draftTool)
}
