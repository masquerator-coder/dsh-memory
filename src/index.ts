/**
 * dsh-memory — Cordis plugin entry (bundle-declarative, section-provider + tools).
 *
 * Three-layer consolidating memory: episodic (session summaries) + semantic
 * (durable facts with dual-signal heat) + active forgetting (three-level
 * ladder). Tier-0 memory is a systemPrompt.section re-evaluated at every
 * assembly; the memory / memory_recall tools write & retrieve the global store.
 *
 * L1/L2 LLM condensation runs on a background timer (LLM-decided, audited into
 * `refine_runs`); the core store/recall/forget loop is zero-LLM (pure functions
 * + rule-based), so it never degrades when the host LLM is unavailable. Routes
 * for the background passes auto-resolve when not configured explicitly.
 *
 * M5–M9 (2026-08-30, see docs/REFINE-REDESIGN.md):
 *   M5 L0 session settle  — turn-end keeps realtime RULE summaries (zero LLM);
 *                           the LLM upgrade is deferred to an idle-settle pass
 *                           (one call per session after l0IdleMinutes idle).
 *   M6 L1 event kick      — a new episode schedules a short-delay refine pass;
 *                           the periodic timer remains as a fallback.
 *   M7 L2 incremental     — clusters whose members changed since the last
 *                           audit are the only ones re-LLM'd (l2_refined).
 *   M8 peak-hour gate     — L1/L2 LLM passes skip during suppressWindows.
 *   M9 identity blocks    — constant soul.md / user.md sections, KV friendly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUDGET, MemoryStore, resolveDshHome } from './store.js'
import { buildIdentitySection, buildSection } from './inject.js'
import { registerMemoryTools } from './tools.js'
import { collectTurnTexts, condenseSession, isCompletedTurnEnd, runL0, type L0Options } from './l0.js'
import { isSuppressed, resolveRefineRoute, runRefineL1, runRefineL2, type SuppressCfg } from './refine.js'
import { autocreateIdentityFiles, IDENTITY_MAX_BYTES, maintainUserIdentity } from './identity.js'
import { registerIdentityRoutes } from './identity-routes.js'
import { MEMORY_SETTINGS_DEFAULTS, memorySettingsSchema, type MemorySettings } from './settings.js'
import type { ForgetDays } from './types.js'

/**
 * Minimal shape of the host's default-model service (declared here so the
 * plugin compiles standalone; the real `@deepseek-ai/dsh-agent-default-model`
 * package augments Context at runtime and is required via `inject`).
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentDefaultModel?: { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } }
    /** dsh settings service (host-provided). Optional so the plugin still
     *  compiles/runs where the seam is absent; when present we register the
     *  `memory` namespace for live settings-UI configuration. */
    settings?: {
      register<T>(ns: string, schema: z<T>, options?: { base?: Partial<T>; applies?: 'live' | 'restart' }): {
        get(): T
        watch(callback: (next: T, prev: T) => void): () => void
        update(patch: object): Promise<void>
        replace(section: object): Promise<void>
      }
    }
  }
}

