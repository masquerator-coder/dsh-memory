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
]

/** Prompt section order: after the built-in tool docs, before the persona. */
const ANCHOR_ORDER = 9500

/** How long an anchor stays usable before it is refreshed. */
const ANCHOR_REFRESH_MS = 15_000

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
    if (type === 'turn/start') {
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
   * The body of one digest run, without the in-flight bookkeeping.
   * @param {object} options - generation options.
   * @returns {Promise<any>} `{ digest }` as committed.
   */
  async function runDigest({ cwd, projectId, signal, reason, length }) {
    const plan = await call('digest.plan', { cwd, project_id: projectId, length }, signal)
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
    return committed
  }

  // ── tools ─────────────────────────────────────────────────────────────

  for (const definition of buildTools({ call, projectFor, generateDigest })) {
    // The heartbeat only needs to know that the model *made* a recording
    // attempt, so wrapping here keeps `tools.js` a pure schema+execute module.
    // A duplicate rejected by the memory store still counts: the model did its
    // part, and re-reminding it about the same insight is noise.
    const registered =
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
    ctx.effect(() => ctx.tools.register(registered), `dsh-memory.tool(${registered.name})`)
  }

  // ── system prompt anchor ──────────────────────────────────────────────

  if (config.systemPromptAnchor) {
    /**
     * Anchor text per working directory, refreshed off the assembly path.
     *
     * Prompt assembly is synchronous, so the anchor cannot await the bridge.
     * A provider kicks off a refresh and returns the last known text; the
     * first assembly of a directory therefore omits the block and the next one
     * includes it. That is a deliberate trade: a stale-by-seconds count line
     * beats a prompt that blocks on a child process.
     *
     * The cache is keyed by working directory, because concurrent sessions in
     * different projects assemble in the same window; one shared slot let a
     * second project render the first project's memory counts.
     */
    const anchorCaches = new Map()

    /** @param {string} cwd - session working directory, '' when unknown. */
    function anchorSlot(cwd) {
      const key = cwd || ''
      let slot = anchorCaches.get(key)
      if (!slot) {
        slot = { at: 0, text: '', pending: false }
        anchorCaches.set(key, slot)
      }
      return slot
    }

    /**
     * Start a refresh when the cached anchor for this directory has aged.
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
        try {
          // The anchor is global: it advertises the one cross-project digest
          // and the user profile, not a per-project summary.
          const result = await call('digest.anchor', {
            include_summary: true,
            include_profile: true,
          })
          slot.text = typeof result?.text === 'string' ? result.text : ''
        } catch (error) {
          logger.warn(`[dsh-memory] anchor refresh failed: ${error?.message ?? error}`)
        } finally {
          slot.at = Date.now()
          slot.pending = false
        }
      })()
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
      return `\n\n**记忆提醒**：距上次调用 \`memory_add\` 已过 ${steps} 个回合。若这期间出现了值得长期保留的经验、决策或操作规则，现在就记下来；没有则忽略本条。`
    }

    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-memory:anchor',
          order: ANCHOR_ORDER,
          interpolate: false,
          text: (context) => {
            refreshAnchor(context)
            // Same assembly context the refresh just looked at.
            const session = context?.agent?.session
            const slot = anchorCaches.get(session?.header?.cwd ?? '')
            // The rules are unconditional: a project with an empty store still
            // needs to know that writing memory is its job. Only the anchor
            // body and the heartbeat vary.
            const body = slot?.text || '（还没有可用的记忆摘要。）'
            return `${ANCHOR_HEADER.replace('{{memory_anchor}}', body)}${heartbeatLine(session?.id)}`
          },
        }),
      'dsh-memory.anchor-section',
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
 * The anchor block: what the model sees instead of the digest itself.
 * `{{memory_anchor}}` is replaced with the Python-rendered pointer text.
 */
const ANCHOR_HEADER = [
  '## 记忆',
  '本会话连接了持久记忆库（memory_system）。下面是记忆锚点：只有规模与时间，不含正文。',
  '',
  '{{memory_anchor}}',
  '',
  '**写入职责**：记忆库不会自动收录对话，**只有你主动调用 `memory_add` 才会写入**。',
  '- 遇到**有价值的经验、决策、操作规则、用户明确偏好**时，主动用 `memory_add` 记下来，不要等用户要求。',
  '- 反例：闲聊、能从代码直接读到的事实、一次性且不会再用的中间步骤，都不要记。',
  '- 写一条好的记忆 = 一句话说清关键实体与结论，并选对 `event_type`（decision / preference / fix / fact / note）。',
  '',
  '使用方式：',
  '- `memory_digest_read` 读取全局摘要全文（所有项目已做过的工作），`memory_recall` 按问题检索事件与事实。',
  '- 想知道某个项目做过什么时，也可以查看该项目根目录下的 `DSH_MEMORY.md`。',
  '- 用户提到"之前说过""上次""我们的约定"时，先 `memory_recall` 再回答；不要凭印象编造记忆。',
  '- 需要了解用户偏好时调用 `memory_profile_read`；用户画像由用户本人维护。',
  '- 用户明确要求记住某件事时用 `memory_add`；要求忘掉时用 `memory_forget`。',
  '- 引用记忆时说明来源，并注意摘要的生成时间；过时内容以当前代码与用户的最新说法为准。',
].join('\n')

/** Resolved configuration defaults, exposed for the plugin's own smoke test. */
export const DEFAULTS = Object.freeze({ ...DEFAULTS_INNER })
