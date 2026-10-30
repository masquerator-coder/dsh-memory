# DSH 记忆系统工作流（以实际代码为准）

> 分析对象：`D:\Coding\dsh-memory` 当前代码
> 文档日期：2026-10-26
> 结论来源：逐文件阅读代码 + 真实插件、真实 Python 子进程、临时 git 仓库的端到端会话模拟

---

## 0. 总体结构：两层进程，一个库

```
DSH 宿主进程（JS 插件）                     Python 子进程（memory_system）
──────────────────────────                 ─────────────────────────────
apply(ctx) 注册 12 个工具 / 锚点 / 事件 / 路由

系统提示词装配 ──digest.anchor────────────▶ 读 memory_digests + meta(用户画像)
memory_add ────memory.remember────────────▶ L2 事件 + L3 事实（同一事务）
                                              └─▶ 重写 <repo>/DSH_MEMORY.md
turn/end ──15s 防抖──▶ digest.plan ──▶ 宿主 llm.stream ──▶ digest.commit
session/disposed ──reviewSessionEnd───────▶ memory.remember(source=session-end)
设置页 HTTP /dsh-memory/* ────────────────▶ 同一 SQLite 的读写接口
```

关键点：

- 插件**不实现记忆逻辑**，只负责宿主侧的事情：工具 schema、提示词锚点、会话事件、摘要的模型调用、设置页路由（`dsh-memory-plugin/index.js:1-13`）。
- 所有读写通过 `python -W ignore -m memory_system --serve` 的 NDJSON 协议完成（`dsh-memory-plugin/bridge.js:432-439`）。
- 记忆库是**一个 SQLite 文件**，默认 `~/.dsh/memory/memory.db`，所有项目共用（`memory_system/bridge.py:171-178`、`memory_system/config.py:304-320`）。
- 项目不是显式传入的，而是由会话 `cwd` 推导：优先 git remote，其次路径（`memory_system/bridge.py:128-143`）。

---

## 1. 会话生命周期

### 1.1 会话开始：没有 “session start” 钩子

代码里**没有** `session/created` / `session/start` 处理器。插件加载时只做注册：

- 注册 12 个工具：7 个 `memory_*` 记忆工具，加 5 个 `skill_*` 项目技能工具（`index.js:21-36`）。
- 注册一个系统提示词 section：记忆锚点（`index.js:754-922`）。
- 注册 `session/event`、`session/disposed`、`agent/request` 处理器。
- 创建 `BridgeClient`，但**此时不启动子进程**；第一次真正调用时才 spawn（`bridge.js:198-242`）。

因此“会话开始”实际表现为两件事。

#### （1）第一次系统提示词装配

`systemPrompt.section.text(context)` 被同步调用，内部触发一次**异步** `digest.anchor`（`index.js:646-672`）：

- 锚点缓存按 `cwd` 分槽：`@@dsh-memory` 计数行与画像行是全局的，紧随其后的**本项目最近工作**按项目不同；
- 15 秒内复用旧文本（`ANCHOR_REFRESH_MS = 15_000`，`index.js:43`）；
- 第一次装配时缓存为空，所以模型看到的是规则 + 占位文本：
  `（还没有可用的记忆摘要。）`
- 计数行**只含摘要规模、时间、用户画像规模**，不含摘要正文（`summary.py:807-826`）；正文由 `{{recent_work}}` 单独提供：当前项目最新 `memory.list` 条目，最多 8 条、合计 ≤400 字（`RECENT_CHARS` / `RECENT_LIMIT`），超出时尾注指向 `memory_search`，没有记忆的项目整节省略。

锚点里的写入/读取职责说明只写工具定义装不下的部分——写入分四件事（不会自动保存、遇到什么值得记、一条一件事、什么不该存），召回分五件事（先用 `memory_recall`、换说法用 `memory_search`、摘要与 `DSH_MEMORY.md` 只记工程动作、画像只读、`memory_forget` 是软删除）；工具名与参数不在此重复（`index.js:1568` `ANCHOR_HEADER`）。技能的门槛、反例与存储位置写在 `skill_create` / `skill_retire` 的工具描述里，但锚点仍保留**一行无条件指引**（`**技能固化**`：可复用任务→先 `skill_list`→无同类则 `skill_create` 存本项目；只存已验证的）：早先把技能规则完全留在 schema 里时，模型每回合只被提醒写记忆、从不被提醒固化技能，项目连续多天零技能创建、全局技能零创建；这一行是使触发率从 0 变非零的最小代价。

