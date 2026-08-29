# dsh-memory v3 设计稿 —— 三层凝练记忆体系

> 状态：**设计定稿 v1.1（review 后修订），待实现**。
> 修订记录（相对 v1.0）：
> - **P0-1**：heat 衰减由幂律改为**指数衰减**，λ 由 `forgetDays`（期望遗忘时间）反推，附数值验证。
> - **P0-2**：episodes 表（情景层）**补遗忘机制**，与 memories 构成双遗忘面。
> - **P0-3**：LLM 决策式整理（L1/L2 凝练）**v3 休眠**，只做零 LLM 骨架。
> - **P1-1**：情景召回**允许 LLM 摘要增强**（可选，降级纯 FTS5）。
> - **P1-2**：删除"自动召回 vs 噪声"伪冲突。
> 权威规格仍以 `DESIGN.md`（v2）为准，本文是 v3 演进稿。
> 借鉴来源：认知三层记忆（工作/情景/语义）+ Hermes 工程三层（冻结注入/技能/FTS5 会话搜索）。

## 0. 演进动机（为什么 v3）

v2 的四个缺口/盲区：

1. **缺情景记忆层**（硬缺口）：只有 `memories` 表存"事实"，不记录"发生过什么"。
2. **库只增不减**（硬缺口）：归档是软删，无物理删除，磁盘无限增长。
3. **热度只有 recency 没有 frequency**：`1/(1+λ·Δt)^α` 只依赖 `last_accessed`，区分不出"过去一月召回 50 次"与"昨天召回 1 次"。
4. **"凝练"未显式化**：记忆应沿时间熵减（对话→事实→规则），v2 只有去重/合并，缺"情景→语义"抽取管道。

## 1. 设计哲学：吸收两套体系、避免冲突

认知三层（内容轴）与 Hermes 三层（载体轴）正交，可叠加。冲突只在两个取舍点，均用机制化解：

| 冲突 | 化解 |
|---|---|
| 工作记忆实时 vs 长期记忆冻结 | dsh 的 `systemPrompt.section()` 本身**每次 assembly 现算**（非 Hermes 冻结快照），天然实时 + 抗 compaction；不引入冻结，工作记忆由宿主上下文窗口实时承担 |
| 海量 episode vs 容量硬上限 | **上限只约束"注入"，不约束"存储"**——存海量，进上下文必须过预算闸门 |

> 注：dsh-memory 的召回是**显式工具调用**，不存在"自动注入情景记忆"的机制，故"自动想起 vs 噪声"的冲突在 v3 语境下不存在，不纳入化解。

## 2. 三层存储架构

```
工作记忆(宿主, 不落盘) ──会话结束──▶ 情景记忆(episodes 表, 会话摘要)
                                            │ L1 抽取(后台凝练, v3 休眠)
                                            ▼
                                    语义记忆(memories 表, 事实/偏好/教训)
                                            │ L2 抽象(合并/裁决/修正, v3 休眠)
                                            ▼
                                       技能(扩展点, v3 不实现, 架构预留)
```

| 层 | 存储 | 载体 | 注入策略 | 容量 |
|---|---|---|---|---|
| **工作记忆** | 不落盘 | dsh 上下文窗口（宿主能力） | 实时 | LLM 上下文预算 |
| **情景记忆** | `episodes` 表 | 会话级摘要（非原文，第一级压缩） | 显式召回，不常驻 | 海量，**时间驱动归档** |
| **语义记忆** | `memories` 表 | 稳定事实/偏好/教训 | Tier0 注入 + Tier1 召回 | 注入有硬上限，存储无上限 |
| **技能** | 技能文件（扩展点） | 程序性知识 | 语义匹配召回 | —（v3 不做） |

**关键决策**：情景层存**会话级摘要**而非原始全文——原文由 dsh 宿主 session 管，dsh-memory 不重复存；这同时解决"存什么"与"第一级压缩"，并控制磁盘增长。落地依赖宿主 session seam 能力，M1 实测确认（§9）。

## 3. 凝练管道（熵减流水线）

**v3 只落地 L0（记录），L1/L2 休眠**——延续"LLM 决策式整理先不推进"的既有决定。定义：**信息从原始对话（高噪声、具体、临时）→ 稳定知识（低噪声、抽象、可复用）的熵减过程**。

