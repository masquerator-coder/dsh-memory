# dsh-memory 整理触发与身份块改造方案

> 状态：**方案稿 v1.0（review 前）**，待付强审。
> 背景：对照 dsh-meow-memory（跨会话记忆插件）后，审视 dsh-memory 的自动整理触发机制，
> 提出"L0 会话收口 + L2 增量指纹 + 峰时抑制"，并为项目新增 soul.md / user.md 身份块。
> 本方案不改动核心存/查/写/遗忘语义，只改**触发时机**与**注入面**，单一职责不变。

---

## 0. 消费结论（先给结论，再展开）

| 想改的点 | 现状 | 是否值得 / 怎么改 |
|---|---|---|
| L0 每回合 LLM 摘要 | 每 turn-end 立即跑，会话进行中反复烧 token | **值得收口**：LLM 增强改为"会话 idle 后一次性收口"，规则留痕实时保留 |
| L1 定时扫 | 已是增量（`extracted` 标记驱动），只处理 pending | 保留，补"L0 收口后事件触发排程"提响应，周期兜底不动 |
| **L2 每轮全库重审** | **每 1h 把所有 topic 簇全交给 LLM**，哪怕库一字节没变 | **最该改**：加"簇指纹/updated 判据"，没变的簇零 LLM 跳过 |
| forget 定时全扫 | 纯规则、不烧 token | 低优先，最多做增量扫描，可先不动 |
| 峰时抑制 | 无 | **值得抄 meow**：L1/L2 LLM 路径加峰时 gate，纯省钱，正交于空闲 |
| soul.md / user.md | 无（只有 memories `layer=user`）| **值得加**，用"常驻文件 + 独立恒定 section"，见 §5 |

一句话：**dsh-memory 真正的空转点是 L2（不是 L0/L1）**；L0 是"烧太勤"、L2 是"烧太空"。

---

## 1. 现状盘点（基于 src 实读）

### 1.1 L0（会话→情景摘要）— `src/index.ts` + `src/l0.ts`
- 触发：`ctx.on('session/event')`，`isCompletedTurnEnd`（`turn/end` 且 `reason.kind==='completed'`）→ 立即 `runL0`。
- 路径：`summarize:'llm'` 时**每一回合都走 `summarizeLlm`**（有 `l0InFlight` 并发上限），否则 `summarizeRules` 纯规则。
- 粒度：每回合 `addEpisode` 一条（episodes 表按回合累加）。
- 问题 A：会话进行中每回合都调 LLM，token 反复烧；
- 问题 B：摘要是对"回合中间态"做的，会话没结束信息不全，之后还得重写。

### 1.2 L1（情景→语义抽取）— `src/refine.ts` + `store.listEpisodesForRefine`
- 触发：`runRefine` 定时器（`refineIntervalMs`，默认 1h，boot 后 2min 首跑）。
- 增量性：`listEpisodesForRefine` 只取 `extracted=0` 的 pending episode（limit 20）——**已是增量**，无 pending 则零 LLM。
- 问题：响应慢（最坏等 1h），但**不空转**。收益小。

### 1.3 L2（语义内合并/仲裁）— `src/refine.ts` + `store.semanticClusters`
- 触发：同一 `runRefine` 定时器，`runRefineL2`。
- 现状：`semanticClusters({min:2, limit:20})` 每轮返回**所有 ≥2 成员的 topic 簇**，逐个交给 LLM 出 merge/keep/drop/correct 判定。
- **问题（核心空转）**：即便库一个字节没变，所有簇每 1h 都被 LLM 重审一遍。没有任何"这簇自上次审过以来变没变"的判据。

### 1.4 forget（主动遗忘）— `src/store.ts` `forgetRun`
- 触发：定时（`FORGET_FIRST_DELAY_MS`）。纯规则、单事务全库扫。
- 成本：n 条 memories + n 条 episodes 的规则判定，不烧 token。低优先优化。

---

## 2. 目标

