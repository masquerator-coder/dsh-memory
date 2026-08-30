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
memoryHome: <path>           # 存储目录（默认 ~/.dsh）——注意：库文件会放在 <memoryHome>/memory/memory.db，
                             # store 会在该路径下再拼一层 memory/。想让库落在 ~/.dsh/memory/memory.db，
                             # 就设 ~/.dsh，不要设 ~/.dsh/memory（否则会得到 ~/.dsh/memory/memory/memory.db）
enableInjection: true        # Tier0 常驻 section
budgetTier0: 900             # 常驻核心字符预算
budgetUser: 400
budgetMemory: 500
importanceThreshold: 3
epistemicWeighting: true
forgetEnabled: true          # 主动遗忘开关
forgetDays:                  # 期望遗忘时间（天）；0 = 立即过冷（下一次遗忘扫描即降级/归档，仍受重要性与观察期门槛保护）
  env: 365
  lesson: 180
  decision: 90
  general: 60
windowDays: 30               # frequency 滑动窗口（天）
episodeRetentionDays: 180    # episodes 归档时间（天）
forgetObserveDays: 30        # 归档→真删观察期（天）

# --- 后台凝练 L0 / L1 / L2 ---
# 路由跟随 dsh 模型选择，勿写死：L0 缺省用当前会话 request-header 的 provider/model，
# L1/L2 缺省按 会话路由 → 宿主导航模型(agentDefaultModel) 回退。若显式写死某个 provider
# 而无对应凭证，会导致 LLM 调用失败、refine 全程 degraded。留空 = 跟随，适合共享给不同用户。
l0Summarize: 'llm'           # 'llm' | 'rules'（L0 会话→情景摘要）
l0Provider: ''               # L0 显式路由（缺省用会话 request-header；建议留空跟随）
l0Model: ''
l0MaxTokens: 400
l0TimeoutMs: 8000            # L0 LLM 端到端超时（P1-10）
l1Enabled: true              # L1 情景→稳定事实抽取（LLM 决策）
l2Enabled: true              # L2 语义簇合并/仲裁（LLM 决策）
l1Provider: ''               # L1/L2 显式路由（缺省：会话路由→宿主导航模型；建议留空跟随）
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
# --- M5 会话收口 ---
l0IdleMinutes: 30            # turn-end 只做零 LLM 规则留痕；会话空闲≥此分钟数才一次性 LLM 收口
checkMinutes: 5              # idle 收口判定周期（分钟）
# --- M7 L2 增量 ---
l2Incremental: true          # 只重审"自上次审定以来有成员变化"的簇，稳定簇零 LLM
# --- M8 峰时抑制（省 LLM API 钱）---
suppressWindows:             # 这些时段 L1/L2 后台 LLM 不跑（按下方 timeZone 计算，"HH:MM" 当天窗口）
  - start: '09:00'           #   默认北京 API 峰谷电价峰时
    end: '12:00'
  - start: '14:00'
    end: '18:00'
suppressLeadMinutes: 15      # 每个峰时开始前 15 分钟也不触发
timeZone: 'Asia/Shanghai'
peakHourSuppress: true       # 忙闲时段扫描总开关（设置页可切换；false=任何时候都跑后台 LLM 凝练）
# --- M9 身份块 ---
enableIdentity: true         # 注入恒定 soul.md / user.md 身份 section（文件放 <memoryHome>/memory/ 下）
# --- R3-total: 记忆总开关 ---
enabled: true                # false → 新会话不注入任何记忆（清洁会话），后台整理/遗忘/维护全停；memory 工具保留（可主动查）
# --- R3-i: 身份文件自动维护 ---
identityAuto: true           # 自动把 layer=user 稳定记忆增量写入 user.md（soul.md 由人写，不自动）
identityIntervalMs: 21600000 # 维护 pass 周期（默认 6h）；先扫描，无新增内容则不写入
identityMaxBytes: 2000       # user.md 自动追加的内容大小上限（字节），达到后跳过追加、不截断

