/**
 * Self-check for the two prompt-path behaviours that Python tests cannot see.
 *
 * Run with `node dsh-memory-plugin/selfcheck.js`. It drives the real `apply`
 * with stub host services and a stubbed bridge, so it asserts what the model
 * would actually receive rather than what a helper returns in isolation:
 *
 * 1. the heartbeat counts model steps (`step/start`), not user turns, and the
 *    reminder text says so;
 * 2. the recent-work section appears only for a project that has memories,
 *    stays inside its character budget, and disappears without one;
 * 3. digest generation reaches a model even when no session in this process has
 *    used one yet, via the deployment default model — and carries the session
 *    id, without which providers that route per conversation reject the call;
 * 4. a maintenance tick asks the Python side for the due background tasks.
 *
 * Exits non-zero on the first failed expectation.
 */

import { BridgeClient } from './bridge.js'
import { apply } from './index.js'

/**
 * The bridge must never start from a self-check.
 *
 * `assemble` stubs `BridgeClient.prototype.call`, but the plugin also starts
 * fire-and-forget reads (the anchor refresh) that can land after a
 * scenario's stub is restored. Those used to spawn the real Python child, and
 * any write path among them (a digest commit) lands in the user's real memory
 * database. Blocking the spawn for the whole process turns such a leak into a
 * visible failure instead of a silent write.
 */
BridgeClient.prototype.ensureChild = async () => {
  throw new Error('selfcheck: the memory bridge must stay stubbed')
}

const CWD = 'D:/selfcheck/project'
const RECENT_BUDGET = 400

let failures = 0

/**
 * @param {boolean} condition - what must hold.
 * @param {string} label - what was being checked.
 */
function check(condition, label) {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.error(`FAIL  ${label}`)
}

/**
 * Render the prompt sections for one scenario, and expose what `apply` mounted.
 * @param {{memories?: Array<{summary: string}>, events?: Array<{type: string, data?: any}>, llm?: any, defaultModel?: any, calls?: Array<{command: string, payload: any}>, config?: object, run?: (assembled: any) => Promise<void>}} scenario - inputs.
 * @returns {Promise<{anchor: string}>} rendered text per section.
 */