1. **L0**：让 LLM 摘要"花在值得的时刻"——会话尘埃落定后一次性收口，而非每回合烧。
2. **L2**：让 LLM 只审"自上次审定以来发生过变化"的簇，稳定簇零 LLM。
3. **L1**：提高响应（事件驱动排程），周期兜底。
4. **峰时抑制**：L1/L2 的 LLM 在 API 峰谷电价峰时跳过，纯省钱。
5. **身份块**：soul.md / user.md 常驻注入，可人工编辑、Git 可追踪、缓存友好。

全程不改动：核心存/查/写/热度/遗忘语义、`memory` / `memory_recall` 工具契约、零 LLM 主循环铁律。

---

## 3. 改造设计

### 3.1 P0 — L0 会话收口（LLM 摘要从"每回合"→"会话 idle 后一次性"）

**思路**：把 L0 拆成两段——
- **规则路径（零 LLM，实时）**：turn-end 立即 `summarizeRules` 并 `addEpisode`（现状保留）。零成本，保住"会话结束即有留痕"的实时价值。
- **LLM 增强路径（可选，收口）**：从"每回合都 `summarizeLlm`"改为——turn-end 把会话标进"pending LLM 收口队列"并记录 `last_activity`；当该会话 **idle ≥ `l0IdleMinutes`（默认 30min，可配）** 后，对整段会话做**一次性 LLM 摘要**，写为一条 topic 化 episode（或覆盖该会话最近一条 episode）。

**idle 判定**：不新增事件流。复用后台定时器，每 `checkMinutes`（默认 5min）扫 pending 队列，判定 `now - last_activity >= l0IdleMinutes`。会话进行中 last_activity 不断刷新 → 永不提前收口；会话中断后一个 check 周期内收口。

**改动面**：
- `src/index.ts`：turn-end hook 从"直接 runL0(llm)"改为"规则 runL0 + 入 pending + touchActivity"；新增 idle 判定循环。
- `src/l0.ts`：`runL0` 增加 `wholeSession` 分支（多回合聚合文本 → 一次 LLM 摘要 → 写一条会话级 episode）。
- `store.ts`：加 `lastEpisodeForSession(sessionId)` / `upsertEpisode`（by id 覆盖，已有 `upsertEpiStmt` 可复用）。

**成果**：会话进行中 0 次 LLM 摘要；收口一次、信息完整、质量最高。

> 备选**最小改**（若不想动 episodes 粒度）：不加收口队列，只在 turn-end 判断"本回合距上一回合结束 ≥ `l0IdleMinutes`"才对该回合走 LLM，否则规则。改动约一行级，收益打对折。**推荐方案 1**。

### 3.2 P1 — L1 事件驱动排程（小改）

- turn-end（或空闲收口）写入一条新 episode 后，直接 `scheduleRefine(短延迟, 如 10s)` 触发一次 runRefine。
- `refineIntervalMs` 周期 timer 保留为兜底（进程重启后补跑、漏触发兜底）。
- 无新 episode → 不排程，空转不变（本就增量）。

### 3.3 P2（核心省 token）— L2 增量指纹

**思路**：L2 只审"簇内存在 `updated > refined_at` 的成员，或该 topic 从未被审过"的簇。

**存储**：新增一张表（不改 memories 列，少迁移）。
```sql
CREATE TABLE IF NOT EXISTS l2_refined (
  topic      TEXT PRIMARY KEY,   -- 簇的主题
  refined_at INTEGER NOT NULL    -- 上次对该簇审定时间
);
```

**改动**：
- `store.semanticClusters` 增加 `recentSince?: number` 参数：只在簇存在 active 成员 `updated > recentSince`、或该 topic 不在 `l2_refined` 时返回该簇。
- `runRefineL2` 每轮：
  1. 取 `this.l2Refined` 得到各 topic 的 `refined_at`，取 `recentSince = min(refined_at)`（或当前轮起点）；
  2. `semanticClusters({ recentSince })` 只拿到值得审的簇；
  3. 审完（无论 ok / degraded / 空判定）`upsertL2Refined(topic, now)`。
