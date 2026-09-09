/**
 * dsh-memory — 事件驱动沉淀兜底 (MEMORY-TRIGGER 2026-09-08).
 *
 * 痛点: 记忆写入触发依赖主会话(LLM)临场想起去 memory add,LLM 忙(构建/调试/查证)
 * 时会忽略阶段收尾,稳定技术事实丢失。本模块把"该不该沉淀的第一手判断"从主会话的
 * 临时想起机械化为 turn-end 的纯规则探测:
 *   - detectDraftSignal 纯函数: 零 LLM,保守阈值,从该 turn 的 user/agent 文本 + 工具集
 *     探测"稳定技术事实"信号,命中则产出{ signal, draft, reason }候选;未命中返回 null。
 *   - runDraftCapture 适配 turn-end 钩子: 收集该 turn 的 user/agent 文本与工具 → 探测
 *     → 命中则写 memory_drafts 草稿(调 store.addDraft)。任何 throw 都被吞掉并经 onError
 *     记录——绝不打断宿主 turn 生命周期(与 runL0 同契约)。
 *
 * 关键边界: 捕获纯规则零 LLM、零 LLM 旁路,不违背设计文档"不每轮 spawn LLM 旁路";
 * 产物是"候选草稿"而非直接 memory add——写入语义层仍由主会话经 memory_drafts 工具
 * 查重后裁决(promote/discard),守住"自动只到候选,写入必须有闸门"。
 *
 * 本模块核心是纯函数(可测试): 只有 store 写与事件收集由调用方注入。
 */
import type { MemoryStore } from './store.js'
import type { DraftSignal } from './types.js'

/** 稳定技术事实信号标签及其中文说明(用于 reason 与卡片)。 */
export const DRAFT_SIGNAL_LABEL: Record<DraftSignal, string> = {
  user_confirm: '用户明确确认/强调的技术事实',
  find_rootcause: '查证类工具命中 + 技术根因结论',
  decision_made: '用户认可确定技术决策',
  strong_hint: '强暗示性技术事实',
}

/**
 * 用户侧明确"这是事实/别忘/关键"的强信号。保守: 只收明确表达,不收泛泛语气。
 * 用于 user_confirm 与 decision_made。注意: 中文无 \b 词边界,故中文 pattern 一律
 * 不用 \b(行内英文标识符等可保留),否则永远无法匹配中文词。
 */
const USER_CONFIRM_PATTERNS: RegExp[] = [
  /记住/, /以后注意/, /这是个坑/, /这是个雷/, /关键[点是]?/, /很重要/,
  /务必/, /一定(?:要|得)/, /别再犯/, /切记/, /注意[:： ]/, /所以([^。！？.!?]{0,12})(?:才对|是正确的|才行)/,
  /确认[^。！？.!?]*?(?:可行|正确|没问题|生效|成功)/, /记住[:：]/,
]

/** agent 侧查证/根因结论的动词信号(与查证类工具命中叠加成 find_rootcause)。 */
const AGENT_ROOTCAUSE_PATTERNS: RegExp[] = [
  /根因/, /根本原因/, /原因在/, /原因是/, /因为[^。！？.!?]{0,14}(?:导致|引起|所以)/,
  /查清/, /定位到/, /发现[^。！？.!?]{0,10}(?:问题是|根因是|原因是)/,
  /修复[^。！？.!?]{0,12}(?:了|完成|成功)/, /验证[^。！？.!?]{0,12}(?:通过|成功|有效|正确)/,
  /确认是/, /原来是/, /最终.{0,8}(?:原因|根因|症结)/, /症结/,
]

/** agent 侧技术结论动词(与用户确认叠加成 decision_made / 单独成 strong_hint)。 */
const AGENT_DECISION_PATTERNS: RegExp[] = [
  /采用/, /改用/, /改为/, /选择/, /落地为/, /决定/, /方案定为/, /确定采用/, /定型为/,
]

