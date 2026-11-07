/**
 * Self-check for the two prompt-path behaviours that Python tests cannot see.
 *
 * Run with `node dsh-memory-plugin/selfcheck.js`. It drives the real `apply`
 * with stub host services and a stubbed bridge, so it asserts what the model
 * would actually receive rather than what a helper returns in isolation:
 *
 * 1. the heartbeat counts model steps (`step/start`), not user turns, and the
 *    reminder text says so;
 * 2. the anchor's project context is requested with the bridge budgets, shows
 *    `.agents/rules` in order, shows the `.agents/memory/<YYYY-MM-DD>.md` day
 *    excerpts (or the recent-work fallback while no day file exists), and stays
 *    out of an assembly that has no working directory;
 * 3. `rule_add` writes exactly one `.agents/rules/<name>.md` through the bridge
 *    and reports the resulting path;
 * 4. digest generation reaches a model even when no session in this process has
 *    used one yet, via the deployment default model — and carries the session
 *    id, without which providers that route per conversation reject the call;
 * 5. a maintenance tick asks the Python side for the due background tasks.
 *
 * Exits non-zero on the first failed expectation.
 */

import { BridgeClient } from './bridge.js'
import {
  apply,
  PROJECT_MEMORY_CHARS,
  PROJECT_RECENT_LIMIT,
  PROJECT_RULES_CHARS,
  PROJECT_RULES_MAX,
} from './index.js'

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
 * @param {{cwd?: string, memories?: Array<{summary: string}>, projectContext?: any, events?: Array<{type: string, data?: any}>, llm?: any, defaultModel?: any, calls?: Array<{command: string, payload: any}>, config?: object, run?: (assembled: any) => Promise<void>}} scenario - inputs.
 * @returns {Promise<{anchor: string}>} rendered text per section.
 */
