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

/** How long an anchor stays usable before it is refreshed. */
const ANCHOR_REFRESH_MS = 15_000

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

/** Default configuration; the row's YAML may override any field. */
const DEFAULTS_INNER = {
  pythonPath: '',
  memorySystemRoot: '',
  memoryHome: '',
  projectOverride: '',
  // Automatic digests are always on; the switch was removed from the UI.
  autoSummary: true,
  autoSummaryDelayMs: 15000,
  systemPromptAnchor: true,
  // Model steps between memory reminders; 0 disables the heartbeat. Off by
  // default: the reminder rides the system prompt, so each appearance is a
  // prefix-cache miss for every session in flight, and the session-end check
  // already covers what would otherwise be lost.
  heartbeatSteps: 0,
  // How often the host asks the Python side to run the due maintenance tasks
  // (decay, consolidation, communities, archive scan, promotions). The tasks
  // keep their own cadence; this only decides how often the question is asked,
  // and 0 turns the tick off.
  maintenanceIntervalMs: 600000,
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
const ZERO_IS_MEANINGFUL = new Set(['heartbeatSteps', 'maintenanceIntervalMs'])

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

/** Session id of the agent behind a tool context. */
function sessionIdOf(context) {
  return context?.agent?.session?.id
}

/**
 * Question id the model must use when asking the user whether a skill may be
 * written globally. The host records the answer itself, so the model cannot
 * assert consent on its own.
 */
export const SKILL_SCOPE_QUESTION_ID = 'dsh-memory:skill-scope'

/** Option id inside {@link SKILL_SCOPE_QUESTION_ID} that grants global scope. */
export const SKILL_SCOPE_GLOBAL_ID = 'global'

/**
 * How long one global-skill approval stays usable, in milliseconds.
 *
 * The approval is answered immediately before the write in practice; the TTL
 * only stops a stale grant from authorising an unrelated skill much later in a
 * long session.
 */
const SKILL_GRANT_TTL_MS = 10 * 60_000

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
 * Answer ids of one `ask_user_question` result, or null when the text is not
 * an answer batch.
 *
 * The tool returns `{"answers":[{"id":"...","selected":["..."],"custom"?:"..."}]}`.
 * `pending` payloads (timed-out asks) carry no `answers` array and must not
 * count as consent.
 * @param {string} text - the tool result text.
 * @returns {Array<{id: string, selected: string[], custom?: string}> | null}
 */
function parseAnswers(text) {
  const start = String(text ?? '').indexOf('{')
  const end = String(text ?? '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(String(text).slice(start, end + 1))
  } catch {
    return null
  }
  const answers = parsed?.answers
  if (!Array.isArray(answers)) return null
  return answers
    .filter((answer) => answer && typeof answer.id === 'string')
    .map((answer) => ({
      id: answer.id,
      selected: Array.isArray(answer.selected) ? answer.selected.map(String) : [],
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}),
    }))
}

/**
 * Whether one answer to {@link SKILL_SCOPE_QUESTION_ID} says "global".
 *
 * Both a selected option and a typed custom answer are honoured, and the match
 * is on the option id rather than on prose so a different locale or wording
 * cannot flip the meaning.
 * @param {{selected: string[], custom?: string}} answer - one answer.
 * @returns {boolean} true only for an explicit global choice.
 */
