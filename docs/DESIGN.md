# DSH Memory — 系统设计

本文档描述 `memory-system` 的架构、接口契约，以及**与原始设计方案不一致之处**。实现代码在 `memory_system/`，测试在 `tests/`（169 项，全部通过）。

> 目标 Agent 是 DeepSeek Harness，但核心不依赖 DSH：没有任何 `memory_system.*` 模块 import `@deepseek-ai/*`。宿主接入通过 `memory_system/adapters/turns.py` 定义的端口完成。

---

## 1. 总体结构

```
                    宿主 (DSH / 其他 Agent)
                            │  适配器 (仅接口)
                   ┌────────▼─────────┐
                   │ adapters/turns.py│  NormalizedEvent / TurnContext / ProjectResolver
                   └────────┬─────────┘
                            │
                   ┌────────▼─────────┐
                   │  system.py       │  MemorySystem —— 唯一门面
                   │  MemorySystem    │
                   └────────┬─────────┘
      ┌──────────┬──────────┼───────────┬─────────────┬──────────────┐
      ▼          ▼          ▼           ▼             ▼              ▼
   L0          L1           L2          L3            L4         maintenance
anchors.py  (接口)      l2.py       l3.py        l4.py         maintenance.py
 指针      外部实现   episodic    retrieval.py  skills.py
                       decay     communities.py maturity.py
                                  governance.py
                        └────────┴───────────────┴──────────────┘
                            storage.py (SQLite + FTS5 + vec0)
                            embedding.py / cache.py / text.py
```

**分层原则**：每一层可独立构造与测试。L2 与 L3 在*行为*上互相引用（L3 边引用 L2 情节作为证据，L2 情节可携带 L3 上下文），但在*构造*上互不依赖 —— `EpisodicMemory` 与 `SemanticMemory` 各自 `build`，事后再交叉链接。这是 L2/L3 能被单独测试的原因。

### 各层职责

| 层 | 模块 | 职责 | 删除策略 |
|---|---|---|---|
| L0 | `anchors.py` | 会话锚点（指针，**不含原文**） | 不可删 |
| L1 | — | 工作记忆，由宿主维护 | 会话结束即消失 |
| L2 | `l2.py` | 情景记忆，Ebbinghaus 衰减 | 降权，**永不物理删除** |
| L3 | `l3.py`, `retrieval.py`, `communities.py` | 语义图，双时间轴 | 关闭有效区间，保留历史 |
| L4 | `l4.py`, `skills.py`, `maturity.py`, `governance.py` | 程序性技能 | 归档到全局备份池 |

---

## 2. 存储选型

**单文件 SQLite（WAL）**，而非设计文档中的 Postgres + Neo4j + Redis + Git。

理由：
- 记忆系统运行在 Agent 进程内，是嵌入式组件，不是独立服务；
- 跨层事务是真实需求 —— 一次 `remember()` 同时写 L2 情节、L3 边、证据链接、变更审计，必须原子；
- FTS5（全文）+ `sqlite-vec`（向量）覆盖了两类检索；图遍历因数据量级（千级节点）用递归 CTE 足够；
- 零运维：一个文件，可备份、可迁移、可随项目内网同步。

代价（**已知且不可消除**）：单写入者。因此所有后台任务（`maintenance.py`）都必须是**分批、幂等、可与读并发**的，不能假设高写入并发。见 D1。

向量后端：优先 `sqlite-vec` 的 `vec0` 虚表；不可用时自动退化为纯 Python 精确扫描（`backend: "exact"`），功能完整、只是慢。已由 `tests/test_degradation.py::test_exact_scan_fallback` 覆盖。

**例外：程序性技能是文件。** 模型生成的技能（项目级 `<repo>/.agents/skills`、全局级 `~/.agents/skills`）不进入这个库：DSH 的原生技能目录会把它们变成会话技能，人和别的工具读同一个文件，换 harness 也不失传。库里只留一条 L2 创建审计记录；`l4_skills` 表仅服务于程序化 API 与旧库迁移。

嵌入维度在数据库首次创建时写入 `meta.embedding_dim`，此后换模型会直接报错而不是静默产生垃圾相似度 —— 换模型等于重建库。

---

## 3. 接口契约

### 3.1 门面：`MemorySystem`

宿主只需要认识这一个类。