#### （2）第一次工具调用才注册项目

`memory_recall` / `memory_add` / `memory_search` 都会先 `requireProject` → `projectFor(cwd)` → bridge 的 `projects` 命令（`index.js:234-242`、`tools.js:179-184`、`bridge.py:372-393`）。

`projects` 命令会：

1. 从 `.git/config` 读 remote（向上最多 6 层），slug 化成 project id；
2. `ensure_project` 写入/更新 `projects` 表；
3. 找到 git 顶层作为 `root_path`（向上最多 12 层）；
4. **立即生成该项目的 `DSH_MEMORY.md`**（`bridge.py:379-381`）。

> 实测：`https://github.com/acme/demo-repo.git` → 项目 id `acme-demo-repo`，并在仓库根创建了 `DSH_MEMORY.md`。

### 1.2 一轮对话中的读取

模型侧有五个读入口：

| 入口 | 触发方式 | 实际行为 |
|---|---|---|
| 系统提示词锚点 | 每次提示词装配 | 15 秒节流的规模/时间信息 + 本项目最近 ≤400 字的工作条目，不含摘要正文 |
| `memory_recall` | 模型主动调用 | 按问题做 L2+L3 混合检索 |
| `memory_search` | 模型主动调用 | SQL 列表/筛选，不按相关度排序 |
| `memory_digest_read` | 模型主动调用 | 读全局摘要全文 |
| `memory_profile_read` | 模型主动调用 | 读用户自行维护的画像 |

另外，项目根目录的 `DSH_MEMORY.md` 是给人和 Agent 直接打开的文件，不是工具返回值，也不会自动注入提示词。

#### `memory_recall` 内部

`tools.js:186-207` → bridge `memory.recall`（`bridge.py:627-642`）→ `MemorySystem.recall` → `Retriever.search`（`retrieval.py:232-309`）：

1. **路由**：纯启发式，`point / relational / global / temporal`；relational/global 走 deep，fast 路径命中少于 3 条也补 deep（`retrieval.py:176-202, 274-289`）。
2. **L2 必跑**：向量 kNN + FTS5 词法命中，按 `similarity * (0.2 + 0.8 * retention)` 重排（`l2.py:392-507`）。
3. **L3 快路径**：实体向量/词法种子 → 有界多跳扩展 → 路径打分（`retrieval.py:312-377`）。
4. **L3 深路径**：Personalized PageRank、社区摘要、确定性重写。
5. **RRF 融合**：快路径权重 1.0，深路径 0.8（`retrieval.py:292-297, 767-785`）。
6. **预算裁剪**：默认 2000 tokens，优先裁 L2（`retrieval.py:743-756`）。
7. **返回即强化**：被返回的 L2 条目 `access_count + 1`、`last_access` 刷新（`l2.py:497-507`、`l2.py:287-324`）。

#### `memory_search` 与 `memory_recall` 的差别

`memory_search` 走 `MemoryNotepad.list`（`summary.py:1006-1048`）：

- 按 `created_at DESC` 列出，不做相关性排序；
- 默认 `state != 'archived'`，可显式查 `archived`；
- 每条的 `retention` 是**实时计算**的，但筛选用的是缓存的 `state` 列。

因此会出现：**已被衰减到检索不到、但在列表里仍显示 active** 的条目。这是设计上的两套视图，不是 bug。

### 1.3 一轮对话中的写入

#### 唯一由模型触发的写入：`memory_add`

`tools.js:240-286` → bridge `memory.remember`（`bridge.py:590-624`）→ `MemorySystem.remember`（`system.py:260-334`）。

一个事务内完成：

1. **L2 去重**：
   - `content_key` 相同；
   - `summary_hash` 相同；
   - 或向量相似度 ≥ `0.95`（`l2.py:749-807`）。
   命中则**不新增**，只强化原条目（`l2.py:236-248`）。
2. **写 L2 事件**：`l2_episodes` + `l2_fts` + `vec_l2`（`l2.py:249-285`）。
3. **写 L3 事实**（可选）：逐条 `add_fact`，失败返回 decision 而不是抛异常（`l3.py:512-701`）。
4. **事务提交后刷新项目摘要文件**（`bridge.py:623`）。

模型会看到每条事实的写入结果。实测：

