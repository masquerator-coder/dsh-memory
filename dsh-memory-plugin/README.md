# dsh-memory

DSH 记忆插件：把 `D:\Coding\dsh-memory\memory_system` 的长期记忆接入 DeepSeek Harness。

插件本身**不含任何记忆逻辑**。全局摘要生成、按预算控制详细程度、用户画像、条目编辑、
Markdown 备份、项目记忆文件与项目规则文件全部由 `memory_system` 实现，插件只做三件事：

1. 把记忆锚点（全局规模/时间 + **本项目记忆与规则**）注入系统提示词；
2. 在回合结束、会话结束时驱动**一份覆盖全部项目的全局工作摘要**；
3. 在设置页提供「记忆」入口，用来调参、看摘要、改画像、编辑条目、备份恢复。

两者之间通过子进程 + 行分隔 JSON 协议通信（`memory_system.bridge`），因此 Python 侧可以脱离 DSH 单独测试。

## 模型可用的 13 个工具

13 个工具 = 7 个 `memory_*` 记忆工具 + 1 个 `rule_add` 规则工具 + 5 个 `skill_*` 技能工具。

| 工具 | 作用 |
| --- | --- |
| `memory_recall` / `memory_search` / `memory_add` / `memory_forget` | 记忆的读、写、归档 |
| `memory_profile_read` / `memory_digest_read` / `memory_digest_generate` | 画像与全局摘要 |
| `rule_add` | 把用户对项目的约定、规则写成 `<repo>/.agents/rules/<name>.md`（kebab-case 文件名 + frontmatter；同名不覆盖，规则不进记忆库与摘要） |
| `skill_create` | 把验证过的做法写成技能文件：默认本项目 `.agents/skills/<name>/SKILL.md`；`scope=global` 写 `~/.agents/skills/<name>/SKILL.md`——全局必须先用 `ask_user_question`（问题 id `dsh-memory:skill-scope`、选项 id `global`）取得用户答复，宿主读到该答复才放行；`user_approved` 已从模型可见参数中移除，模型无法自我声明同意 |
| `skill_list` / `skill_get` | 列出 / 读取技能（项目技能与全局技能都在磁盘，`skill_list` 合并两处） |
| `skill_run` / `skill_retire` | 记录执行结果（写 `<memoryHome>/l4_runs` 台账）/ 退役（目录移进 `.retired/`；退役全局技能同样需要用户同意） |

## 系统提示词里的两处内容

| Section | order | 内容 | 开关 |
| --- | --- | --- | --- |
| `dsh-memory:instruction` | `1` | 用户自己写的**系统指令**原文，`interpolate: false`（`{{…}}` 保持字面） | 设置页开关（`config.systemPromptAnchor` 无关） |
| `dsh-memory:anchor` | `9500` | 记忆锚点：摘要规模/时间、用户画像规模、本项目 `.agents/memory/MEMORY.md` 摘录与 `.agents/rules/*.md`、工具使用规则 | `systemPromptAnchor` |

系统指令放在最前面（`1`，紧跟 `dsh-system-prompt` 保留给部署人格前缀的 `0`），因为它是用户自己的文字，读起来就是人格的一部分，而不是记忆条目。空文本或开关关闭时该 section 渲染成 `''`，`renderPrompt` 会丢弃空 section——所以没写指令的用户一分 token 都不付。

锚点里的**项目上下文**在会话首次装配时通过桥接 `project.context` 读取，按 `cwd` 缓存 15 秒：`.agents/memory/MEMORY.md` 的最新工作行（≤1200 字）与 `.agents/rules/*.md` 的全部规则（≤2400 字 / 12 条，按文件名排序以保证稳定、利于前缀缓存）；记忆文件缺失时退回该项目最新的 L2 工作条目（≤8 条）。提示词只放摘录，完整历史从文件读、完整规则从 `.agents/rules/` 读。

技能分两处存，都是文件：**项目技能**在仓库 `.agents/skills`（DSH 自己的技能目录会列出它，并用原生 `skill` 工具加载），**全局技能**在 `~/.agents/skills`（所有项目共享，可用 `DSH_MEMORY_GLOBAL_SKILLS` 覆盖）。`org` / `sys` 数据库作用域已移除；全局技能的创建与退役是用户决策，模型必须先征得同意。每次成功创建还会在记忆库留一条 L2 审计记录，但技能定义本身只在 `SKILL.md` 里。

## 设置页功能

设置 → 记忆：