| 方法 | 用途 | 调用时机 |
|---|---|---|
| `ensure_project(project_id, ...)` | 注册/刷新项目 | 会话开始 |
| `remember(...)` | **一次写入 = 1 个情节 + N 条事实** | 一轮对话结束后 |
| `recall(query, project_id=...)` | 混合检索（fast / deep / auto） | 提问时 |
| `explain(edge_id=...)` | 追溯 L3 → L2 → L0 | 用户问"凭什么" |
| `prepare_turn(...)` | L4 三级渐进披露 + 预算 | 每轮开始 |
| `add_skill / load_skill / record_skill_run` | 技能生命周期 | 运维 / 执行后 |
| `capture_trajectory(...)` | 记录原始执行轨迹 | 一轮结束 |
| `review_candidates / accept_candidate / reject_candidate` | 成熟度候选审核 | 人工 |
| `pending_promotions / decide_promotion` | 跨项目提升审批 | 人工 |
| `run_maintenance(...)` | 后台批处理 | 定时器 |
| `stats(project_id)` | 可观测性 | 诊断 |

`remember()` 把"一次发生的事"和"由此得出的结论"绑在同一个事务里，这是**溯源完整性的来源**：图上不存在没有 L2 情节支撑的断言。

### 3.2 L2 契约

```python
L2.add(*, project_id, summary, importance, event_type, participants,
       outcome, session_key, anchor_id, content_key, meta) -> Episode
L2.search(query, *, project_ids, k, include_dormant, include_archived,
          include_superseded, event_types, since, until, reinforce) -> list[EpisodeHit]
L2.reinforce(memory_ids, amount) -> int
L2.refresh_states(limit) -> dict
```

- 强度：`S = S0 · importance · (1 + β·ln(1+access_count))`，`R = exp(-Δt/S)`
- 打分：`score = similarity · (floor + (1-floor)·R)`
- 状态：`active ≥ 0.30`，`dormant ≥ 0.05`，`archived` 以下
- 去重：内容哈希 + `content_key` + 向量三重判据，命中即 return 既有 id
- **状态判定在检索时实时计算**，不读 `state` 缓存列。`state` 列只是批量刷新的物化结果，可能滞后数小时；用它过滤会让已衰减的记忆回魂。

### 3.3 L3 契约

```python
L3.add_fact(project_id, FactInput(...)) -> EdgeDecision(status, reason, edge, conflict, closed_edge_ids)
L3.edges_of(entity_id, *, relation, current_only, at) -> list[Edge]
L3.history(target_id=None, *, involved_entity_id=None) -> list[dict]
L3.provenance(target_id) -> {"episode_ids": [...], "anchor_ids": [...]}
L3.retract_dependents(launch_key, absent_tools) -> list[str]
```

写入期校验（**写时校验，不在检索时校验**）：

| 校验 | 处理 |
|---|---|
| 关系未注册 | `rejected / unknown_relation` |
| 端点类型不符 | `rejected / type_constraint` |
| 基数=1 且已有当前边 | `closed`（关闭旧边，保留历史） |
| 引用的 episode id 不存在 | `rejected / needs_evidence`（证据链无所指即拒绝；悬空 id 会静默削弱所有证据比较） |
| 完全无证据的新断言 | 默认放行 —— 手写/导入边合法地没有来源（与检索侧 `edge_lost_its_sources` 口径一致）；严格宿主设 `L3Config.require_evidence=True` 后才 `rejected / needs_evidence` |
| 证据更弱 | `rejected / weaker_evidence`（附双方证据强度） |
| 形成环 | `rejected / cycle` —— 环在**单一关系内**判定（`is_a`/`causes`/`part_of` 混合链不是任一关系的环）；已声明的 `inverse` 关系以反方向参与图遍历 |
| 完全重复 | `duplicate`（提升置信度） |
| 冲突且策略为 `defer` | `disputed`（两条都标记争议） |

双时间轴：`valid_from/valid_to`（世界何时如此）与 `recorded_at`（我们何时得知）。`edges_of(at=...)` 查询"某时刻为真"。

三元组唯一索引强制"重开一条已关闭的边"时复用旧行、覆盖其区间 —— 因此旧行的
世界态（`valid_from`/`valid_to`/置信度/证据 episode）以 `prior` 快照保留在
`l3_changes` 的 `edge.created` 审计明细里，历史不会被改写。

### 3.4 L4 契约

```python
skills.prepare_turn(*, view, user_text, context, intent_labels, loaded_skill_ids) -> Disclosure
skills.match(*, view, user_text, context, intent_labels) -> list[SkillMatch]
skills.record_run(skill_id, RunRecord(...)) -> str
trajectories.record(project_id, steps, ...) -> Trajectory | None
trajectories.evaluate(project_id) -> list[MaturityEvidence]
trajectories.mature(project_id) -> list[dict]
archive.search(text, ...) -> list[ArchiveHit]
promotions.propose() -> list[Promotion]
```