- 合法事实 `dsh-memory --uses--> SQLite` 写入；
- 非法关系 `lives_in` 被拒绝，并提示只能使用内置词表；
- 同一条文本再写一次，返回**同一个** `memory_id`。

L3 写时校验顺序（`l3.py:512-619`）：

- 关系白名单（未知关系拒绝）；
- 置信度下限；
- 端点非空；
- 证据中的 episode 必须真实存在；
- 类型 domain/range；
- 完全重复则只强化；
- acyclic 关系环检测；
- 基数 `one` 的关系冲突按策略处理（默认 `evidence`）。

#### 人工写入：设置页

`/dsh-memory/memories` 支持 `update / forget / restore / get / list`（`index.js:953-978`）：

- 改摘要会**同时重算向量和 FTS body**（`summary.py:1080-1156`）；
- `forget` 是软删除：`state='archived'` + `meta.forgotten_at`，可恢复（`summary.py:1158-1189`）；
- 每次编辑都刷新 `DSH_MEMORY.md`。

#### 用户画像写入

只有设置页 `profile.write`，模型没有写画像的工具（`tools.js:306-317`、`bridge.py:442-454`）。

#### 备份恢复

`backup.restore` 只新增条目，不删除现有记忆（`bridge.py:958+`）。

### 1.4 空闲时：自动生成全局摘要

触发链：

`turn/end` → `scheduleAutoSummary(session)` → 15 秒防抖 → `generateDigest(reason='auto')`（`index.js:310-318, 264-277`）。

细节：

- 每个会话一个定时器；同一会话再次 `turn/end` 会**取消并重排**；
- 只有一份**全局摘要**，全局 in-flight 去重：自动任务遇到正在生成直接跳过，手动任务加入等待（`index.js:482-531`）；
- `digest.plan` 收集**所有项目**的 L2 工作记录：
  - 排除 `preference` / `user_message`（`summary.py:85, 330-374`）；
  - 排除已遗忘、已被替代；
  - 每项目最多 160 条；
  - 材料字符预算 = `target_chars * 8`，夹在 20k–200k；
- 宿主用**最近一次会话用过的模型路由**调用 `ctx.llm.stream`（`index.js:431-473`）；
- `digest.commit` 原样落库，不按预算截断，记录状态、字数、token、来源 memory id、reason、generator（`summary.py:599-649`）；
- 提交后刷新**所有注册项目**的 `DSH_MEMORY.md`（`summary.py:648`）。

实测结果：

- 只有 decision 进入材料，preference **没有**泄漏进摘要；
- 摘要记录 `scope=global`, `reason=auto`, `status=ok`, `119 字 / 53 tokens`；
- 15 秒后下一次提示词装配，锚点出现：
  `全局记忆摘要：119 字（约 53 tokens），生成于 2026-10-25 23:09`

> 注意：`ANCHOR_REFRESH_MS = 15s` 意味着摘要生成后的**前 15 秒内**，锚点仍是旧的；这是为了让提示词装配不阻塞在子进程上。

### 1.5 会话结束：最后一次补写

`session/disposed` → `reviewSessionEnd`（`index.js:335-380`）：

1. 解析项目；没有项目则退出；
2. 从 `snapshotEvents()` / `session.log` 提取**真实用户消息**（`source.kind === 'user'`）和助手消息，丢掉注入的合成消息与工具流量，保留尾部 8000 字符；
3. 少于 200 字符直接跳过；
4. 必须有 `ctx.llm` 和本进程记录过的模型路由；
5. 调用一次模型，要求输出 JSON：
   `{"memories":[{"summary":..., "event_type":..., "importance":...}]}`
6. 最多 10 条，摘要 4–600 字，类型白名单，importance 夹在 0–1；
7. 逐条走 bridge `memory.remember`，`source='dsh-session-end'`；
8. 失败只记 warning，绝不阻塞销毁（`index.js:375-380`）。

实测：第二会话销毁后，模型补写了一条 `fact`，`DSH_MEMORY.md` 随即多出这一行。

---

## 2. 触发时机总表