async function assemble(scenario) {
  // Most scenarios work in the fixture project; `''` models a session whose
  // working directory is not known yet.
  const cwd = scenario.cwd ?? CWD
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

  /**
   * Render every registered section the way `renderPrompt` does.
   *
   * Empty text disappears in the real assembly, so a section that renders ''
   * must be absent from the joined prompt rather than present as a blank line.
   * @returns {string} the joined prompt sections.
   */
  const renderAll = () => {
    const parts = []
    for (const text of sections.values()) {
      const value = typeof text === 'function' ? text({}) : text
      if (value) parts.push(value)
    }
    return parts.join('\n\n')
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
    if (command === 'project.context') {
      if (scenario.projectContext) return scenario.projectContext
      return {
        project_id: 'selfcheck-project',
        root_path: CWD,
        // The shape `project_files.read_project_memory` returns: the memory
        // directory, the newest day file, and every day file newest first.
        memory: {
          dir: `${CWD}/.agents/memory`,
          path: null,
          exists: false,
          files: [],
          days: [],
          chars: 0,
          updated: null,
          excerpt: '',
          truncated: false,
          legacy: false,
        },
        rules_dir: null,
        rules: [],
        rules_truncated: false,
        // `project.context` carries no `state` field, so this default stays
        // empty unless a scenario passes its own `projectContext`.
        recent: payload.state === 'active' ? (scenario.memories ?? []) : [],
      }
    }
    if (command === 'rule.write') {
      return { path: `${CWD}/.agents/rules/${payload.name}.md`, name: payload.name }
    }
    if (command === 'instruction.read') return scenario.instruction ?? { content: '', enabled: false }
    return {}
  }

  try {
    // The shipped default is 0 (off); these checks exercise the feature, so
    // every scenario runs with a 20-step window.
    apply(stub, { heartbeatSteps: 20, ...(scenario.config ?? {}) })
    const emit = (event) => {
      for (const entry of listeners) {
        if (entry.event === 'session/event') entry.listener({ id: 's1', header: { cwd } }, event)
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
    const context = { agent: { session: { id: 's1', header: { cwd } } } }
    // A scenario that turns the memory anchor off (`systemPromptAnchor: false`)
    // has no such section, and the rest of the checks still have to run.
    const render = () => {
      const text = sections.get('dsh-memory:anchor')
      return typeof text === 'function' ? text(context) : ''
    }
    const anchorFirst = render()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const assembled = {
      anchorFirst,
      anchor: render(),
      render,
      /** The whole rendered system prompt, empty sections dropped. */
      prompt: renderAll,
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

console.log('the anchor still tells the model to fixate a reusable procedure')
{
  // The skill rules live in the tool schema, but a schema-only rule produced
  // days of zero skill creation: the anchor reminded the model to write
  // memories every turn and never to save a verified procedure. This line is
  // the only unconditional trigger, so losing it silently is the regression.
  const { anchorFirst } = await assemble({})
  check(anchorFirst.includes('**技能固化**'), 'the anchor carries a skill section')
  check(anchorFirst.includes('`skill_list`'), 'it names skill_list as the first move')
  check(anchorFirst.includes('`skill_create`'), 'it names skill_create as the second')
  check(anchorFirst.includes('一次性任务不保存'), 'it keeps the one-off exception')
}

console.log('a global skill needs an answer the host saw, not a flag the model set')
{
  const asks = []
  const callArgs = (args) => ({
    name: 'locate-failing-test',
    title: '定位失败的测试',
    description: '找出失败的测试并定位原因',
    when_to_use: '测试报告失败时',
    steps: [{ action: '跑一遍失败用例' }],
    ...args,
  })

  // No question was ever answered, so a global write is refused even though the
  // model could pass anything it liked in the arguments.
  const first = await assemble({
    run: async ({ runTool }) => {
      asks.push(await runTool('skill_create', callArgs({ scope: 'global' })))
    },
  })
  check(first.anchorFirst.includes('**技能固化**'), 'the refused scenario still assembles')
  check(
    asks[0]?.text.includes('未创建'),
    'a global create without a user answer is refused',
  )
  check(
    asks[0]?.text.includes('dsh-memory:skill-scope'),
    'the refusal names the question id to ask',
  )

  // An actual answer to that question lets the write through, and only once.
  // `selected` carries the chosen option's *label* (the host has no option-id
  // field), so the granting label must include the bracketed marker.
  const granted = await assemble({
    run: async ({ runTool, emit }) => {
      emit({
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-1',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  answers: [
                    { id: 'dsh-memory:skill-scope', selected: ['存成全局技能 [skill-scope:global]'] },
                  ],
                }),
              },
            ],
          },
        },
      })
      asks.push(await runTool('skill_create', callArgs({ scope: 'global' })))
      asks.push(await runTool('skill_create', callArgs({ scope: 'global', name: 'second-skill' })))
    },
  })
  check(granted.anchorFirst.includes('**技能固化**'), 'the granted scenario still assembles')
  check(!asks[1]?.text.includes('未创建'), 'the answered question lets the global write through')
  check(asks[2]?.text.includes('未创建'), 'the grant is spent after one write')

  // The real host shape: a label the model wraps in its own wording. The marker
  // must be found inside it, which is the regression this covers.
  const labelled = await assemble({
    run: async ({ runTool, emit }) => {
      emit({
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-label',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  answers: [
                    { id: 'dsh-memory:skill-scope', selected: ['Save as a global skill [skill-scope:global] (Recommended)'] },
                  ],
                }),
              },
            ],
          },
        },
      })
      asks.push(await runTool('skill_create', callArgs({ scope: 'global', name: 'labelled-skill' })))
    },
  })
  check(labelled.anchorFirst.includes('**技能固化**'), 'the label-marked scenario assembles')
  check(!asks[3]?.text.includes('未创建'), 'a real option label containing the marker grants consent')

  // A label that merely mentions "global" must not grant consent.
  const looseWord = await assemble({
    run: async ({ runTool, emit }) => {
      emit({
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-loose',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  answers: [{ id: 'dsh-memory:skill-scope', selected: ['use the global cache'] }],
                }),
              },
            ],
          },
        },
      })
      asks.push(await runTool('skill_create', callArgs({ scope: 'global', name: 'loose-skill' })))
    },
  })
  check(looseWord.anchorFirst.includes('**技能固化**'), 'the loose-word scenario assembles')
  check(asks[4]?.text.includes('未创建'), 'a label that merely mentions global does not grant consent')

  // An explicit "project only" answer never grants global scope.
  const declined = await assemble({
    run: async ({ runTool, emit }) => {
      emit({
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'call-2',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  answers: [{ id: 'dsh-memory:skill-scope', selected: ['project'] }],
                }),
              },
            ],
          },
        },
      })
      asks.push(await runTool('skill_create', callArgs({ scope: 'global' })))
    },
  })
  check(declined.anchorFirst.includes('**技能固化**'), 'the declined scenario assembles')
  check(asks[5]?.text.includes('未创建'), 'choosing the project option does not grant global')

  // A pending (timed-out) ask carries no answers; silence is not consent.
  const pending = await assemble({
    run: async ({ runTool, emit }) => {
      emit({
        type: 'tool/result',
        data: { message: { toolCallId: 'call-3', content: [{ type: 'text', text: '{"pending":true}' }] } },
      })
      asks.push(await runTool('skill_create', callArgs({ scope: 'global' })))
    },
  })
  check(pending.anchorFirst.includes('**技能固化**'), 'the pending scenario assembles')
  check(asks[6]?.text.includes('未创建'), 'a timed-out ask grants nothing')
}

