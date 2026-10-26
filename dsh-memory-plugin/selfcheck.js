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
 * 3. the skill index's empty state points at dedupe before authoring.
 *
 * Exits non-zero on the first failed expectation.
 */

import { BridgeClient } from './bridge.js'
import { apply } from './index.js'

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
 * Render the prompt sections for one scenario.
 * @param {{memories?: Array<{summary: string}>, events?: Array<{type: string, data?: any}>}} scenario - inputs.
 * @returns {Promise<{anchor: string, skills: string}>} rendered text per section.
 */
async function assemble(scenario) {
  const sections = new Map()
  const listeners = []
  const stub = {
    get(name) {
      // Only the three services `apply` hard-requires; `connection` is optional.
      return ['tools', 'systemPrompt', 'agents'].includes(name) ? {} : undefined
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
    tools: { register() {} },
    inject() {},
    logger: { info() {}, warn() {}, error() {} },
  }

  const originalCall = BridgeClient.prototype.call
  const originalEnsureChild = BridgeClient.prototype.ensureChild
  // No Python child at all: the check is about prompt text, not the bridge.
  BridgeClient.prototype.ensureChild = async () => null
  BridgeClient.prototype.call = async (command, payload = {}) => {
    if (command === 'projects') return { project_id: 'selfcheck-project' }
    if (command === 'digest.anchor') {
      return { text: '@@dsh-memory 1\n@@', summary: {}, profile: null }
    }
    if (command === 'memory.list') {
      return { items: payload.state === 'active' ? (scenario.memories ?? []) : [] }
    }
    if (command === 'skill.index') return { index: [] }
    return {}
  }

  try {
    apply(stub, {})
    for (const event of scenario.events ?? []) {
      for (const entry of listeners) {
        if (entry.event === 'session/event') entry.listener({ id: 's1', header: { cwd: CWD } }, event)
      }
    }

    // Assembly is synchronous and the bridge read resolves off to the side:
    // one pass starts it, the wait lets it land, the second pass renders it.
    const context = { agent: { session: { id: 's1', header: { cwd: CWD } } } }
    sections.get('dsh-memory:anchor')(context)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      anchor: sections.get('dsh-memory:anchor')(context),
      skills: sections.get('dsh-memory:skills')(context),
    }
  } finally {
    BridgeClient.prototype.call = originalCall
    BridgeClient.prototype.ensureChild = originalEnsureChild
  }
}

console.log('heartbeat counts model steps')
{
  const { anchor } = await assemble({
    events: [1, 2, 3, 4].map((turn) => ({ type: 'turn/start', data: { turn } })),
  })
  check(!anchor.includes('记忆提醒'), 'four user turns alone do not trip a 20-step reminder')
}
{
  const events = []
  for (let turn = 1; turn <= 2; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } })
    for (let step = 1; step <= 12; step += 1) events.push({ type: 'step/start', data: { turn, step } })
  }
  const { anchor } = await assemble({ events })
  check(anchor.includes('记忆提醒'), '24 model steps across two turns do trip the reminder')
  check(anchor.includes('个模型步'), 'the reminder names model steps, not user turns')
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
    anchor.indexOf('**收尾时写**'),
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
    anchor.indexOf('**收尾时写**'),
  )
  check(!section.includes('更早的用'), 'a complete list points at DSH_MEMORY.md only')
}
{
  const { anchor } = await assemble({ memories: [] })
  check(!anchor.includes('本项目最近的工作'), 'a project with no memories omits the section entirely')
}

console.log('skill index empty state')
{
  const { skills } = await assemble({})
  check(skills.includes('skill_list'), 'the empty state asks for a dedupe check first')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
// `apply` arms unref'd timers and listeners that outlive the checks; without
// this the process lingers on a handle no assertion is waiting for.
process.exit(0)