| 时机 | 触发者 | 动作 | 是否写库 |
|---|---|---|---|
| 插件加载 | DSH | 注册工具/锚点/事件/路由，不启动子进程 | 否 |
| 首次提示词装配 | 系统提示词 | `digest.anchor` + 本项目 `memory.list` 异步刷新，首屏为占位 | 否 |
| 首次工具调用 | 模型 | `projects` 注册项目 + 创建 `DSH_MEMORY.md` | 是（projects） |
| 模型判断值得记 | 模型 | `memory_add` → L2 + L3 原子写 | 是 |
| 检索 | 模型 | `memory_recall` → 融合排序 + 强化命中的行 | 是（access_count） |
| 审阅 | 模型/设置页 | `memory_search` / `memory.list`（设置页默认不按项目过滤；勾选状态由前端 `all_projects` 决定） | 否 |
| 用户要求遗忘 | 模型/设置页 | 软归档 + `forgotten_at` | 是 |
| 每 N 个 `step/start` | 插件 | 提示词尾部追加“记忆提醒” | 否 |
| `turn/end` | 插件 | 15 秒防抖后自动生成全局摘要 | 是（memory_digests） |
| `session/disposed` | 插件 | 一次模型补写检查 | 是（通常 0–N 条） |
| 设置页操作 | 用户 | 改配置/画像/条目/摘要/备份 | 是 |
| 提示词/锚点 | 插件 | 锚点缓存 15 秒 | 否 |

---

## 3. 记忆存储方式

### 3.1 文件布局

```
~/.dsh/memory/            # 可由 memoryHome / DSH_MEMORY_HOME / DSH_HOME 覆盖
├── memory.db             # 唯一主库（WAL 模式，运行时伴生 -wal / -shm）
└── exports/              # 超大备份才会落盘
<repo>/DSH_MEMORY.md      # 每个项目根目录的派生工作摘要
```

`DSH_MEMORY.md` 不是主存储，只是从 L2 事件派生的可读视图；不反馈进召回，也不进全局摘要材料（`summary.py:829-867`）。

### 3.2 主要表

实测该库中包含：

- 基础：`meta`、`projects`、`events`、`anchors`
- L2：`l2_episodes`、`l2_fts`（FTS5）、`vec_l2`（sqlite-vec `vec0`）
- L3：`l3_entities`、`l3_edges`、`l3_changes`、`l3_change_sources`、`l3_communities`、`l3_entities_fts`、`vec_l3_entity`
- L4：`l4_skills`（仅程序化 API 与旧库迁移使用）、`l4_runs`、`l4_trajectories`、`l4_candidates`、`l4_archive`、`l4_promotions`、`vec_l4_skill`、`vec_l4_archive`。**模型生成的技能不在这几张表里**：项目技能是 `<项目根>/.agents/skills/<name>/SKILL.md`，全局技能是 `~/.agents/skills/<name>/SKILL.md`，执行记录在 `<memoryHome>/l4_runs/<项目>/<name>.jsonl`；每次创建只留一条 L2 审计记录。
- 摘要：`memory_digests`

`meta` 中保存：

- `schema_version`
- `embedding_dim`、`embedding_fingerprint`
- `memory.summary.length`、`memory.summary.auto`、`memory.summary.updated_at`
- `memory.user_profile`、`memory.user_profile.updated_at`
- 条目标签 blob、维护任务时间戳、会话采集去重键

实测：`embedding_fingerprint = hash:256:True`，并存在 `vec_l2` 等 sqlite-vec 虚表；没有 sqlite-vec 时会自动退化为普通表精确扫描（`vectors.py:1-20, 93-99`）。

### 3.3 一条记忆的实际字段

以实测的 decision 为例：

- `memory_id = ep_690a...`
- `project_id = acme-demo-repo`
- `event_type = decision`
- `importance = 0.85`
- `state = active`
- `access_count = 2`（一次重复写合并 + 一次召回）
- `session_key = sess-1`
- `meta.source = dsh-tool`
- FTS body 是**预先分词**的：`dsh memory 全局 摘要 改为 ... decision`
- 图谱中对应一条边：`uses`，`meta.episode_ids` 指回这条 L2。

---

## 4. 衰减与后台维护

L2 的公式（`l2.py:1-23, 193-213`）：

```
S = 24h * importance * (1 + 0.5 * ln(1 + access_count))
R = exp(-Δt / S)
score = similarity * (0.2 + 0.8 * R)
```

状态阈值：

- `R >= 0.30` → active
- `0.05 <= R < 0.30` → dormant
- `R < 0.05` → archived

关键事实：

