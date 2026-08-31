# dsh-memory

DeepSeek Harness 的三层凝练记忆插件（Cordis 插件，bundle-declarative，零 npm 运行时依赖）。它以**工作 / 情景 / 语义**三层存储组织记忆，用**双信号热度（指数衰减 + 召回频率）**衡量"这条还活跃吗"，以**三级阶梯主动遗忘**做磁盘与上下文的熵管理——核心存、查、写、热度、遗忘**全程零 LLM**，纯函数 + 规则，稳定可靠。

---

## 一、设计思路

### 1.1 为什么做三层（演进动机）

早期方案只有"语义事实"一张表，存在四个缺口：

1. **缺情景层**——只记录"事实"，不记录"发生过什么"。会话级摘要缺失，无法回答"当时是怎么讨论的"。
2. **库只增不减**——归档是软删，无物理删除，磁盘无限增长。
3. **热度只看 recency**——`1/(1+λ·Δt)^α` 只依赖最后访问时间，区分不出"过去 30 天召回 50 次"与"昨天召回 1 次"。
4. **凝练未显式化**——记忆应沿时间熵减（对话 → 事实 → 规则），早期只有去重/合并，缺"情景 → 语义"的抽取管道。

v3 对应补齐：情景层、主动遗忘、**双信号热度**、显式凝练管道（L0 记录落地，L1/L2 为架构预留、默认休眠）。

### 1.2 三层记忆架构

| 层 | 存储 | 载体 | 注入策略 | 遗忘 |
|---|---|---|---|---|
| **工作记忆** | 不落盘 | dsh 上下文窗口（宿主能力） | 实时 | — |
| **情景记忆** | `episodes` 表 | 会话级摘要（第一级压缩） | 显式召回，不常驻 | 时间驱动归档 |
| **语义记忆** | `memories` 表 | 稳定事实 / 偏好 / 教训 | Tier0 注入 + Tier1 召回 | 三级阶梯 |

```
工作记忆(宿主) ──会话结束──▶ 情景记忆(episodes) ──L1抽取(休眠)──▶ 语义记忆(memories) ──L2抽象(休眠)──▶ 技能(扩展预留)
```

三个关键决策：

- **情景层存"会话摘要"而非原始全文**——原文由 dsh 宿主 session 管理，插件不重复存。既解决"存什么"，又天然完成第一级压缩，还控制磁盘增长。
- **上限只约束"注入"，不约束"存储"**——海量记忆照存，进上下文必须过预算闸门。
- **注入现算而非冻结**——`systemPrompt.section()` 每次装配重算，天然实时 + 抗 compaction；工作记忆由宿主上下文窗口实时承担，插件不引入冻结。

### 1.3 双信号热度（为什么这个模型）

```
heat = recency_weight × frequency_boost
recency_weight  = e^(-λ·Δt)               # 指数衰减，Δt = 距 last_accessed 的天数
frequency_boost = 1 + ln(1 + window_freq) # 近 windowDays 天召回次数的对数加成
```

λ 由**期望遗忘时间**反推（`λ = ln20 / forgetDays`，即降到 heat≈0.05 所需天数）：

| kind | forgetDays（默认） | 半衰期 | 降到 heat<0.01 |
|---|---|---|---|
| env（环境） | 365 天 | 84.5 天 | 561 天 |
| lesson（教训） | 180 天 | 41.6 天 | 277 天 |
| decision（决策） | 90 天 | 20.8 天 | 138 天 |
| general（一般） | 60 天 | 13.9 天 | 92 天 |
| user（用户层） | ∞（免疫） | 0 | 永不 |

要点：

- **双信号分离**是防误删核心：热度回答"这条现在还活跃吗"（负责排序、降级、进入遗忘候选），重要性回答"这条删得起吗"（负责遗忘的最终闸门）。
- **召回频率 ≠ 价值**：`用户房贷还款日在每月 15 日` 这类低频高价值事实，绝不因冷而被删。
- 诚实标注：`window_freq` 是"召回命中"的代理信号，不是"被模型真正采用"；固定窗口有边界效应，后续可换 EWMA 平滑。