**注意力预算**：索引 500 / 明细 800 / 完整定义 2000 / 单轮合计 ≤ 3300 tokens。超预算时按 `index → detail → definition` 顺序逐级裁剪并记录 `degraded` 原因，绝不截断到半句话。

**三级渐进披露**：
1. 索引行（`- name · triggers · 摘要`，单行、无步骤）
2. 匹配技能的明细（何时使用、前置、步骤标题）
3. 完整定义（仅当模型显式 `load_skill`）

**匹配打分**：`0.4·intent + 0.3·prereq + 0.2·semantic + 0.1·success`。前置不满足（工具不可用）时分数乘 0.45 —— 技能必须**可执行**才有资格被推荐。

**作用域**：记忆库里的技能行只用于 `project`（程序化 API）；模型/桥接路径的项目技能与全局技能都是 `.agents/skills` 文件，全局文件在 `~/.agents/skills`。`SkillRegistry.create` 拒绝新的 `org` / `sys` 写入，桥接层也不读写全局 `l4_skills` 行；旧行只保留给迁移。创建与退役全局技能都需要用户明确同意：宿主先从 `ask_user_question`（问题 id `dsh-memory:skill-scope`）取得真实答复，才给桥接传 `host_approved=true`；该标记由宿主签字，模型无法自我声明。

**成熟度 ≠ 运行状态**：运行状态是 `candidate → active → retired`；"mature" 只表示轨迹证据满足五个条件（≥3 次成功、≥2 个会话、步骤一致性 ≥0.6、有前置条件、非单步）。步骤一致性在**同一 signature 的全部变体之间**计算（组内取众数 variant 作代表键）—— 变体是单条轨迹精确工具序列的哈希，按它分组等于每组与自身比较，不允许失败。成熟的轨迹变成 `candidate` 技能，**必须经用户审核**才 `active`。

---

## 4. 与原始设计方案的差异

以下是实现中发现的原方案与实际不符、或按原方案无法正确工作的地方。

### D1 · 存储：单库 SQLite，而非四套存储

见 §2。取舍：放弃多写入者并发，换来嵌入式零运维与跨层事务。**建议**：若将来需要多进程同时写，应改为"单写入者队列 + 只读副本"，而不是换数据库。

### D2 · DSH 没有 `project_id`

`SessionHeader` 只有 `id / cwd / parentSession / origin / agentPreset`。原设计假设会话自带项目 id，**实际不存在**。

实现方式：`ProjectResolver` 从 `cwd` 推导，并**优先用 git remote**（`git@github.com:acme/web.git` → `acme-web`），这样同一仓库的不同 checkout 落到同一项目；只有拿不到 remote 时才退化为路径 slug。**建议**：DSH 若将来暴露项目标识，适配器只需替换 resolver。

### D3 · "检索中迭代改写" 不能调用模型

原设计的 deep path 含"多轮 LLM 改写查询"。在检索路径里调用模型会让延迟不可控、成本不可预测，且违反"fast path < 200ms"。

实现为**本地确定的子查询展开**：从种子实体出发，按已注册关系生成结构化子查询（`head --rel--> ?`、`? --rel--> tail`），无模型调用。若确需语义改写，应在**写入期**离线生成候选改写并缓存，而不是检索期现算。

### D4 · 扩散激活用 PPR 代替 BFS

原设计的逐跳 BFS 在同一子图上反复扩展，代价随跳数指数增长且难以设预算。改为带重启的 PageRank（`α=0.15`，节点上限 400），单次迭代成本可控，且天然按重要性排序。已实测 deep path p50 13ms（预算 2000ms）。

### D5 · "LLM 自动生成技能正文" 改为轨迹挖掘

原设计让模型读历史后直接写技能。问题是模型会**编造**从未执行过的步骤，而技能的价值恰恰在于"被验证过的可复现序列"。

改为 `maturity.py`：只从真实执行轨迹中归纳，五个条件全部满足才产出 `candidate`，且**未经用户审核不可执行**。这是"诚实的技能"与"看起来像技能的幻觉"之间的分界。

### D6 · token 预算必须本地估算

宿主不提供 server-side tokenizer。用保守的本地估算（CJK 按字、拉丁按 4 字符/token，取上界），宁可少放内容也不超预算。已在 `test_budget_never_exceeded` 中锁定。

