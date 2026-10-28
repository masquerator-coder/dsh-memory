/**
 * Model-facing memory tools.
 *
 * Kept apart from the plugin wiring because these are the surface the model
 * actually sees: every schema, name and description here is prompt budget and
 * behaviour. The runtime shapes come from `@deepseek-ai/dsh-tools`:
 * `parameters` uses the author DSL (`required: true` on the field),
 * `output` declares a schema plus a `render` that returns content blocks, and
 * `execute(args, exec)` receives the dispatch execution.
 *
 * @module dsh-memory/tools
 */

import { BridgeError } from './bridge.js'

/** Working directory of the agent behind a tool execution. */
function cwdOf(exec) {
  return exec?.agent?.session?.header?.cwd
}

/** Session id of the agent behind a tool execution. */
function sessionIdOf(exec) {
  return exec?.agent?.session?.id
}

/**
 * One text-block result with a structural schema.
 * @param {string} text - the model-facing text.
 * @returns {object} an output descriptor.
 */
function textOutput(text) {
  return { text }
}

/** The output descriptor shared by every text-returning memory tool. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * Render a recall result as model-facing text.
 *
 * A degraded result is spelled out rather than folded into "nothing found":
 * recall swallows a failing half (an index error, a provider outage) and
 * reports it on `degraded`, so silence here would let the model conclude the
 * memory does not exist when the lookup never ran.
 * @param {any} recall - bridge `memory.recall` result (`{ result: {...} }`).
 * @returns {string} formatted text.
 */
export function formatRecall(recall) {
  const payload = recall?.result ?? recall ?? {}
  const episodes = Array.isArray(payload.episodes) ? payload.episodes : []
  const facts = Array.isArray(payload.facts) ? payload.facts : []
  const disclosure =
    typeof payload.disclosure === 'string' ? payload.disclosure : payload.disclosure?.text ?? ''
  const degraded = typeof payload.degraded === 'string' ? payload.degraded.trim() : ''
  const lines = []
  if (episodes.length > 0) {
    lines.push('### 相关事件')
    episodes.forEach((item, index) => {
      const id = item.memory_id ?? item.id ?? '?'
      const meta = [item.event_type, item.project_id, item.created_at?.slice?.(0, 10)]
        .filter(Boolean)
        .join(' · ')
      lines.push(`${index + 1}. [\`${id}\`] ${item.summary ?? item.text ?? ''}${meta ? `（${meta}）` : ''}`)
    })
  }
  if (facts.length > 0) {
    lines.push('### 相关事实')
    facts.forEach((edge, index) => {
      const head = edge.head ?? edge.src ?? '?'
      const relation = edge.relation ?? edge.rel ?? '?'
      const tail = edge.tail ?? edge.dst ?? '?'
      lines.push(`${index + 1}. ${head} —${relation}→ ${tail}`)
    })
  }
  if (degraded) {
    lines.push(`> ⚠️ 本次检索部分降级（${degraded}）：结果可能不完整，不能据此断定“没有相关记忆”。`)
  }
  if (lines.length === 0) {
    return disclosure ? `${disclosure}\n\n没有检索到相关记忆。` : '没有检索到相关记忆。'
  }
  return `${disclosure ? `${disclosure}\n\n` : ''}${lines.join('\n')}`
}

/**
 * Render the per-fact write decisions from a `memory.remember` result.
 *
 * The store answers every fact with a decision instead of raising, so a caller
 * that ignores them cannot tell "written to the graph" from "quietly refused".
 * @param {any[]} decisions - `remembered.facts` entries.
 * @returns {string} one line per refused or downgraded fact; empty when all landed.
 */
export function formatFactDecisions(decisions) {
  const items = Array.isArray(decisions) ? decisions : []
  const refused = items.filter((item) => item && item.status === 'rejected')
  if (refused.length === 0) return ''
  const merged = items.filter((item) => item && item.status === 'duplicate')
  const lines = refused.map((item) => {
    const reason = item.reason || 'rejected'
    const hint =
      reason === 'unknown_relation'
        ? '；relation 只接受内置词表（causes / contradicts / depends_on / is_a / located_in / owns / part_of / related_to / uses / works_at）'
        : ''
    return `- 事实未写入图谱：${reason}${hint}`
  })
  if (merged.length > 0) lines.push(`- 另有 ${merged.length} 条已存在（duplicate），未重复写入`)
  return `事实写入结果（${refused.length}/${items.length} 条被拒绝）：\n${lines.join('\n')}`
}

/**
 * Render a listing result as model-facing text.
 * @param {any} result - bridge `memory.list` result.
 * @returns {string} formatted text.
 */