| 级 | 名称 | 输入→输出 | LLM 依赖 | v3 状态 |
|---|---|---|---|---|
| **L0 记录** | 会话结束压缩 | 会话内容 → episode 摘要 | 可选（默认纯规则） | **做** |
| **L1 抽取** | 情景→语义 | episode 摘要 → 稳定事实/偏好/教训 | 是（决策式） | **休眠** |
| **L2 抽象** | 语义内精炼 | 多条事实 → 合并/裁决/修正 | 是（决策式） | **休眠** |

- **L0 触发**：会话结束时（宿主提供 session-end 事件则监听；否则显式 `/memory_consolidate` + cron 兜底）。**摘要默认纯规则**（截断关键片段 + 去重），LLM 摘要作可选开关（默认关）。
- **L1/L2 休眠的含义**：`refine` 的 LLM 通路不接线（`opts.llm` 恒空），只有纯规则降级/归档生效——即 v2 现状。**启用顺序沿用既有纪律：先补护栏（smoke 固化）→ 再接线**，且核心存查循环绝不因 LLM 挂了而退化。
- **v3 的"凝练先行"退化为"去重先行"**：写入时 `sha256(content)` 锚已做内容去重（防冗余底线）；LLM merge 作为 L2 启用后的增强，先于真删执行。

## 4. 双信号热度模型（指数衰减 + frequency）

```
heat = recency_weight × frequency_boost
recency_weight  = e^(-λ·Δt)              # 指数衰减，Δt = 距 last_accessed 的天数
frequency_boost = 1 + ln(1 + window_freq) # 近 N 天召回次数的对数加成
```

**λ 由期望遗忘时间反推**（`forgetDays` = 降到 heat=0.05 的天数），`λ = ln20 / forgetDays`。数值已验证：

| kind | forgetDays（默认） | λ | 半衰期 | 降到 heat<0.01 |
|---|---|---|---|---|
| env | 365 天 | 0.00821 | 84.5 天 | 561 天 |
| lesson | 180 天 | 0.01664 | 41.6 天 | 277 天 |
| decision | 90 天 | 0.03329 | 20.8 天 | 138 天 |
| general | 60 天 | 0.04993 | 13.9 天 | 92 天 |
| user | ∞（免疫） | 0 | — | — |

> 说明：`forgetDays` 是可配置项（Config），表内是默认值；**改指数衰减后，heat<0.05 在月/年尺度可达**（对比原幂律：general 需 5.1 年、env 需 38 年才降到 0.05，形同虚设）。

- `window_freq`：滑动窗口召回次数（默认窗口 `window_ms = 30 天`），非累计计数。
- 访问（召回命中）时：
  ```
  if now - window_start > window_ms: window_freq = 1; window_start = now
  else: window_freq += 1
  并刷新 last_accessed，重算 heat
  ```
- 诚实标注：`window_freq` 是"召回命中"代理信号，**不是"被模型真正采用"**。固定窗口有边界效应（每 29 天访问一次会停在 1-2 次），起步用固定窗口，后续可换 EWMA 平滑。

**双信号分离（防误删核心）**：

| 信号 | 回答 | 负责 |
|---|---|---|
| 热度（recency + frequency） | "这条现在还活跃吗" | 排序、降级、**进入遗忘候选** |
| 重要性（importance，显式标） | "这条删得起吗" | 遗忘的**最终闸门** |

召回频率 ≠ 价值：`用户房贷还款日在每月 15 日`（低频高价值）绝不因冷而被删。热度只决定"谁先淘汰"，重要性决定"能不能真删"。

## 5. 主动遗忘（三级阶梯 + 双遗忘面）

遗忘是**降级 → 软归档 → 真删**，每步可回滚。**两个遗忘面：memories（语义层）+ episodes（情景层）**。

### 5.1 memories 遗忘

**真删门槛**（全部满足才删，缺一不可）：
- `heat < 0.05`（冷，约一个 forgetDays 未访问）
- `importance < 3`（低价值）
- `quality < 60`（低质量）
- `archived = 1` 且 `now - archived_at > 观察期(默认 30 天)`
- `layer != 'user'`（用户层永生）
- 无未决纠错痕迹（有 `failure_memories` 记录的延长观察期）

**免疫规则**：`layer = 'user'` 与 `importance = 5` 永远免疫真删（importance=5 最多降级，不删）。

