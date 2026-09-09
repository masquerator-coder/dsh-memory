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
import type { MemoryStore } from './store.js';
import type { DraftSignal } from './types.js';
/** 稳定技术事实信号标签及其中文说明(用于 reason 与卡片)。 */
export declare const DRAFT_SIGNAL_LABEL: Record<DraftSignal, string>;
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
export declare function detectDraftSignal(input: {
    userText: string;
    agentText: string;
    toolsUsed: string[];
}): {
    signal: DraftSignal;
    draft: string;
    reason: string;
} | null;
/**
 * 按角色从该 turn 事件收集文本块(与 l0.collectTurnTexts 同策略,但区分 user/agent)。
 * 纯函数。返回 { user, agent } 两个字符串数组,各自已去重。
 */
export declare function collectTurnRoleTexts(events: readonly unknown[], turn: number | undefined): {
    user: string[];
    agent: string[];
};
/** 收集服务端 tool/call 名列表(与 l0.collectTurnTools 同策略,独立实现以零耦合). */
export declare function collectTurnToolsPlain(events: readonly unknown[], turn: number | undefined): string[];
/**
 * 适配 turn-end 钩子的薄封装: 收集该 turn 的 user/agent 文本与工具 → detectDraftSignal
 * → 命中则 store.addDraft。任何异常都被吞掉并经 onError 上报(绝不打断宿主 turn 生命周期,
 * 与 runL0 同契约)。返回捕获到的草稿 id 或 null(未捕获/失败)。
 */
export declare function runDraftCapture(store: MemoryStore, input: {
    events: readonly unknown[];
    turn: number | undefined;
    sessionId: string;
    onError?: (err: unknown) => void;
}): number | null;