### D7 · L0 是接口，不是实现

DSH 插件拿不到任意会话原文，因此锚点**可存、可传，但系统无法解引用或验证**。`AnchorRegistry` 只保证 `(session_key, seq)` 单调可排序。消费方必须把锚点当不透明指针。这是能力边界，不是遗漏。

### D8 · L1 完全交给宿主

工作记忆是上下文窗口本身，系统不复制一份。L2 写入的时机由宿主决定（通常一轮结束）。

### D9 · 归档池不参与运行时检索

原设计把归档描述为"可被检索的备用池"。实现中 `SkillArchive` **只用于写入期去重**（新建技能时判断 `new / reference / similar`）与项目删除后的保留，`prepare_turn` 与 `match` 永不读取它 —— 否则一个已退役的流程会在无关项目里被重新推荐。

### D10 · 提升推荐由用户决定，系统只做记账

`PromotionService` 每天最多 book N 条（默认 3），逾期失效，被拒绝的簇在静默期内不再重复打扰。系统**从不**自动创建全局技能；用户接受后写入 `~/.agents/skills/<name>/SKILL.md`，并把决策记进 `l4_promotions`。

---

## 5. 性能实测

1200 条 L2 情节 + 114 个实体 + 237 条边 + 120 个技能，Windows / Python 3.14：

| 路径 | p50 | p95 | max | 预算 |
|---|---|---|---|---|
| fast path | 5.4 ms | 5.7 ms | 13.5 ms | 200 ms |
| deep path (PPR) | 13.0 ms | 14.3 ms | 14.4 ms | 2000 ms |
| `prepare_turn` | 4.6 ms | 5.0 ms | 5.2 ms | 300 ms |

写入：1200 条 L2 情节 0.87s；237 条 L3 边 0.04s。

**首次调用成本**：jieba 构建前缀词典约 440ms、`sqlite-vec` 模块注册约 100ms。两者都在 `MemorySystem.__init__` 里预热（`text.prewarm()` + `VectorIndex.warm()`），因此第一轮对话的检索不会踩到 400ms 的坑。

> 一个实现细节值得记录：`jieba.cut()` 返回**惰性生成器**，词典是在迭代时才构建的。预热必须 `list(...)` 消费它，否则只是把成本推后。实测这一步把首次 tokenize 从 302ms 降到 0.1ms。

---

## 6. 已知局限

1. **哈希嵌入只有词法能力（默认后端）。** 默认 `HashEmbedding` 零依赖、可复现，但无法理解同义改写。生产环境应使用 `embedding_preset="qwen3"`（Qwen3-Embedding-0.6B，1024 维），见 §6.1。
2. **单写入者。** 见 D1。
3. **社区摘要是抽取式的**，不是生成式的；质量上限取决于节点命名。
4. **成熟度依赖真实轨迹**，冷启动阶段 L4 几乎为空 —— 这是设计意图，不是缺陷。
5. **无跨库同步**。多机协作需要额外的复制层，当前未实现。
6. **`retract_dependents` 按 `launch_key` + 缺失工具匹配**，属于启发式；若观测上下文记录不全会漏判，宁漏不误删。

### 6.1 嵌入模型选型与降级策略

推荐 **Qwen3-Embedding-0.6B**（1024 维）。理由：

| 维度 | 值 | 对本系统的意义 |
|---|---|---|
| 维度 | 1024 | 与默认配置一致，切换零成本 |
| 体积 | 0.6B / ~1.2GB | 可与 Agent 同机运行 |
| 多语言 | MTEB 多语均分 64.88 | 记忆内容中英混排 |
| 代码检索 | MTEB-Code 75.41 | 大量标识符、路径、工具名 |
| 上下文 | 32K | 技能定义全文可一次编码 |

同尺寸对照：`bge-m3` 多语均分约 57（维度同为 1024，可同价替换）；
`nomic-embed-text` 更快但中文明显偏弱，不推荐用于中英混排记忆；
`Qwen3-Embedding-4B/8B` 分别为 69.45/70.58，比 0.6B 高约 5 分但体积大 7–13 倍，
建议先用 0.6B 在真实数据上测命中率再决定。

**启动探测**：`MemorySystem` 打开时对 HTTP 端点做一次真实嵌入调用，校验可达性、
维度、非零向量与有限值（NaN/inf 一律视为退化 —— NaN 会在相似度截断时变成 1.0，
即用"完美匹配"撒谎，读路径对非有限分量一律取中性值）。策略由 `EmbeddingConfig.on_unavailable` 控制：