**降级/归档门槛**（沿用 v2 语义，指数衰减下时间尺度已验证）：
- 降级 tier0→tier1：`heat < 0.05 && importance < 5 && layer != 'user'`
- 软归档：`heat < 0.01 && importance < 4 && layer != 'user'`

### 5.2 episodes 遗忘（新增，P0-2）

episodes 是"发生过的事"，信息价值随时间衰减，**时间驱动清理**，不设免疫：

- **归档**：`now - ts > episodeRetentionDays(默认 180 天)` → 归档
- **真删**：归档 + 观察期（默认 30 天）→ 物理删
- 预留 `extracted` 字段：未来 L1 启用后，"已被抽取进语义层"的旧 episode 可提前归档（v3 不用，只用时间）

**触发时机**：定期扫描（默认每天一次 cron），不在每次写入时做——写入只做降级检查，重清理放后台。

**审计**：真删条目先导出审计快照（内容 + 理由）再物理删，保证"删了能查、误删能回滚"。见 `forget_runs` 表（§7）。

## 6. 三级召回路由

单一入口 `memory_recall`，按 `scope` + 预算路由：

```
memory_recall { query, topK?, scope? }   # scope: semantic | episodic | all（默认 all）
```

| 级 | 数据源 | 打分 | 延迟 | 成本 |
|---|---|---|---|---|
| Tier0 常驻 | 已在上下文 | —（不算召回） | 0 | 占上下文 |
| 语义召回 | `memories`（默认排除 archived/low_quality） | FTS5 MATCH + CJK 子串 + 关键词 + epistemic×heat | 几十 ms | 按需注入 |
| 情景召回 | `episodes`（ep_fts） | FTS5 全文 + **LLM 摘要增强（可选）** | 几百 ms | 按需注入 |

- **情景召回的 LLM 摘要增强（P1-1）**：有 LLM 时对召回结果做语义摘要再注入（补 FTS5 语义短板，参考 Hermes"FTS5 + LLM 摘要"）；LLM 不可用时**降级为纯 FTS5 原文片段**，召回仍可用，仅语义弱。
- 命中刷新 `window_freq` + `last_accessed`（→heat 回抬）。

## 7. 完整 DDL（v2 基础上扩展）

`memories` 表**新增 3 列**（幂等 `ADD COLUMN`）：

```sql
ALTER TABLE memories ADD COLUMN window_freq  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN window_start INTEGER;               -- 滑动窗口起点(ms)，空=未访问
ALTER TABLE memories ADD COLUMN archived_at  INTEGER;               -- 软归档时间戳(ms)，空=未归档
```

新增表 1 —— **情景记忆**（含遗忘字段）：

```sql
CREATE TABLE IF NOT EXISTS episodes (
  id         TEXT PRIMARY KEY,          -- sha256(session_id + ts) 前 16 hex
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,          -- 会话结束时间
  summary    TEXT NOT NULL,             -- 会话级摘要（L0 压缩产物）
  tools_used TEXT,                      -- JSON：本会话用过的工具名数组
  topic      TEXT NOT NULL DEFAULT 'general',
  extracted  INTEGER NOT NULL DEFAULT 0,-- 预留：是否已被 L1 抽取（v3 不用）
  archived   INTEGER NOT NULL DEFAULT 0,-- 遗忘用
  archived_at INTEGER,                  -- 遗忘用
  created    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_episodes_arch    ON episodes(archived, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS ep_fts USING fts5(summary, topic);
```

新增表 2 —— **遗忘审计**：

```sql
CREATE TABLE IF NOT EXISTS forget_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  candidate_sha TEXT,                   -- 候选清单快照 digest，离线可复现
  decisions     TEXT,                   -- 决策清单 JSON（降级/归档/真删/保留）
  applied       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL           -- ok | degraded
);
```

- FTS 维护同 v2：业务写与 FTS 写同事务；boot 时 `rebuild` 兜底对齐。
- 迁移沿用 v2 教训：`PRAGMA table_info` 探测 + 幂等 `ADD COLUMN`（吞并发 duplicate column error）。

## 8. 硬规则（5 条）

