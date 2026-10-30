# DSH 记忆系统

面向 Agent 的分层长期记忆，由两部分组成：

| 部分 | 位置 | 职责 |
|---|---|---|
| Python 核心 | `memory_system/` | 存储、衰减、检索、图谱校验、摘要、画像、备份、L4（项目技能与全局技能都是文件）。单文件 SQLite，无必需第三方依赖 |
| DSH 插件 | `dsh-memory-plugin/` | 把核心接入 DeepSeek Harness：12 个模型工具、系统提示词锚点、会话事件、摘要的模型调用、设置页路由 |

插件本身不实现记忆逻辑，所有读写都通过子进程 + 行分隔 JSON 协议交给 Python 核心。因此 Python 侧可以脱离 DSH 单独使用和测试。

```bash
pip install -e .            # 核心，仅标准库
pip install -e ".[vec,zh]"  # + sqlite-vec（向量索引）、jieba（中文分词）
```

要求 Python 3.10+。

## Python 核心快速开始

```python
from memory_system import MemorySystem, MemoryConfig

with MemorySystem(MemoryConfig.for_home("~/.dsh/memory")) as memory:
    memory.ensure_project("acme-web", org_id="acme")

    # 一次调用 = 一条情景记忆 + 它建立的事实，同一事务写入。
    memory.remember(
        project_id="acme-web",
        summary="billing-service 迁移到 eu-west-1；切换后发现重试次数过高",
        importance=0.85,
        event_type="decision",
        facts=[{"head": "billing-service", "relation": "located_in", "tail": "eu-west-1"}],
    )

    # 检索：自动路由、融合排序、按预算裁剪。
    result = memory.recall("billing-service 在哪个区域", project_id="acme-web")
    for fact in result.facts:
        print(fact.head.name, fact.edge.relation, fact.tail.name)

    # 这条信念从哪来？
    memory.explain(edge_id=result.facts[0].edge.edge_id)
```

> **关于向量化。** 默认的 `HashEmbedding` 无依赖、确定性，但纯粹是词法匹配：换个说法（“计费服务” vs `billing-service`）就匹配不上。需要真正的语义召回时，使用内置的 **Qwen3-Embedding-0.6B** 预设（1024 维，中英混排与代码表现好）：
>
> ```bash
> ollama pull qwen3-embedding:0.6b
> ```
>
> ```python
> config = MemoryConfig.for_home("~/.dsh/memory", embedding_preset="qwen3")
> memory = MemorySystem(config)   # 打开时探测端点
> ```
>
> 其他预设：`bge-m3`（1024）、`nomic-embed-text`（768）。任何 OpenAI 兼容服务（Ollama、vLLM、LM Studio、TEI）都可以，覆盖 `http_url` / `http_model` / `dim` 即可。
>
> **端点在启动时探测。** `on_unavailable` 决定端点不可用时的行为：`"warn"`（默认）照常打开并记录 `memory.probe`，`"raise"` 拒绝打开，`"fallback"` 降级为 hash 向量——但**只允许在空库上**，因为静默混用两个向量空间比直接失败更糟。
>
> 维度按库固定。需要换模型时用 `memory.change_embedding(provider, allow_redimension=True)` 重算全部向量。

## 接入 DSH

仓库根就是组合包：`package.json` 声明 `dsh.bundle`，指向 `dsh-memory-plugin/cordis.patch.yml`。安装目标是**仓库根**，不是 `dsh-memory-plugin` 子目录。

```powershell
# 确认 Python 能 import memory_system
python -c "import sys; sys.path.insert(0, r'D:\Coding\dsh-memory'); import memory_system; print(memory_system.__file__)"

# 安装（插件页「添加插件」，或 CLI）
dsh plugin --profile web add D:\Coding\dsh-memory
```

插件默认把仓库根加入子进程 `PYTHONPATH`，所以不强制 `pip install`；也可以设置 `memorySystemRoot` 显式指定。