function answerSaysGlobal(answer) {
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  if (selected.some((value) => String(value).trim() === SKILL_SCOPE_GLOBAL_ID)) return true
  return String(answer?.custom ?? '').includes(SKILL_SCOPE_GLOBAL_ID)
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
      generateDigest({
        cwd: session?.header?.cwd,
        signal: undefined,
        reason: 'auto',
        sessionId: session?.id,
      }).catch((error) => {
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

  // ── background maintenance ────────────────────────────────────────────
  //
  // The Python side owns the cadence: `maintenance.run` executes only what is
  // due, so a tick that lands early costs one bridge round trip. Without any
  // caller the `state` column never moves and the list keeps calling decayed
  // entries "active" while recall (which computes retention live) cannot
  // return them.

  if (config.maintenanceIntervalMs > 0) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    let stopped = false

    /** Ask for one maintenance pass, then schedule the next. */
    const tick = async () => {
      if (stopped) return
      try {
        const result = await call('maintenance.run', {})
        const ran = (result?.reports ?? []).filter((report) => report?.ran)
        if (ran.length > 0) {
          logger.info(`[dsh-memory] maintenance ran: ${ran.map((report) => report.name).join(', ')}`)
        }
      } catch (error) {
        // Maintenance is housekeeping: a failed pass warns and waits for the
        // next tick instead of retrying in a tight loop or failing a turn.
        logger.warn(`[dsh-memory] maintenance pass failed: ${error?.message ?? error}`)
      } finally {
        if (!stopped) {
          timer = setTimeout(tick, config.maintenanceIntervalMs)
          if (typeof timer.unref === 'function') timer.unref()
        }
      }
    }

    timer = setTimeout(tick, config.maintenanceIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => {
      stopped = true
      clearTimeout(timer)
    }, 'dsh-memory.maintenance-tick')
  }

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

  /**
   * Sessions in which the user has just approved one global skill write.
   *
   * A global skill is visible to every project on the machine, so the grant
   * must not come from the model: the old design let the model pass a boolean
   * asserting its own permission, which only asked it to be honest. The host now
   * reads the answer out of the session's own `tool/result` event and signs the
   * bridge call with `host_approved`, and the grant covers exactly one write
   * before it is spent — the next global write asks again.
   *
   * @type {Map<string, {at: number, skill: string | null}>}
   */
  const skillScopeGrants = new Map()

  /**
   * Record the user's answer to a skill-scope question, if this result is one.
   *
   * Only a real `ask_user_question` result counts. A `pending` payload (the
   * ask timed out) and an errored call carry no answers, so they grant
   * nothing: silence is not consent.
   * @param {string} sessionId - the session the result belongs to.
   * @param {any} event - the `tool/result` session event.
   */
  function noteSkillScopeAnswer(sessionId, event) {
    if (!sessionId) return
    const data = event?.data
    // An errored or aborted ask never expressed a choice.
    if (!data || data.error !== undefined) return
    const message = data.message
    if (!message || message.isError === true) return
    const answers = parseAnswers(messageText(message))
    if (!answers) return
    const answer = answers.find((item) => item.id === SKILL_SCOPE_QUESTION_ID)
    if (!answer) return
    if (answerSaysGlobal(answer)) {
      skillScopeGrants.set(sessionId, { at: Date.now(), skill: null })
    } else {
      // An explicit "project only" answer also clears a stale grant.
      skillScopeGrants.delete(sessionId)
    }
  }

  /**
   * Spend this session's global-skill grant, if one is live.
   *
   * A grant is single-use and short-lived: it must have been given inside this
   * session and be the most recent answer, so an approval from an hour ago
   * cannot silently authorise a second, unrelated skill.
   * @param {string} sessionId - the session attempting a global write.
   * @returns {boolean} true when the write may proceed.
   */
  function takeSkillScopeGrant(sessionId) {
    if (!sessionId) return false
    const grant = skillScopeGrants.get(sessionId)
    if (!grant) return false
    if (Date.now() - grant.at > SKILL_GRANT_TTL_MS) {
      skillScopeGrants.delete(sessionId)
      return false
    }
    skillScopeGrants.delete(sessionId)
    return true
  }

  /**
   * The last session id this process saw.
   *
   * Host-side model calls (digest generation, the session-end review) happen
   * outside any session, and some providers route per session: the
   * `opencode-go` relay rejects a request without `x-opencode-session` with a
   * 400. `llm.stream` takes a `sessionId` for exactly that reason, so every
   * host-side call carries the one this process observed last.
   */
  let lastSessionId

  /** @param {string | undefined} sessionId - a session this process observed. */
  function noteSession(sessionId) {
    if (typeof sessionId === 'string' && sessionId) lastSessionId = sessionId
  }

  /**
   * The session id a host-side model call should borrow.
   *
   * The last observed session wins; the live session list is only the fallback
   * for a process that has not seen an event yet. It is a provider routing
   * hint, never a claim about which session the work belongs to.
   * @returns {string | undefined} a session id, if this process knows one.
   */
  function hostSessionId() {
    if (lastSessionId) return lastSessionId
    try {
      const sessions = ctx.get?.('sessions')?.list?.() ?? []
      for (const session of sessions) {
        if (typeof session?.id === 'string' && session.id) return session.id
      }
    } catch {
      // An unreadable session list is the same as none: the call is still worth
      // attempting, and the provider's own error says what was missing.
    }
    return undefined
  }

  ctx.on('session/event', (session, event) => {
    noteSession(session?.id)
    const type = event?.type
    if (type === 'step/start') {
      // One step is one model call. Counting `turn/start` instead made a
      // single long turn — thirty tool calls, no `memory_add` — look like one
      // step, so the reminder stayed silent exactly when it was needed.
      bumpStep(session?.id)
      return
    }
    if (type === 'tool/result') noteSkillScopeAnswer(session?.id, event)
    if (type !== 'turn/end') return
    if (config.autoSummary) scheduleAutoSummary(session)
  })

  ctx.effect(() => () => stepsSinceWrite.clear(), 'dsh-memory.heartbeat-state')
  ctx.effect(() => () => skillScopeGrants.clear(), 'dsh-memory.skill-scope-state')

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
      session?.id,
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
    noteSession(session?.id)
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
   * The working directory a host-side request should act on.
   *
   * `lastCwd` is rewritten by every prompt assembly (`rememberCwd`), so it names
   * the session the user is actually typing in. The session list is only a
   * cold-start fallback: its entries carry `createdAt` and no activity stamp, so
   * ranking by the absent `updatedAt` compared `NaN` and kept whatever order
   * the list happened to be in — which is how the settings page could resolve
   * another project's working directory.
   * @returns {string | undefined} a working directory, if any.
   */
  function liveCwd() {
    if (lastCwd.value) return lastCwd.value
    const sessions = ctx.get?.('sessions')
    const list = sessions?.list?.() ?? []
    /** @param {any} session - one session record. @returns {number} creation time. */
    const stamp = (session) => {
      const raw = session?.header?.createdAt ?? session?.createdAt ?? 0
      const value = typeof raw === 'number' ? raw : Date.parse(String(raw))
      return Number.isFinite(value) ? value : 0
    }
    for (const session of [...list].sort((a, b) => stamp(b) - stamp(a))) {
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd) {
        rememberCwd(cwd)
        return cwd
      }
    }
    return undefined
  }

  /**
   * Resolve the working directory a host-side request should act on: the one
   * the caller named, else the last assembled session's.
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

  /**
   * Set by the anchor section: re-read the cached anchor immediately.
   *
   * A no-op when the anchor section is disabled. Digest generation and profile
   * writes call it so the next prompt assembly sees the new state instead of
   * waiting out `ANCHOR_REFRESH_MS` on a stale cache.
   */
  let refreshAnchorNow = async () => {}

  ctx.on('agent/request', async (payload, next) => {
    // `next()` is the only thing that drives the request; if it throws, the
    // error must reach the host unchanged, so there is nothing to clean up
    // here beyond recording a route we did observe.
    const request = await next()
    if (request?.provider && request?.model) lastRoute = { provider: request.provider, model: request.model }
    return request
  })

  /**
   * The model route a host-side call should use right now.
   *
   * A route observed on a session wins: this process already proved it works,
   * and the digest should be written by the model that wrote the work it
   * summarizes. A fresh process has no such route until its first message is
   * sent — which is exactly when the settings page can be opened and its
   * 「生成」 button pressed — so fall back to the deployment's default model,
   * the same selection a new agent would be created with. Read lazily, so a
   * selection saved from the model picker is honored without a restart.
   * @returns {{ provider: string, model: string } | undefined} a resolvable route.
   */
  function hostRoute() {
    if (lastRoute) return lastRoute
    let selection
    try {
      selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    } catch {
      // A default model that cannot be read is the same as none: the caller
      // reports "no model available" instead of failing the whole digest run.
      return undefined
    }
    const provider = selection?.provider
    const model = selection?.model
    if (typeof provider !== 'string' || !provider) return undefined
    if (typeof model !== 'string' || !model) return undefined
    return { provider, model }
  }

  /**
   * Read all streamed text from a model call.
   * @param {any} llm - the llm service.
   * @param {{ provider: string, model: string }} route - model route.
   * @param {Array<{ role: string, content: string }>} turns - conversation.
   * @param {AbortSignal | undefined} signal - cancellation.
   * @param {string | undefined} sessionId - session to borrow for provider routing.
   * @returns {Promise<string>} the concatenated assistant text.
   */
  async function collectText(llm, route, turns, signal, sessionId) {
    const messages = turns.map((turn, index) => ({
      id: `dsh-memory-${index}`,
      role: turn.role,
      content: [{ type: 'text', text: turn.content }],
      source: turn.role === 'assistant' ? { kind: 'model', ...route } : { kind: 'user' },
    }))
    let text = ''
    let failure
    // `sessionId` is not bookkeeping: providers that route per conversation
    // (the opencode-go relay, for one) reject a request without their session
    // header with a 400, which is exactly how every digest run used to fail.
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      ...(sessionId ? { sessionId } : {}),
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
   * @param {string} [options.sessionId] - session the run belongs to, when known.
   * @returns {Promise<any>} `{ digest }` as committed.
   */
  async function generateDigest({ cwd, signal, reason = 'manual', length, sessionId } = {}) {
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
    const task = runDigest({ cwd, projectId, signal, reason, length, sessionId })
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
  async function runDigest({ cwd, projectId, signal, reason, length, sessionId }) {
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
    // Session route first, deployment default model second: see `hostRoute`.
    const route = hostRoute()
    // A host-side call belongs to no session, but several providers route on
    // one; borrow the newest session this process knows (see `hostSessionId`).
    const ownerSession = sessionId ?? hostSessionId()
    let text = ''
    let error
    let generator = 'host-llm'
    if (!llm) {
      error = 'llm 服务不可用，无法调用模型生成摘要'
      generator = 'unavailable'
    } else if (!route) {
      error = '无法确定要调用的模型：本进程还没有会话使用过模型，也没有可用的默认模型'
      generator = 'unavailable'
    } else if (plan.has_materials === false) {
      // Empty memory is a real state, not a failure: record the honest note.
      text = `## 暂无工作记录\n还没有可作为摘要的工作记录（${new Date().toISOString().slice(0, 10)}）。`
      generator = 'host-llm'
    } else {
      try {
        text = await collectText(
          llm,
          route,
          [
            { role: 'system', content: plan.system },
            { role: 'user', content: plan.user },
          ],
          signal,
          ownerSession,
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
    // The anchor caches the count line for `ANCHOR_REFRESH_MS`. Re-read it now:
    // the whole point of generating a digest is that the next prompt shows it,
    // and waiting out the cache made the settings page look like it did nothing.
    await refreshAnchorNow()
    return committed
  }

  // ── tools ─────────────────────────────────────────────────────────────

  for (const definition of buildTools({
    call,
    projectFor,
    generateDigest,
    // The global-skill gate lives here, not in `tools.js`: only the host sees
    // the session's `tool/result` events, and only the host can tell a real
    // user answer from a boolean the model filled in itself.
    takeSkillScopeGrant,
    skillScopeQuestionId: SKILL_SCOPE_QUESTION_ID,
    skillScopeGlobalId: SKILL_SCOPE_GLOBAL_ID,
  })) {
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
    ctx.effect(() => ctx.tools.register(wrapped), `dsh-memory.tool(${wrapped.name})`)
  }

  // ── system prompt anchor ──────────────────────────────────────────────

  if (config.systemPromptAnchor) {
    /**
     * One slot for the global part, one slot per working directory for the
     * project part.
     *
     * The `@@dsh-memory` count line and the profile are global — `digest.anchor`
     * ignores the caller's directory — so keying that part by directory only
     * made N projects each age out and each pay for an identical round trip.
     * `recent` is per project, so it is keyed by cwd: a shared slot let a
     * refresh stamped for one directory install its lines under every other
     * session, which is how another project's work reached the block.
     */
    const anchorSlotShared = {
      at: 0,
      text: '',
      summary: null,
      profile: null,
      pending: false,
      failed: false,
    }

    /** @type {Map<string, {recent: {lines: string[], truncated: boolean, ok: boolean} | null, at: number}>} */
    const recentSlots = new Map()

    /** @param {string} cwd - session working directory; the global part is shared. */
    function anchorSlot(_cwd) {
      return anchorSlotShared
    }

    /**
     * The recent-work entry for one directory.
     * @param {string} cwd - session working directory, '' when unknown.
     * @returns {{recent: {lines: string[], truncated: boolean, ok: boolean} | null, at: number}} the entry.
     */
    function recentSlot(cwd) {
      const key = cwd || ''
      let slot = recentSlots.get(key)
      if (!slot) {
        slot = { recent: null, at: 0 }
        recentSlots.set(key, slot)
      }
      return slot
    }

    /**
     * Read the global part of the anchor — the digest count line and the
     * profile size — into the shared slot.
     *
     * A failed read leaves `summary` unknown rather than claiming there is no
     * digest: the error says nothing about what the store holds.
     */
    async function readAnchorLine() {
      const slot = anchorSlotShared
      try {
        const result = await call('digest.anchor', {
          include_summary: true,
          include_profile: true,
        })
        slot.text = typeof result?.text === 'string' ? result.text : ''
        slot.summary = Boolean(result?.summary)
        slot.profile = Boolean(result?.profile)
        slot.failed = false
      } catch (error) {
        slot.failed = true
        logger.warn(`[dsh-memory] anchor refresh failed: ${error?.message ?? error}`)
      }
    }

    /**
     * Read the count line, the profile and the project's recent work.
     *
     * The count line and the profile are global — one cross-project digest, for
     * every session, stamped by the shared slot's `at`. The per-project lines
     * are read into that directory's own slot, and a failure there must not
     * lose the global part.
     *
     * A recent-work read that did not happen (`ok: false`) is not stored: the
     * directory keeps whatever it had and its slot stays unstamped, so the next
     * assembly retries instead of serving a wrong or empty block for a whole
     * refresh window.
     * @param {string} cwd - session working directory, '' when unknown.
     */
    async function loadAnchor(cwd) {
      const slot = anchorSlotShared
      const recent = recentSlot(cwd)
      try {
        await readAnchorLine()
        try {
          const result = await refreshRecent(cwd)
          if (result.ok) {
            recent.recent = result
            recent.at = Date.now()
          }
        } catch (error) {
          logger.warn(`[dsh-memory] recent-work refresh failed: ${error?.message ?? error}`)
          recent.recent = { lines: [], truncated: false, ok: true }
          recent.at = Date.now()
        }
      } finally {
        slot.at = Date.now()
        slot.pending = false
      }
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
      void loadAnchor(cwd)
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
     * `ok: false` means the project could not be resolved, which is not the
     * same as an empty project: the read never happened. The caller must not
     * cache that state, and must not fall back to an unfiltered query — an
     * empty project id makes `memory.list` list every project's memories, so a
     * session whose cwd is not known yet would carry another project's work in
     * its recent-work block for a full refresh window.
     *
     * @param {string} cwd - the session's working directory.
     * @returns {Promise<{lines: string[], truncated: boolean, ok: boolean}>} the lines.
     */
    async function refreshRecent(cwd) {
      const projectId = await projectFor(cwd)
      if (!projectId) {
        logger.warn(`[dsh-memory] recent-work skipped: no project for cwd ${JSON.stringify(cwd)}`)
        return { lines: [], truncated: false, ok: false }
      }
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
      return { lines, truncated: items.length > lines.length, ok: true }
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
      // A failed read says nothing about the store: say so instead of claiming
      // there is no digest.
      if (slot?.failed) return ANCHOR_READ_FAILED
      if (slot?.summary === false) return ANCHOR_NO_SUMMARY
      // Still unknown: the first read has not landed yet. Announcing "no digest
      // yet" here was wrong whenever a digest existed but the process had just
      // started (or the plugin had just reloaded).
      return ANCHOR_LOADING
    }

    /**
     * The per-project work lines, or '' when this project has no memories yet.
     *
     * Absent is not the same as empty here: a fresh project would otherwise
     * spend resident tokens announcing that it has nothing.
     *
     * @param {{recent?: {lines?: string[], truncated?: boolean} | null} | null} entry -
     *   this directory's recent-work slot; null when it was never read.
     * @returns {string} the section, or ''.
     */
    function recentSection(entry) {
      const recent = entry?.recent
      const lines = recent?.lines ?? []
      if (lines.length === 0) return ''
      const tail = recent.truncated
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
      const key = sessionId ?? ''
      const steps = stepsSinceWrite.get(key) ?? 0
      if (steps < threshold) return ''
      // Fire once per window, then restart the count. Returning the reminder on
      // every step past the threshold rewrote the system prompt on every model
      // call — the step count in the text changed each time — which invalidated
      // the provider's prefix cache on every request. The reminder text now
      // carries the threshold, a constant, and the counter restarts here.
      stepsSinceWrite.set(key, 0)
      return `\n\n**记忆提醒**：距上次调用 \`memory_add\` 已过 ${threshold} 个模型步。若这期间出现了值得长期保留的经验、决策或操作规则，现在就记下来；没有则忽略本条。`
    }

    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-memory:anchor',
          order: ANCHOR_ORDER,
          interpolate: false,
          text: (context) => {
            refreshAnchor(context)
            // Same assembly context the refresh just looked at. The count line
            // is global, so every session reads the shared slot; the
            // recent-work section comes from this directory's own slot.
            const session = context?.agent?.session
            const cwd = session?.header?.cwd ?? ''
            const slot = anchorSlot(cwd)
            // The rules are unconditional: a project with an empty store still
            // needs to know that writing memory is its job. Only the anchor
            // body, the recent-work section and the heartbeat vary.
            return `${ANCHOR_HEADER.replace('{{memory_anchor}}', anchorBody(slot)).replace(
              '{{recent_work}}',
              recentSection(recentSlot(cwd)),
            )}${heartbeatLine(session?.id)}`
          },
        }),
      'dsh-memory.anchor-section',
    )

    /**
     * Re-read the anchor now, for callers that just changed its inputs.
     *
     * Digest generation and profile writes use this so the next prompt
     * assembly sees the new state; the 15s TTL stays for ordinary sessions.
     *
     * Those callers only change the global part. The project's recent work is
     * re-read when a session cwd is known (a memory write may have changed it);
     * with no cwd there is nothing project-specific to refresh, so the global
     * read alone runs — calling the recent-work read with an empty path is how
     * a block for the wrong project (or for every project) could be installed.
     */
    refreshAnchorNow = async () => {
      anchorSlotShared.pending = true
      const cwd = lastCwd.value || ''
      if (!cwd) {
        anchorSlotShared.pending = false
        await readAnchorLine()
        return
      }
      await loadAnchor(cwd)
    }

    // Warm the global part at load. Assembly is synchronous, so without this
    // the very first prompt after a host start or a plugin reload carries the
    // "not read yet" body even though the digest is already on disk. The
    // per-project lines are not read here: there is no session cwd yet, and
    // stamping the slot with an empty one would hide them for a full TTL.
    void readAnchorLine()
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
        // The anchor carries the profile size; re-read it so the next prompt
        // does not keep showing the old count until the cache ages out.
        await refreshAnchorNow()
      }
      const settings = await call('settings.get', {})
      const profile = await call('profile.read', {})
      return { settings, profile }
    })

    route('/dsh-memory/profile', async (body) => {
      if (typeof body?.content === 'string') {
        const written = await call('profile.write', { content: body.content })
        await refreshAnchorNow()
        return written
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
        case 'delete': {
          // Not surfaced in the page, which offers no button for it: it exists
          // so an operator can drop a digest row (a failed attempt, say)
          // without opening the database.
          const deleted = await call('digest.delete', { digest_id: body?.digest_id })
          // Dropping the digest changes the anchor body; do not leave the old
          // count line resident until the TTL expires.
          await refreshAnchorNow()
          return deleted
        }
        default:
          // `digest.view` already returns the history alongside the content, so
          // there is no separate `history` action to keep in sync.
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
      const listing = await call('memory.list', {
        project_id: body?.all_projects ? undefined : projectId,
        all_projects: body?.all_projects === true,
        query: body?.query,
        state: body?.state,
        event_type: body?.event_type,
        limit: Math.min(Math.max(Number(body?.limit) || 20, 1), 200),
        offset: Math.max(Number(body?.offset) || 0, 0),
        include_superseded: body?.include_superseded === true,
      })
      // With "all projects" off, the listing is scoped to whatever project the
      // host resolved. When no live session names a working directory the
      // bridge falls back to the literal project `unknown`, which holds nothing —
      // and a page that then printed "2 entries" looked exactly like two
      // memories had replaced five from another project. Say so instead, so the
      // page can label the scope and offer the unscoped view.
      if (body?.all_projects !== true) {
        const named = body?.project_id || projectId
        return {
          ...listing,
          scoped_to_project: Boolean(named),
          ...(named ? {} : { scope_note: 'no-live-session' }),
        }
      }
      return { ...listing, scoped_to_project: false }
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
        // A failed digest run does not make the bridge unhealthy, and the page
        // never asks, so this route is the one place it surfaces. History is
        // read newest-first and keeps error rows — `status.digest` is only the
        // latest *successful* digest, which is exactly the wrong question here.
        let lastAttempt = null
        try {
          const history = await call('digest.history', { limit: 1 })
          lastAttempt = Array.isArray(history?.items) ? (history.items[0] ?? null) : null
        } catch {
          // Diagnostics only: a history read failure is not a health failure.
        }
        const problems = []
        if (lastAttempt?.status === 'error') {
          problems.push({
            kind: 'digest',
            message: lastAttempt.error || '摘要生成失败',
            digest_id: lastAttempt.digest_id,
            created_at: lastAttempt.created_at,
          })
        }
        const due = status?.stats?.maintenance?.due
        return {
          // Reachability plus "the last digest attempt did not fail". A caller
          // that only wants the former reads `latencyMs`/`home`.
          ok: problems.length === 0,
          latencyMs: Date.now() - started,
          home: status?.home,
          project: status?.project_id,
          settings: status?.settings,
          memories: status?.memories,
          probe: status?.probe,
          digest: {
            latest: status?.digest ?? null,
            last_attempt: lastAttempt
              ? {
                  digest_id: lastAttempt.digest_id,
                  status: lastAttempt.status,
                  reason: lastAttempt.reason,
                  created_at: lastAttempt.created_at,
                  error: lastAttempt.error ?? null,
                }
              : null,
          },
          maintenance: { due: Array.isArray(due) ? due : [] },
          problems,
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
 * `ANCHOR_LOADING` must not claim anything about the store: the slot is empty
 * on a cold process even when a digest exists, and the first assembly happens
 * before the asynchronous read returns. Saying "no digest yet" there made a
 * freshly started (or freshly reloaded) host look like an empty memory.
 * `ANCHOR_NO_SUMMARY` is only for a read that actually answered "no digest".
 */
const ANCHOR_LOADING = '（正在读取记忆摘要…）'
const ANCHOR_READ_FAILED = '（记忆摘要暂时读取失败；记忆库仍可正常读写。）'
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
 *
 * The skill line is the deliberate exception. With the skill rules living only
 * in the `skill_create` schema, projects went days with zero skills created:
 * the model was reminded every turn to write memories, never to固化 a verified
 * procedure. One unconditional line here is cheap next to that.
 */
const ANCHOR_HEADER = [
  '## 记忆',
  '跨会话持久记忆：全机共享一个库，按工作目录推导项目。工具定义见工具列表，这里只写工具定义装不下的使用顺序与边界。',
  '',
  '{{memory_anchor}}',
  '',
  '{{recent_work}}',
  '',
  '### 记忆的写入与召回',
  '',
  '**记忆写入**：',
  '',
  '- 记忆不会自动保存，**只有你主动调用 `memory_add` 才会写入**。会话结束时另有一次模型补漏，再多一层兜底；别把希望放在它上面。',
  '- 当你遇到有价值的经验、教训、决策与理由、操作规则、用户偏好等，总结成一句话，说清关键实体与结论（含文件、命令、项目名），调用 `memory_add` 存入记忆库。',
  '- 每条记忆尽量简洁、原子，复杂的事情拆成多条记忆。',
  '- 不存闲聊、代码里能直接读到的、一次性中间步骤，用户偏好照记原话。',
  '',
  '**记忆召回**：',
  '',
  '- 问题需要过往经验时，先用 `memory_recall`（按相关度）再回答，不要凭印象编造。',
  '- 换了说法的关键词用 `memory_search` 补，`state` 可查 dormant / archived，召回默认只给 active。',
  '- 摘要与 `DSH_MEMORY.md` 只记工程动作，经验、决策、偏好、教训只在检索里。',
  '- 用户画像只能读，由用户自己在设置页维护。',
  '- `memory_forget` 是软删除：做完告知用户"已归档、可恢复"。',
  '',
  '**技能固化**：',
  '',
  '- 完成可复用任务（同一套步骤后续还会复用）后，先用 `skill_list` 检查是否有同类技能；如无，再用 `skill_create` 保存。仅保存已跑通验证的，一次性任务不保存。',
  '- 选级别：只对这个项目成立的做法存**项目级**（默认，`scope="project"`）；跨项目通用的做法（如 Windows 沙箱踩坑、通用构建流程）才考虑**全局**（`scope="global"`）。全局技能对本机所有项目可见，必须先用 `ask_user_question` 征求用户同意——问题 id 用 `dsh-memory:skill-scope`、选项 id 用 `global`，宿主只认这次真实答复，没有它全局写入会被直接拒绝；用户不选全局就存成本项目技能，不要重复追问。',
].join('\n')

/** Resolved configuration defaults, exposed for the plugin's own smoke test. */
export const DEFAULTS = Object.freeze({ ...DEFAULTS_INNER })