/**
 * 查证/排障类工具名——命中其一即视为"该 turn 做了证据收集",与根因结论叠加才捕,
 * 避免 agent 随口说"原因是"被误捕。
 */
const ROOTCAUSE_TOOLS = new Set<string>([
  'web_search', 'web_fetch', 'grep', 'read', 'glob', 'pwsh', 'univer_api',
  'univer_inspect', 'univer_status', 'univer_lint', 'git',
])

/** 工具名中是否含查证/排障特征(宽松匹配,含 git/log/status/search/read 等)。 */
function isRootcauseTool(name: string): boolean {
  if (ROOTCAUSE_TOOLS.has(name)) return true
  const n = name.toLowerCase()
  return /(^|_)(search|fetch|grep|read|inspect|status|lint|log|git|debug|trace)(_|$)/.test(n)
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text))
}

/** 从一条文本抽"该记住"的候选: 取命中信号附近的一句陈述,去首尾空白、收敛换行、限长。 */
function extractDraft(source: string, cap = 160): string {
  let s = String(source ?? '').replace(/\s+/g, ' ').trim()
  if (s.length > cap) s = `${s.slice(0, cap)}…`
  return s
}

const DRAFT_SOURCE_CAP = 240

/**
 * 纯函数: 从该 turn 的 user/agent 文本 + 工具集判定是否捕获一条"待沉淀草稿"。
 *
 * 判定优先级(取第一条最强命中,一次只产一条,避免一轮多条噪声):
 *   1. user_confirm   — 用户明确确认/强调(记住/以后注意/这是个坑/关键/很重要…)
 *   2. find_rootcause — 查证类工具命中 AND agent 含根因结论动词(强证据,降误报)
 *   3. decision_made  — 用户确认句式 AND agent 含决策动词(确定技术决策且被认可)
 *   4. strong_hint    — 仅 agent 含决策/根因动词但不满足上述强条件(保守: 极低频才用)
 *
 * 保守阈值优先: 强度不足(如 agent 单说"原因是"但没有查证工具)返回 null 不打扰。
 * 纯函数,零 dsh 依赖,便于 smoke 单测锁定样例。
 */
export function detectDraftSignal(
  input: { userText: string; agentText: string; toolsUsed: string[] },
): { signal: DraftSignal; draft: string; reason: string } | null {
  const user = String(input.userText ?? '')
  const agent = String(input.agentText ?? '')
  const tools = Array.isArray(input.toolsUsed) ? input.toolsUsed : []
  const sourceText = (user + '\n' + agent).trim().slice(0, DRAFT_SOURCE_CAP)

  // 1. user_confirm — 用户明确强调/确认(最高可信,直接捕)
  if (matchesAny(USER_CONFIRM_PATTERNS, user)) {
    return {
      signal: 'user_confirm',
      draft: extractDraft(user),
      reason: DRAFT_SIGNAL_LABEL.user_confirm,
    }
  }

  const usedRootcauseTool = tools.some((t) => isRootcauseTool(t))
  const agentHasRootcause = matchesAny(AGENT_ROOTCAUSE_PATTERNS, agent)
  const agentHasDecision = matchesAny(AGENT_DECISION_PATTERNS, agent)
  const userHasInput = user.trim().length > 0

  // 2. find_rootcause — 查证工具命中 AND 根因结论(强证据,降误报)
  if (usedRootcauseTool && agentHasRootcause) {
    return {
      signal: 'find_rootcause',
      draft: extractDraft(agent),
      reason: DRAFT_SIGNAL_LABEL.find_rootcause,
    }
  }

  // 3. decision_made — agent 做确定技术决策且该 turn 用户有实质输入(决策成立)
  if (agentHasDecision && userHasInput) {
    return {
      signal: 'decision_made',
      draft: extractDraft(agent),
      reason: DRAFT_SIGNAL_LABEL.decision_made,
    }
  }

  // 4. (空) 不再发射 strong_hint——它与 decision_made 高度重叠且扩大误捕面,
  //    违背"保守阈值、宁可不打扰"。strong_hint 类型保留为 schema/types 扩展位,
  //    但本版本不主动发射,避免弱信号噪声进入待沉淀草稿。
  return null
}