- **检索时实时计算 R**，所以衰减立即影响召回排序与过滤；
- `state` 列只是缓存，由 `refresh_states()` 批量刷新（`l2.py:335-367`）；
- 插件每 `maintenanceIntervalMs`（默认 10 分钟）调用一次桥接命令 `maintenance.run`，Python 侧按 `MaintenanceConfig` 的间隔（decay/consolidate/promotions 1h、communities 6h、archive_scan 24h）决定这次真正跑哪些任务（`maintenance.py:90-161`）。所以 `state` 列现在会自动跟上，早到的 tick 只是一次空调用。
- 召回默认只返回 active，所以长时间不访问的记忆会从默认 recall 消失；但 `DSH_MEMORY.md` 与全局摘要的取材**不看衰减状态**，只排除遗忘/替代项，因此工作记录仍会保留。

---

## 4.5 L4 程序性记忆：项目技能与全局技能都是文件

### 4.5.1 分工

| 环节 | 谁做 | 位置 |
|---|---|---|
| 告诉模型「什么时候值得存」 | 工具描述（`skill_create` schema） | `tools.js:390-482` |
| 展示**全局**技能 | **DSH 自己的技能目录**扫 `~/.agents/skills`，与项目技能一起出现在 `available_skills` | DSH 侧，不在本仓库 |
| 展示**项目**技能 | **DSH 自己的 `skill-filesystem` 提供者**扫 `<项目根>/.agents/skills`（rank 200）与 `.dsh/skills`（rank 100） | DSH 侧，不在本仓库 |
| 保存 / 查看 / 记录执行 / 退役 | 模型调用 `skill_*` 工具 | `tools.js:390-560` |
| 落盘、退役、台账 | Python 核心 | `project_skills.py`（`create` / `discover` / `retire` / `append_run`）、`bridge.py:744-1010` |

**为什么技能不写库**：`.agents/skills/<name>/SKILL.md` 是跨工具的约定目录，DSH 会把它变成会话技能（`available_skills` + `skill` 工具），人和别的工具读同一个文件，技能随仓库进版本库。全局技能同理，放在 `~/.agents/skills`，所有项目共享。写进数据库意味着模型必须专门调工具才能看到，且换一个 harness 就失传。

**为什么提示词不再列技能索引**：项目技能与全局技能都已经由 DSH 技能目录进入 `available_skills`，插件再列一遍会让同一个技能出现两次，既费 token 又让模型以为是两个技能；技能的使用与创建方式也已写在 `skill_*` 工具描述里。

### 4.5.2 写入门槛（防噪音）

写入门槛写在 `skill_create` 的工具描述里，只列「必须同时满足」的正面条件，没有分值、没有阈值：本次任务里**真的执行过并验证成功**、
同类任务大概率会再来、步骤是具体动作与顺序、`skill_list` 里没有同类技能。同时列出反例
（一次性任务、临时调试、能从代码读到的内容、用户偏好、未验证的做法）。

会话节奏也由工具描述约束（「一个会话最多新建 1 个」），插件不再维护内存计数或改写提示词。

第三道闸在写入路径（`project_skills.create`）：

1. **名字合法**：`name` 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`——DSH 对别的拼写是静默丢弃，
   所以在写盘前就报 `ValidationError`，并把中文留在 `title` / `description` 里；
2. **不覆盖**：同名目录已存在直接拒绝（`先 skill_get 看它，确需替换先 skill_retire`）；
3. **不淘汰**：active 技能达到 `DEFAULT_LIMIT`（24）时
   拒绝写入，而不是悄悄退役一个；
4. **作用域**：默认 `scope=project`；写全局必须显式 `scope=global`。桥接层对 `org` / `sys` 直接报
   `bad_request`。全局写入的同意由**宿主签字**，不再由模型自述：`skill_create` / `skill_retire`
   的模型可见参数里没有任何"我同意了"字段，模型必须先调用 `ask_user_question`
   （问题 id `dsh-memory:skill-scope`，选项 id `global`），宿主在 `session/event` 的 `tool/result`
   里读到这次真实答复才给桥接传 `host_approved=true`；授权一次性、10 分钟内有效，写完即作废，
   超时（`pending`）或报错的答复不算同意。`bridge.py` 只认 `host_approved`——它代表**宿主已取得
   用户同意**，是存储层对"模型直接调桥接"的底线；直接调桥接的 CLI/脚本可自行置位（人跑命令
   本身就是同意的主体）。模型侧的门在 `dsh-memory-plugin/tools.js`。

写盘是原子的：先写 `SKILL.md.tmp`，再 `os.replace`；失败会清掉刚创建的空目录，不留半成品。
每次成功创建还会写一条 L2 审计记录（`content_key=skill:<scope>:<name>`）。

### 4.5.3 披露与生命周期

- **项目技能**：完整定义就是文件正文，`skill_get` 直接返回它，DSH 的 `skill` 工具也一样；
  `skill_list` 给出标题、描述、触发词与步骤数（`step_count` 从正文的 `## 步骤` 数出来）。