# 以上 enabled / identityAuto / identityIntervalMs / refineIntervalMs / peakHourSuppress
# 同时经 dsh 设置页「记忆」面板（settings 命名空间 `memory`）实时读写——settings 用户层
# 覆盖 cordis config（base），改动 live 生效无需重启。
```

> 运行时要求：Node **>=22.5**（`node:sqlite`；24 才稳定）。见 `package.json` 的 `engines`。

## 开发

```bash
# 一键构建：自动定位 deepseek-harness（DSH_HARNESS_ROOT 环境变量优先，否则
# 探测 D:/Apps、C:/Apps、~/deepseek-harness 等常见位置），并从其 pnpm store
# 自动探测 esbuild / @types/react / typescript 的**最高语义版本**（不硬编码
# 版本号），随后 tsc 类型检查（Node + client）+ esbuild 打包 client。
# 提交的 tsconfig.json / tsconfig.client.json 仅是开发机 IDE 默认；构建不用其中的硬编码。
node build.mjs
# 冒烟（无 dsh 也可跑，全量断言组 G1–G23）
node smoke.mjs
```

`lib/` 已提交，消费者（含 git 安装）无需工具链。前端 client 入口为 `exports["./client"]`（`dsh.client.platform: "web"`），esbuild 打包成 `window.__ModuleLoader__.load` 格式（react 走 shell 单例，不打进 bundle）。

## 状态

- **M0-M3 完成**：幂等 schema、跨会话直写召回、情景层、双信号热度、主动遗忘（三级阶梯 + 双遗忘面 + 审计 + user 免疫 + 真删快照）——`smoke.mjs` 全部断言组（175 项）全绿、稳定连跑，`tsc` 零错误。
- **M4 真机装载**：已完成（2026-08-29，独立库 `~/.dsh/memory-v3`，见 Obsidian 断点）。
- **M5 会话收口**（REFINE-REDESIGN 方案 1）：turn-end 只做零 LLM 规则留痕；LLM 升级延迟到会话 idle≥`l0IdleMinutes` 后一次性收口（`condenseSession`，原地升级不重复建行）。
- **M6 L1 事件排程**：新 episode 写入或收口后 ~10s 触发 refine（`kickRefine`），周期 timer 兜底。
- **M7 L2 增量**：新表 `l2_refined`；只审成员 `updated>refined_at` 或从未审过的簇，稳定簇零 LLM（空转归零）；降级 pass 不落指纹、LLM 恢复后会补审。
- **M8 峰时抑制**：`isSuppressed`（默认北京 09–12/14–18 点 + 前 15min）gate L1/L2 后台 LLM，纯省 API 钱。
- **M9 身份块**：`soul.md` / `user.md` 恒定 section（mtime 缓存、KV 友好、无 BOM 兼容），位置 `<memoryHome>/memory/`。
- **P2-37（replace 保持 topic）**：`memory` 工具 replace 未显式传 `topic` 时保留原条目 topic，不再回落 `general`——避免拆散同 topic 的 L2 簇。
- **R3-total（记忆开关）**：`enabled=false` 时新会话为不注入任何记忆的清洁会话（tier0 / 身份 section 均不注入），后台整理/遗忘/身份维护全停；`memory`/`memory_recall` 工具保留供主动使用。
- **R3-i（身份文件自动进化）**：`autocreateIdentityFiles` 启动即自动建空白 soul.md/user.md；`maintainUserIdentity` 纯规则 pass（零 LLM）把 `layer=user` 稳定记忆增量写入 user.md——用 `identity_synced` 表按 `contentId` 去重，**无新增内容则不写入**（先扫描的守卫），文件超过 `identityMaxBytes` 后跳过追加、绝不截断。soul.md 保留人工维护（AI 人格是设计决策，不由凝练自动生成）。
- **R3-ui（设置页面板）**：在 dsh 设置页左侧新增「记忆」设置项（官方 `settings.section` slot）——记忆总开关、user.md 自动进化开关、身份维护扫描间隔、忙闲时段抑制开关、soul.md/user.md 内联编辑。前端 client 入口（`exports["./client"]` + esbuild 打包成 ModuleLoader 格式），通过 `ctx.settingsScope.bind({namespace:'memory'})` 读写 `memory` 设置命名空间（后端 `ctx.settings.register` + `scope.watch` live 热生效）；soul/user 文件经 `/memory/identity` HTTP 路由读写（文件仍为真相源，可人工手编）。

## soul.md / user.md（M9）

放 `<memoryHome>/memory/soul.md`（AI 自身人格/行为准则，人写）与 `user.md`（用户长期画像，可提炼+人审）。纯 markdown，可人工编辑、可 Git 追踪；作为**恒定 section** 注入（`order:11/12`），文件 mtime 变化才重读 → KV 缓存友好，弥补 Tier0 现算对前缀缓存的扰动。不进 memories 表（不该被热度/遗忘管）。文件缺失则 section 省略。Windows 下写入必须**无 BOM UTF-8**（`\uFEFF` 会被剥离，但建议源头避免）。

## KV Cache effect

Tier-0 section（`order:10`）每次 prompt 装配**现算**，文本随记忆变更而变化。写入（turn N）后，turn N+1 起的系统提示词在 section 位置**之后**的 token 前缀缓存失效（命中深度回退）。规律：

- **append-only**（新增弱影响记忆，不移动已有行）→ 只在 section 末尾追加，位置之后的缓存重算量小。
- **replace / remove**（改写或删除已有行）→ 改动位置之后的 token 全量重算，代价最大。
- 主题行（topics 摘要）与内容行顺序变化同样会打断前缀稳定性。

写代码时遵循：

1. 想要**跨会话稳定的记忆**，尽量在会话早期写入（随后缀同在前缀稳定之后），日常把「新会话再写」当默认。
2. 会话中途的频繁 `replace/remove` 检索类操作走 `memory_recall`（不落盘、不动 section），别用写工具冲刷常驻区。
3. 别在同一场会话里反复改预算/开关等会影响 section 内容的配置——要改就在新会话开头。

综上属**"独立一次请求 + 稳定重复前缀"之间的动态注入**：写路径改变时以"从第一个变动的 token 起复用失效"计账。

## 设计文档

完整设计见 `docs/DESIGN.md`（v3 三层凝练记忆体系设计稿）。