export function formatListing(result) {
  const items = Array.isArray(result?.items) ? result.items : []
  if (items.length === 0) return '记忆库中没有符合条件的条目。'
  const lines = items.map((item, index) => {
    const flags = [item.state, item.event_type, item.outcome].filter(Boolean).join('/')
    return `${index + 1}. [\`${item.memory_id}\`] ${item.summary}${flags ? `（${flags}）` : ''}`
  })
  const total = result?.total ?? items.length
  return `共 ${total} 条，显示 ${items.length} 条：\n${lines.join('\n')}`
}

/**
 * Render one skill `skill.list` item as a single review line.
 * @param {any} skill - item from the bridge.
 * @returns {string} `- name · status · trigger · description`.
 */
function skillLine(skill) {
  const trigger = (skill.triggers ?? []).slice(0, 2).join('|')
  const flags = [skill.scope, skill.status, skill.tier].filter(Boolean).join(' · ')
  return `- \`${skill.qualified_name}\`（${flags}）${trigger ? `触发：${trigger} ` : ''}${skill.description ?? ''}`
}

/**
 * Render a `skill.list` result, project scope first.
 * @param {any} result - bridge `skill.list` result.
 * @returns {string} formatted text.
 */
export function formatSkillList(result) {
  const items = Array.isArray(result?.items) ? result.items : []
  if (items.length === 0) return '当前项目与公共技能目录里都还没有技能。'
  const rank = { project: 3, global: 2, org: 2, sys: 1 }
  const ordered = [...items].sort((a, b) => (rank[b.scope] ?? 0) - (rank[a.scope] ?? 0))
  const active = ordered.filter((item) => item.status === 'active')
  const others = ordered.filter((item) => item.status !== 'active')
  const lines = [`共 ${items.length} 个技能（active ${active.length} 个）：`]
  lines.push(...active.map(skillLine))
  if (others.length > 0) lines.push(`候选/已退役 ${others.length} 个：`, ...others.map(skillLine))
  return lines.join('\n')
}

/**
 * Compile one author-DSL property into a JSON Schema node.
 *
 * The DSL marks requiredness with `required: true` on the property itself; a
 * JSON Schema states it as a root-level name list, so the flag is stripped
 * here and collected by {@link compileParameters}.
 * @param {any} spec - author property spec.
 * @returns {object} a JSON Schema node.
 */
function compileProperty(spec) {
  if (!spec || typeof spec !== 'object') return {}
  const { required: _required, properties, items, ...rest } = spec
  const out = { ...rest }
  if (properties && typeof properties === 'object') {
    const compiled = compileParameters(properties)
    if (compiled.required) out.required = compiled.required
    out.properties = compiled.properties
  }
  if (items && typeof items === 'object') out.items = compileProperty(items)
  return out
}

/**
 * Compile an author parameter map into an object-rooted JSON Schema.
 *
 * Hosts pass `tool.parameters` straight to the provider API as `input_schema`
 * (`dsh-llm-deepseek` / `dsh-llm-pi-ai`), and only `defineTool` compiles the
 * DSL — `tools.register()` takes the definition as given. A raw DSL object has
 * no `type: "object"`, so the request is rejected before the model ever sees
 * the tool. Compiling here keeps the authoring shape while shipping a schema
 * the API accepts.
 * @param {object} spec - per-property parameter definitions.
 * @returns {{type: string, properties: object, required?: string[]}} JSON Schema.
 */