- 任何 `add/replace/correct` 都刷 `updated`（现有逻辑已如此）→ 天然被捕获；簇稳定 → 后续轮 skip，零 LLM。

**初始化**：老库无 `l2_refined` → 首次全簇审一次，之后稳态。幂等迁移（`CREATE TABLE IF NOT EXISTS`）。

**审计**：skip 的簇不追加 `refine_runs`（避免 audit 噪音），只有真正过了 LLM 的簇落 audit，状态新增 `skip` 语义或用 ok-noop 标识一次即可。

**成果**：库静止时 L2 每轮 0 次 LLM 调用，空转归零。

### 3.4 P3 — forget（低优先，可先不动）

现状纯规则不烧 token，全库扫毫秒级。可选做增量（只扫最近 `updated/created` 窗口的 memories/episodes + 每日全量兜底），但收益小、会加复杂度。**建议维持现状**，把精力留到 P0/P2。

### 3.5 P4 — 峰时抑制（L1/L2 LLM 省钱 gate）

独立于空闲门槛，正交旋钮。包一层纯函数：
```ts
// src/refine.ts 或独立 idle.ts，纯函数可测：
function isSuppressed(now: Date, cfg: { suppressWindows: {start:string;end:string}[]; suppressLeadMinutes:number; timeZone:string }): boolean
```
- 在 `runRefine`（L1/L2，烧 token）入口判断：峰时（默认北京 09–12 / 14–18 点）及每个峰时开始前 `suppressLeadMinutes`（默认 15）分钟内 → `return`（本轮 skip，下个周期再试）。
- L0 规则路径、forget（零 token）不 gate。
- 配置：`suppressWindows` / `suppressLeadMinutes` / `timeZone`，默认北京。`enabled` 可关。

### 3.6 配置新增（全部可选）

```yaml
# L0 会话收口
l0IdleMinutes: 30      # 会话空闲 ≥ 此分钟数，对该会话一次性 LLM 收口（默认 30）
checkMinutes: 5        # idle / 收口 判定周期
# L2 增量
l2Incremental: true    # 只审有变化的簇（默认开）；false = 退回现全量
# 峰时抑制（省 API 钱，烧 LLM 的后台路径）
suppressWindows:
  - start: '09:00'
    end: '12:00'
  - start: '14:00'
    end: '18:00'
suppressLeadMinutes: 15
timeZone: 'Asia/Shanghai'
```

---

## 4. store API 改动清单（函数级）

| 方法 | 位置 | 动作 |
|---|---|---|
| `semanticClusters({ recentSince })` | store.ts | 扩展：只返回有成员 `updated > recentSince` 或 `topic ∉ l2_refined` 的簇 |
| `upsertL2Refined(topic, ts)` | store.ts | 新增 |
| `l2RefinedSince()` | store.ts | 新增（返回各 topic 的 refined_at）|
| `lastEpisodeForSession(sessionId)` | store.ts | 新增（P0 收口覆盖用）|
| `upsertEpisode(id, {...})` | store.ts | 已有 `upsertEpiStmt`，按需暴露封装 |
| `forgetRun({ onlySince })` | store.ts | 可选（P3，暂不建议）|

`store.ts` 顶部 `initSchema()` 加：
```sql
CREATE TABLE IF NOT EXISTS l2_refined (
  topic TEXT PRIMARY KEY, refined_at INTEGER NOT NULL
);
```

---

## 5. soul.md / user.md 身份块（新增功能）

### 5.1 判断：值得加，且要用"文件 + 恒定 section"而非塞进 memories 表

**为什么不用 memories 表**：
- soul/user 量小、跨会话恒真、**不该被热度淘汰、不该被遗忘**——放进有 heat/forget 的 memories 表，正是给机制添乱（现状 `layer=user` 只是免疫真删，仍按热度排序、占 Tier0 budget）。
- 身份是"给人 / 给提示词"的**稳定文本**，不是"从对话提炼、会被替代"的事实条目。

