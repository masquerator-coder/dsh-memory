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
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUDGET, MemoryStore, resolveDshHome } from './store.js'
import { buildSection } from './inject.js'
import { registerMemoryTools } from './tools.js'
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
    scheduleForget(FORGET_FIRST_DELAY_MS)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      store.close()
    }
  })
}