export const name = 'memory'
export const inject = ['tools', 'systemPrompt', 'llm', 'agentDefaultModel', 'settings'] as const

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
  /** L0 episodic condensation mode: 'llm' (default = idle-settle LLM upgrade) | 'rules' (pure). */
  l0Summarize?: 'rules' | 'llm'
  /** Optional explicit LLM route pair for L0 (must be set together). */
  l0Provider?: string
  l0Model?: string
  /** L0 output-token cap. Default 400. */
  l0MaxTokens?: number
  /** L0 LLM deadline ms. Default 8000. */
  l0TimeoutMs?: number
  /** L1 episodic→semantic extraction (LLM-decided). Default true. */
  l1Enabled?: boolean
  /** L2 semantic merge/arbitration (LLM-decided). Default true. */
  l2Enabled?: boolean
  /** M7: only re-LLM a cluster whose members changed since last audit. Default true. */
  l2Incremental?: boolean
  /** Explicit route pair for L1. Optional: auto-resolves (learned session route → host default model). */
  l1Provider?: string
  l1Model?: string
  /** L1 output-token cap. Default 800. */
  l1MaxTokens?: number
  /** L1 LLM deadline ms. Default 10000. */
  l1TimeoutMs?: number
  /** Explicit route pair for L2 (same as L1: explicit when enabled). */
  l2Provider?: string
  l2Model?: string
  /** L2 output-token cap. Default 800. */
  l2MaxTokens?: number
  /** L2 LLM deadline ms. Default 10000. */
  l2TimeoutMs?: number
  /** Background refine scan interval ms. Default 1h. */
  refineIntervalMs?: number
  /** Minimum members for an L2 cluster to be offered to the LLM. Default 2. */
  l2MinCluster?: number
  /** Whether L1 retries LLM-degraded episodes (extracted=2) on later passes. Default false. */
  l1RetryDegraded?: boolean
  /** M5: session idle (min) before the LLM settle upgrades its episode. Default 30. */
  l0IdleMinutes?: number
  /** M5: idle-settle check cadence (min). Default 5. */
  checkMinutes?: number
  /** M8: peak-hour LLM suppression windows ("HH:MM", same-day). Default Beijing 09–12 / 14–18. */
  suppressWindows?: { start: string; end: string }[]
  /** M8: also suppress for these minutes before each window opens. Default 15. */
  suppressLeadMinutes?: number
  /** M8: timezone the suppression windows are expressed in. Default 'Asia/Shanghai'. */
  timeZone?: string
  /** M9: inject constant soul.md / user.md identity sections. Default true. */
  enableIdentity?: boolean
  /** R3-total: master memory switch. false → new sessions inject no memory
   *  (clean sessions) and background condensation/forgetting stop; the memory /
   *  memory_recall tools stay available for explicit use. Default true. */
  enabled?: boolean
  /** R3-i: auto-create + incrementally maintain user.md from user-layer memories. Default true. */
  identityAuto?: boolean
  /** R3-i: identity maintenance cadence (ms). Default 6h. */
  identityIntervalMs?: number
  /** R3-i: cap on the auto-maintained identity file (bytes). Default 2000. */
  identityMaxBytes?: number
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
  l1Enabled: z.boolean(),
  l2Enabled: z.boolean(),
  l2Incremental: z.boolean(),
  l1Provider: z.string(),
  l1Model: z.string(),
  l1MaxTokens: z.number(),
  l1TimeoutMs: z.number(),
  l2Provider: z.string(),
  l2Model: z.string(),
  l2MaxTokens: z.number(),
  l2TimeoutMs: z.number(),
  refineIntervalMs: z.number(),
  l2MinCluster: z.number(),
  l1RetryDegraded: z.boolean(),
  l0IdleMinutes: z.number(),
  checkMinutes: z.number(),
  suppressWindows: z.array(z.object({ start: z.string(), end: z.string() })),
  suppressLeadMinutes: z.number(),
  timeZone: z.string(),
  enableIdentity: z.boolean(),
  enabled: z.boolean(),
  identityAuto: z.boolean(),
  identityIntervalMs: z.number(),
  identityMaxBytes: z.number(),
})

const FORGET_INTERVAL_MS = 24 * 60 * 60 * 1000 // daily
const FORGET_FIRST_DELAY_MS = 5 * 60 * 1000 // 5 min after boot
/** Cap on in-flight L0 condensation runs (P1-10): a slow LLM summary must not
 *  stack unboundedly across turns. */
const L0_MAX_INFLIGHT = 4
/** P2-5 (review 2026-08-31): bounds on the pending-settle session map — max
 *  tracked sessions (LRU-evicted) and a staleness horizon after which a
 *  buffered-but-never-settled session is dropped. */