/** 事件的 text 源(与 l0.ts TurnTextSource 同形,此处独立声明避免耦合监控类型). */
interface DraftTextSource {
  readonly type?: string
  readonly data?: { readonly turn?: number; readonly content?: readonly unknown[] } | Record<string, never> | null
  readonly text?: string
}

const USER_TYPES = new Set(['user/message', 'user/text'])
const AGENT_TYPES = new Set(['agent/message', 'agent/text'])

/**
 * 按角色从该 turn 事件收集文本块(与 l0.collectTurnTexts 同策略,但区分 user/agent)。
 * 纯函数。返回 { user, agent } 两个字符串数组,各自已去重。
 */
export function collectTurnRoleTexts(events: readonly unknown[], turn: number | undefined): { user: string[]; agent: string[] } {
  const user: string[] = []
  const agent: string[] = []
  for (const raw of events) {
    const ev = raw as DraftTextSource
    if (turn !== undefined) {
      const d = ev.data as { turn?: number } | null | undefined
      if (d && typeof d.turn === 'number' && d.turn !== turn) continue
    }
    const type = ev.type
    if (!type) continue
    let text = ''
    if (typeof ev.text === 'string' && ev.text.trim().length > 0) {
      text = ev.text.trim()
    } else {
      const blocks = (ev.data as { content?: readonly unknown[] } | null | undefined)?.content
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          const block = b as { type?: string; text?: string }
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
            text = block.text.trim()
            break
          }
        }
      }
    }
    if (!text) continue
    if (USER_TYPES.has(type)) user.push(text)
    else if (AGENT_TYPES.has(type)) agent.push(text)
  }
  const dedupe = (a: string[]): string[] => Array.from(new Set(a))
  return { user: dedupe(user), agent: dedupe(agent) }
}

/** 收集服务端 tool/call 名列表(与 l0.collectTurnTools 同策略,独立实现以零耦合). */
export function collectTurnToolsPlain(events: readonly unknown[], turn: number | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of events) {
    const ev = raw as { type?: string; data?: { turn?: number; name?: string } | Record<string, never> | null }
    if (ev.type !== 'tool/call') continue
    const d = ev.data as { turn?: number; name?: string } | null | undefined
    if (turn !== undefined && (!d || typeof d.turn !== 'number' || d.turn !== turn)) continue
    const name = d?.name
    if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * 适配 turn-end 钩子的薄封装: 收集该 turn 的 user/agent 文本与工具 → detectDraftSignal
 * → 命中则 store.addDraft。任何异常都被吞掉并经 onError 上报(绝不打断宿主 turn 生命周期,
 * 与 runL0 同契约)。返回捕获到的草稿 id 或 null(未捕获/失败)。
 */
export function runDraftCapture(
  store: MemoryStore,
  input: {
    events: readonly unknown[]
    turn: number | undefined
    sessionId: string
    onError?: (err: unknown) => void
  },
): number | null {
  try {
    const { user, agent } = collectTurnRoleTexts(input.events, input.turn)
    const userText = user.join('\n')
    const agentText = agent.join('\n')
    if (!userText.trim() && !agentText.trim()) return null
    const toolsUsed = collectTurnToolsPlain(input.events, input.turn)
    const hit = detectDraftSignal({ userText, agentText, toolsUsed })
    if (!hit) return null
    return store.addDraft({
      session_id: input.sessionId,
      turn: input.turn,
      signal: hit.signal,
      source_text: (userText + '\n' + agentText).trim().slice(0, 240),
      draft: hit.draft,
      reason: hit.reason,
    })
  } catch (err) {
    input.onError?.(err)
    return null
  }
}