### 会话中实际发生了什么

```text
DSH 宿主进程（JS 插件）                   Python 子进程（memory_system）
──────────────────────────               ─────────────────────────────
apply(ctx)：注册 12 个工具 / 锚点 / 事件 / 路由
系统提示词装配 ──digest.anchor──────────▶ 读摘要元信息 + 用户画像规模
memory_add ────memory.remember──────────▶ L2 事件 + L3 事实（同一事务）
                                            └─▶ 重写 <repo>/DSH_MEMORY.md
skill_create ──skill.create─────────────▶ <repo>/.agents/skills/<name>/SKILL.md
                                            或 ~/.agents/skills/<name>/SKILL.md（需用户同意）
turn/end ──15s 防抖──▶ digest.plan ──▶ 宿主 llm.stream ──▶ digest.commit
session/disposed ──reviewSessionEnd─────▶ memory.remember(source=dsh-session-end)
设置页 /dsh-memory/* ───────────────────▶ 同一 SQLite 的读写接口
```

1. **插件加载**：只注册工具、提示词 section（记忆锚点）、会话事件和设置页路由，**不启动子进程**。第一次真正调用工具时才 spawn。
2. **首次提示词装配**：异步请求 `digest.anchor` 与当前项目的 `memory.list`，按 `cwd` 缓存 15 秒。首次没有缓存，模型看到的是占位文本。锚点含摘要规模、时间、画像规模，以及**本项目最近 8 条以内、合计不超过 400 字的工作摘要**（`RECENT_CHARS`），**不含全文**；没有记忆的项目不出现这一节。技能的使用与创建方式由工具定义和 DSH 自带的技能目录提供，提示词不再另列索引。
3. **首次工具调用**：`memory_recall` / `memory_add` / `memory_search` / `skill_*` 会先解析项目。项目 id 优先来自 git remote（向上找 `.git/config`），否则由路径推导；随后注册项目并立即生成该项目的 `DSH_MEMORY.md`。
4. **读写**：模型通过 `memory_add` 主动写入记忆；通过 `memory_recall` / `memory_search` / `memory_digest_read` / `memory_profile_read` 读取。**当前版本不会自动抄录对话。**
5. **技能**：模型通过 `skill_create` 把**验证过、可复用**的做法写成技能文件——默认是**本项目仓库里的文件**（`.agents/skills/<name>/SKILL.md`），用户明确同意后也可写全局的 `~/.agents/skills/<name>/SKILL.md`。DSH 自己的技能目录会列出它们、用 `skill` 工具加载；`skill_list` / `skill_get` 查看，`skill_run` 记录执行结果，`skill_retire` 把目录移进 `.retired/`。见下文「L4 程序性技能」。
6. **心跳（默认关闭）**：自上次写入起每经过 `heartbeatSteps` 个**模型步**（`step/start`，一个模型步 = 一次模型调用）在提示词尾部出现一次记忆提醒，随后重新计数；`0` 关闭。提醒文本在系统提示词里，所以它每出现/消失一次都会让前缀缓存失效，默认关。
7. **回合结束**：`turn/end` 后等待 `autoSummaryDelayMs`（默认 15 秒）。同一会话再次结束会取消并重排定时器；全局摘要同时只允许一个生成任务。
8. **会话销毁**：若本会话有真实对话且有可用模型路由，再调用一次模型检查遗漏，最多补写 10 条，来源标记为 `dsh-session-end`；失败只记 warning，不阻塞销毁。

### 触发时机总表