export function compileParameters(spec) {
  const source = spec && typeof spec === 'object' ? spec : {}
  const properties = {}
  const required = []
  for (const [name, prop] of Object.entries(source)) {
    properties[name] = compileProperty(prop)
    if (prop && prop.required === true) required.push(name)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * Build every memory tool definition.
 * @param {object} deps - host seams.
 * @param {(command: string, payload?: object, signal?: AbortSignal) => Promise<any>} deps.call - bridge call.
 * @param {(cwd?: string) => Promise<string | undefined>} deps.projectFor - project resolution.
 * @param {(options: object) => Promise<any>} deps.generateDigest - digest generation.
 * @returns {object[]} registry-ready definitions.
 */
export function buildTools({ call, projectFor, generateDigest }) {
  /** Resolve the project a tool call acts on, failing clearly when unknown. */
  const requireProject = async (exec) => {
    const projectId = await projectFor(cwdOf(exec))
    if (!projectId) throw new BridgeError('无法确定当前项目：会话没有工作目录', 'NO_PROJECT')
    return projectId
  }

  const definitions = [
    {
      name: 'memory_recall',
      description:
        '检索与当前工作相关的记忆（事件与事实）。用于回答“之前做过什么”“这个项目的约定”“上次为什么这样决定”。按相关度返回条目。',
      parameters: {
        query: { type: 'string', required: true, description: '要检索的内容，用用户的原话或关键实体。' },
        limit: { type: 'number', description: '返回条数，默认 8，最多 30。' },
        project: { type: 'string', description: '项目 id；省略则用当前工作目录对应的项目。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const projectId = args.project || (await requireProject(exec))
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 30)
        const result = await call(
          'memory.recall',
          { project_id: projectId, query: args.query, k_l2: limit, k_l3: limit },
          exec?.signal,
        )
        return textOutput(formatRecall(result))
      },
    },
    {
      name: 'memory_search',
      description:
        '按关键词与状态列出记忆库条目（不排序、可分页），用于审阅与核对记忆内容。与 memory_recall 的区别：recall 按相关度排序，search 按筛选条件与时间列出。',
      parameters: {
        query: { type: 'string', description: '可选关键词。' },
        state: { type: 'string', description: 'active 或 archived；省略为全部。' },
        event_type: { type: 'string', description: '如 decision、fix、user_message。' },
        all_projects: { type: 'boolean', description: '跨项目检索，默认只查当前项目。' },
        limit: { type: 'number', description: '返回条数，默认 10，最多 50。' },
        offset: { type: 'number', description: '分页偏移。' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await call(
          'memory.list',
          {
            project_id: args.all_projects ? undefined : await requireProject(exec),
            all_projects: args.all_projects === true,
            query: args.query,
            state: args.state,
            event_type: args.event_type,
            limit: Math.min(Math.max(Number(args.limit) || 10, 1), 50),
            offset: Math.max(Number(args.offset) || 0, 0),
          },
          exec?.signal,
        )
        return textOutput(formatListing(result))
      },
    },
    {
      name: 'memory_add',
      description:
        '把一条值得长期记住的内容写入记忆库：用户明确的偏好、项目约定与决策、踩过的坑及其原因。不要记录闲聊，也不要记录能从代码直接读到的内容。',
      parameters: {
        summary: { type: 'string', required: true, description: '一句话说明要记住的内容，含关键实体与结论。' },
        event_type: { type: 'string', description: 'decision / preference / fix / fact / note，默认 note。' },
        importance: { type: 'number', description: '0 到 1，默认 0.6。' },
        outcome: { type: 'string', description: 'success / failure / neutral。' },
        facts: {
          type: 'array',
          description: '可选的结构化事实三元组。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              head: { type: 'string' },
              relation: {
                type: 'string',
                description:
                  '关系名，必须用内置词表之一：causes / contradicts / depends_on / is_a / located_in / owns / part_of / related_to / uses / works_at。中文原词（如“任职机构与职称”）会被拒绝。',
              },
              tail: { type: 'string' },
            },
          },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await call(
          'memory.remember',
          {
            project_id: await requireProject(exec),
            summary: args.summary,
            event_type: args.event_type || 'note',
            importance: Math.min(Math.max(Number(args.importance ?? 0.6), 0), 1),
            outcome: args.outcome,
            facts: Array.isArray(args.facts) ? args.facts : undefined,
            source: 'dsh-tool',
            session_key: sessionIdOf(exec),
          },
          exec?.signal,
        )
        const mentioned = formatFactDecisions(result?.remembered?.facts)
        const wrote = `已写入记忆 \`${result?.remembered?.memory_id ?? '?'}\`。`
        return textOutput(mentioned ? `${wrote}\n${mentioned}` : wrote)
      },
    },
    {
      name: 'memory_forget',
      description:
        '把一条记忆标记为已归档（软删除，可恢复）。仅在用户明确要求“忘掉”某条内容时使用；归档后默认检索不再返回它。',
      parameters: {
        memory_id: { type: 'string', required: true, description: '要归档的记忆 id，例如 ep_xxx。' },
        reason: { type: 'string', description: '归档原因。' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await call(
          'memory.forget',
          { memory_id: args.memory_id, reason: args.reason || 'tool request' },
          exec?.signal,
        )
        return textOutput(`已归档 \`${result?.memory?.memory_id ?? args.memory_id}\`，可随时恢复。`)
      },
    },
    {
      name: 'memory_profile_read',
      description:
        '读取用户自己维护的用户画像（偏好、习惯、约束）。需要知道用户希望怎么被服务时调用；画像由用户编辑，不要改写它。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const result = await call('profile.read', {}, exec?.signal)
        const content = result?.content?.trim()
        return textOutput(content ? content : '用户画像为空：用户还没有填写任何偏好。')
      },
    },
    {
      name: 'memory_digest_read',
      description:
        '读取全局记忆摘要全文：它记录所有项目已经做过的工作。系统提示词里只有摘要的规模与时间，需要细节时调用本工具。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const result = await call('digest.view', {}, exec?.signal)
        const content = result?.digest?.content?.trim()
        if (!content) {
          return textOutput('还没有全局记忆摘要。可调用 memory_digest_generate 生成。')
        }
        return textOutput(content)
      },
    },
    {
      name: 'memory_digest_generate',
      description:
        '根据所有项目的最新工作记录重新生成全局记忆摘要（会调用一次模型，可能耗时数十秒）。仅在用户要求刷新摘要、或摘要明显过时时调用。',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        // The session id rides along because providers that route per
        // conversation reject a call without it (see `collectText` in index.js).
        const record = await generateDigest({
          cwd: cwdOf(exec),
          signal: exec?.signal,
          reason: 'manual',
          sessionId: sessionIdOf(exec),
        })
        const digest = record?.digest
        if (!digest) return textOutput('摘要生成未返回结果。')
        if (digest.status === 'error') return textOutput(`摘要生成失败：${digest.error ?? '未知错误'}`)
        return textOutput(
          `全局摘要已更新（\`${digest.digest_id}\`，${digest.actual_chars} 字，约 ${digest.estimated_tokens} tokens）。`,
        )
      },
    },
    {
      name: 'skill_create',
      description:
        '把一个刚被验证过的程序性做法存成技能。默认存**本项目**：写入 `<项目根>/.agents/skills/<name>/SKILL.md`；传 `scope="global"` 则存成**公共技能**，写入 `~/.agents/skills/<name>/SKILL.md`，对本机所有项目可见。两个目录都是 DSH 技能目录扫描的位置，下一回合起模型目录（`available_skills`）会列出它，人和别的工具也读同一个文件。`name` 必填，必须是小写 kebab-case ASCII（如 `locate-failing-test`），中文标题放 `title`。只在做法可复用时调用：同一套步骤在不同任务里会被反复用到（例如定位失败的测试、发布前的检查、生成某类文件的固定流程）。一次性任务、只是读过代码、还没验证过的猜测都不要存。宁缺毋滥：一个会话最多新建 1 个技能，且必须先 `skill_list` 确认没有同类技能。**创建公共技能前必须先问用户是否要保存为公共技能，得到明确同意后才能传 `scope="global"` 与 `user_approved=true`；不要自行假定同意。**',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description:
            '技能标识，同时是目录名：小写 kebab-case ASCII，如 `locate-failing-test`。中文会被 DSH 丢弃，所有中文放 title/description。',
        },
        scope: {
          type: 'string',
          description:
            '`project`（默认，写入本项目 `.agents/skills`）或 `global`（公共技能，写入 `~/.agents/skills`，所有项目可见）。选 global 前必须先询问用户。',
        },
        user_approved: {
          type: 'boolean',
          description:
            '仅当用户已明确同意创建公共技能（或退役公共技能）时设为 true；创建普通项目技能不需要。',
        },
        title: { type: 'string', required: true, description: '技能名，简短可区分，如「定位失败的测试」。' },
        description: { type: 'string', required: true, description: '一句话说明这个技能做什么，不超过 30 字。' },
        when_to_use: { type: 'string', required: true, description: '什么时候该用：具体条件，不要只写「需要时」。' },
        triggers: {
          type: 'array',
          description: '2-4 个触发关键词，用户提出同类任务时会命中；同类技能之间应互斥。',
          items: { type: 'string' },
        },
        steps: {
          type: 'array',
          required: true,
          description: '按执行顺序排列的步骤，每条一句话、用祈使句；关键步骤标 critical。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string' },
              tool: { type: 'string', description: '这一步主要用到的工具名，可省略。' },
              args_hint: { type: 'string', description: '参数写法提示，可省略。' },
              critical: { type: 'boolean' },
            },
          },
        },
        requires_tools: {
          type: 'array',
          description: '执行前提用到的工具名；缺少这些工具时该技能不会被推荐。',
          items: { type: 'string' },
        },
        success_criteria: { type: 'string', description: '怎样算做完，可省略。' },
        fallback: { type: 'string', description: '失败时怎么回退，可省略。' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const steps = (Array.isArray(args.steps) ? args.steps : [])
          .map((step) => ({
            action: typeof step?.action === 'string' ? step.action : '',
            tool: step?.tool,
            args_hint: step?.args_hint,
            critical: step?.critical === true,
          }))
          .filter((step) => step.action.trim().length > 0)
        const result = await call(
          'skill.create',
          {
            project_id: await requireProject(exec),
            cwd: cwdOf(exec),
            model_authored: true,
            scope: args.scope === 'global' ? 'global' : 'project',
            user_approved: args.user_approved === true,
            name: args.name,
            definition: {
              title: args.title,
              description: args.description,
              when_to_use: args.when_to_use,
              triggers: Array.isArray(args.triggers) ? args.triggers : [],
              steps,
              requires_tools: Array.isArray(args.requires_tools) ? args.requires_tools : [],
              success_criteria: args.success_criteria,
              fallback: args.fallback,
            },
          },
          exec?.signal,
        )
        const skill = result?.skill ?? {}
        const where = result?.scope === 'global' ? '公共技能' : '项目技能'
        const record = result?.record_id
          ? `记忆库已保留创建记录 \`${result.record_id}\`。`
          : '记忆库创建记录未写入（技能文件已保存）。'
        return textOutput(
          `已创建${where} \`${skill.qualified_name}\`（${skill.step_count} 步），写入 \`${skill.path}\`。下一回合起 DSH 技能目录会列出它，可用 \`skill\` 工具加载；执行后同 skill_run 记录结果，做法过时用 skill_retire 退役。${record}`,
        )
      },
    },
    {
      name: 'skill_list',
      description:
        '列出当前项目可用的技能：项目技能（本项目 `.agents/skills`）+ 公共技能（`~/.agents/skills`）。新建技能前先用它确认没有同类技能。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const result = await call(
          'skill.list',
          { project_id: await requireProject(exec), cwd: cwdOf(exec) },
          exec?.signal,
        )
        return textOutput(formatSkillList(result))
      },
    },
    {
      name: 'skill_get',
      description:
        '读取一个技能的完整定义（全部步骤、前置条件、成功标准）。索引里只有一行摘要，执行前需要细节时调用；项目技能与公共技能都直接返回 `SKILL.md` 正文。',
      parameters: {
        skill: {
          type: 'string',
          required: true,
          description: '技能名（用它的 kebab-case name，如 `locate-failing-test`）或 skill_id。',
        },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await call(
          'skill.get',
          { project_id: await requireProject(exec), cwd: cwdOf(exec), skill: args.skill },
          exec?.signal,
        )
        return textOutput(result?.markdown || `未找到技能 ${args.skill}。`)
      },
    },
    {
      name: 'skill_run',
      description:
        '记录一次技能执行的结果。技能被真正按步骤用过之后调用，用于成功率；只是看一眼技能不要调用。执行记录追加到记忆库目录下的 `l4_runs`，不进技能目录。',
      parameters: {
        skill: { type: 'string', required: true, description: '技能名或 skill_id。' },
        outcome: { type: 'string', description: 'success / failure / partial，默认 success。' },
        error: { type: 'string', description: '失败原因，可省略。' },
        deviation: { type: 'string', description: '步骤偏离说明，可省略。' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await call(
          'skill.run',
          {
            project_id: await requireProject(exec),
            cwd: cwdOf(exec),
            skill: args.skill,
            outcome: args.outcome || 'success',
            error: args.error,
            deviation: args.deviation,
          },
          exec?.signal,
        )
        return textOutput(
          `已记录执行 \`${result?.run_id ?? '?'}\`，当前成功率 ${result?.success_rate ?? '?'}。`,
        )
      },
    },
    {
      name: 'skill_retire',
      description:
        '退役一个技能：做法过时、被更好的做法替代、或用户明确说不要时使用。技能目录会被移到同级的 `.retired/`，文件保留可恢复。项目技能可直接退役；**公共技能对全部项目可见，退役前必须先询问用户并得到同意，再传 `user_approved=true`。**',
      parameters: {
        skill: { type: 'string', required: true, description: '技能名或 skill_id。' },
        reason: { type: 'string', description: '退役原因。' },
        user_approved: {
          type: 'boolean',
          description: '仅当用户已明确同意退役公共技能时设为 true；退役项目技能不需要。',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await call(
          'skill.retire',
          {
            project_id: await requireProject(exec),
            cwd: cwdOf(exec),
            skill: args.skill,
            reason: args.reason || 'tool request',
            model_authored: true,
            user_approved: args.user_approved === true,
          },
          exec?.signal,
        )
        return textOutput(`已退役 \`${result?.skill?.qualified_name ?? args.skill}\`，记录保留可恢复。`)
      },
    },
  ]

  // Compiled once at the boundary so every definition leaves with a schema the
  // provider accepts; the authoring DSL above stays readable.
  return definitions.map((definition) => ({
    ...definition,
    parameters: compileParameters(definition.parameters),
  }))
}