console.log('project context: the memory excerpt is injected within its budget')
{
  // Two days worth of records, newest first: the excerpt the bridge assembles
  // from several `.agents/memory/<YYYY-MM-DD>.md` files.
  const excerpt = [
    '## 2026-11-06',
    '- 项目记忆改成一天一个文件',
    '## 2026-11-05',
    '- 记忆文件迁到 .agents/memory/<日期>.md',
    '- 规则目录用 .agents/rules/<name>.md',
  ].join('\n')
  const calls = []
  const { anchor } = await assemble({
    calls,
    projectContext: {
      project_id: 'selfcheck-project',
      root_path: CWD,
      memory: {
        dir: `${CWD}/.agents/memory`,
        path: `${CWD}/.agents/memory/2026-11-06.md`,
        exists: true,
        files: [`${CWD}/.agents/memory/2026-11-06.md`, `${CWD}/.agents/memory/2026-11-05.md`],
        days: ['2026-11-06', '2026-11-05'],
        chars: excerpt.length,
        updated: '2026-11-06 09:20:11',
        excerpt,
        truncated: true,
        legacy: false,
      },
      rules_dir: `${CWD}/.agents/rules`,
      rules: [],
      rules_truncated: false,
      recent: [],
    },
  })
  check(anchor.includes('**本项目工作记录**'), 'a project with work records shows its excerpt block')
  check(
    anchor.includes('（来自 `.agents/memory/` 下的按日期文件'),
    'the block names the per-day files under the memory directory',
  )
  check(anchor.includes('更新于 2026-11-06 09:20:11'), 'the block shows the newest record update stamp')
  check(anchor.includes('项目记忆改成一天一个文件'), 'the newest day excerpt reaches the prompt')
  check(anchor.includes('记忆文件迁到 .agents/memory/<日期>.md'), 'an older day excerpt reaches the prompt too')
  check(anchor.includes('更早的内容在 `.agents/memory/`'), 'a cut excerpt points at the memory directory')
  check(anchor.includes('.agents/memory/<YYYY-MM-DD>.md'), 'a cut excerpt names the per-day file pattern')
  check(
    !anchor.includes('**本项目最近的工作**'),
    'the DB fallback is not used while day records exist',
  )
  const section = anchor
    .slice(anchor.indexOf('**本项目工作记录**'), anchor.indexOf('**记忆写入**'))
    .trim()
  check(
    section.length <= PROJECT_MEMORY_CHARS + 200,
    `the memory block stays near its budget (${section.length} chars)`,
  )
  const contextCall = calls.find((entry) => entry.command === 'project.context')
  check(contextCall !== undefined, 'the anchor reads the project context through the bridge')
  check(contextCall?.payload?.cwd === CWD, 'the project-context read carries the session cwd')
  check(
    contextCall?.payload?.memory_chars === PROJECT_MEMORY_CHARS,
    'the memory excerpt is requested with its budget',
  )
  check(contextCall?.payload?.rule_chars === PROJECT_RULES_CHARS, 'the rules are requested with their budget')
  check(contextCall?.payload?.max_rules === PROJECT_RULES_MAX, 'the rule count is capped')
  check(contextCall?.payload?.recent_limit === PROJECT_RECENT_LIMIT, 'the fallback list is capped')
}