- **全局技能**：与项目技能一样由 DSH 技能目录列出，`skill_list` 也合并两处；完整定义走 `skill_get`；
  同样是文件，没有 Hot/Warm/Cold 分层。
- **退役**：把目录移进对应根下的 `.retired/<name>/`（DSH 的一层扫描看不见它，文件还在，挪回来就恢复）。
  项目技能退到 `<项目根>/.agents/skills/.retired`，全局技能退到 `~/.agents/skills/.retired`；
  退役全局技能同样需要用户同意（走同一个 `dsh-memory:skill-scope` 问题）。
- **执行证据**：追加到 `<memoryHome>/l4_runs/<项目>/<name>.jsonl`（**不进仓库**，
  否则 `git status` 会被日志污染）；全局技能记在保留作用域 `_global` 下。`skill_run` 返回滚动窗口内的成功率。
- **旧数据迁移**：`migrate.export_project_skills` 把库里遗留的 project 行写成 bundle，
  把 `l4_runs` 里的历史执行记录搬进台账，**最后**才删行 + FTS + 向量——顺序反了就会丢记录。
  没有给名字的行会带 reason 留在库里，不会被猜一个名字改掉。旧的 `org` / `sys` 行不再被桥接命令读取；
  升级时可手动把需要的技能重建为 `~/.agents/skills` 下的文件，再删除旧行。
- 技能**定义**不进入 L2 / L3 / 摘要：`memory_search`、`memory_recall`、全局摘要与 Markdown 导出都不含技能定义；
  创建动作的 L2 审计记录只回答“何时、从哪个项目、存到哪个文件”。

---

## 5. 实测验证

### 5.1 环境

- 仓库代码未改；
- 真实插件 `dsh-memory-plugin/index.js`；
- 真实子进程 `python -m memory_system --serve`；
- 伪造宿主只提供：服务容器、系统提示词 section、工具注册、会话事件、流式 LLM；
- 临时 git 仓库 remote：`https://github.com/acme/demo-repo.git`；
- 临时记忆库：`%TEMP%\dsh-mem-sim\run\memory-home\memory.db`。

### 5.2 结果

| 步骤 | 实测 |
|---|---|
| 插件装载 | 注册 12 个工具，名称与 `TOOL_NAMES` 完全一致；未启动 Python |
| 首屏装配 | 显示规则 + `（还没有可用的记忆摘要。）`，确认首屏异步未回 |
| 首次 `memory_recall` | 空库返回“没有检索到相关记忆”；同时注册项目 `acme-demo-repo`，创建 `DSH_MEMORY.md` |
| `memory_add` 带 2 条事实 | 写入 `ep_690a...`；`uses` 成功，`lives_in` 被 `unknown_relation` 拒绝，并提示合法关系表 |
| 重复写同一条 | 返回同一个 `memory_id`，未新增行 |
| 心跳 | 2 个 `step/start` 后出现“距上次调用 memory_add 已过 2 个模型步” |
| 写入 preference | 成功，但**没有**进入摘要材料，也**没有**进入 `DSH_MEMORY.md` |
| `turn/end` + 400ms | 自动摘要 `status=ok, scope=global, reason=auto, 119 字 / 53 tokens` |
| 15 秒后装配 | 锚点出现摘要规模/时间；15 秒内仍是旧占位 |
| 第二会话召回 | 返回 decision 事件 + `dsh-memory --uses--> SQLite` 事实 |
| `session/disposed` | 触发补写，新增 `fact`，来源 `dsh-session-end`，项目文件同步更新 |
| `memory_forget` | recall 立刻检索不到；`memory.restore` 后又能检索到 |
| 数据库统计 | 1 个项目、3 条 L2、2 个实体、1 条边、1 份摘要；存在 `l2_fts` 与 `vec_l2` |
| 回归测试 | `pytest` 204 项全部通过 |

### 5.3 一个重要的实测现象