### 1.4 主动遗忘（三级阶梯 + 双遗忘面）

遗忘是**降级 → 软归档 → 真删**，每步可回滚，双向都可审计。**两个遗忘面**：`memories`（语义层，按热度 + 重要性）+ `episodes`（情景层，按时间）。

语义事实真删门槛（缺一不可）：
- `heat < 0.05`（冷，约一个 forgetDays 未访问）且 `archived = 1` 且超过观察期（默认 30 天）
- `importance < 3`、`quality < 60`（低价值、低质量）
- `layer != 'user'` 且无未决纠错痕迹

**免疫规则**：`layer=user` 与 `importance=5` 永远免疫真删（importance=5 最多降级）。真删前落快照（`forget_deleted` 表），内容 + 原因可查、可回滚。

### 1.5 零 LLM 主循环 & Live 设置

- **存、查、写、热度、遗忘全零 LLM**（纯函数 + 规则）。核心存查循环绝不因 LLM 挂掉而退化。
- LLM 只在**可选的凝练增强**使用：L0 会话摘要（默认纯规则，可切 LLM）、L1/L2 决策式整理（v3 休眠）、情景召回摘要增强。
- 宿主通过 `ctx.settings` 注册 `memory` 命名空间，**设置面板的开关改动经 `scope.watch` live 热生效，无需重启**。

---

## 二、功能特性

### 2.1 记忆工具（Agent 可调用）

**`memory`** —— 写入全局语义库（跨会话即刻可见）：

```
{ action: list|add|replace|remove, layer, kind, tier, topic, id,
  content, importance, force }
```

**`memory_recall`** —— 三种范围召回：

```
{ query, topK?, scope? }   # scope: semantic | episodic | all（默认 all）
```

- 语义层：FTS5 + CJK 子串 + `epistemic × heat` 加权
- 情景层：FTS5 + 时间近因

### 2.2 设置面板（dsh 设置页「记忆」项）

设置面板注册在官方 `settings.section` slot，左侧导航自带**神经元图标**（插件自声明，无需侵入 harness shell）。可实时切换：

| 开关 | 字段 | 作用 |
|---|---|---|
| 记忆总开关 | `enabled` | 关 → 清洁会话（不注入任何记忆），后台整理/遗忘/维护全停 |
| 主动遗忘 | `forgetEnabled` | 关 → 暂停降级/归档/硬删，**不清理已有记忆** |
| user.md 自动进化 | `identityAuto` | 关 → 停止自动维护 user.md |
| 忙闲时段抑制扫描 | `peakHourSuppress` | 关 → 任何时段都跑后台 LLM 凝练（费 API 钱） |
| 身份维护扫描间隔 | `identityIntervalMs` | user.md 自动同步周期 |
| soul.md / user.md 内联编辑 | — | 直接读写身份文件（文件仍为真相源） |

### 2.3 身份文件（soul.md / user.md）

- **soul.md**：AI 人格 / 行为准则，**只由人写**，插件永不自动改写。
- **user.md**：用户长期画像，**自动维护**——把 `layer=user` 稳定记忆增量写入（内容哈希去重、无新增不写、超 `identityMaxBytes` 跳过不截断）。

两者作为恒定 section 注入（mtime 变化才重读，KV 缓存友好），不与 memories 表混管（不该被热度/遗忘管）。Windows 写入无 BOM UTF-8。

### 2.4 后台维护

- **L0 会话收口**：turn-end 只做零 LLM 规则留痕；会话空闲 ≥ `l0IdleMinutes` 后一次性 LLM 收口为 episode 摘要。
- **L1/L2 凝练**（架构预留、默认休眠）：情景→事实抽取、语义簇合并/仲裁；启用遵循"先护栏后接线"纪律。
- **每日主动遗忘**：`runForget` 按热度/重要性/时间执行三级阶梯，受 `enabled` 与 `forgetEnabled` 双闸门实时控制。
- **身份维护**：按 `identityIntervalMs`（默认 6h）增量同步 user.md。
- **峰时抑制**：默认北京 09–12 / 14–18 点（含前 15 分钟）跳过后台 LLM 凝练，省 API 费用。