1. **存、写、热度、遗忘主循环零 LLM 依赖**——召回允许 LLM 摘要增强（可选，降级纯 FTS5）；凝练 L1/L2 休眠，启用后也绝不充当召回闸门。
2. **实时性分层**——工作记忆实时（宿主上下文），长期记忆 section 每次现算（dsh seam 天然如此，不引入 Hermes 冻结快照）。
3. **上限只约束注入，不约束存储**——存可海量，进上下文必须过预算闸门 + 质量过滤。
4. **永生分层**——`layer=user` 与 `importance=5` 免疫真删；情景层按时间归档（软删，可恢复）。
5. **自动只到候选，进上下文必须过闸门**——任何召回只生成候选，是否注入由预算 + 重要性裁决。

## 9. 里程碑

| 里程碑 | 内容 | 收口 |
|---|---|---|
| **M0 骨架** | 幂等 schema（3 新增列 + episodes + forget_runs）+ 编译零错误 | `smoke.mjs` 断言 |
| **M1 情景层** | episodes 记录（L0 纯规则摘要）+ ep_fts 检索 + 跨会话情景召回 + **实测 dsh session seam** | `smoke.mjs` + 真机 |
| **M2 双信号热度** | 指数衰减 + frequency 滑动窗口 + 召回命中刷新 | `smoke.mjs` 断言（锁一条具体曲线） |
| **M3 主动遗忘** | 三级阶梯 + 双遗忘面 + 真删门槛 + 免疫规则 + forget_runs 审计 | `smoke.mjs` 断言 |
| **M4 真机装载** | `dsh plugin add` + apply() 建库 + 跨层/跨会话召回实测 | 真 dsh boot |

> M1 需实测确认：dsh 宿主是否暴露"按 session 查询历史"的 seam，决定 episodes 存摘要还是改做"索引宿主 session"。凝练 L1/L2 不在 v3 里程碑内（休眠）。

每个里程碑以 `smoke.mjs`（无 dsh 也可跑）断言收口；M4 以真 dsh boot 收口。

## 10. 相对 v2 的最小改动路径

| 改动 | v2 现状 | v3 增量 |
|---|---|---|
| memories 表 | 已有 | +`window_freq`/`window_start`/`archived_at` 3 列 |
| heat 公式 | 幂律 recency | **指数衰减** + `frequency_boost` |
| episodes 表 | 无 | 新增（情景记忆 + 遗忘字段） |
| forget_runs 表 | 无 | 新增（遗忘审计） |
| 真删阶段 | 只有软归档 | 三级阶梯 + 双遗忘面 + 真删门槛 + 免疫规则 |
| 召回 | 语义单层 | 三级路由 + `scope` + 情景召回 LLM 摘要（可选） |
| 凝练 | 决策式整理（休眠） | L0 记录落地；L1/L2 继续休眠 |

**核心不变**：零 npm 依赖（`node:sqlite` + 内建）、全局直写跨会话即时可见、Tier0 注入、质量过滤、纠错留痕、dream_runs 审计、单一职责。全部复用，**不推倒重来**。

## 11. 非目标（明确不做）

- 技能层落地（程序性记忆）——仅架构预留扩展点。
- 向量召回（ONNX bge-small-zh / DGX vLLM embedding）——留路线图，FTS5 + CJK 兜底先行。
- L1/L2 凝练（LLM 决策式整理）——v3 休眠，后续"先补护栏再接线"。
- confirmMode=suggest 的遗忘确认制——遗忘沿用 confirmMode 语义，v3 默认 auto。
- 跨设备同步、项目/分支隔离细化、工作记忆独立存储（Redis 式会话缓存）。

---

## 附录：v3 的 LLM 介入点（明确边界）

| 介入点 | v3 默认 | 降级路径 |
|---|---|---|
| L0 会话摘要 | 纯规则（截断 + 去重） | 可选 LLM 摘要（开关，默认关） |
| L1 情景→语义抽取 | **休眠** | — |
| L2 抽象/merge | **休眠** | — |
| 情景召回摘要（P1-1） | 可选 LLM | 纯 FTS5 原文片段 |
| 存 / 写 / 热度 / 遗忘 | **零 LLM** | —（纯函数 + 纯规则） |

---

*本文是 v3 演进稿：在 v2 的"语义记忆 + 全局直写 + 背景自愈"骨架上，补"情景记忆层"与"主动遗忘（双遗忘面）"，热度改指数衰减 + frequency，凝练 L0 落地、L1/L2 休眠。核心存查写 + 热度 + 遗忘仍零 LLM、零第三方依赖、单一职责。*
