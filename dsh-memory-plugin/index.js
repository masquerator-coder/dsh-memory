/**
 * DSH memory plugin — host half.
 *
 * This plugin is the harness-side client of `memory_system`. It never reasons
 * about memory itself: capture, retrieval, digest budgeting, the user profile,
 * notebook edits and Markdown backup all live in the Python package and are
 * reached through {@link BridgeClient}. What lives here is only what a harness
 * owns — tool schemas the model can call, the system-prompt anchor, session
 * capture, the model call that writes a digest, and the HTTP routes the
 * settings page talks to.
 *
 * @module dsh-memory
 */

import { readFile } from 'node:fs/promises'

import { BridgeClient, BridgeError, defaultMemoryHome, defaultMemorySystemRoot } from './bridge.js'
import { buildTools } from './tools.js'

/** Tool names this plugin owns; also the user-facing memory surface. */
export const TOOL_NAMES = [
  'memory_search',
  'memory_add',
  'memory_forget',
  'memory_recall',
  'memory_profile_read',
  'memory_digest_read',
  'memory_digest_generate',
  'skill_create',
  'skill_list',
  'skill_get',
  'skill_run',
  'skill_retire',
]

/** Prompt section order: after the built-in tool docs, before the persona. */
const ANCHOR_ORDER = 9500

/** L4 index order: right after the memory anchor, still before the persona. */
const SKILL_INDEX_ORDER = 9510

/** How long an anchor stays usable before it is refreshed. */
const ANCHOR_REFRESH_MS = 15_000

/** How long the project's skill index stays usable before it is re-read. */
const SKILL_REFRESH_MS = 30_000

/**
 * How much recent work the anchor shows for the current project.
 *
 * A hard ceiling, not a target: the block is resident in every request, and a
 * digest plus a five-line list is the point where the rest is cheaper to read
 * from `DSH_MEMORY.md` than to carry every turn.
 */
const RECENT_CHARS = 400

/** How many newest memories the anchor considers before the character cut. */
const RECENT_LIMIT = 8

/**
 * Skills one project may hold before the model must retire or merge one.
 *
 * The design's ceiling is 200, which is the right bound for a long-lived
 * registry but far past what a model should ever create through a tool call:
 * every project-scope skill competes for the Level-1 index and the model's
 * attention. Two dozen is already generous for "worth keeping procedures".
 */
const MODEL_SKILL_CAP = 24

/** Default configuration; the row's YAML may override any field. */
const DEFAULTS_INNER = {
  pythonPath: '',
  memorySystemRoot: '',
  memoryHome: '',
  projectOverride: '',
  // Memory is written by the model through `memory_add`, never harvested from
  // session traffic: the host injects many synthetic user-role messages
  // (runtime context, skill catalog, compaction checkpoints), and capturing
  // them as if they were the human's words poisons recall.
  captureTurns: false,
  // Automatic digests are always on; the switch was removed from the UI.
  autoSummary: true,
  autoSummaryDelayMs: 15000,
  systemPromptAnchor: true,
  // Project-scope L4 skills: the resident index block, and whether the model
  // is told when it may save a procedure as a new skill.
  skillIndex: true,
  skillAuthoring: true,
  // Model steps between memory reminders; 0 disables the heartbeat.
  heartbeatSteps: 20,
  // Ask the model once, at session teardown, for anything still unwritten.
  sessionEndCheck: true,
  requestTimeoutMs: 60000,
  embeddingPreset: '',
}

/**
 * Numeric settings for which zero is a meaningful value rather than a typo.
 *
 * `heartbeatSteps: 0` is documented as "no reminder at all", but the generic
 * `> 0` guard below rejected it and silently kept the default, so the switch
 * could not actually be turned off. Every other number is a duration or a
 * count where zero would mean "no timeout" or "run on every step", so zero
 * stays invalid for those.
 */
const ZERO_IS_MEANINGFUL = new Set(['heartbeatSteps'])

/**
 * Normalize raw row configuration.
 * @param {Record<string, unknown>} input - loader-provided config.
 * @returns {typeof DEFAULTS_INNER} resolved configuration.
 */
function resolveConfig(input) {
  const config = { ...DEFAULTS_INNER }
  for (const key of Object.keys(DEFAULTS_INNER)) {
    const value = input?.[key]
    if (value === undefined || value === null) continue
    if (typeof DEFAULTS_INNER[key] === 'number') {
      const parsed = Number(value)
      const zero = parsed === 0 && ZERO_IS_MEANINGFUL.has(key)
      if (Number.isFinite(parsed) && (parsed > 0 || zero)) config[key] = parsed
      continue
    }
    if (typeof DEFAULTS_INNER[key] === 'boolean') {
      config[key] = value === true || value === 'true'
      continue
    }
    config[key] = String(value)
  }
  return config
}

/** Host services this plugin cannot work without. */
export const HOST_SERVICES = ['tools', 'systemPrompt', 'agents']

/**
 * Services that enable extra surface when present, never gate the plugin.
 *
 * `connection` is mounted only by the Web profile. Declaring it in `inject`
 * made a headless run skip `apply` entirely — no tools, no prompt anchor —
 * even though the tool surface needs nothing from it.
 */
export const OPTIONAL_SERVICES = ['connection']

/** @deprecated Use {@link HOST_SERVICES}; kept so existing imports still work. */
export const inject = HOST_SERVICES

/** Working directory of the agent behind a tool or assembly context. */
function cwdOf(context) {
  return context?.agent?.session?.header?.cwd
}

/** Session id of the agent behind a tool context. */
function sessionIdOf(context) {
  return context?.agent?.session?.id
}

/** Text of a message's content blocks, ignoring non-text blocks. */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The human/model exchange of a session, trimmed to what a reviewer needs.
 *
 * Only real user turns and assistant replies are kept: synthetic user-role
 * messages (runtime context, skill catalog, compaction checkpoints) repeat
 * every turn and would drown the actual conversation the same way they once
 * poisoned capture. Tool traffic is dropped for the same reason.
 * @param {any} session - a live or disposed session.
 * @param {number} limit - characters to keep from the tail.
 * @returns {string} the transcript tail, or '' when unreadable.
 */