### 2.5 关于 KV Cache（配置注意事项）

Tier0 section 每次装配现算。写入路径会按"从第一个变动的 token 起复用失效"影响前缀缓存命中：**append-only** 代价最小；**replace/remove** 位置之后的 token 全量重算。因此建议：跨会话稳定的记忆尽量在会话早期写入；频繁检索走 `memory_recall`（不落盘、不动 section）；不要在会话中途反复改预算/开关。

---

## 三、安装方法

> 运行时要求：**Node ≥ 22.5**（依赖 `node:sqlite`；Node 24 才稳定）。`lib/` 已提交，消费者无需任何工具链。

### 3.1 从远端安装（推荐）

```bash
dsh plugin --profile web add https://gitcode.com/foqiang/dsh-memory.git
# 或 GitHub 源：
dsh plugin --profile web add git@github.com:masquerator-coder/dsh-memory.git
```

### 3.2 本地开发安装

```bash
dsh plugin --profile web add file:C:/abs/path/to/dsh-memory
```

### 3.3 验证

重启 dsh 后：

```bash
# 1. 存储库初始化：
ls ~/.dsh/memory/memory.db
# 2. 新会话 system prompt 出现记忆 section
# 3. 设置 → 「记忆」面板出现（含神经元图标、记忆总开关、主动遗忘等）
```

>bundle 安装时 `cordis.patch.yml` 自动作为 loader patch 应用，注入 `id: memory` 的实例（`enableInjection: true` 默认开启 Tier0 注入）。

---

## 四、配置说明

`dsh-memory` 开箱即用（全默认即可）。按需在 `dsh` 配置中覆盖：

```yaml
# --- 存储 & 注入 ---
memoryHome: <path>           # 存储目录（默认 ~/.dsh）——注意：库文件在 <memoryHome>/memory/memory.db，
                             # store 会再拼一层 memory/。想让库落在 ~/.dsh/memory/memory.db 就设 ~/.dsh，
                             # 不要设 ~/.dsh/memory（否则得到 ~/.dsh/memory/memory/memory.db）
enableInjection: true        # Tier0 常驻 section
budgetTier0: 900             # 常驻核心字符预算
budgetUser: 400
budgetMemory: 500
importanceThreshold: 3
epistemicWeighting: true

# --- 主动遗忘 ---
forgetEnabled: true          # false → 暂停降级/归档/硬删（不清理已有记忆）
forgetDays:                  # 期望遗忘时间（天）；0 = 立即过冷，仍受重要性/观察期门槛保护
  env: 365
  lesson: 180
  decision: 90
  general: 60
windowDays: 30               # frequency 滑动窗口（天）
episodeRetentionDays: 180    # episodes 归档时间（天）
forgetObserveDays: 30        # 归档 → 真删观察期（天）

# --- 后台凝练 L0 / L1 / L2 ---
# 路由跟随 dsh 模型选择，勿写死：L0 缺省用会话 request-header；L1/L2 缺省按
# 会话路由 → 宿主导航模型 回退。写死而缺凭证会导致 refine 全程 degraded。留空=跟随。
l0Summarize: 'llm'           # 'llm' | 'rules'（L0 会话 → 情景摘要）
l0Provider: ''               # 显式路由（建议留空跟随）
l0Model: ''
l0MaxTokens: 400
l0TimeoutMs: 8000
l1Enabled: true              # L1 情景→稳定事实抽取（LLM 决策，v3 休眠）
l2Enabled: true              # L2 语义簇合并/仲裁（LLM 决策，v3 休眠）
refineIntervalMs: 3600000    # 后台整理扫描间隔
l2MinCluster: 2
l1RetryDegraded: false

# --- M5 会话收口 ---
l0IdleMinutes: 30            # 会话空闲 ≥ 此分钟数才一次性 LLM 收口
checkMinutes: 5              # idle 收口判定周期（分钟）

# --- M8 峰时抑制（省 API 钱）---
suppressWindows:             # 这些时段 L1/L2 后台 LLM 不跑（按 timeZone 计算）
  - start: '09:00'
    end: '12:00'
  - start: '14:00'
    end: '18:00'
suppressLeadMinutes: 15
timeZone: 'Asia/Shanghai'
peakHourSuppress: true       # false → 任何时段都跑后台 LLM

# --- M9 身份块 ---
enableIdentity: true         # 注入恒定 soul.md / user.md 身份 section

# --- R3-total / R3-i：记忆总开关 & 身份维护 ---
enabled: true                # false → 清洁会话，后台全部停；memory 工具保留
identityAuto: true           # 自动把 layer=user 稳定记忆增量写入 user.md
identityIntervalMs: 21600000 # 默认 6h
identityMaxBytes: 2000       # user.md 自动追加上限，达到后跳过不截断
```