| 区块 | 作用 |
| --- | --- |
| 记忆库 | 连接状态、当前项目 id、条目数、存储位置、检索后端 |
| 记忆摘要长度 | 滑块，档位 `300 / 500 / 800 / 1000 / 1500 / 2000 / 3000` 字。预算只决定模型写多详细：预算大就展开细节，预算小就写结论，**不再截断输出**；自动生成固定空闲时运行 |
| 用户画像 | 直接编辑并保存；系统提示词会告诉模型"需要时可以查看用户画像" |
| 系统指令 | 一段常驻系统提示词的长期指令，作用类似 `soul.md`：人格、语气、固定规则、必须遵守的偏好。顶部开关决定是否注入；**关闭只停止注入，文本仍保留**，重新打开立即恢复。上限 4000 字，独立于记忆锚点的开关 |
| 全局记忆摘要 | **生成**（调用模型）、**查看全文**（弹窗）、历史版本。摘要覆盖所有项目，只记录已做过的工作，不记录经验教训与偏好 |
| 记忆条目 | **记忆查看与编辑**：列出、搜索、改内容/重要度/类型/标签、归档与恢复 |
| 备份与恢复 | 导出 Markdown；从 Markdown 预览并恢复 |

除全局摘要外，`memory_system` 还会自动维护每个项目的两处文件：`.agents/memory/MEMORY.md`
按时间记录该项目做过的工作（派生视图，可随时重新生成），`.agents/rules/` 下一条规则一份
markdown 记录用户对项目的约定。两者都会在会话首次装配系统提示词时自动注入。旧版仓库根目录的
`DSH_MEMORY.md` 会迁移到 `.agents/memory/MEMORY.md` 后删除（只处理带 `<!-- dsh-memory:project-summary -->`
标记的生成文件，用户手写的不动）。

## 安装

仓库根就是组合包：根目录 `package.json` 声明 `dsh.bundle`，指向
`dsh-memory-plugin/cordis.patch.yml`。因此安装的 spec 是**仓库根**（Git 地址或本仓库目录），
不是 `dsh-memory-plugin` 子目录——子目录本身不声明组合包，DSH 会报「这个包没有声明组合包」。

```powershell
# 1. 确保 Python 能 import memory_system（插件默认把仓库根放进子进程 PYTHONPATH）
python -c "import sys; sys.path.insert(0, r'D:\Coding\dsh-memory'); import memory_system; print(memory_system.__file__)"

# 2a. 在 DSH 里安装：插件页「添加插件」，或
#     plugin_manager action=install_bundle target=D:\Coding\dsh-memory
# 2b. 或直接用 CLI（目录形式以 link: 记在 profile 里）：
dsh plugin --profile web add D:\Coding\dsh-memory
```

patch 里的模块名是相对路径（`./index.js`），所以仓库放在哪里都能被解析。

## 配置（`cordis.patch.yml` 中的 `dsh-memory` 行）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonPath` | `''` | 指定解释器；留空则依次尝试 `DSH_MEMORY_PYTHON`、`DSH_PYTHON`、`python` |
| `memorySystemRoot` | `''` | 含 `memory_system` 包的仓库根目录，会加入子进程 `PYTHONPATH`；留空则按插件自身位置推导（`bridge.js` 的上一级目录），不绑定某台机器 |
| `memoryHome` | `''` | 记忆库目录，留空为 `~/.dsh/memory`（或 `$DSH_HOME/memory`） |
| `projectOverride` | `''` | 固定项目 id，不再按会话工作目录推导 |
| `autoSummary` | `true` | 回合结束、空闲后自动生成全局摘要；常开，界面不提供开关。摘要是**读**记忆，不受写入路径影响。生成用的模型调用带宿主会话 id（`llm.stream({sessionId})`），因为按会话路由的提供方缺这个头会直接 400 |
| `autoSummaryDelayMs` | `15000` | 回合结束到生成摘要之间的空闲间隔 |
| `systemPromptAnchor` | `true` | 是否注入记忆锚点（含项目记忆摘录与项目规则）。系统指令是独立的 section，不受这个开关影响 |
| `heartbeatSteps` | `0` | 距上次 `memory_add` 经过多少个模型步（`step/start`，一次模型调用算一步）后，在系统提示词里出现一次记忆提醒，随后重新计数；`0` 关闭（默认）。提醒会改写常驻提示词，开启即意味着周期性前缀缓存失效 |
| `maintenanceIntervalMs` | `600000` | 每隔多久调用一次 `maintenance.run`（衰减/合并/社区/归档扫描/晋升）；任务按 `MaintenanceConfig` 的节奏自限，早到的 tick 只是一次空调用；`0` 关闭 |
| `sessionEndCheck` | `true` | 会话结束时调用一次模型，检查还有没有未写入的记忆 |
| `requestTimeoutMs` | `60000` | 单次桥接调用超时；超时会重启子进程，避免响应错位 |
| `embeddingPreset` | `''` | 传给 `MemoryConfig` 的向量化预设 |