| 策略 | 行为 |
|---|---|
| `warn`（默认） | 记录到 `memory.probe`，照常打开；但**写入会明确失败**并说明原因，不会静默丢失记忆 |
| `raise` | 拒绝打开 |
| `fallback` | 降级为哈希后端，**仅当库中已有向量时改为报错** |

`warn` 之所以不让写入静默通过：记忆系统最坏的失败不是崩溃，而是**看起来写成功了
但没存下来**。端点不可达时 `DegradedProvider` 直接抛 `ProviderError`，附带修复
建议，且事务未提交、不会留下半条数据。

`fallback` 的限制同样是刻意的：把两种模型的向量混在一个空间里，比启动失败更糟 ——
相似度会静默失真，而记忆系统没有外部信号能发现这件事。

探测在**打开路径**上，因此做了双重限时：先用一个共享截止时间的 TCP 可达性检查
（0.75s，覆盖所有解析到的地址族），再做一次真实请求。实测端点不可达时打开耗时
从 4.9–10s 降到 0.8–1.3s。这一步是必须的 —— `urllib` 会依次重试每个地址族且
timeout 按次生效，`localhost`（解析出 v4+v6）在防火墙静默丢包时要耗 2 倍超时。
已由 `tests/test_embedding.py` 的启动延迟用例守住。

**换模型 = 重建，不是改配置**。`change_embedding()` 逐层重算全部向量；维度变化
必须显式 `allow_redimension=True`（vec0 表宽固定）。已在 `tests/test_embedding.py` 覆盖。

**部分失败不声明完成**。`embedding_fingerprint` 是"库内全部向量已属于新空间"的声明，
只在逐层重算**零错误**时写入；部分失败时保持不声明，`needs_reembed()` 继续返回
True，重跑即可收敛 —— 否则一个混合向量空间会从此静默失真，而系统没有任何外部
信号能发现。`embedding_dim` 则始终如实反映物理索引（索引已重建或未变）。

---

## 7. 目录

```
memory_system/
  __init__.py      公开 API
  system.py        MemorySystem 门面
  config.py        全部可调参数
  storage.py       schema / Store / 事务
  vectors.py       vec0 或精确扫描
  embedding.py     嵌入提供方
  cache.py         嵌入 LRU
  text.py          分词 / 关键词 / token 估算
  anchors.py       L0
  l2.py            L2
  l3.py            L3 图
  retrieval.py     路由 / 快慢路径 / RRF
  communities.py   社区检测与摘要
  summary.py       全局工作摘要 / 项目根 Markdown / 用户画像
  migrate.py       嵌入模型迁移（逐层重建向量）
  l4.py            技能结构 / 预算规划 / 渲染
  skills.py        L4 注册表 / 匹配 / 运行记录
  maturity.py      轨迹 → 成熟度 → 候选
  governance.py    归档池 / 提升推荐
  maintenance.py   后台批处理
  errors.py        错误类型
  bridge.py        stdio JSON 协议桥（`python -m memory_system --serve`，DSH 插件的子进程）
  adapters/
    turns.py       宿主端口（NormalizedEvent / TurnContext / ProjectResolver）
    dsh.py         DSH 接口桩（未实现，仅记录绑定点）
tests/             204 项
```

**digest 的遗忘承诺**：digest 是宿主唯一注入提示词的路径，因此它与检索遵守同一条
遗忘规则 —— 带 `forgotten_at` 的情节不进入材料。restore 后记忆随之回到 digest 候选池。
已由 `tests/test_summary.py` 锁定。

**只有一份全局工作摘要**：宿主不再生成“当前项目摘要”。全局摘要覆盖所有项目，只记录
已经做过的工作（实现、修复、迁移、已落地的决定与结果），不写经验教训、偏好或未来计划。
预算（300–3000 字）作为**生成指令**写入提示词：预算大时模型展开更多工作项与细节，
预算小时只写每个项目的结论；`commit` 原样保存模型输出，不做按预算截断。

**项目根摘要文件**：每个项目在 `root_path` 下维护一个 `DSH_MEMORY.md`，由 L2 工作记录
按日期派生，记录该项目做过的工作，不进入召回或全局摘要。项目首次被解析（`projects`）
以及每次记忆写入/编辑/遗忘/恢复、全局摘要提交后都会刷新；写失败被隔离，不影响记忆写入。