| 时机 | 触发者 | 动作 | 写库 |
|---|---|---|---|
| 插件加载 | DSH | 注册工具 / 锚点 / 事件 / 路由 | 否 |
| 首次提示词装配 | 系统提示词 | 异步刷新锚点与本项目最近工作，首屏显示「正在读取记忆摘要…」 | 否 |
| 首次工具调用 | 模型 | 注册项目 + 创建 `DSH_MEMORY.md` | 是 |
| 模型判断值得记 | 模型 | `memory_add` → L2 + L3 原子写 | 是 |
| 模型判断做法可复用 | 模型 | `skill_create` → 写 `<repo>/.agents/skills/...`；用户同意后也可写 `~/.agents/skills/...` | 是（L2 审计记录） |
| 技能被真正用过 | 模型 | `skill_run` → `<memoryHome>/l4_runs/<项目>/<name>.jsonl` 执行记录与成功率（全局技能记在 `_global`） | 否（写台账） |
| 检索 | 模型 | `memory_recall` → 融合排序并强化命中项 | 是（`access_count`） |
| 审阅 | 模型 / 设置页 | `memory_search` / `memory.list` / `skill_list` | 否 |
| 用户要求遗忘 | 模型 / 设置页 | 软归档 + `forgotten_at`；技能退役是把目录移进 `.retired/` | 部分（技能只动文件） |
| 每 N 个 `step/start` | 插件 | 提示词追加记忆提醒 | 否 |
| `turn/end` | 插件 | 15 秒防抖后生成全局摘要 | 是（`memory_digests`） |
| 每 `maintenanceIntervalMs` | 插件 | `maintenance.run`：跑对到期的衰减 / 合并 / 社区 / 归档扫描 / 晋升 | 是（`state`、`l3_communities` 等） |
| `session/disposed` | 插件 | 一次模型补写检查 | 是（0–N 条） |
| 设置页操作 | 用户 | 改配置 / 画像 / 条目 / 摘要 / 备份 | 是 |

## 模型可用的 12 个工具

| 工具 | 作用 |
|---|---|
| `memory_recall` | 按问题做 L2+L3 混合检索，按相关度返回 |
| `memory_search` | 按关键词 / 状态 / 类型列出条目，按时间分页，不按相关度排序 |
| `memory_add` | 写入一条记忆，可附带结构化事实三元组 |
| `memory_forget` | 把条目软归档，可恢复 |
| `memory_profile_read` | 读取用户自己维护的画像 |
| `memory_digest_read` | 读取全局摘要全文 |
| `memory_digest_generate` | 调用一次模型，重新生成全局摘要 |
| `skill_create` | 把一个验证过的做法写成技能文件：默认本项目 `.agents/skills/<name>/SKILL.md`；`scope=global` 写 `~/.agents/skills/<name>/SKILL.md`——全局必须先用 `ask_user_question`（问题 id `dsh-memory:skill-scope`）取得用户答复，宿主读到答复才放行 |
| `skill_list` | 列出本项目可见的技能（磁盘上的项目技能 + `~/.agents/skills` 里的全局技能） |
| `skill_get` | 读取一个技能的完整定义（项目技能与全局技能都直接返回 `SKILL.md` 正文） |
| `skill_run` | 记录一次技能执行结果（写入 `<memoryHome>/l4_runs` 台账与成功率） |
| `skill_retire` | 退役一个技能（把目录移进同级 `.retired/`，可恢复；全局技能需要用户同意） |

没有“写画像”的工具：画像只能由用户在设置页编辑。

## 记忆如何组织

**L2 情景记忆。** 每条记忆都有重要度、访问次数和衰减后的保留率：

```text
S = 24h × importance × (1 + 0.5 × ln(1 + access_count))
R = exp(-Δt / S)
score = similarity × (0.2 + 0.8 × R)
```

`R ≥ 0.30` 为 active，`0.05 ≤ R < 0.30` 为 dormant，`R < 0.05` 为 archived。检索时**实时计算** R，因此衰减立即影响召回；`state` 列只是缓存。召回默认只返回 active，被返回的条目会刷新 `access_count` 和 `last_access`。记忆不会被物理删除。