**哪些可在设置面板实时切换（免重启）**：`enabled` / `forgetEnabled` / `identityAuto` / `identityIntervalMs` / `refineIntervalMs` / `peakHourSuppress`——这些经 dsh 设置页「记忆」面板读写，settings 用户层覆盖 cordis config，改动 live 生效。

---

## 五、存储布局

```
~/.dsh/memory/
└── memory.db              # SQLite (node:sqlite), WAL
    ├── memories           # 语义事实（含 window_freq/window_start/archived_at）
    ├── mem_fts            # FTS5 语义索引
    ├── episodes           # 情景会话摘要
    ├── ep_fts             # FTS5 情景索引
    ├── failure_memories   # 纠错留痕
    ├── forget_runs        # 遗忘审计
    ├── forget_deleted     # 真删快照（内容+原因，可回滚/可查）
    └── identity_synced    # user.md 增量同步去重指纹
```

身份文件（不进 memories 表）：`<memoryHome>/memory/soul.md`、`<memoryHome>/memory/user.md`。

---

## 六、使用示例

```text
# Agent 记入一条用户偏好（layer=user → 永生，自动进 user.md）
memory  action=add  layer=user  topic="用户偏好"  importance=5  content="用户偏爱简洁、结构化的中文回答"

# 记一条一般教训
memory  action=add  layer=memory  topic="部署教训"  importance=4  content="harness 推送 master:main 到 gitcode"

# 跨层召回
memory_recall  query="用户的回答风格偏好"  scope=semantic
memory_recall  query="上周关于部署的讨论"    scope=episodic
```

---

## 七、开发

```bash
# 一键构建：自动定位 deepseek-harness（DSH_HARNESS_ROOT 优先），从其 pnpm store
# 自动探测 esbuild / @types/react / typescript 最高语义版本（不硬编码），
# 随后 tsc 类型检查（Node + client）+ esbuild 打包 client。
node build.mjs
# 冒烟（无 dsh 也可跑，全量断言组 G1–G23）
node smoke.mjs
```

提交的 `tsconfig.json` / `tsconfig.client.json` 仅为开发机 IDE 默认；构建不用其中的硬编码路径。前端 client 入口为 `exports["./client"]`（`dsh.client.platform: "web"`），esbuild 打包成 `window.__ModuleLoader__.load` 格式（react 走 shell 单例，不打进 bundle）。

---

## 八、状态与兼容性

- **核心闭环完成**：三层存储、全局直写、跨会话召回、双信号热度、主动遗忘（三级阶梯 + 双遗忘面 + 审计 + 免疫 + 真删快照）——`smoke.mjs` 全部断言组（175 项）全绿、稳定连跑，`tsc` 零错误。
- **真机联调通过（2026-08-31）**：「记忆」设置项出现、面板控件渲染正常；`curl /memory/identity` 路由通；设置页关「记忆总开关」→ 新会话 agent 不再记得（live 生效铁证）。
- **后台凝练 L1/L2**：v3 休眠（仅零 LLM 骨架 + 纯规则降级/归档），为后续接线预留、遵循先护栏后接线纪律。
- **KV Cache**：Tier0 现算，写路径会按变动位置影响前缀缓存命中（见 §2.5）。

---

## 设计文档

- `docs/DESIGN.md` —— v3 设计稿（设计哲学、双信号热度推导、主动遗忘门槛、凝练管道）。
- `docs/REFINE-REDESIGN.md` —— 凝练管道重构方案（L0/L1/L2 触发与降级）。
