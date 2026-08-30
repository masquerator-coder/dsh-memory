# dsh-memory

DeepSeek Harness 的**三层凝练记忆插件**（Cordis 插件、bundle-declarative、零 npm 运行时依赖）。v3 在 v2 的"语义记忆 + 全局直写 + 背景自愈"骨架上，补上**情景记忆层**与**主动遗忘**，并把热度改为**双信号（指数衰减 + 召回频率）**。

## 三层记忆架构

| 层 | 存储 | 载体 | 注入策略 | 遗忘 |
|---|---|---|---|---|
| 工作记忆 | 不落盘 | dsh 上下文窗口（宿主能力） | 实时 | — |
| 情景记忆 | `episodes` 表 | 会话级摘要 | 显式召回（不常驻） | 时间驱动归档 |
| 语义记忆 | `memories` 表 | 稳定事实/偏好/教训 | Tier0 注入 + Tier1 召回 | 三级阶梯 |

```
工作记忆(宿主) ──会话结束──▶ 情景记忆(episodes) ──L1抽取(休眠)──▶ 语义记忆(memories) ──L2抽象(休眠)──▶ 技能(预留)
```

## 核心设计

- **全局直写**：`memory` 写入直接进全局库，跨会话即刻可见（无"会话结束才固化"门槛）。
- **双信号热度**：`heat = e^(-λ·Δt) × (1 + ln(1 + window_freq))`。λ 由期望遗忘时间反推（`λ = ln20/forgetDays`），env 365d / lesson 180d / decision 90d / general 60d；`window_freq` 是近 30 天召回次数的滑动窗口。
- **主动遗忘（三级阶梯 + 双遗忘面）**：降级 tier0→tier1 → 软归档 → 观察期满真删。memories 按热度+重要性，episodes 按时间。`layer=user` 与 `importance=5` 免疫。
- **双信号分离**：热度决定"谁先淘汰"，重要性决定"能不能真删"——低频高价值记忆绝不因冷而被删。
- **零 LLM 主循环**：存、查、写、热度、遗忘全零 LLM（纯函数 + 规则）。凝练 L1/L2（LLM 决策式整理）v3 休眠；情景召回可选 LLM 摘要增强（降级纯 FTS5）。

## 工具

- `memory` — `{ action: list|add|replace|remove, layer, kind, tier, topic, id, content, importance, force }`，写入全局语义库（跨会话即时可见）。
- `memory_recall` — `{ query, topK?, scope? }`，`scope: semantic|episodic|all`（默认 all）。语义层 FTS5 + CJK 子串 + epistemic×heat 加权；情景层 FTS5 + 时间近因。

## 安装（bundle-declarative）

```bash
dsh plugin --profile web add https://gitcode.com/foqiang/dsh-memory.git
# 或本地开发：
dsh plugin --profile web add file:C:/abs/path/to/dsh-memory
```

重启 dsh。验证：`~/.dsh/memory/memory.db` 初始化，新会话 system prompt 出现记忆 section。

## 存储布局

```
~/.dsh/memory/
└── memory.db              # SQLite (node:sqlite), WAL
    ├── memories           # 语义事实 (含 window_freq/window_start/archived_at)
    ├── mem_fts            # FTS5 语义索引
    ├── episodes           # 情景会话摘要
    ├── ep_fts             # FTS5 情景索引
    ├── failure_memories   # 纠错留痕
    ├── forget_runs        # 遗忘审计
    └── forget_deleted     # 真删快照（内容+原因，可回滚/可查，P1-13）
```

## 配置（可选）

```yaml
memoryHome: <path>           # 存储目录（默认 ~/.dsh/memory）
enableInjection: true        # Tier0 常驻 section
budgetTier0: 900             # 常驻核心字符预算
budgetUser: 400
budgetMemory: 500
importanceThreshold: 3
epistemicWeighting: true
forgetEnabled: true          # 主动遗忘开关
forgetDays:                  # 期望遗忘时间（天）
  env: 365
  lesson: 180
  decision: 90
  general: 60
windowDays: 30               # frequency 滑动窗口（天）
episodeRetentionDays: 180    # episodes 归档时间（天）
forgetObserveDays: 30        # 归档→真删观察期（天）

# --- 后台凝练 L0 / L1 / L2 ---
l0Summarize: 'llm'           # 'llm' | 'rules'（L0 会话→情景摘要）
l0Provider: ''               # L0 显式路由（缺省用会话 request-header）
l0Model: ''
l0MaxTokens: 400
l0TimeoutMs: 8000            # L0 LLM 端到端超时（P1-10）
l1Enabled: true              # L1 情景→稳定事实抽取（LLM 决策）
l2Enabled: true              # L2 语义簇合并/仲裁（LLM 决策）
l1Provider: ''               # L1/L2 显式路由（缺省：会话路由→宿主导航模型）
l1Model: ''
l1MaxTokens: 800
l1TimeoutMs: 10000
l2Provider: ''
l2Model: ''
l2MaxTokens: 800
l2TimeoutMs: 10000
refineIntervalMs: 3600000    # 后台整理扫描间隔
l2MinCluster: 2              # L2 簇最小成员数
l1RetryDegraded: false       # 是否重试 LLM 降级（extracted=2）的 episode
```

> 运行时要求：Node **>=22.5**（`node:sqlite`；24 才稳定）。见 `package.json` 的 `engines`。

## 开发

```bash
# 编译（对齐 dsh monorepo 的类型；本项目未内置 @deepseek-ai 依赖，
# 此处路径针对 D:/Apps/deepseek-harness 布局——独立安装请把 tsconfig 的
# paths/typeRoots 改指向本地 node_modules 中已安装的 @deepseek-ai 包。）
node "D:/Apps/deepseek-harness/node_modules/typescript/bin/tsc" -p tsconfig.json
# 冒烟（无 dsh 也可跑，全量断言组 G1–G17）
node smoke.mjs
```

`lib/` 已提交，消费者（含 git 安装）无需工具链。

## 状态

- **M0-M3 完成**：幂等 schema、跨会话直写召回、情景层、双信号热度、主动遗忘（三级阶梯 + 双遗忘面 + 审计 + user 免疫 + 真删快照）——`smoke.mjs` 全部断言组（120 项）全绿、稳定连跑通过，`tsc` 零错误。
- **M4 真机装载**：待验证（需 dsh 环境 + 用户确认，dsh 是 RCE 面）。
- **凝练 L1/L2（LLM 决策式整理）**：设计完成、v3 休眠，后续"先补护栏再接线"。

## 设计文档

完整设计见 `docs/DESIGN.md`（v3 三层凝练记忆体系设计稿）。