**L3 语义图谱。** 每条事实在**写入时**校验：关系白名单（`causes` / `contradicts` / `depends_on` / `is_a` / `located_in` / `owns` / `part_of` / `related_to` / `uses` / `works_at`）、置信度下限、端点非空、证据中的 episode 必须存在、类型 domain/range、重复只强化、无环关系检测、基数冲突按策略处理。事实带两条时间轴（世界何时如此 vs 我们何时得知），并指回作为证据的 L2 条目。

**L4 程序性技能。** 项目技能和全局技能都是文件，区别只在目录：

- **项目技能 = 仓库里的文件**：`<项目根>/.agents/skills/<name>/SKILL.md`。这是 DSH 自己的技能目录（`project-agents`，rank 200；`.dsh/skills` 是 rank 100），所以**模型用原生 `skill` 工具加载它，人和别的工具读同一个文件**，技能随仓库进版本库。
- **全局技能 = 用户级文件**：`~/.agents/skills/<name>/SKILL.md`（可用 `DSH_MEMORY_GLOBAL_SKILLS` 覆盖，测试用）。所有项目共享，DSH 的原生技能目录同样会扫描它。创建全局技能是**用户决策**：模型必须先调用 `ask_user_question`（问题 id `dsh-memory:skill-scope`、选项 id `global`），宿主从会话的 `tool/result` 里读到这次真实答复才置 `host_approved` 放行；这个授权一次性、10 分钟内有效，模型无法自我声明。`org` / `sys` 两个数据库作用域已移除。

无论项目还是全局，成功创建后都会在记忆库留**一条 L2 记录**（`content_key=skill:<scope>:<name>`），回答“什么时候、从哪个项目存了这个技能”；技能定义本身只存在于 `SKILL.md`，库里不再有 `l4_skills` 行。会话里能做的是创建（`skill_create`）、查看（`skill_list` / `skill_get`）、记录执行（`skill_run`）、退役（`skill_retire`）。

技能不再由插件注入提示词索引：项目技能与全局技能都由 DSH 的技能目录列进 `available_skills`（一行一个，只有触发词与作用），执行前用原生 `skill` 工具或 `skill_get` 取完整定义。提示词里重复列一遍既费 token，也会让同一个技能看起来像两个。

`SKILL.md` 的 frontmatter 是给 DSH 解析的：`name`（kebab-case ASCII，同时是目录名）、`description`（进 `available_skills` 的那一行）、可选的 `whenToUse`；中文标题、触发词、前置工具、时间戳放在 `metadata` 里（DSH 原样保留、不解释）。

### 什么时候值得存一个技能

成本不在磁盘，而在于下一次模型会**读到并相信**一条错误的流程，所以门槛是「验证过且可复用」，不是「听起来合理」：

- 这套步骤在本次任务里**真的被执行过并验证成功**（不是设想、不是只读过代码）；
- 同类任务大概率会再来，步骤基本可复用；
- 步骤是具体动作与顺序，不是「仔细阅读代码」这类空话；
- `skill_list` 里没有同类技能。

反例（都不要存）：一次性任务、临时调试步骤、能从代码/文档直接读到的内容、用户偏好（属于 `memory_add`）、还没确认有效的做法。这些门槛与「一个会话最多新建 1 个」的节奏都写在 `skill_create` 的工具描述里，不再占用系统提示词。

项目技能和全局技能共用两道文件护栏（`memory_system/project_skills.py`）：