旧版本自动摘要生成成功后，下一次提示词装配仍显示旧占位，必须等 15 秒缓存过期、并且装配两次才会看到摘要行（`ANCHOR_REFRESH_MS` 与异步刷新的直接结果）。现在摘要 `commit`、画像保存与摘要删除都会立刻重读锚点，下一次装配即生效；冷启动的首个装配显示「正在读取记忆摘要…」，读完后替换，不再把「还没读到」说成「没有摘要」。

### 5.4 复现方式

最小复现可以直接走 bridge（不需要 DSH）：

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONPATH = 'D:\Coding\dsh-memory'

# 查看命令表
python -m memory_system --list

# 注册项目（cwd 指向任意 git 仓库）
python -m memory_system projects '{\"home\":\"C:\\\\temp\\\\mem\",\"cwd\":\"D:\\\\Coding\\\\dsh-memory\"}'

# 写入
python -m memory_system memory.remember '{\"home\":\"C:\\\\temp\\\\mem\",\"cwd\":\"D:\\\\Coding\\\\dsh-memory\",\"summary\":\"测试一条记忆\",\"event_type\":\"note\"}'

# 检索
python -m memory_system memory.recall '{\"home\":\"C:\\\\temp\\\\mem\",\"cwd\":\"D:\\\\Coding\\\\dsh-memory\",\"query\":\"测试\"}'
```

完整插件级模拟（伪造 ctx + 真实 `index.js` + 真实 Python 子进程）使用的临时脚本：

- `%TEMP%\dsh-mem-sim\simulate.mjs`
- `%TEMP%\dsh-mem-sim\readside.py`
- `%TEMP%\dsh-mem-sim\inspect_db.py`

---

## 6. 代码与文档/配置不一致处

这些是读代码时确认的，不是推测：

1. ~~**`captureTurns` 是死配置**~~（已删）
   `index.js` 曾定义 `captureTurns` 却从未读取；现已从默认值、`cordis.patch.yml` 与 README 移除，旧配置里残留的该键会被 `resolveConfig` 静默忽略。`memory.capture` 桥接命令仍然存在且有测试——它留给需要自动采集的宿主，不是死代码。

2. **会话开始时没有自动读取 `DSH_MEMORY.md`**
   `AGENTS.md` 要求新会话先读该文件，但代码只把它当作普通文件放在仓库根；插件不会自动注入其内容。模型需要自己打开文件，或通过 `memory_recall` 检索。

3. ~~心跳按 `turn/start` 计数，不是按模型 step~~（已修）
   代码曾监听 `turn/start`，而提示词写的是“已过 N 个回合”，于是一个跑 30 次工具调用的长回合只算 1 步，提醒在最该出现时沉默。现在改听 `step/start`（`index.js` 心跳 section），文案随之改为“个模型步”。回归检查：`node dsh-memory-plugin/selfcheck.js`。

4. **L4：项目技能与全局技能都是文件**
   Python 侧原本就有完整的 skills / trajectories / governance，插件现在通过桥接命令
   `skill.index` / `skill.list` / `skill.create` / `skill.get` / `skill.run` / `skill.retire`
   接入的是：**项目技能写进 `<项目根>/.agents/skills/<name>/SKILL.md`**（DSH 自己的
   `skill-filesystem` 提供者扫描它、模型用原生 `skill` 工具加载），**全局技能写进 `~/.agents/skills`**，
   由 DSH 技能目录列出（`available_skills`），创建/退役全局技能要求用户明确同意：宿主先从
   `ask_user_question`（问题 id `dsh-memory:skill-scope`）取得真实答复，才给桥接传 `host_approved=true`。
   桥接层不再读写 `l4_skills` 的全局行。轨迹归纳（`prepare_turn` / `capture_trajectory`）、备份归档
   （`SkillArchive`）与晋升仍未接入；`memory_system/adapters/dsh.py` 仍是接口桩。
   `promotions` 的两个扫描器读的是库里的 project 行，因此模型写入文件后通常为空
   （`maintenance` 返回带 `note`）。

5. ~~**后台维护没有调度者**~~（已修）
   `Maintenance` 仍是“宿主 tick 驱动”，但插件现在自己就是那个 tick：每 `maintenanceIntervalMs` 调一次 `maintenance.run`，任务按各自的间隔自限（见 4.4 关键事实）。`decay` 会刷新 `state` 列，列表与召回不再长期互相矛盾；召回仍实时计算 R。

6. **摘要的模型调用必须带会话 id**
   宿主 `llm.stream` 的 `sessionId` 会被提供方用来按会话路由（例如 `opencode-go` 用 `x-opencode-session` 头，缺了直接 400 `MissingSessionID`）。插件把正在生成摘要的会话 id 传下去；设置页手动生成没有会话上下文，退回本进程最近一次见到的会话 id（`hostSessionId()`）。没有这个字段时，摘要行会以 `status=error` 落库，而 `latest()` 与锚点继续显示上一份成功摘要。

7. **失败/空摘要不推进“摘要已更新”时间戳**
   `summary.commit` 只在 `status == "ok"` 时写 `meta.memory.summary.updated_at`；此前失败提交也会盖时间戳，使 `/health` 与设置接口报告的更新时间新于实际内容。错误行本身仍保留在历史里，供 `digest.history` 与 `/health` 判断最近一次尝试是否失败。

8. **摘要只有全局一份**
   `SCOPES = ("global",)`；`project` 仅作为历史兼容值存在（`summary.py:72-76`）。项目级内容改由 `DSH_MEMORY.md` 承载。

9. **`status.home` 实际是数据库文件路径**
   `bridge.py:359` 返回 `str(memory.config.db_path)`，不是目录。

---

## 7. 关键代码索引

| 关注点 | 位置 |
|---|---|
| 插件默认配置 / 工具清单 | `dsh-memory-plugin/index.js:21-74` |
| 锚点注入与 15 秒缓存 | `dsh-memory-plugin/index.js:847-1085` |
| 心跳计数与提醒 | `dsh-memory-plugin/index.js:1040-1085` |
| 自动摘要防抖 / 去重 | `dsh-memory-plugin/index.js:279-302, 690-820` |
| 会话结束补写 | `dsh-memory-plugin/index.js:443-490` |
| 后台维护 tick | `dsh-memory-plugin/index.js:304-344` |
| 12 个工具的 schema 与执行 | `dsh-memory-plugin/tools.js:200-540` |
| 子进程传输 / 超时摘除 | `dsh-memory-plugin/bridge.js:128-423` |
| 项目 id / 根目录解析 | `memory_system/bridge.py:86-165` |
| SQLite 复用（serve 模式） | `memory_system/bridge.py:202-262` |
| bridge 命令表 | `memory_system/bridge.py:323-760` |
| L4 技能桥接命令 | `memory_system/bridge.py:784-918` |
| 模型写技能（去重 + 上限） | `memory_system/system.py:467-529` |
| 原子写入 L2+L3 | `memory_system/system.py:260-334` |
| L2 去重 / 衰减 / 检索 | `memory_system/l2.py:193-507, 749-807` |
| L3 写时校验 | `memory_system/l3.py:512-701` |
| 查询路由 / 融合 / 预算 | `memory_system/retrieval.py:176-309, 743-785` |
| 摘要计划 / 提交 / 锚点 | `memory_system/summary.py:330-649, 761-816` |
| `DSH_MEMORY.md` 生成 | `memory_system/summary.py:829-910` |
| 条目编辑 / 遗忘 / 恢复 | `memory_system/summary.py:960-1189` |
| 库表结构 | `memory_system/storage.py:29-356` |
| 向量后端选择 | `memory_system/vectors.py:37-120` |
| 配置默认值 | `memory_system/config.py:102-138, 274-302` |

---

## 8. 一句话总结

**DSH 会话期间，记忆系统不会自动抄录对话**：系统提示词只注入“规模/时间”锚点；技能不再由插件注入索引，而是由 DSH 技能目录与 `skill_*` 工具描述提供；模型通过 `memory_add` 主动写入，经 L2 去重、L3 写时校验后原子落库，并同步派生 `DSH_MEMORY.md`；模型判断某个做法验证过且可复用时，用 `skill_create` 把它存成本项目技能（近似定义直接复用既有技能，达到上限则报错而不是淘汰），只有用户明确同意时才存成全局技能；技能定义留在 `.agents/skills` 文件里，记忆库只留一条创建审计记录；`memory_recall` 在读取时做 L2/L3 混合检索、RRF 融合并强化命中项；`turn/end` 后 15 秒生成一份跨项目的全局摘要；会话销毁时再用一次模型调用补漏。记忆数据最终都在一个 SQLite 文件里，技能则跟随各自的技能目录（项目内或 `~/.agents/skills`），衰减只在检索时实时生效，后台维护需要宿主另行驱动。