const L0_PENDING_MAX_SESSIONS = 64
const L0_PENDING_STALE_MS = 24 * 60 * 60 * 1000
/** M6: fresh-episode refine kick delay (ms) — near-immediate, not the 1h timer. */
const REFINE_KICK_DELAY_MS = 10_000

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
  const episodeRetentionDays = config.episodeRetentionDays ?? 180
  const forgetObserveDays = config.forgetObserveDays ?? 30
  const l0Summarize = config.l0Summarize ?? 'llm'
  const l0MaxTokens = config.l0MaxTokens ?? 400
  const l0TimeoutMs = config.l0TimeoutMs ?? 8000
  const l1Enabled = config.l1Enabled ?? true
  const l2Enabled = config.l2Enabled ?? true
  const l2Incremental = config.l2Incremental ?? true
  const l1MaxTokens = config.l1MaxTokens ?? 800
  const l1TimeoutMs = config.l1TimeoutMs ?? 10000
  const l2MaxTokens = config.l2MaxTokens ?? 800
  const l2TimeoutMs = config.l2TimeoutMs ?? 10000
  const l2MinCluster = config.l2MinCluster ?? 2
  const l1RetryDegraded = config.l1RetryDegraded ?? true
  // M5 / M8 / M9
  const l0IdleMinutes = config.l0IdleMinutes ?? 30
  const checkMinutes = config.checkMinutes ?? 5
  const enableIdentity = config.enableIdentity ?? true
  const suppressCfg: SuppressCfg = {
    suppressWindows: config.suppressWindows ?? [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    suppressLeadMinutes: config.suppressLeadMinutes ?? 15,
    timeZone: config.timeZone ?? 'Asia/Shanghai',
  }
  // R3-total / R3-i / R3-ui — live-toggleable settings. `runtime` is the single
  // source of truth for everything a settings page can change at runtime: seeded
  // from cordis config and refreshed from the dsh settings document via
  // scope.watch() below. identityMaxBytes stays a static cordis-config value
  // (a file-size cap, not a toggle).
  const identityMaxBytes = config.identityMaxBytes ?? IDENTITY_MAX_BYTES
  const settingsBase: MemorySettings = {
    enabled: config.enabled ?? MEMORY_SETTINGS_DEFAULTS.enabled,
    forgetEnabled: config.forgetEnabled ?? MEMORY_SETTINGS_DEFAULTS.forgetEnabled,
    identityAuto: config.identityAuto ?? MEMORY_SETTINGS_DEFAULTS.identityAuto,
    identityIntervalMs: config.identityIntervalMs ?? MEMORY_SETTINGS_DEFAULTS.identityIntervalMs,
    refineIntervalMs: config.refineIntervalMs ?? MEMORY_SETTINGS_DEFAULTS.refineIntervalMs,
    peakHourSuppress: MEMORY_SETTINGS_DEFAULTS.peakHourSuppress,
  }
  const runtime = { ...settingsBase }

  // R3-ui: register the `memory` settings namespace when the dsh settings seam
  // is present. The settings user layer overrides the cordis-config base; watch()
  // pushes changes into `runtime` for live effect (no restart required).
  const settingsScope = ctx.settings?.register<MemorySettings>('memory', memorySettingsSchema, {
    base: settingsBase,
    applies: 'live',
  })
  let unwatchSettings: (() => void) | undefined
  if (settingsScope) {
    const seed = settingsScope.get()
    runtime.enabled = seed.enabled
    runtime.forgetEnabled = seed.forgetEnabled
    runtime.identityAuto = seed.identityAuto
    runtime.identityIntervalMs = seed.identityIntervalMs
    runtime.refineIntervalMs = seed.refineIntervalMs
    runtime.peakHourSuppress = seed.peakHourSuppress
    // P3-6 (review 2026-08-31): keep the unsubscribe and call it on dispose —
    // relying on the host scope's lifetime silently leaked the watcher across
    // hot reloads.
    unwatchSettings = settingsScope.watch((next) => {
      runtime.enabled = next.enabled
      runtime.forgetEnabled = next.forgetEnabled
      runtime.identityAuto = next.identityAuto
      runtime.identityIntervalMs = next.identityIntervalMs
      runtime.refineIntervalMs = next.refineIntervalMs
      runtime.peakHourSuppress = next.peakHourSuppress
    })
  }

  // P2-4 (review 2026-08-31): in-flight background tasks (L0 condensation,
  // idle settle, refine passes) are fire-and-forget async and write to the
  // store — dispose must not close the DB under them. Track them here and
  // close the store only after they all settle.
  const inFlightTasks = new Set<Promise<unknown>>()
  const track = (p: Promise<unknown>): void => {
    inFlightTasks.add(p)
    void p.finally(() => { inFlightTasks.delete(p) }).catch(() => { /* tracked tasks never reject out */ })
  }

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let refineTimer: ReturnType<typeof setTimeout> | undefined
  let refineKick: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let identityTimer: ReturnType<typeof setTimeout> | undefined

  const runForget = (): void => {
    if (disposed || !runtime.enabled || !runtime.forgetEnabled) return
    try {
      store.forgetRun({
        forgetDays: config.forgetDays,
        episodeRetentionDays,
        observeDays: forgetObserveDays,
      })
    } catch (err) {
      if (!disposed) console.warn('[dsh-memory] forget run failed:', err instanceof Error ? err.message : err)
    }
  }

  const scheduleForget = (delay: number): void => {
    // P1-2 (review 2026-08-31): no static config gate here — the timer stays
    // resident so a runtime toggle off→on (settings panel) revives the daily
    // runForget without a restart, honoring the README "live-toggle" promise.
    // runForget itself already double-gates on runtime.enabled &&
    // runtime.forgetEnabled, so a disabled config only skips work, not the loop.
    timer = setTimeout(() => {
      timer = undefined
      runForget()
      scheduleForget(FORGET_INTERVAL_MS)
    }, delay)
    timer.unref() // P1-11: don't hold the Node event loop open for the daily forget
  }

  ctx.effect(() => {
    // R3-i: ensure identity files exist (idempotent; empty shells). Unconditional
    // so a later settings toggle-on has the files ready.
    autocreateIdentityFiles(store.dir)

    // R3-ui: expose soul.md/user.md over /memory/identity for the settings UI
    // editor. Degrades silently if the host has no webServer service.
    const disposeIdentityRoutes = registerIdentityRoutes(ctx, store)

    // Tier-0 memory + identity sections stay registered; their text thunk reads
    // runtime.enabled so toggling the master switch drops/restores injection live.
    if (enableInjection) {
      ctx.systemPrompt.section({
        name: 'memory:tier0',
        order: 10,
        text: () => (runtime.enabled ? buildSection(store, { importanceThreshold }).text : ''),
      })
    }
    // M9: constant identity blocks (soul.md / user.md) — mtime-cached, KV friendly.
    if (enableIdentity) {
      ctx.systemPrompt.section({
        name: 'memory:soul',
        order: 11,
        text: () => (runtime.enabled ? buildIdentitySection(store.dir, 'soul.md', 'AI 本人').text : ''),
      })
      ctx.systemPrompt.section({
        name: 'memory:user',
        order: 12,
        text: () => (runtime.enabled ? buildIdentitySection(store.dir, 'user.md', '用户画像').text : ''),
      })
    }
    registerMemoryTools(ctx, store, { epistemicWeighting })

    // ---- L0 episodic condensation + L1/L2 background refinement ----
    // Host default model route (idiot-proof auto-route): read once at boot so the
    // background L1/L2 timer has a route even before any live session ran.
    let hostDefault: { provider?: string; model?: string } | undefined
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.provider && sel?.model) hostDefault = { provider: sel.provider, model: sel.model }
    } catch {
      hostDefault = undefined
    }
    // Route learned from a live session request-header (captured in the L0 hook).
    const learned: { provider?: string; model?: string } = {}
    // Adapt the dsh LLM seam (LlmRuntime.stream -> text-delta iterable) into the
    // shape l0.ts / refine.ts consume, and resolve the model route (plan 2: session
    // header for L0; explicit config for background L1/L2 which have no session).
    const llmSeam = 'llm' in ctx
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
    let l0InFlight = 0

    // M5: per-session pending LLM settle bookkeeping (activity timestamp + buffered
    // turn texts). Idle-settle upgrades the freshest rule episode with one LLM call.
    // P2-5 (review 2026-08-31): the map itself is bounded — long-running hosts
    // with many short-lived sessions (never idle-settled) would otherwise grow
    // it forever. Cap the session count (evict the least-recently-active) and
    // let runSettle drop entries stale beyond L0_PENDING_STALE_MS.
    const l0Pending = new Map<string, { lastActivity: number; texts: string[] }>()
    const l0Dispose = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!isCompletedTurnEnd(event)) return
      if (!runtime.enabled) return // R3-total: memory disabled → no auto condensation at all
      if (l0InFlight >= L0_MAX_INFLIGHT) return // P1-10: cap concurrent condensation
      const turn = (event.data as { turn?: number } | null | undefined)?.turn
      // Resolve the model route (plan 2: auto from the session's request header).
      const cfg = session.requestHeader()?.config
      if (cfg?.provider && cfg?.model) {
        learned.provider = cfg.provider
        learned.model = cfg.model
      }
      // Realtime RULE summary (zero LLM) — keeps the episodic trace live while the
      // conversation runs; the LLM upgrade is deferred to the idle-settle pass.
      const provider = config.l0Provider ?? cfg?.provider
      const model = config.l0Model ?? cfg?.model
      l0InFlight += 1
      track(runL0(store, {
        events: session.events as readonly unknown[],
        turn,
        summarize: 'rules', // M5: turn-end never burns LLM — settle does
        sessionId: session.id,
        // P2-7: program errors (disk full, closed DB) must leave a trace.
        onError: (err) => { if (!disposed) console.warn('[dsh-memory] L0 condensation failed:', err instanceof Error ? err.message : err) },
      }).finally(() => { l0InFlight -= 1 }).catch(() => { /* L0 never breaks the host turn lifecycle */ }))

      // Buffer this turn's texts for the idle LLM settle (bounded to last 200).
      if (session.id) {
        const texts = collectTurnTexts(session.events, turn)
        const prev = l0Pending.get(session.id)
        if (!prev && l0Pending.size >= L0_PENDING_MAX_SESSIONS) {
          // P2-5: evict the least-recently-active session's buffer.
          let oldestKey: string | undefined
          let oldestTs = Infinity
          for (const [k, v] of l0Pending) if (v.lastActivity < oldestTs) { oldestTs = v.lastActivity; oldestKey = k }
          if (oldestKey !== undefined) l0Pending.delete(oldestKey)
        }
        l0Pending.set(session.id, {
          lastActivity: Date.now(),
          texts: (prev ? prev.texts : []).concat(texts).slice(-200),
        })
      }
      kickRefine() // M6: a fresh realtime episode → L1 extraction in ~10s
    })

    // M6: a fresh episode (written above) schedules a short-delay refine pass so
    // L1/L2 react in ~10s, not the next 1h timer. Latched; never double-fires.
    const kickRefine = (): void => {
      if (disposed || refineKick) return
      refineKick = setTimeout(() => {
        refineKick = undefined
        track(runRefine())
      }, REFINE_KICK_DELAY_MS)
      refineKick.unref?.()
    }

    // L1/L2 refinement: unified background timer (no per-turn cost). Runs on the
    // same seam; explicit route (l1/l2Provider/model, falling back to l0 route)
    // because the timer has no request-header. Guarded by a re-entrancy latch so
    // a slow pass never stacks; never blocks the core write/recall loop.
    let refining = false
    const runRefine = async (): Promise<void> => {
      if (disposed || refining || !runtime.enabled) return
      refining = true
      try {
        // M8: peak-hour gate (toggleable via settings) — skip LLM burn during
        // expensive windows; the periodic scan re-evaluates later.
        if (runtime.peakHourSuppress && isSuppressed(new Date(), suppressCfg)) return
        if (l1Enabled) {
          const l1Route = resolveRefineRoute(
            (config.l1Provider && config.l1Model)
              ? { provider: config.l1Provider, model: config.l1Model }
              : (config.l0Provider && config.l0Model)
                ? { provider: config.l0Provider, model: config.l0Model }
                : undefined,
            learned,
            hostDefault,
          )
          if (!l1Route && !disposed) console.warn('[dsh-memory] L1 enabled but no LLM route resolved (explicit config, learned session route, and host default model all absent) — pass will be degraded')
          await runRefineL1(store, {
            llm: llmSeam,
            provider: l1Route?.provider,
            model: l1Route?.model,
            maxTokens: l1MaxTokens, timeoutMs: l1TimeoutMs,
            retryDegraded: l1RetryDegraded,
          })
        }
        if (l2Enabled) {
          const l2Route = resolveRefineRoute(
            (config.l2Provider && config.l2Model)
              ? { provider: config.l2Provider, model: config.l2Model }
              : (config.l0Provider && config.l0Model)
                ? { provider: config.l0Provider, model: config.l0Model }
                : undefined,
            learned,
            hostDefault,
          )
          if (!l2Route && !disposed) console.warn('[dsh-memory] L2 enabled but no LLM route resolved (explicit config, learned session route, and host default model all absent) — pass will be degraded')
          await runRefineL2(store, {
            llm: llmSeam,
            provider: l2Route?.provider,
            model: l2Route?.model,
            maxTokens: l2MaxTokens, timeoutMs: l2TimeoutMs,
            minCluster: l2MinCluster,
            incremental: l2Incremental, // M7
          })
        }
      } catch (err) {
        if (!disposed) console.warn('[dsh-memory] refine run failed:', err instanceof Error ? err.message : err)
      } finally {
        refining = false
      }
    }
    const scheduleRefine = (delay: number): void => {
      if (disposed) return
      refineTimer = setTimeout(() => {
        refineTimer = undefined
        track(runRefine().finally(() => scheduleRefine(runtime.refineIntervalMs)))
      }, delay)
      refineTimer.unref() // P1-11: don't hold the event loop for the background pass
    }

    // M5: idle-settle check loop — scans pending sessions each checkMinutes and
    // upgrades those idle ≥ l0IdleMinutes with a single LLM consolidation call.
    const runSettle = (): void => {
      if (disposed || !runtime.enabled) return
      const now = Date.now()
      const idleMs = l0IdleMinutes * 60 * 1000
      for (const [sid, p] of l0Pending) {
        if (now - p.lastActivity < idleMs) continue
        // P2-5: a buffered session that never reached a settle (route down
        // forever, host restarted mid-idle) is dropped after the stale horizon
        // instead of pinning map memory forever.
        if (now - p.lastActivity > L0_PENDING_STALE_MS) { l0Pending.delete(sid); continue }
        if (l0Summarize !== 'llm') { l0Pending.delete(sid); continue } // pure-rule mode: rule summary already live
        const route = resolveRefineRoute(
          (config.l0Provider && config.l0Model)
            ? { provider: config.l0Provider, model: config.l0Model }
            : undefined,
          learned,
          hostDefault,
        )
        // P2-2 (review 2026-08-31): DO NOT delete the pending entry until a
        // condenseSession is actually dispatched — the old order dropped the
        // buffered turn texts forever whenever the route was momentarily
        // unresolvable or the in-flight cap was full.
        if (!route) continue // retried next check cycle
        if (l0InFlight >= L0_MAX_INFLIGHT) continue // deferred one cycle, buffer kept
        l0Pending.delete(sid)
        l0InFlight += 1
        track(condenseSession(store, {
          texts: p.texts,
          llm: llmSeam,
          provider: route.provider,
          model: route.model,
          maxTokens: l0MaxTokens,
          timeoutMs: l0TimeoutMs,
          sessionId: sid,
        }).finally(() => {
          l0InFlight -= 1
          kickRefine() // M6: a settled session-level episode → L1 extraction soon
        }).catch(() => { /* never breaks the idle loop */ }))
      }
    }
    const scheduleSettle = (): void => {
      if (disposed) return
      settleTimer = setTimeout(() => {
        settleTimer = undefined
        runSettle()
        scheduleSettle()
      }, checkMinutes * 60 * 1000)
      settleTimer.unref?.() // P1-11: don't hold the event loop
    }

    // R3-i: identity-file maintenance pass — appends new user-layer memories into
    // user.md. Pure-rule, zero LLM; skips entirely when there is no new content.
    const runIdentity = (): void => {
      if (disposed || !runtime.enabled || !runtime.identityAuto) return
      try {
        maintainUserIdentity(store, store.dir, { maxBytes: identityMaxBytes })
      } catch (err) {
        if (!disposed) console.warn('[dsh-memory] identity maintain failed:', err instanceof Error ? err.message : err)
      }
    }
    const scheduleIdentity = (delay: number): void => {
      if (disposed) return
      identityTimer = setTimeout(() => {
        identityTimer = undefined
        runIdentity()
        scheduleIdentity(runtime.identityIntervalMs)
      }, delay)
      identityTimer.unref?.()
    }

    // Background loops start unconditionally; each run() gates runtime.enabled,
    // so toggling the master switch live gates the work without timer churn.
    scheduleForget(FORGET_FIRST_DELAY_MS)
    scheduleRefine(2 * 60 * 1000) // first pass 2 min after boot
    scheduleSettle() // M5: idle-settle loop (every checkMinutes)
    scheduleIdentity(60 * 1000) // first identity pass 1 min after boot
    return () => {
      disposed = true
      l0Dispose()
      disposeIdentityRoutes()
      unwatchSettings?.() // P3-6: stop the settings watcher on dispose
      if (timer) clearTimeout(timer)
      if (refineTimer) clearTimeout(refineTimer)
      if (refineKick) clearTimeout(refineKick)
      if (settleTimer) clearTimeout(settleTimer)
      if (identityTimer) clearTimeout(identityTimer)
      // P2-4 (review 2026-08-31): close the store only after every in-flight
      // background task (L0 / settle / refine) has settled — they are
      // fire-and-forget async and would otherwise write to a closed DB.
      // allSettled never rejects; LLM calls are deadline-bounded so the wait
      // is bounded too.
      void Promise.allSettled([...inFlightTasks]).finally(() => {
        try { store.close() } catch { /* already closed */ }
      })
    }
  })
}