function sessionTranscript(session, limit = 8000) {
  let events = []
  try {
    events = session?.snapshotEvents?.() ?? session?.log ?? []
  } catch {
    return ''
  }
  const lines = []
  for (const event of events) {
    const data = event?.data
    if (event?.type === 'user/message') {
      if (data?.source?.kind !== 'user') continue
      const text = messageText(data)
      if (text) lines.push(`用户：${text}`)
    } else if (event?.type === 'assistant/message') {
      const text = messageText(data?.message ?? data)
      if (text) lines.push(`助手：${text}`)
    }
  }
  const joined = lines.join('\n\n')
  return joined.length <= limit ? joined : joined.slice(-limit)
}

/**
 * Read the memory list out of a model reply, tolerating prose around the JSON.
 * @param {string} reply - the raw assistant text.
 * @returns {Array<{summary: string, event_type: string, importance: number}>} accepted items.
 */
function parseMemories(reply) {
  const text = String(reply ?? '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = Array.isArray(parsed?.memories) ? parsed.memories : []
  const allowed = new Set(['decision', 'preference', 'fix', 'fact', 'note'])
  const items = []
  for (const entry of raw) {
    const summary = typeof entry?.summary === 'string' ? entry.summary.trim() : ''
    if (summary.length < 4) continue
    const eventType = allowed.has(entry?.event_type) ? entry.event_type : 'note'
    const importance = Math.min(Math.max(Number(entry?.importance ?? 0.6), 0), 1)
    items.push({ summary: summary.slice(0, 600), event_type: eventType, importance })
  }
  return items.slice(0, 10)
}

/**
 * Build the plugin.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>} rawConfig - the row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  for (const service of HOST_SERVICES) {
    if (!ctx.get(service)) {
      ctx.logger?.warn?.(`[dsh-memory] service "${service}" is missing; the memory plugin stays inactive`)
      return
    }
  }
  for (const service of OPTIONAL_SERVICES) {
    if (!ctx.get(service)) {
      ctx.logger?.info?.(
        `[dsh-memory] optional service "${service}" is absent; the memory tools stay available`,
      )
    }
  }
  const logger = ctx.logger ?? console
  const home = config.memoryHome || defaultMemoryHome()
  const client = new BridgeClient({
    pythonPath: config.pythonPath,
    root: config.memorySystemRoot || defaultMemorySystemRoot(),
    timeoutMs: config.requestTimeoutMs,
    logger,
  })
  ctx.effect(() => () => {
    void client.settle()
  }, 'dsh-memory.bridge')

  /** @type {Map<string, string>} session id → project id, for capture. */
  const projects = new Map()

  /**
   * Resolve the project id for a session cwd.
   * @param {string | undefined} cwd - session working directory.
   * @returns {Promise<string | undefined>} project id, if resolvable.
   */
  async function projectFor(cwd) {
    if (config.projectOverride) return config.projectOverride
    if (!cwd) return undefined
    const cached = projects.get(`cwd:${cwd}`)
    if (cached) return cached
    const result = await client.call('projects', { home, cwd })
    if (result?.project_id) projects.set(`cwd:${cwd}`, result.project_id)
    return result?.project_id
  }

  /**
   * Lowest-level bridge call with the shared payload prefix.
   * @param {string} command - command name.
   * @param {Record<string, unknown>} payload - command arguments.
   * @param {AbortSignal} [signal] - cancellation for the wait.
   * @returns {Promise<any>} command result.
   */
  function call(command, payload = {}, signal) {
    return client.call(command, { home, embedding_preset: config.embeddingPreset || undefined, ...payload }, signal)
  }

  // ── heartbeat + auto-summary timing ───────────────────────────────────

  /** Pending auto-summary timers, so a later turn can coalesce them. */
  const autoTimers = new Map()

  /**
   * Debounce an automatic digest for one session.
   * @param {any} session - the session whose turn just settled.
   */
  function scheduleAutoSummary(session) {
    const id = session?.id
    if (!id) return
    const existing = autoTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      autoTimers.delete(id)
      generateDigest({ cwd: session?.header?.cwd, signal: undefined, reason: 'auto' }).catch((error) => {
        logger.warn(`[dsh-memory] automatic digest failed: ${error?.message ?? error}`)
      })
    }, config.autoSummaryDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    autoTimers.set(id, timer)
  }

  ctx.effect(() => () => {
    for (const timer of autoTimers.values()) clearTimeout(timer)
    autoTimers.clear()
  }, 'dsh-memory.auto-summary-timers')

  /**
   * Model steps taken since the last `memory_add`, per session id.
   *
   * A step is one model call (`step/start`), not one user turn: a turn that
   * runs thirty tool calls is thirty steps, which is what `heartbeatSteps`
   * counts and what the reminder text promises.
   *
   * The heartbeat is host pacing, not memory logic: it decides *when* to
   * remind the model, never *what* is worth remembering. The reminder rides
   * the system-prompt section so it costs no session event.
   */
  const stepsSinceWrite = new Map()

  /**
   * Count one model step toward the next memory reminder.
   * @param {string} sessionId - the session that took the step.
   */
  function bumpStep(sessionId) {
    if (!sessionId) return
    stepsSinceWrite.set(sessionId, (stepsSinceWrite.get(sessionId) ?? 0) + 1)
  }

  /**
   * Clear a session's counter after it writes a memory.
   * @param {string} sessionId - the session that called `memory_add`.
   */
  function noteMemoryWrite(sessionId) {
    if (sessionId) stepsSinceWrite.set(sessionId, 0)
  }

  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type === 'step/start') {
      // One step is one model call. Counting `turn/start` instead made a
      // single long turn — thirty tool calls, no `memory_add` — look like one
      // step, so the reminder stayed silent exactly when it was needed.
      bumpStep(session?.id)
      return
    }
    if (type !== 'turn/end') return
    if (config.autoSummary) scheduleAutoSummary(session)
  })

  ctx.effect(() => () => stepsSinceWrite.clear(), 'dsh-memory.heartbeat-state')

  /**
   * Last-chance memory check when a session goes away.
   *
   * The heartbeat only reminds the model mid-flight; a session that ends right
   * after a valuable exchange never reaches the next reminder. One model call
   * at teardown asks whether anything is still unwritten, and writes it
   * through the same `memory.remember` command the tool uses, so the store
   * keeps one write path.
   *
   * Teardown must never block or throw: the session is already gone, so a
   * failure is a warning in the log, not an error the host has to handle.
   * @param {any} session - the disposed session.
   */
  async function reviewSessionEnd(session) {
    if (!config.sessionEndCheck) return
    const cwd = session?.header?.cwd
    const projectId = await projectFor(cwd)
    if (!projectId) return
    const transcript = sessionTranscript(session)
    // Too little was said to hold anything the model could not state directly.
    if (transcript.length < 200) return
    const llm = ctx.get?.('llm')
    if (!llm || !lastRoute) return
    const reply = await collectText(
      llm,
      lastRoute,
      [
        {
          role: 'system',
          content: [
            '你是记忆整理器。阅读下面这段会话记录，找出其中值得长期保留、但尚未写入记忆库的内容。',
            '只输出一个 JSON 对象，不要任何解释或代码块：',
            '{"memories":[{"summary":"一句话，含关键实体与结论","event_type":"decision|preference|fix|fact|note","importance":0.6}]}',
            '没有值得保留的内容时输出 {"memories":[]}。',
            '不要记录闲聊、能从代码直接读到的内容、一次性中间步骤。宁缺毋滥。',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ],
      undefined,
    )
    for (const item of parseMemories(reply)) {
      await call('memory.remember', {
        project_id: projectId,
        summary: item.summary,
        event_type: item.event_type,
        importance: item.importance,
        source: 'dsh-session-end',
        session_key: session?.id,
      })
    }
  }

  ctx.on('session/disposed', (session) => {
    void reviewSessionEnd(session).catch((error) => {
      if (error?.code === 'DISPOSED') return
      logger.warn(`[dsh-memory] session-end memory check failed: ${error?.message ?? error}`)
    })
  })

  // ── current project resolution ────────────────────────────────────────

  /** Last known working directory, so a request without one still resolves. */
  const lastCwd = { value: '' }

  /**
   * Remember a working directory seen on a session.
   * @param {string | undefined} cwd - session working directory.
   */
  function rememberCwd(cwd) {
    if (typeof cwd === 'string' && cwd) lastCwd.value = cwd
  }

  /**
   * Pick the most recently active session's working directory.
   * @returns {string | undefined} a working directory, if any.
   */
  function liveCwd() {
    const sessions = ctx.get?.('sessions')
    const list = sessions?.list?.() ?? []
    if (list.length > 0) {
      const ranked = [...list].sort((a, b) => Number(b?.updatedAt ?? b?.updated_at ?? 0) - Number(a?.updatedAt ?? a?.updated_at ?? 0))
      for (const session of ranked) {
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd) {
          rememberCwd(cwd)
          return cwd
        }
      }
    }
    return lastCwd.value || undefined
  }

  /**
   * Resolve the working directory a host-side request should act on: the one
   * the caller named, else the latest live session's, else the last seen one.
   * @param {string | undefined} cwd - caller-supplied working directory.
   * @returns {string | undefined} working directory.
   */
  function resolveCwd(cwd) {
    if (typeof cwd === 'string' && cwd) {
      rememberCwd(cwd)
      return cwd
    }
    return liveCwd()
  }

  // ── digest generation (host owns the model) ───────────────────────────

  /** The most recent model route a session used, so digests use a real model. */
  let lastRoute

  ctx.on('agent/request', async (payload, next) => {
    // `next()` is the only thing that drives the request; if it throws, the
    // error must reach the host unchanged, so there is nothing to clean up
    // here beyond recording a route we did observe.
    const request = await next()
    if (request?.provider && request?.model) lastRoute = { provider: request.provider, model: request.model }
    return request
  })

  /**
   * Read all streamed text from a model call.
   * @param {any} llm - the llm service.
   * @param {{ provider: string, model: string }} route - model route.
   * @param {Array<{ role: string, content: string }>} turns - conversation.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @returns {Promise<string>} the concatenated assistant text.
   */
  async function collectText(llm, route, turns, signal) {
    const messages = turns.map((turn, index) => ({
      id: `dsh-memory-${index}`,
      role: turn.role,
      content: [{ type: 'text', text: turn.content }],
      source: turn.role === 'assistant' ? { kind: 'model', ...route } : { kind: 'user' },
    }))
    let text = ''
    let failure
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
    }
    if (failure) {
      throw new BridgeError(`模型调用失败：${failure.message ?? failure.code ?? '未知错误'}`, failure.code ?? 'LLM_FAILED')
    }
    return text
  }

  /**
   * Digest run in progress.
   *
   * Automatic generation fires per idle session and the settings page can ask
   * for one at the same time. There is only one global digest, so overlapping
   * runs would each pay for a model call and then commit two copies.
   */
  const digestInFlight = new Map()

  /**
   * The memory ids the last global digest was built from, or null before one
   * has been seen. Seeded from `digest.history` on first use so a restarted
   * host still knows what the on-disk digest already covers, and refreshed
   * after every commit.
   * @type {Set<string> | null}
   */
  let lastDigestSources = null

  /** Load the previous digest's source snapshot once. */
  async function loadLastDigestSources() {
    if (lastDigestSources) return lastDigestSources
    try {
      const history = await call('digest.history', { limit: 1 })
      const sources = history?.items?.[0]?.sources
      lastDigestSources = Array.isArray(sources) ? new Set(sources) : new Set()
    } catch {
      // Unknown history must not block a digest: treat it as "nothing known".
      lastDigestSources = new Set()
    }
    return lastDigestSources
  }

  /**
   * Plan the global digest, ask the model to write it, and commit it.
   * @param {object} options - generation options.
   * @param {string} [options.cwd] - project working directory (for root notes).
   * @param {AbortSignal} [options.signal] - cancellation.
   * @param {string} [options.reason] - `manual` or `auto`.
   * @param {number} [options.length] - override the stored budget.
   * @returns {Promise<any>} `{ digest }` as committed.
   */
  async function generateDigest({ cwd, signal, reason = 'manual', length } = {}) {
    cwd = resolveCwd(cwd)
    // Resolving the project also registers its root path, which is what lets
    // the Python side refresh that project's DSH_MEMORY.md. It is never a
    // reason to fail a global digest.
    let projectId
    if (cwd) {
      try {
        projectId = await projectFor(cwd)
      } catch {
        // The digest itself is cross-project and can proceed without it.
      }
    }
    // Several sessions can go idle at once, and the manual button can fire
    // while an automatic run is mid-flight, so a second caller joins the first
    // instead of starting its own.
    //
    // The joined caller does not forward its own `signal`: aborting one
    // client must not cancel a run that other callers are waiting on.
    const key = 'global'
    const running = digestInFlight.get(key)
    if (running) {
      if (reason === 'auto') return { digest: null, skipped: 'in-flight' }
      try {
        return await running
      } catch {
        // The earlier run failed; fall through and try once more.
      }
    }
    const task = runDigest({ cwd, projectId, signal, reason, length })
    digestInFlight.set(key, task)
    try {
      return await task
    } finally {
      // Only the owner removes the entry, so a late finisher cannot clear a
      // run that replaced it.
      if (digestInFlight.get(key) === task) digestInFlight.delete(key)
    }
  }

  /**
   * Whether a planned digest would read exactly what the last committed one read.
   *
   * `digest.plan` returns the memory ids its material digest was built from, and
   * `digest.commit` stores that same list on the record. Comparing the two sets
   * answers "has any work been recorded since the last summary?" without a model
   * call. A plan with no sources is never considered unchanged: an empty store
   * still deserves its one honest note.
   * @param {{sources?: string[]}} plan - the plan just fetched.
   * @returns {boolean} true when re-summarizing would produce the same digest.
   */
  function unchangedSince(plan) {
    const planned = plan?.sources
    if (!Array.isArray(planned) || planned.length === 0) return false
    const last = lastDigestSources
    if (!last) return false
    if (last.size !== planned.length) return false
    return planned.every((id) => last.has(id))
  }

  /**
   * The body of one digest run, without the in-flight bookkeeping.
   * @param {object} options - generation options.
   * @returns {Promise<any>} `{ digest }` as committed.
   */
  async function runDigest({ cwd, projectId, signal, reason, length }) {
    const plan = await call('digest.plan', { cwd, project_id: projectId, length }, signal)
    // An automatic run that would read exactly the materials the last digest
    // was built from produces the same summary again at full model cost. It
    // happens constantly: every session teardown schedules one, so idle
    // sessions would re-summarize an unchanged store all day. `plan.sources`
    // is the memory-id snapshot the previous commit recorded, which makes
    // "has anything new been written since?" a set comparison, not a model call.
    if (reason === 'auto' && plan.has_materials !== false) {
      await loadLastDigestSources()
      if (unchangedSince(plan)) {
        logger.info('[dsh-memory] automatic digest skipped: no new work records')
        return { digest: null, skipped: 'no-change' }
      }
    }
    const llm = ctx.get?.('llm')
    let text = ''
    let error
    let generator = 'host-llm'
    if (!llm) {
      error = 'llm 服务不可用，无法调用模型生成摘要'
      generator = 'unavailable'
    } else if (!lastRoute) {
      error = '本进程还没有任何会话使用过模型，无法确定调用哪个模型'
      generator = 'unavailable'
    } else if (plan.has_materials === false) {
      // Empty memory is a real state, not a failure: record the honest note.
      text = `## 暂无工作记录\n还没有可作为摘要的工作记录（${new Date().toISOString().slice(0, 10)}）。`
      generator = 'host-llm'
    } else {
      try {
        text = await collectText(
          llm,
          lastRoute,
          [
            { role: 'system', content: plan.system },
            { role: 'user', content: plan.user },
          ],
          signal,
        )
      } catch (failure) {
        if (failure?.code === 'ABORTED') throw failure
        error = failure?.message ?? String(failure)
      }
    }
    const committed = await call(
      'digest.commit',
      {
        cwd,
        project_id: projectId,
        text,
        target_chars: plan.target_chars,
        sources: plan.sources ?? [],
        material_chars: plan.material_chars ?? 0,
        prompt_version: plan.prompt_version,
        reason,
        generator,
        error,
      },
      signal,
    )
    logger.info(`[dsh-memory] digest ${committed?.digest?.status ?? 'unknown'} (${reason}, global)`)
    // Record what this digest now covers, so the next automatic run can tell
    // whether anything new has been written since.
    lastDigestSources = new Set(plan.sources ?? [])
    return committed
  }

  // ── tools ─────────────────────────────────────────────────────────────

  for (const definition of buildTools({ call, projectFor, generateDigest })) {
    // The heartbeat only needs to know that the model *made* a recording
    // attempt, so wrapping here keeps `tools.js` a pure schema+execute module.
    // A duplicate rejected by the memory store still counts: the model did its
    // part, and re-reminding it about the same insight is noise.
    const wrapped =
      definition.name === 'memory_add'
        ? {
            ...definition,
            async execute(args, exec) {
              try {
                return await definition.execute(args, exec)
              } finally {
                noteMemoryWrite(sessionIdOf(exec))
              }
            },
          }
        : definition
    // Skill creation has the same shape of seam: the per-session guard in the
    // prompt only needs to know that the model tried to save a procedure.
    const registered =
      wrapped.name === 'skill_create'
        ? {
            ...wrapped,
            async execute(args, exec) {
              try {
                return await wrapped.execute(args, exec)
              } finally {
                noteSkillCreate(sessionIdOf(exec))
              }
            },
          }
        : wrapped
    ctx.effect(() => ctx.tools.register(registered), `dsh-memory.tool(${registered.name})`)
  }

  // ── L4: project skills ───────────────────────────────────────────────

  /**
   * Skills created from this process.
   *
   * Deliberately in-memory and deliberately not a record of what exists: the
   * project's skills are whatever the next `skill.index` reads back from the
   * store. This only paces the model ("one new skill per session, more only
   * when the user asks"), so losing it on restart costs nothing.
   */
  const skillsCreated = new Map()

  /**
   * Count one skill the model just tried to save.
   * @param {string | undefined} sessionId - the creating session.
   */
  function noteSkillCreate(sessionId) {
    if (!sessionId) return
    skillsCreated.set(sessionId, (skillsCreated.get(sessionId) ?? 0) + 1)
  }

  ctx.effect(() => () => skillsCreated.clear(), 'dsh-memory.skill-state')

  // ── system prompt anchor ──────────────────────────────────────────────

  if (config.systemPromptAnchor) {
    /**
     * One slot, not one per working directory.
     *
     * The `@@dsh-memory` count line and the profile are global — `digest.anchor`
     * ignores the caller's directory — so keying that part by directory only
     * made N projects each age out and each pay for an identical round trip.
     * `recent` is per project, but the refresh is on one slot: the extra
     * `memory.list` rides along with the anchor call it already makes.
     */
    const anchorSlotShared = { at: 0, text: '', summary: null, profile: null, recent: null, pending: false }

    /** @param {string} _cwd - session working directory; the anchor is global. */
    function anchorSlot(_cwd) {
      return anchorSlotShared
    }

    /**
     * Start a refresh when the cached anchor has aged.
     * @param {any} context - assembly context carrying the agent.
     */
    function refreshAnchor(context) {
      const session = context?.agent?.session
      const cwd = session?.header?.cwd ?? ''
      rememberCwd(session?.header?.cwd)
      const slot = anchorSlot(cwd)
      const age = Date.now() - slot.at
      if (slot.pending) return
      if (slot.at > 0 && age < ANCHOR_REFRESH_MS) return
      slot.at = Date.now()
      slot.pending = true
      void (async () => {
        // The count line and the profile are global: the one cross-project
        // digest, for every session. The per-project lines are read next to
        // it, and a failure there must not lose the global part.
        try {
          const result = await call('digest.anchor', {
            include_summary: true,
            include_profile: true,
          })
          slot.text = typeof result?.text === 'string' ? result.text : ''
          slot.summary = Boolean(result?.summary)
          slot.profile = Boolean(result?.profile)
        } catch (error) {
          logger.warn(`[dsh-memory] anchor refresh failed: ${error?.message ?? error}`)
        }
        try {
          slot.recent = await refreshRecent(cwd)
        } catch (error) {
          logger.warn(`[dsh-memory] recent-work refresh failed: ${error?.message ?? error}`)
          slot.recent = { lines: [], truncated: false }
        } finally {
          slot.at = Date.now()
          slot.pending = false
        }
      })()
    }

    /**
     * Read this project's most recent work lines for the anchor.
     *
     * The digest is cross-project, so for the project the session is actually
     * in it says almost nothing. These are the newest L2 summaries for this
     * project only, cut to a hard character budget: the block is resident in
     * every request, so the section earns its tokens by answering "what has
     * been done here" without a tool round trip, and by staying short enough
     * that the full digest and `DSH_MEMORY.md` remain the place for detail.
     *
     * A project with no memories answers `[]`, and the block then omits the
     * section entirely instead of advertising emptiness every turn.
     *
     * @param {string} cwd - the session's working directory.
     * @returns {Promise<{lines: string[], truncated: boolean}>} the lines.
     */
    async function refreshRecent(cwd) {
      const projectId = await projectFor(cwd)
      if (!projectId) return { lines: [], truncated: false }
      const result = await call('memory.list', {
        project_id: projectId,
        limit: RECENT_LIMIT,
        state: 'active',
      })
      const items = Array.isArray(result?.items) ? result.items : []
      const lines = []
      let used = 0
      for (const item of items) {
        const summary = String(item?.summary ?? '').replace(/\s+/g, ' ').trim()
        if (!summary) continue
        const line = `- ${summary}`
        if (used + line.length > RECENT_CHARS) break
        lines.push(line)
        used += line.length
      }
      return { lines, truncated: items.length > lines.length }
    }

    /**
     * The anchor body for one assembly.
     *
     * An empty slot means "never read yet" and a failed read lands here too, so
     * `summary` and `profile` are reported as unknown: absence of a digest must
     * not be inferred from a state that may simply predate the first read.
     * @param {{text?: string, summary?: boolean, profile?: boolean}} slot - anchor cache entry.
     * @returns {string} the body text.
     */
    function anchorBody(slot) {
      if (slot?.text) return slot.text
      if (slot?.summary === false) return ANCHOR_NO_SUMMARY
      return ANCHOR_NOTHING_YET
    }

    /**
     * The per-project work lines, or '' when this project has no memories yet.
     *
     * Absent is not the same as empty here: a fresh project would otherwise
     * spend resident tokens announcing that it has nothing.
     *
     * @param {{recent?: {lines?: string[], truncated?: boolean} | null}} slot - anchor cache entry.
     * @returns {string} the section, or ''.
     */
    function recentSection(slot) {
      const lines = slot?.recent?.lines ?? []
      if (lines.length === 0) return ''
      const tail = slot.recent.truncated
        ? `- …更早的用 \`memory_search\`（state 可查 dormant/archived）或读仓库根的 \`DSH_MEMORY.md\``
        : '- 全量历史读仓库根的 `DSH_MEMORY.md`'
      return ['**本项目最近的工作**（从新到旧，节选用）', ...lines, tail].join('\n')
    }

    /**
     * The reminder line for one session, or '' when the heartbeat is quiet.
     * @param {string | undefined} sessionId - the assembling session.
     * @returns {string} a one-line nudge, or ''.
     */
    function heartbeatLine(sessionId) {
      const threshold = Number(config.heartbeatSteps) || 0
      if (threshold <= 0) return ''
      const steps = stepsSinceWrite.get(sessionId ?? '') ?? 0
      if (steps < threshold) return ''
      return `\n\n**记忆提醒**：距上次调用 \`memory_add\` 已过 ${steps} 个模型步。若这期间出现了值得长期保留的经验、决策或操作规则，现在就记下来；没有则忽略本条。`
    }

    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-memory:anchor',
          order: ANCHOR_ORDER,
          interpolate: false,
          text: (context) => {
            refreshAnchor(context)
            // Same assembly context the refresh just looked at. One shared
            // slot: the count line is global, so every session reads it; only
            // the recent-work section is this project's.
            const session = context?.agent?.session
            const slot = anchorSlot(session?.header?.cwd ?? '')
            // The rules are unconditional: a project with an empty store still
            // needs to know that writing memory is its job. Only the anchor
            // body, the recent-work section and the heartbeat vary.
            return `${ANCHOR_HEADER.replace('{{memory_anchor}}', anchorBody(slot)).replace(
              '{{recent_work}}',
              recentSection(slot),
            )}${heartbeatLine(session?.id)}`
          },
        }),
      'dsh-memory.anchor-section',
    )
  }

  // ── L4: skill index section ───────────────────────────────────────────

  if (config.skillIndex || config.skillAuthoring) {
    /**
     * Index text per working directory, refreshed off the assembly path.
     *
     * Same trade as the memory anchor: assembly is synchronous, so a stale-by-
     * seconds index beats a prompt that waits on the Python child. The slot is
     * stamped with the moment the refresh *started*, so a long read cannot
     * make the cache look fresh for longer than it is.
     */
    const skillCaches = new Map()

    /** @param {string} cwd - session working directory, '' when unknown. */
    function skillSlot(cwd) {
      const key = cwd || ''
      let slot = skillCaches.get(key)
      if (!slot) {
        slot = { at: 0, text: '', pending: false }
        skillCaches.set(key, slot)
      }
      return slot
    }

    /**
     * Start a read of this project's skill index when the cached one aged.
     * @param {string | undefined} cwd - session working directory.
     */
    function refreshSkillIndex(cwd) {
      const slot = skillSlot(cwd || '')
      if (slot.pending) return
      if (slot.at > 0 && Date.now() - slot.at < SKILL_REFRESH_MS) return
      slot.at = Date.now()
      slot.pending = true
      void (async () => {
        try {
          const projectId = await projectFor(cwd)
          if (!projectId) return
          const result = await call('skill.index', { project_id: projectId })
          const lines = Array.isArray(result?.index) ? result.index : []
          slot.text = lines.join('\n')
        } catch (error) {
          logger.warn(`[dsh-memory] skill index refresh failed: ${error?.message ?? error}`)
        } finally {
          slot.pending = false
        }
      })()
    }

    /**
     * The guidance for one assembly: what the project can already do, and when
     * saving a new procedure is allowed.
     * @param {string | undefined} sessionId - the assembling session.
     * @param {string | undefined} cwd - the session's working directory.
     * @returns {string} the skill block, or '' when there is nothing to say.
     */
    function skillBlock(sessionId, cwd) {
      const slot = skillCaches.get(cwd ?? '')
      const index = slot?.text?.trim() ?? ''
      const created = skillsCreated.get(sessionId ?? '') ?? 0
      const parts = []
      if (config.skillIndex) {
        parts.push(SKILL_INDEX_HEADER.replace('{{skill_index}}', index || SKILL_INDEX_EMPTY))
        // `0` is not a literal cap: the first skill of a session is the one
        // most likely to be worth keeping, and the user can ask for more.
        if (config.skillAuthoring) {
          const pace =
            created === 0
              ? SKILL_AUTHORING_RULE
              : SKILL_AUTHORING_PACED.replace('{{count}}', String(created))
          parts.push(`${pace}\n${SKILL_AUTHORING_CAP.replace('{{cap}}', String(MODEL_SKILL_CAP))}`)
        }
      }
      return `\n\n${parts.join('\n\n')}`
    }

    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-memory:skills',
          order: SKILL_INDEX_ORDER,
          interpolate: false,
          text: (context) => {
            const session = context?.agent?.session
            const cwd = session?.header?.cwd
            rememberCwd(cwd)
            refreshSkillIndex(cwd)
            return skillBlock(session?.id, cwd)
          },
        }),
      'dsh-memory.skill-section',
    )
  }

  // ── HTTP surface for the settings page ─────────────────────────────────

  /**
   * Hostnames only this machine can reach, so a page served from them is the
   * local user's own page. Mirrors the loopback test in the host's request
   * fence (`dsh-client-connection` `api-request-trust`).
   * @param {string} hostname - WHATWG-parsed hostname (IPv6 without brackets).
   * @returns {boolean} true for loopback spellings.
   */
  function isLoopbackHostname(hostname) {
    // WHATWG keeps IPv6 literals bracketed, which is why `[::1]` is spelled so.
    if (hostname === 'localhost' || hostname === '[::1]') return true
    const parts = hostname.split('.')
    return (
      parts.length === 4 &&
      parts[0] === '127' &&
      parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    )
  }

  /**
   * Authority of a request, parsed the way the host parses it.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {any} webCtx - the context the route was registered on.
   * @returns {URL | undefined} the Host as a URL, if it is a bare authority.
   */
  function requestAuthority(req, webCtx) {
    const host = req.headers.host
    if (typeof host !== 'string' || host.length === 0) return undefined
    const protocol = webCtx.get('webServer')?.protocol ?? 'http:'
    try {
      return new URL(`${protocol}//${host}`)
    } catch {
      return undefined
    }
  }

  /**
   * Whether this request may reach the memory routes.
   *
   * The plugin registers plain exact routes, so nothing upstream has vetted
   * the request yet. Accepting every caller would turn these routes into a
   * cross-site write surface (a web page could post to the local port and
   * rewrite or delete memories), so the fence is explicit: the `Host` must be
   * a loopback authority — the memory routes only serve a page on this machine
   * — and a browser-supplied `Origin` must name that same authority.
   *
   * Two checks the DSH `/api` fence also performs are dead ends here rather
   * than omissions. `connection` is optional (see `HOST_SERVICES`): it is only
   * mounted by the Web profile, and a second `ctx.inject(['connection'], …)`
   * scope would re-run the whole `apply` body and register every route twice.
   * Cookie identity is unavailable for the same reason, so loopback
   * reachability carries the trust exactly as it does for any other
   * loopback-only local service.
   *
   * @param {import('node:http').IncomingMessage} req - the incoming request.
   * @param {any} webCtx - the context that injected `webServer`.
   * @returns {number | undefined} HTTP status to reject with, else undefined.
   */
  function requestRejection(req, webCtx) {
    const authority = requestAuthority(req, webCtx)
    if (authority === undefined || !isLoopbackHostname(authority.hostname)) return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = req.headers.origin
    if (origin === undefined) return undefined
    try {
      return new URL(origin).host === authority.host ? undefined : 403
    } catch {
      return 403
    }
  }

  /**
   * HTTP status for a bridge failure code.
   *
   * A code that describes the *request* — a path the caller chose, a payload
   * the bridge refused — is a client error and must not come back as `200`,
   * which reads as success to anything inspecting the status line. Codes that
   * describe the server (a crashed child, an unexpected bug) keep the old
   * status: the body already carries `ok: false`.
   */
  const CLIENT_ERROR_STATUS = {
    NO_PROJECT: 400,
    validation: 400,
    bad_request: 400,
    not_found: 404,
  }

  /**
   * Answer one JSON route.
   * @param {any} webCtx - the context that injected `webServer`.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @param {Function} handler - async (body, url) → JSON value.
   */
  function jsonRoute(webCtx, req, res, handler) {
    const trace = (message) => {
      try {
        logger.warn(`[dsh-memory] ${req.method} ${req.url}: ${message}`)
      } catch {
        /* logging must never break a route */
      }
    }
    let rejection
    try {
      rejection = requestRejection(req, webCtx)
    } catch (error) {
      trace(`trust check threw: ${error?.message ?? error}`)
      rejection = 403
    }
    trace(`rejection=${String(rejection)}`)
    if (rejection) {
      // Drain the body first: answering before the request is consumed leaves
      // some clients with a truncated (non-JSON) response.
      req.resume()
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '未授权的请求' } }))
      return
    }
    const chunks = []
    let bytes = 0
    let aborted = false
    req.on('error', (error) => trace(`request error: ${error?.message ?? error}`))
    req.on('data', (chunk) => {
      if (aborted) return
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'TOO_LARGE', message: '请求体过大' } }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      let body = {}
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } }))
          return
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      Promise.resolve()
        .then(() => handler(body, url))
        .then((value) => {
          if (res.headersSent) return
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, result: value }))
        })
        .catch((error) => {
          const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
          const status = CLIENT_ERROR_STATUS[code] ?? 200
          logger.warn(`[dsh-memory] route failed (${code}): ${error?.message ?? error}`)
          if (res.headersSent) {
            res.end()
            return
          }
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              ok: false,
              error: { code, message: error?.message ?? String(error) },
            }),
          )
        })
    })
  }

  /**
   * Resolve the project id a route should act on.
   * @param {any} body - parsed request body.
   * @returns {Promise<string | undefined>} project id.
   */
  async function routeProject(body) {
    if (body?.project_id) return String(body.project_id)
    const cwd = resolveCwd(body?.cwd)
    return projectFor(cwd)
  }

  ctx.inject(['webServer'], (webCtx) => {
    /**
     * Register one exact route.
     * @param {string} path - route path.
     * @param {Function} handler - async (body, url) → JSON value.
     */
    const route = (path, handler) => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler: (req, res) => jsonRoute(webCtx, req, res, handler) }),
        `dsh-memory.route(${path})`,
      )
    }

    route('/dsh-memory/status', async (body) => {
      const projectId = await routeProject(body)
      const status = await call('status', { project_id: projectId, cwd: body?.cwd })
      return status
    })

    route('/dsh-memory/settings', async (body) => {
      if (body?.length !== undefined || body?.mode !== undefined) {
        await call('settings.set', { length: body.length, mode: body.mode })
      }
      if (body?.profile !== undefined) {
        await call('profile.write', { content: body.profile })
      }
      const settings = await call('settings.get', {})
      const profile = await call('profile.read', {})
      return { settings, profile }
    })

    route('/dsh-memory/profile', async (body) => {
      if (typeof body?.content === 'string') {
        return await call('profile.write', { content: body.content })
      }
      return await call('profile.read', {})
    })

    route('/dsh-memory/digest', async (body) => {
      switch (body?.action) {
        case 'generate': {
          const record = await generateDigest({
            cwd: body?.cwd,
            signal: undefined,
            reason: 'manual',
            length: body?.length,
          })
          const view = await call('digest.view', {})
          return { ...view, generated: record?.digest ?? null }
        }
        case 'delete':
          return await call('digest.delete', { digest_id: body?.digest_id })
        case 'history':
          return await call('digest.history', {})
        default:
          return await call('digest.view', {})
      }
    })

    route('/dsh-memory/memories', async (body) => {
      const projectId = await routeProject(body)
      const action = body?.action ?? 'list'
      if (action === 'update') {
        return await call('memory.update', { memory_id: body.memory_id, patch: body.patch ?? {} })
      }
      if (action === 'forget') {
        return await call('memory.forget', { memory_id: body.memory_id, reason: body.reason })
      }
      if (action === 'restore') {
        return await call('memory.restore', { memory_id: body.memory_id })
      }
      if (action === 'get') {
        return await call('memory.get', { memory_id: body.memory_id })
      }
      return await call('memory.list', {
        project_id: body?.all_projects ? undefined : projectId,
        all_projects: body?.all_projects === true,
        query: body?.query,
        state: body?.state,
        event_type: body?.event_type,
        limit: Math.min(Math.max(Number(body?.limit) || 20, 1), 200),
        offset: Math.max(Number(body?.offset) || 0, 0),
        include_superseded: body?.include_superseded === true,
      })
    })

    route('/dsh-memory/backup', async (body) => {
      if (body?.action === 'restore') {
        return await call('backup.restore', {
          path: body.path,
          markdown: body.markdown,
          project_id: await routeProject(body),
          dry_run: body.dry_run === true,
          restore_profile: body.restore_profile !== false,
        })
      }
      const exported = await call('backup.export', {
        project_id: body?.all_projects ? undefined : await routeProject(body),
        all_projects: body?.all_projects !== false,
        include_digests: body?.include_digests !== false,
        include_profile: body?.include_profile !== false,
        max_episodes: Math.min(Math.max(Number(body?.max_episodes) || 2000, 1), 20000),
        markdown: true,
      })
      // A backup too large for one bridge response arrives as a file path
      // instead of inline markdown: the pipe frame cannot carry it, and an
      // oversized envelope is replaced by an error wholesale. Read the file
      // here — an HTTP response has no such cap — so the browser still gets
      // the whole document, and the copy on disk stays as a real backup.
      const markdown =
        typeof exported?.markdown === 'string'
          ? exported.markdown
          : exported?.path
            ? await readFile(String(exported.path), 'utf8')
            : ''
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      return {
        filename: `dsh-memory-${stamp}.md`,
        markdown,
        chars: markdown.length,
        lines: markdown.split('\n').length,
        counts: exported?.counts ?? null,
        path: exported?.path ?? null,
      }
    })

    route('/dsh-memory/health', async () => {
      const started = Date.now()
      try {
        const status = await call('status', {})
        return {
          ok: true,
          latencyMs: Date.now() - started,
          home: status?.home,
          project: status?.project_id,
          settings: status?.settings,
          memories: status?.memories,
          probe: status?.probe,
        }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: error?.message ?? String(error),
          code: error?.code ?? 'INTERNAL',
        }
      }
    })
  })
}