| 护栏 | 行为 |
|---|---|
| 名字合法 | `name` 必须是 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`——DSH 对别的拼写是**静默丢弃**，所以在写入前就报错 |
| 不覆盖、不淘汰 | 同名目录已存在直接拒绝（先 `skill_get` 看一眼，确需替换先 `skill_retire`）；active 技能达到上限（默认 24）拒绝写入，而不是悄悄退役一个 |

全局技能多一道同意护栏：模型创建或退役公共技能时，宿主必须先从 `ask_user_question` 拿到用户答复，才会给桥接传 `host_approved=true`；桥接只认这个标记，它代表**宿主已取得用户同意**，不代表模型自己声称同意。直接调桥接的 CLI/脚本可以自己置位（人跑命令本身就是同意的主体）。

写入是原子的（`SKILL.md.tmp` → `os.replace`），失败不留半成品目录。执行记录**不进仓库**：追加到 `<memoryHome>/l4_runs/<项目>/<name>.jsonl`，否则 `git status` 会被日志污染。

技能**定义**不进入 L2/L3/摘要：它们不在 `memory_search` / `memory_recall` / 全局摘要里，只在 DSH 的技能目录、`skill_list` 和文件本身。创建动作会留一条 L2 审计记录（何时、从哪个项目、存到哪个文件），但它不参与检索排序或摘要生成。

### 检索路径

`memory_recall` 是启发式路由，不调用模型：

1. 路由为 `point` / `relational` / `global` / `temporal`；后两者走 deep，fast 命中不足 3 条也补 deep。
2. L2 必跑：向量 kNN + FTS5 词法命中，按 `similarity × (0.2 + 0.8 × retention)` 重排。
3. L3 fast：实体种子 → 有界多跳扩展 → 路径打分。
4. L3 deep：Personalized PageRank、社区摘要、确定性重写。
5. RRF 融合：fast 权重 1.0，deep 0.8。
6. 默认 2000 token 预算，优先裁 L2。

`memory_search` 走列表接口：按 `created_at DESC`，默认排除 archived；`retention` 实时计算，但筛选用缓存的 `state`，所以可能出现“列表显示 active、实际已衰减到检索不到”的条目。这是两套视图，不是 bug。

## 存储

```text
~/.dsh/memory/            # 可由 memoryHome / DSH_MEMORY_HOME / DSH_HOME 覆盖
├── memory.db             # 唯一主库（WAL，运行时伴生 -wal / -shm）
└── exports/              # 超大备份落盘
<repo>/DSH_MEMORY.md      # 每个项目根目录的派生工作摘要
```

一个 SQLite 文件**跨项目共享**，项目靠 `project_id` 隔离。主要表：

- 基础：`meta`、`projects`、`events`、`anchors`
- L2：`l2_episodes`、`l2_fts`（FTS5）、`vec_l2`（sqlite-vec `vec0`）
- L3：`l3_entities`、`l3_edges`、`l3_changes`、`l3_change_sources`、`l3_communities`、`l3_entities_fts`、`vec_l3_entity`
- L4：`l4_skills`（仅程序化 API 与旧库迁移使用，模型生成路径不再写入）、`l4_runs`、`l4_trajectories`、`l4_candidates`、`l4_archive`、`l4_promotions` 及对应向量表（**模型生成的技能不在其中**：项目技能是 `<repo>/.agents/skills` 下的文件，全局技能是 `~/.agents/skills` 下的文件，执行记录在 `<memoryHome>/l4_runs`）
- 摘要：`memory_digests`

`meta` 保存 `schema_version`、`embedding_dim`、`embedding_fingerprint`、摘要长度、用户画像、维护时间戳等。实测默认指纹为 `hash:256:True`。没有 `sqlite-vec` 时自动退化为普通表精确扫描，功能完整、只是更慢。

`DSH_MEMORY.md` 不是主存储，只是从 L2 工作记录派生的可读视图（最多 300 条，原子替换）。它不会反馈进召回，也不进入全局摘要材料。

## 全局摘要与用户画像

- 只有**一份全局摘要**，覆盖所有项目；`project` 作用域仅为历史兼容保留。项目级内容由 `DSH_MEMORY.md` 承载。
- `digest.plan` 收集所有项目的 L2 工作记录，排除 `preference` / `user_message`、已遗忘和已被替代的条目；每个项目最多 160 条，材料预算随摘要长度档位变化。
- 摘要由**宿主侧模型**生成：插件先拿材料与提示词，用会话最近一次使用的 provider/model 调 `ctx.llm.stream`，再原样 `digest.commit`。提交时**不按预算截断**。
- 模型调用带宿主会话 id（`llm.stream({sessionId})`）：按会话路由的提供方（如 `opencode-go` 要求 `x-opencode-session`）缺这个头会直接 400。插件用本次会话的 id；设置页手动生成时退回到本进程最近一次见到的会话。
- 生成需要本进程记录过模型路由；库里没有可总结的工作记录时不会硬编摘要。自动生成与手动生成走同一条路径，只有 `reason` 不同。失败的尝试仍会留一条 `status=error` 的摘要行（`latest()` 会忽略它），但**不会**推进“摘要已更新”的时间戳。
- 每次提交后会刷新所有已注册项目的 `DSH_MEMORY.md`。

## 插件配置

在 `dsh-memory-plugin/cordis.patch.yml` 的 `dsh-memory` 行修改：

| 键 | 默认值 | 说明 |
|---|---|---|
| `pythonPath` | `''` | 指定解释器；留空依次尝试 `DSH_MEMORY_PYTHON`、`DSH_PYTHON`、`python` |
| `memorySystemRoot` | `''` | 含 `memory_system` 的仓库根，加入子进程 `PYTHONPATH`；留空按插件位置推导 |
| `memoryHome` | `''` | 记忆库目录；留空为 `~/.dsh/memory`（或 `$DSH_HOME/memory`） |
| `projectOverride` | `''` | 固定项目 id，不再按会话 cwd 推导 |
| `autoSummary` | `true` | 回合结束后自动生成全局摘要；设置页不提供开关 |
| `autoSummaryDelayMs` | `15000` | `turn/end` 到生成摘要之间的空闲间隔 |
| `systemPromptAnchor` | `true` | 是否注入记忆锚点。系统指令是独立 section，不受此开关影响 |
| `heartbeatSteps` | `0` | 距上次 `memory_add` 经过多少个模型步（`step/start`）后提醒一次（随后重新计数）；`0` 关闭。默认关闭，因为它会改写系统提示词、使前缀缓存失效 |
| `maintenanceIntervalMs` | `600000` | 每隔多久问一次 Python 侧“有到期的后台任务吗”。任务本身按 `MaintenanceConfig` 的节奏（1h/6h/24h）自限，早到的 tick 只是一次空转；`0` 关闭 |
| `sessionEndCheck` | `true` | 会话结束时调用一次模型检查遗漏 |
| `requestTimeoutMs` | `60000` | 单次桥接调用超时；超时会 `ping`，仍无响应则重启子进程 |
| `embeddingPreset` | `''` | 传给 `MemoryConfig` 的向量化预设；留空用库默认 |

## 桥接协议

```bash
python -W ignore -m memory_system --serve   # stdin/stdout 每行一个 JSON
python -m memory_system --list              # 查看支持的命令
```

```jsonc
// 请求
{"id": "h1", "command": "memory.recall", "payload": {"home": "...", "project_id": "...", "query": "..."}}
// 成功
{"id": "h1", "ok": true, "result": { ... }}
// 失败
{"id": "h1", "ok": false, "error": {"code": "validation", "message": "..."}}
```

每次请求可带 `home`、`db_path`、`embedding_preset`。stdio 强制 UTF-8：Windows 旧控制台代码页（GBK）曾把中文解码成乱码，因此 `memory_system.__main__` 按字节读取并按 UTF-8 解码。同一时刻只有一个请求在途；超时后先 `ping`，进程无响应才重启，避免响应错位。

## 设置页

Web profile 下注册 `/dsh-memory/*` 路由：

| 路由 | 作用 |
|---|---|
| `status` | 连接状态、当前项目 id、条目数、存储位置、检索后端 |
| `settings` | 摘要长度档位（300–3000 字） |
| `profile` | 读取 / 保存用户画像 |
| `instruction` | 读取 / 保存**系统指令**（常驻系统提示词的长期指令，类似 `soul.md`）与注入开关 |
| `digest` | 查看全文、手动生成、历史版本 |
| `memories` | 列出、搜索、编辑、归档、恢复条目 |
| `backup` | 导出 Markdown；从 Markdown 预览并恢复（只新增，不删除） |
| `health` | 健康检查：桥接延迟、最近一次摘要尝试（含失败原因）、到期维护任务。设置页本身不调用它，供运维/脚本用 |

修改记忆摘要会同时重算向量和 FTS body；`forget` 是软删除（`state='archived'` + `meta.forgotten_at`），可恢复；每次编辑都会刷新 `DSH_MEMORY.md`。

## 已知边界

这些是当前代码的实际行为，不是设计目标：

1. **没有“会话开始”钩子。** 不会自动读取或注入 `DSH_MEMORY.md`，也不会预加载项目记忆。`AGENTS.md` 里的“先读 `DSH_MEMORY.md`”需要模型自己执行。
2. **不自动采集对话。** 唯一由模型触发的写入是 `memory_add`；会话结束检查是额外补写。桥接层仍有 `memory.capture`（幂等、有测试），但插件不调用它——它留给需要自动采集的宿主，不是死代码。
3. **锚点有 15 秒缓存，但写入会主动失效。** 摘要生成、画像保存、摘要删除都会立刻重读锚点，下一次装配就能看到新值；普通会话仍按 15 秒 TTL 刷新。冷启动（进程刚起或插件刚重载）的首个装配显示「正在读取记忆摘要…」，读完即替换，不再声称「还没有摘要」。
4. **心跳按模型步计数，且只在默认关闭时无成本。** 监听 `step/start`（一次模型调用）：一个跑 30 次工具调用的长回合算 30 步。开启后每满一个窗口才出现一次并重新计数；关掉（`0`）则不进入提示词。
5. **后台维护由插件定时问、Python 侧自限。** 每 `maintenanceIntervalMs`（默认 10 分钟）调用一次 `maintenance.run`；`decay` / `consolidate` / `communities` / `archive_scan` / `promotions` 各自按 `MaintenanceConfig` 的间隔决定是否真的执行，所以早到的 tick 只是一次空转。关掉 tick 后 `state` 列会重新开始滞后——召回实时计算 R 仍然正确。技能都是文件，没有 Hot/Warm/Cold 分层。
6. **L4 的项目技能与全局技能都在文件里。** 项目技能写 `<repo>/.agents/skills`，全局技能写 `~/.agents/skills`；创建/退役全局技能需要用户明确同意。跨项目备份归档（`SkillArchive`）与轨迹归纳（`maturity`）仍需调用 Python API，插件没有暴露。`promotions` 的两个扫描器读的是库里的 project 行，因此模型写入文件后通常为空——`maintenance` 的 `promotions` 结果会带一句 `note` 说明这一点。
7. **`status.home` 返回数据库文件路径**，不是目录。
8. **几层“只有库 API、没有宿主接线”的能力。** `anchors`（L0 锚点）没有生产者，`l3_communities`、`l4_candidates`、`l4_promotions`、`l4_archive` 只在 `run_maintenance` 里写入——它们的读取路径在宿主侧（社区摘要、候选技能、晋升建议），目前恒为空。需要先有轨迹采集（`capture_trajectory`）或晋升决策入口，这些表才有内容。

更完整的逐行分析与实测记录见 [`docs/MEMORY_WORKFLOW.md`](docs/MEMORY_WORKFLOW.md)。

## 测试

```bash
pytest            # 278 项
```

## 文档

- [`docs/MEMORY_WORKFLOW.md`](docs/MEMORY_WORKFLOW.md) — 以实际代码为准的工作流、触发时机、存储格式、端到端会话模拟结果
- [`docs/DESIGN.md`](docs/DESIGN.md) — 架构、接口契约、与原始设计的分歧
- [`dsh-memory-plugin/README.md`](dsh-memory-plugin/README.md) — 插件安装与设置页细节