**为什么用常驻文件（soul.md / user.md）**：
1. **可人工编辑、可 Git 追踪、可 diff**——soul 是设计出来的（付强定），不是 AI 提炼的；user 画像提炼后也需人审（恰好 match 付强 review-before-execution）。
2. **KV 缓存友好**——做成**独立恒定 section**（order 固定，只在文件改动时刷新 section 文本），正好弥补 dsh 现在 Tier0 section 每次现算破坏缓存的问题，是加分项。
3. **对齐 Hermes 范式**（SOUL.md + user profile），付强已熟悉。

### 5.2 存储与注入

```
~/.dsh/memory/soul.md     # AI 人格 / 行为准则（人写）
~/.dsh/memory/user.md     # 用户长期画像（提炼 + 人审）
```
- 注入：system prompt 两个独立 section（`memory:soul` order 稳定、`memory:user` order 稳定）。文件改动时（mtime 变化）重读并重建 section 文本，否则沿用缓存。
- 检索：**不参与 FTS5 / heat / 预算**（常驻全量，无需检索、不该淘汰）。与现有 `memories layer=user` **并存**：user.md 放"谁会这个人、长期画像"，memories user 放"可检索的具体偏好条目"。

### 5.3 工具（可选，建议分两步）

- **第一步（最小）**：仅静态注入 + 手工编辑文件。模型只读。
- **第二步（增强）**：加 `memory_identity` 工具（`get`/`append`/`replace` soul|user）。模型从对话提炼 user 事实 → append 到 user.md；soul 仍人写。所有工具写入走审计（`identity_writes` 或复用 `refine_runs`），且**写入需用户确认**（对齐"纠错留痕"纪律）。

### 5.4 写作规范（soul.md 的定位，重要）

soul.md 本质是**提示词约束，不是自由文本档案**：写"希望 agent 表现的——语言、结构、口吻、边界、行为准则"，按命令式短句，别写成人物散文。user.md 是"关于用户的事实"，同样短句、条目化。（沿付强在《AI辅助数据分析与优化》里的"人定义规则"理念。）

### 5.5 Windows 陷阱（务必，否则踩坑）

沿用授强 SOUL.md 的经验：**写入必须无 BOM 的 UTF-8**。Windows 编辑器/echo 常写 BOM，会让安全扫描器拦截加载、且可能破坏 markdown 首行。写文件用显式无 BOM（`utf8` 而非 `utf8bom`/默认带 BOM 写法），文档同步到 Obsidian 时同样注意。

---

## 6. 里程碑（每步 smoke.mjs 断言收口）

| 里程碑 | 内容 | 断言 |
|---|---|---|
| **M5-L0** | 会话收口：turn-end 规则留痕实时 + 保持 idle 判定 + LLM 一次性收口 | smoke：idle 前 0 次 LLM、idle 后 1 次收口、规则留痕不丢 |
| **M6-L1** | 事件驱动排程（写后 10s 触发），周期兜底保留 | smoke：新 episode 被快速抽取 |
| **M7-L2** | 增量指纹：`l2_refined` + `semanticClusters(recentSince)` | smoke：稳定簇第 2 轮 0 LLM、改一条后只审所属簇 |
| **M8** | 峰时抑制 + forget 增量（可选） | smoke：`isSuppressed` 边界断言 |
| **M9** | soul/user 身份块 + `memory_identity`（分两步） | smoke：section 常量注入、文件改动才刷新、写入审计 |

> 顺序：**M7（最省钱）与 M5（质量）优先**；M6/M8 低风险可并行；M9 独立新功能，可随时插入。

---

## 7. 非目标（不做）

- 不引入向量/embedding 检索（沿用 FTS5 + CJK）。
- soul/user 不做进 memories 表（省迁移、语义独立）。
- 不改核心存/查/写/遗忘主循环的零 LLM 铁律。
- forget 不做重活（现状已够）。
- 本轮不自作主张改代码——方案 review 后再动。