/**
 * What stands in for the anchor body.
 *
 * The bridge answers `''` when there is neither a digest nor a profile, which
 * is the normal state of a fresh install; the old single placeholder then
 * announced a missing digest even when the section above it showed the live
 * profile, so the two contradicted each other.
 */
const ANCHOR_NOTHING_YET = '（还没有全局摘要，也没有用户画像；记忆库仍可正常读写。）'
const ANCHOR_NO_SUMMARY = '（尚未生成全局摘要；可用 `memory_digest_generate` 生成。）'

/**
 * The anchor block.
 *
 * `{{memory_anchor}}` is the Python-rendered count line (digest size and age,
 * profile size), and `{{recent_work}}` this project's newest work lines — or
 * nothing, when the project has no memories yet.
 *
 * What a tool's own definition already says stays out of here: this block is
 * resident in every request and the full tool schemas ride along with it, so
 * repeating names and parameters would only cost tokens and drift. What it
 * carries is what no single tool description can hold — the order the tools
 * are meant to be used in, and the edge each one has.
 */
const ANCHOR_HEADER = [
  '## 记忆',
  '跨会话持久记忆：全机共享一个库，按工作目录推导项目。工具定义见工具列表，这里只写工具定义装不下的使用顺序与边界。',
  '',
  '{{memory_anchor}}',
  '',
  '{{recent_work}}',
  '',
  '**收尾时写**：库不会自动抄录对话，**只有调用 `memory_add` 才会写入**（另有会话结束时的一次补漏）。任务收尾或提交前，把值得留下的经验、决策与理由、踩过的坑、操作规则写成一条，`summary` 一句话说清关键实体与结论（含文件、命令、项目名）——一句话，太长会挤占这里的篇幅；不存闲聊、代码里能直接读到的、一次性中间步骤，用户偏好照记原话。偏好与教训**不进摘要、也不进画像**，只能靠 `memory_add` + 检索留住。',
  '',
  '**回答前读**：用户提到"之前说过""上次""我们的约定"时，先用 `memory_recall`（按相关度）再回答，不要凭印象编造；换了说法的关键词用 `memory_search` 补，`state` 可查 dormant / archived，召回默认只给 active。摘要与 `DSH_MEMORY.md` 只记工程动作，经验、决策、偏好、坑只在检索里。用户画像只能读，由用户自己在设置页维护。`memory_forget` 是软删除：做完告知用户"已归档、可恢复"，别说成彻底删除。',
].join('\n')