async function assemble(scenario) {
  const sections = new Map()
  const listeners = []
  const registered = []
  const services = {
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
    systemPrompt: {},
    agents: {},
  }
  // The host mounts both of these in every profile; a scenario that omits one
  // is checking what happens without it, exactly as `ctx.get` reports it.
  if (scenario.llm) services.llm = scenario.llm
  if (scenario.defaultModel) services.agentDefaultModel = scenario.defaultModel

  const tools = services.tools
  const stub = {
    get(name) {
      // Only the three services `apply` hard-requires; the rest are optional.
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    on(event, listener) {
      listeners.push({ event, listener })
    },
    systemPrompt: {
      section({ name, text }) {
        sections.set(name, text)
        return () => {}
      },
    },
    tools,
    inject() {},
    logger: { info() {}, warn() {}, error() {} },
  }

  const originalCall = BridgeClient.prototype.call
  // Every bridge answer this scenario needs comes from the stub below. The
  // spawn itself is blocked process-wide at the top of this file, so a read
  // that escapes this window fails instead of touching the real store.
  BridgeClient.prototype.call = async (command, payload = {}) => {
    scenario.calls?.push({ command, payload })
    if (command === 'projects') return { project_id: 'selfcheck-project' }
    if (command === 'digest.anchor') {
      return { text: '@@dsh-memory 1\n@@', summary: {}, profile: null }
    }
    if (command === 'digest.plan') {
      return {
        system: 'selfcheck system prompt',
        user: 'selfcheck user material',
        sources: [],
        target_chars: 500,
        material_chars: 100,
        prompt_version: 1,
        has_materials: scenario.hasMaterials !== false,
      }
    }
    if (command === 'digest.commit') {
      return {
        digest: {
          digest_id: 'selfcheck-digest',
          status: payload.error ? 'error' : 'ok',
          error: payload.error,
          text: payload.text,
          generator: payload.generator,
          actual_chars: (payload.text ?? '').length,
          estimated_tokens: 42,
        },
      }
    }
    if (command === 'memory.list') {
      return { items: payload.state === 'active' ? (scenario.memories ?? []) : [] }
    }
    return {}
  }

  try {
    // The shipped default is 0 (off); these checks exercise the feature, so
    // every scenario runs with a 20-step window.
    apply(stub, { heartbeatSteps: 20, ...(scenario.config ?? {}) })
    const emit = (event) => {
      for (const entry of listeners) {
        if (entry.event === 'session/event') entry.listener({ id: 's1', header: { cwd: CWD } }, event)
      }
    }
    // Forward `agent/request` as the loop does: the listener returns the route
    // a model call is about to use, which is the route the plugin remembers.
    const request = async (route) => {
      for (const entry of listeners) {
        if (entry.event === 'agent/request') await entry.listener({}, async () => route)
      }
    }
    for (const event of scenario.events ?? []) emit(event)

    // Assembly is synchronous and the bridge read resolves off to the side:
    // one pass starts it, the wait lets it land, the next pass renders it.
    const context = { agent: { session: { id: 's1', header: { cwd: CWD } } } }
    const render = () => sections.get('dsh-memory:anchor')(context)
    const anchorFirst = render()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const assembled = {
      anchorFirst,
      anchor: render(),
      render,
      emit,
      request,
      /** Execute one registered tool the way the loop would. */
      runTool(name, args = {}) {
        const definition = registered.find((entry) => entry.name === name)
        if (!definition) throw new Error(`tool "${name}" was not registered`)
        return definition.execute(args, context)
      },
    }
    // Tool runs must happen inside this `try`: the bridge stub is restored on
    // the way out, so a digest tool call after `assemble` returns would find no
    // stub at all.
    if (scenario.run) await scenario.run(assembled)
    return assembled
  } finally {
    BridgeClient.prototype.call = originalCall
  }
}

/**
 * A stub `llm` service that records the route of every stream it serves.
 * @param {Array<{provider: string, model: string, sessionId?: string}>} calls - route log to append to.
 * @returns {{stream: (request: any) => AsyncGenerator<any>}} the stub service.
 */
function recordingLlm(calls) {
  return {
    async *stream(request) {
      calls.push({ provider: request.provider, model: request.model, sessionId: request.sessionId })
      yield { type: 'text-delta', text: '## 示例摘要\n默认模型写出的摘要正文。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

console.log('heartbeat counts model steps')
{
  const { anchorFirst } = await assemble({
    events: [1, 2, 3, 4].map((turn) => ({ type: 'turn/start', data: { turn } })),
  })
  check(!anchorFirst.includes('记忆提醒'), 'four user turns alone do not trip a 20-step reminder')
}
{
  const events = []
  for (let turn = 1; turn <= 2; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } })
    for (let step = 1; step <= 12; step += 1) events.push({ type: 'step/start', data: { turn, step } })
  }
  const { anchorFirst, anchor, render, emit } = await assemble({ events })
  check(anchorFirst.includes('记忆提醒'), '24 model steps across two turns do trip the reminder')
  check(anchorFirst.includes('个模型步'), 'the reminder names model steps, not user turns')
  // One reminder per window: emitting it on every later step rewrote the whole
  // system prompt (and dropped the prefix cache) on every model call.
  check(!anchor.includes('记忆提醒'), 'the reminder fires once, not on every step past the threshold')
  for (let step = 1; step <= 20; step += 1) emit({ type: 'step/start', data: { turn: 3, step } })
  check(render().includes('记忆提醒'), 'another full window fires it again')
}

console.log('a cold anchor does not claim the store is empty')
{
  const { anchorFirst } = await assemble({})
  check(!anchorFirst.includes('还没有全局摘要'), 'an unread anchor does not report a missing digest')
}

console.log('recent work is bounded and conditional')
{
  const memories = Array.from({ length: 8 }, (_, i) => ({
    summary: `selfcheck 工作项 ${i} 一句话说明改了哪个模块并跑了什么命令，再补一句结果，让摘要长到需要截断`,
  }))
  const { anchor } = await assemble({ memories })
  check(anchor.includes('本项目最近的工作'), 'a project with memories shows them')
  const section = anchor.slice(
    anchor.indexOf('**本项目最近的工作**'),
    anchor.indexOf('**记忆写入**'),
  ).trim()
  check(section.length <= RECENT_BUDGET + 120, `the section stays near its budget (${section.length} chars)`)
  check(section.includes('更早的用'), 'a cut list points at memory_search instead of pretending to be complete')
}
{
  // Short summaries that all fit: the section must not claim there is more.
  const memories = Array.from({ length: 3 }, (_, i) => ({ summary: `短条目 ${i}` }))
  const { anchor } = await assemble({ memories })
  const section = anchor.slice(
    anchor.indexOf('**本项目最近的工作**'),
    anchor.indexOf('**记忆写入**'),
  )
  check(!section.includes('更早的用'), 'a complete list points at DSH_MEMORY.md only')
}
{
  const { anchor } = await assemble({ memories: [] })
  check(!anchor.includes('本项目最近的工作'), 'a project with no memories omits the section entirely')
}

console.log('digest generation finds a model without a session route')
{
  // A freshly started host: the settings page is open, no message has been
  // sent yet, so no session route exists. The digest must still be written.
  const calls = []
  let result
  await assemble({
    llm: recordingLlm(calls),
    defaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    async run({ runTool }) {
      result = await runTool('memory_digest_generate')
    },
  })
  check(calls.length === 1, 'a host with no session route still calls the model once')
  check(
    calls[0]?.provider === 'deepseek-official' && calls[0]?.model === 'deepseek-flash',
    'the fallback uses the deployment default model',
  )
  // The opencode-go relay answers 400 without x-opencode-session, which the
  // host derives from this option; leaving it out made every digest fail.
  check(calls[0]?.sessionId === 's1', 'the model call carries the session id')
  check(!String(result?.text ?? '').includes('失败'), 'the digest is committed instead of failing')
}
{
  // A session route is a route this process has proven works; it stays the
  // first choice even when a different default model is configured.
  const calls = []
  await assemble({
    llm: recordingLlm(calls),
    defaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    async run({ runTool, request }) {
      await request({ provider: 'deepseek-official', model: 'deepseek-pro' })
      await runTool('memory_digest_generate')
    },
  })
  check(calls[0]?.model === 'deepseek-pro', 'a session route still wins over the default model')
}
{
  // No session route and no default model is a genuine dead end: report it
  // rather than pretending a digest was written by nobody.
  const calls = []
  let result
  await assemble({
    llm: recordingLlm(calls),
    async run({ runTool }) {
      result = await runTool('memory_digest_generate')
    },
  })
  check(calls.length === 0, 'no model is called when no route is resolvable')
  check(String(result?.text ?? '').includes('失败'), 'the dead end is still reported as a failure')
}

console.log('a maintenance tick asks for the due tasks')
{
  // The cadence belongs to the Python side (`maintenance.run` runs only what is
  // due), so the host only has to keep asking. One short tick proves the wiring.
  const calls = []
  await assemble({
    calls,
    config: { maintenanceIntervalMs: 30 },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 130))
    },
  })
  const ticks = calls.filter((entry) => entry.command === 'maintenance.run')
  check(ticks.length > 0, 'the tick asks the bridge to run the due tasks')
  check(
    ticks.every((entry) => {
      const payload = entry.payload ?? {}
      return payload.tasks === undefined && payload.force === undefined && payload.project_ids === undefined
    }),
    'the host leaves the task cadence to the Python side',
  )
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
// `apply` arms unref'd timers and listeners that outlive the checks; without
// this the process lingers on a handle no assertion is waiting for.
process.exit(0)