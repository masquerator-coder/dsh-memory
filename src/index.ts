/**
 * dsh-memory — Cordis plugin entry (bundle-declarative, section-provider + tools).
 *
 * Three-layer consolidating memory: episodic (session summaries) + semantic
 * (durable facts with dual-signal heat) + active forgetting (three-level
 * ladder). Tier-0 memory is a systemPrompt.section re-evaluated at every
 * assembly; the memory / memory_recall tools write & retrieve the global store.
 *
 * L1/L2 LLM condensation is dormant in v3 — the core store/recall/forget loop
 * is zero-LLM (pure functions + rule-based), so it never degrades when the
 * host LLM is unavailable.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUDGET, MemoryStore, resolveDshHome } from './store.js'
import { buildSection } from './inject.js'
import { registerMemoryTools } from './tools.js'
import { isCompletedTurnEnd, runL0, type L0Options } from './l0.js'
import type { ForgetDays } from './types.js'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt'] as const

/** Plugin configuration. Every field optional; defaults applied in {@link apply}. */
export interface Config {
  memoryHome?: string
  enableInjection?: boolean
  budgetTier0?: number
  budgetUser?: number
  budgetMemory?: number
  importanceThreshold?: number
  epistemicWeighting?: boolean
  /** Run periodic active forgetting (demote/archive/hard-delete). Default true. */
  forgetEnabled?: boolean
  /** Expected time-to-forget (days) per kind. */
  forgetDays?: Partial<ForgetDays>
  /** Frequency sliding window (days). Default 30. */
  windowDays?: number
  /** Episodes older than this (days) are archived. Default 180. */
  episodeRetentionDays?: number
  /** Observation window (days) between archive and hard-delete. Default 30. */
  forgetObserveDays?: number
  /** L0 episodic condensation mode: 'llm' (default, with rule fallback) | 'rules' (pure). */
  l0Summarize?: 'rules' | 'llm'
  /** Optional explicit LLM route pair for L0 (must be set together). */
  l0Provider?: string
  l0Model?: string
  /** L0 LLM output-token cap. Default 400. */
  l0MaxTokens?: number
  /** L0 LLM deadline ms. Default 8000. */
  l0TimeoutMs?: number
}

export const Config: z<Config> = z.object({
  memoryHome: z.string(),
  enableInjection: z.boolean(),
  budgetTier0: z.number(),
  budgetUser: z.number(),
  budgetMemory: z.number(),
  importanceThreshold: z.number(),
  epistemicWeighting: z.boolean(),
  forgetEnabled: z.boolean(),
  forgetDays: z.object({
    env: z.number(),
    lesson: z.number(),
    decision: z.number(),
    general: z.number(),
  }),
  windowDays: z.number(),
  episodeRetentionDays: z.number(),
  forgetObserveDays: z.number(),
  l0Summarize: z.union([z.const('rules'), z.const('llm')]),
  l0Provider: z.string(),
  l0Model: z.string(),
  l0MaxTokens: z.number(),
  l0TimeoutMs: z.number(),
})

const FORGET_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily
const FORGET_FIRST_DELAY_MS = 5 * 60 * 1000 // 5 min after boot

export function apply(ctx: Context, config: Config = {}): void {
  const store = new MemoryStore(
    config.memoryHome || resolveDshHome(),
    {
      tier0: config.budgetTier0 ?? DEFAULT_BUDGET.tier0,
      user: config.budgetUser ?? DEFAULT_BUDGET.user,
      memory: config.budgetMemory ?? DEFAULT_BUDGET.memory,
    },
    config.windowDays ?? 30,
  )

  const enableInjection = config.enableInjection ?? true
  const importanceThreshold = config.importanceThreshold ?? 3
  const epistemicWeighting = config.epistemicWeighting ?? true
  const forgetEnabled = config.forgetEnabled ?? true
  const episodeRetentionDays = config.episodeRetentionDays ?? 180
  const forgetObserveDays = config.forgetObserveDays ?? 30
  const l0Summarize = config.l0Summarize ?? 'llm'
  const l0MaxTokens = config.l0MaxTokens ?? 400
  const l0TimeoutMs = config.l0TimeoutMs ?? 8000

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const runForget = (): void => {
    if (disposed) return
    try {
      store.forgetRun({
        forgetDays: config.forgetDays,
        windowDays: config.windowDays,
        episodeRetentionDays,
        observeDays: forgetObserveDays,
      })
    } catch (err) {
      if (!disposed) console.warn('[dsh-memory] forget run failed:', err instanceof Error ? err.message : err)
    }
  }

  const scheduleForget = (delay: number): void => {
    if (!forgetEnabled) return
    timer = setTimeout(() => {
      timer = undefined
      runForget()
      scheduleForget(FORGET_INTERVAL_MS)
    }, delay)
  }

  ctx.effect(() => {
    if (enableInjection) {
      ctx.systemPrompt.section({
        name: 'memory:tier0',
        order: 10,
        text: () => buildSection(store, { importanceThreshold }).text,
      })
    }
    registerMemoryTools(ctx, store, { epistemicWeighting })

    // ---- L0 episodic condensation: turn/end(completed) → episode summary ----
    // Adapt the dsh LLM seam (LlmRuntime.stream -> text-delta iterable) into the
    // shape l0.ts consumes, and resolve the model route (plan 2: session header).
    const l0Llm = 'llm' in ctx
      ? {
          stream: (o: { provider: string; model: string; messages: { role: string; content: { type: string; text: string }[] }[]; system?: string; maxTokens?: number; signal?: AbortSignal }) => {
            const opaque = (ctx.llm as unknown as { stream(o: never): AsyncIterable<never> }).stream(o as never)
            return (async function* () {
              for await (const chunk of opaque) {
                const c = chunk as { type?: string; text?: string }
                if (c?.type === 'text-delta' && typeof c.text === 'string') yield c
              }
            })()
          },
        }
      : undefined
    const l0Dispose = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!isCompletedTurnEnd(event)) return
      // Resolve the model route (plan 2: auto from the session's request header).
      const cfg = session.requestHeader()?.config
      const provider = config.l0Provider ?? cfg?.provider
      const model = config.l0Model ?? cfg?.model
      void runL0(store, {
        events: session.events as readonly unknown[],
        turn: (event.data as { turn?: number } | null | undefined)?.turn,
        summarize: l0Summarize,
        llm: l0Llm,
        provider,
        model,
        maxTokens: l0MaxTokens,
        timeoutMs: l0TimeoutMs,
        signal: undefined,
        sessionId: session.id,
        toolsUsed: undefined,
        topic: undefined,
      }).catch(() => { /* L0 never breaks the host turn lifecycle */ })
    })

    scheduleForget(FORGET_FIRST_DELAY_MS)
    return () => {
      disposed = true
      l0Dispose()
      if (timer) clearTimeout(timer)
      store.close()
    }
  })
}