console.log('project context: a project without day records falls back to recent work')
{
  const { anchor } = await assemble({
    projectContext: {
      project_id: 'selfcheck-project',
      root_path: CWD,
      memory: {
        dir: `${CWD}/.agents/memory`,
        path: null,
        exists: false,
        files: [],
        days: [],
        chars: 0,
        updated: null,
        excerpt: '',
        truncated: false,
        legacy: false,
      },
      rules_dir: `${CWD}/.agents/rules`,
      rules: [],
      rules_truncated: false,
      recent: [{ summary: '最近完成了规则目录迁移' }, { summary: '把 DSH_MEMORY.md 搬到 .agents' }],
    },
  })
  check(anchor.includes('**本项目最近的工作**'), 'a project with no day records shows the recent-work fallback')
  check(anchor.includes('- 最近完成了规则目录迁移'), 'the fallback lists the newest work lines')
  check(
    anchor.includes('全量历史见 `.agents/memory/`'),
    'the fallback points at the per-day record directory',
  )
  check(
    anchor.includes('`.agents/memory/<YYYY-MM-DD>.md`'),
    'the fallback names the per-day file pattern',
  )
  check(!anchor.includes('**本项目工作记录**'), 'the excerpt block is not shown without day records')
}

console.log('project context: an empty project adds no resident block')
{
  const { anchor } = await assemble({})
  check(!anchor.includes('**本项目工作记录**'), 'no work records means no excerpt block')
  check(!anchor.includes('**本项目最近的工作**'), 'no fallback entries means no recent-work block')
  check(!anchor.includes('**本项目规则**'), 'no rule files means no rules block')
}
{
  // First contact materializes today's `<repo>/.agents/memory/<YYYY-MM-DD>.md`
  // even when the project has no work yet; the file exists but carries nothing
  // to inject.
  const { anchor } = await assemble({
    projectContext: {
      project_id: 'selfcheck-project',
      root_path: CWD,
      memory: {
        dir: `${CWD}/.agents/memory`,
        path: `${CWD}/.agents/memory/2026-11-06.md`,
        exists: true,
        files: [`${CWD}/.agents/memory/2026-11-06.md`],
        days: ['2026-11-06'],
        chars: 120,
        updated: null,
        excerpt: '',
        truncated: false,
        legacy: false,
      },
      rules_dir: `${CWD}/.agents/rules`,
      rules: [],
      rules_truncated: false,
      recent: [],
    },
  })
  check(!anchor.includes('**本项目工作记录**'), 'a materialized but empty day record adds no block')
  check(!anchor.includes('完整记录见'), 'an empty day record does not advertise itself every turn')
}

console.log('project context: the rules are injected in order')
{
  const rules = [
    {
      name: 'commit-message-style',
      title: '提交信息格式',
      description: '约束提交信息的写法',
      path: `${CWD}/.agents/rules/commit-message-style.md`,
      chars: 40,
      content: '提交信息用中文。\n第一行写结论，正文写清改了什么。',
    },
    {
      name: 'no-em-dash',
      title: '不用破折号',
      description: '约束用户可见文案的标点',
      path: `${CWD}/.agents/rules/no-em-dash.md`,
      chars: 18,
      content: '用户可见文案里不要用破折号。',
    },
  ]
  const { anchor } = await assemble({
    projectContext: {
      project_id: 'selfcheck-project',
      root_path: CWD,
      memory: {
        dir: `${CWD}/.agents/memory`,
        path: null,
        exists: false,
        files: [],
        days: [],
        chars: 0,
        updated: null,
        excerpt: '',
        truncated: false,
        legacy: false,
      },
      rules_dir: `${CWD}/.agents/rules`,
      rules,
      rules_truncated: true,
      recent: [],
    },
  })
  check(anchor.includes('**本项目规则**'), 'a project with rules gets a rules block')
  check(anchor.includes('共 2 条'), 'the heading counts the rules')
  check(anchor.includes('**提交信息格式**（`commit-message-style`）'), 'a rule renders its title and name')
  check(anchor.includes('提交信息用中文。'), 'the first rule body is injected')
  check(anchor.includes('  第一行写结论，正文写清改了什么。'), 'rule bodies are indented under their heading')
  check(anchor.includes('**不用破折号**（`no-em-dash`）'), 'the second rule is injected too')
  check(anchor.includes('用户可见文案里不要用破折号。'), 'the second rule body is injected')
  check(anchor.indexOf('**提交信息格式**') < anchor.indexOf('**不用破折号**'), 'the rules keep their order')
  check(anchor.includes('还有规则未全部注入'), 'a truncated rule list says more rules exist')
  check(anchor.indexOf('**本项目规则**') < anchor.indexOf('**记忆写入**'), 'the rules read before the tool usage guide')
}
{
  const { anchor } = await assemble({})
  check(!anchor.includes('**本项目规则**'), 'a project with no rules omits the rules block entirely')
}