/** Resolved configuration defaults, exposed for the plugin's own smoke test. */
export const DEFAULTS = Object.freeze({ ...DEFAULTS_INNER })

/**
 * The skill index block: what this project already knows how to do.
 * `{{skill_index}}` is replaced with the Python-rendered Level-1 lines.
 */
const SKILL_INDEX_HEADER = [
  '## 技能（本项目的程序性记忆）',
  '下面是本项目已保存的可用技能，一行一个，只有触发条件与作用，不含步骤：',
  '',
  '{{skill_index}}',
  '',
  '执行某个技能前先 `skill_get` 读完整步骤；正文细节不要凭索引里的摘要臆测。',
].join('\n')

/**
 * Shown when the project has no skills yet.
 *
 * The "check for a duplicate first" half moved here from the authoring rule:
 * the host already publishes its own skill catalog ("do not infer until
 * loaded"), and this line is what the model reads next, so it must not invite
 * creating one — it must point at the same dedupe step as the rule below.
 */
const SKILL_INDEX_EMPTY =
  '（本项目还没有技能。确有验证过的做法要存时，先 `skill_list` 查重，再 `skill_create`；只探索过的做法先不存。）'

/**
 * When saving a procedure is allowed.
 *
 * This is the whole anti-noise policy: the cost of a bad skill is not disk, it
 * is the model reading and trusting a wrong procedure next time, so the bar is
 * "tested and reusable", not "plausible".
 */