## 记忆库位置

默认 `~/.dsh/memory/memory.db`，**跨项目共享**；项目通过会话工作目录（优先 `git remote`）推导为 `project_id`，
因此 `D:\Coding\dsh-memory` 与别的仓库各自拥有独立的记忆，却共用一个数据库文件。

## 桥接协议

子进程：`python -W ignore -m memory_system --serve`，stdin/stdout 每行一个 JSON。

```jsonc
// 请求
{"id": "h1", "command": "memory.recall", "payload": {"home": "...", "project_id": "...", "query": "..."}}
// 成功
{"id": "h1", "ok": true, "result": { ... }}
// 失败
{"id": "h1", "ok": false, "error": {"code": "validation", "message": "..."}}
```

每次请求可带 `home`、`db_path`、`embedding_preset`。stdio **强制 UTF-8**：Windows 旧控制台代码页（GBK）
曾把中文解码成乱码，`memory_system.__main__` 因此按字节读取并按 UTF-8 解码。

查看支持的命令：

```powershell
python -m memory_system --list
python -m memory_system status '{\"cwd\": \"D:\\\\Coding\\\\dsh-memory\"}'
```

### 项目记忆与规则相关命令

- `project.context`：请求 `{"cwd": "...", "memory_chars"?: 1200, "max_rules"?: 12, "rule_chars"?: 2400, "recent_limit"?: 8}`；返回当前项目的记忆摘录 `memory {path, exists, chars, updated, excerpt, truncated}`、规则列表 `rules [{name, title, description, path, chars, content}]`、`rules_dir`、`rules_truncated`，以及记忆文件缺失时的兜底 `recent [{summary}]`。插件在首次提示词装配时调用它，按 cwd 缓存 15 秒。
- `rule.write`：请求 `{"cwd": "...", "name": "kebab-case", "title": "...", "description": "...", "content": "..."}`，写 `<projectRoot>/.agents/rules/<name>.md`，返回 `{"path", "name", "project_id", "root_path"}`；同名文件已存在返回 `conflict`。

`status` 增加 `project_memory` / `project_rules`（当前项目记忆文件与规则目录的路径）；旧的 `project_summary` 仍然返回（现在同样指向 `.agents/memory/MEMORY.md`）。

## 模型调用

摘要由「宿主侧」调用模型：插件先 `digest.plan` 拿到材料与提示词，用会话当前使用的 provider/model 流式调用
`ctx.llm.stream`，再 `digest.commit` 原样落库。预算写在提示词里（预算越大要求越详细），
**提交时不再裁剪文本**。因此：

- 模型路由优先用会话最近用过的 provider/model；本进程还没有会话用过模型时（例如刚启动就打开设置页点「生成」），
  回退到 DSH 的默认模型（`agentDefaultModel` 的 `currentSelection()`，即新建 agent 会用的那一个）；
- 记忆库为空时不会硬编摘要，而是记录「还没有可总结的工作记录」；
- 自动生成与手动生成走同一条路径，只有 `reason` 不同；
- 每次提交还会刷新各项目的 `.agents/memory/MEMORY.md`；该文件由 L2 工作记录派生，失败不会影响摘要。

## 数据安全

- 记忆条目只做**软删除**（`archived`），随时可恢复；
- 恢复备份只新增条目，从不删除现有记忆；
- 记忆锚点只包含摘要规模、时间、用户画像规模、**本项目 `.agents/memory/MEMORY.md` 摘录（≤1200 字）与 `.agents/rules/*.md` 规则（≤2400 字 / 12 条）**与工具指引，**不含摘要正文**，全文通过工具按需读取；
- 全局摘要只记录“做过什么工作”，不写入经验教训与用户偏好；
- `.agents/memory/MEMORY.md` 是派生文件，只包含该项目的工作记录，可随时重新生成；`.agents/rules/` 下的规则是写下来的约定，进版本库；
- 会话结束检查存的是模型整理后的一句话摘要，不存模型输出全文或完整对话。