console.log('rule_add writes one rule file through the bridge')
{
  const calls = []
  const content = '提交信息用中文。\n第一行写结论，正文写清改了什么。'
  let result
  await assemble({
    calls,
    async run({ runTool }) {
      result = await runTool('rule_add', {
        name: 'commit-message-style',
        title: '提交信息格式',
        description: '约束提交信息的写法',
        content,
      })
    },
  })
  const writes = calls.filter((entry) => entry.command === 'rule.write')
  check(writes.length === 1, 'rule_add makes exactly one rule.write call')
  const payload = writes[0]?.payload ?? {}
  check(payload.cwd === CWD, 'the write carries the session working directory')
  check(payload.name === 'commit-message-style', 'the rule name reaches the bridge')
  check(payload.title === '提交信息格式', 'the title reaches the bridge')
  check(payload.description === '约束提交信息的写法', 'the description reaches the bridge')
  check(payload.content === content, 'the rule body reaches the bridge verbatim')
  check(
    String(result?.text ?? '').includes('.agents/rules/commit-message-style.md'),
    'the tool reports the written path',
  )
}

console.log('a cwd-less assembly never borrows another project context')
{
  const calls = []
  const { anchor } = await assemble({
    cwd: '',
    calls,
    // If anything asked the bridge anyway, this answer would render; the point
    // is that a session with no working directory never asks.
    projectContext: {
      project_id: 'other-project',
      root_path: 'D:/other/project',
      memory: {
        dir: 'D:/other/project/.agents/memory',
        path: 'D:/other/project/.agents/memory/2026-11-05.md',
        exists: true,
        files: ['D:/other/project/.agents/memory/2026-11-05.md'],
        days: ['2026-11-05'],
        chars: 10,
        updated: '2026-11-05 13:10:36',
        excerpt: '另一个项目的工作记录',
        truncated: false,
        legacy: false,
      },
      rules_dir: 'D:/other/project/.agents/rules',
      rules: [
        {
          name: 'other-rule',
          title: '别人的规则',
          description: '不该出现',
          path: 'D:/other/project/.agents/rules/other-rule.md',
          chars: 4,
          content: '不该出现',
        },
      ],
      rules_truncated: false,
      recent: [],
    },
  })
  const contextCalls = calls.filter((entry) => entry.command === 'project.context')
  check(contextCalls.length === 0, 'no project context is requested without a working directory')
  check(!anchor.includes('另一个项目的工作记录'), 'no project memory leaks into a cwd-less assembly')
  check(!anchor.includes('别人的规则'), 'no project rules leak into a cwd-less assembly')
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

console.log('the user instruction is injected only when it is switched on')
{
  const text = '- 回答先给结论，再展开细节\n- 代码注释用中文'
  // Switched on and non-empty: the text reaches the prompt verbatim.
  const on = await assemble({ instruction: { content: text, enabled: true } })
  check(on.prompt().includes(text), 'an enabled instruction is injected')
  // Off keeps the text on disk but keeps it out of the prompt: a section that
  // is present but blank would still be paid for on every request.
  const off = await assemble({ instruction: { content: text, enabled: false } })
  check(!off.prompt().includes(text), 'a switched-off instruction is not injected')
  // Never written: nothing to say, so nothing is carried.
  const blank = await assemble({ instruction: { content: '', enabled: true } })
  check(!blank.prompt().includes('回答先给结论'), 'an empty instruction renders nothing')
}
{
  // The user's text is literal: a `{{…}}` group in it must not be expanded or
  // fail assembly, which is why the section sets `interpolate: false`.
  const text = '用 {{cwd}} 作占位符的写法保持原样'
  const { prompt } = await assemble({ instruction: { content: text, enabled: true } })
  check(prompt().includes('{{cwd}}'), 'braces in the instruction survive verbatim')
}
{
  // The instruction is the user's own text, not a memory fact: turning the
  // memory anchor off must not take the instruction with it.
  const { prompt } = await assemble({
    config: { systemPromptAnchor: false },
    instruction: { content: '独立于记忆锚点的指令', enabled: true },
  })
  check(prompt().includes('独立于记忆锚点的指令'), 'the instruction survives systemPromptAnchor: false')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
// `apply` arms unref'd timers and listeners that outlive the checks; without
// this the process lingers on a handle no assertion is waiting for.
process.exit(0)