const SKILL_AUTHORING_RULE = [
  '**技能写入职责**：技能是程序性记忆——可以重复执行的做法。工具不会自动提取它，**只有你调用 `skill_create` 才会保存**。',
  '同时满足下面全部条件才值得存：',
  '- 这次任务中，这套步骤**真的被执行过并验证成功**（不是设想、不是只读过代码）；',
  '- 同类任务**大概率会再来**，步骤基本可复用；',
  '- 步骤里有**具体动作与顺序**（改了哪个模块、跑了什么命令、按什么顺序验证），不是“仔细阅读代码”这类空话；',
  '- `skill_list` 里**没有同类技能**——有就复用或改写那个，不要新建。',
  '不要存的：一次性任务、临时调试步骤、能从代码或文档直接读到的内容、用户偏好（那属于 `memory_add`）、还没确认有效的做法。',
].join('\n')

/** Said after the session already saved one skill. */
const SKILL_AUTHORING_PACED = [
  '**技能写入职责**：本会话已经创建或尝试过 {{count}} 个技能。除非用户明确要求，**不要再新建**；',
  '确有需要时，先 `skill_list` 确认没有同类技能，并优先考虑把可复用的部分补进已有技能。',
].join('\n')

/**
 * How many project skills the prompt asks the model to aim for.
 *
 * Deliberately far below what the store accepts: `l4.max_active_per_project`
 * (200 by default) is the enforced ceiling and rejects with `capacity`, while
 * this is guidance about attention. The text below must not present it as a
 * hard limit, or the model reports a cap that nothing enforces.
 */
const SKILL_AUTHORING_CAP = [
  '项目技能建议控制在 {{cap}} 个左右；接近这个数量时优先合并或退役旧技能，不要为了腾位置乱建。',
  '这个数字是建议值；真正的硬性上限由记忆库配置决定，超过时会直接拒绝写入。',
  '技能存在本项目里，不写入记忆库：它们不会出现在 `memory_search` / `memory_recall` / 摘要里，要查看技能用 `skill_list`。',
].join('\n')
