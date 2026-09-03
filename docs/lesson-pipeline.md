# dsh-memory — LLM 轻量旁路介入与教训沉淀管道（design）

> 状态：**已实现（2026-09-02），smoke G26–G33 全绿**。范围：`add / replace / delete / refine(L0/L1/L2) / forget / inject / recall`
> 全链路判定点审计 + 需要 LLM 轻量旁路介入的环节 + 核心新增「纠错→教训」管道。
> 2026-09-02 定稿于方法 2 论证。

---

## 0. 设计原则（最高优先级，一切改动不越过这条线）

**旁路 LLM，绝不污染正在执行任务的上下文。** 四重硬保证（沿用项目 `llmText` / `summarizeLlm` 的既有 seam 形态）：

| # | 保证 | 机制 |
|---|---|---|
| 1 | 上下文隔离 | 判定 prompt 是独立构造的 `messages` 数组（`refine.ts` L172-180、`l0.ts` L186-229），只含喂给判定器的极小输入，绝不读、绝不写当前 agent 的执行上下文 |
| 2 | 非阻塞 | 即时判定 fire-and-forget 排队；复用 `refining` 重入锁 + `scheduleRefine` 非阻塞 `unref()` timer（`index.ts` L529-536），不卡主循环 |
| 3 | 结果只落库、不回流 | 判定产物只写 `lesson_drafts → memories`，不注入当前会话、不进 Tier0 常驻（`inject.ts` 只注入 preference/env）、不写回主对话 |
| 4 | 输入最小化 + 成本闸 | 喂给判定器的只是一对 old/new + 主题 + 来源标签，非会话原文；输出受 `maxTokens` 限制；叠 `peakHourSuppress` 峰时抑制 + 周期批量兜底 |

零 LLM 主干并非"必须遵守"，而是**默认底座**：`recordFailure` 始终即时、纯规则写审计痕迹（健壮、永不因 LLM 挂掉而丢证据）；LLM 是**增强层**，凡能取得更好判定效果就用，但全部旁路、全部可配、全部可降级回规则。

---

## 1. 全链路判定点审计（add / delete / replace / refine / forget / inject / recall）

### 1.1 add（写入）

| 判定点 | 当前实现 | 局限 | LLM 轻量介入 | 结论 |
|---|---|---|---|---|
| `kind` 类别 | `inferKind` 纯正则（`store.ts` L1218-1225，关键词匹配） | 口语化/抽象记忆常判错：如"用户讨厌红色系"判 `general`，实为 `preference` | **高** | **介入**（§3.1）：kind 直接决定遗忘桶（env 365d / lesson 180d / decision 90d / general 60d）与常驻资格，判错即错判寿命 |
| `importance` | 未提供默认 3（`store.ts` L410） | 无判别；`>=5` 的免疫删除 / 永不降级保护形同虚设 | **高** | **介入**（§3.1）：importance 直接决定免疫 / 常驻 / 遗忘门槛 |
| `quality` / `low_quality` | `qualityScore` 纯规则（`quality.ts` L81-95：长度/元词/近重复） | 优质简短事实可能误判低质→默认不注入不召回 | 中 | 保留规则（hot path + 刻意保守），不介入 |
| `tier` 常驻 | `autoTier` 纯规则（`store.ts` L422-427） | 依赖 kind/importance，修正上述两项即可 | — | 跟随 §3.1 的 kind/importance 结果，无需独立 LLM |
| dedup `findCanonical` | 写时严格 `SIM_DUP≥0.85` 合并（`store.ts` L330-354） | 语义重复合并不了，靠 L2 后台兜底 | 中 | 不介入（hot path + 已有 L2 后台仲裁扇区） |

### 1.2 replace（纠错）— **本设计的核心入口**

| 判定点 | 当前实现 | 局限 | LLM 轻量介入 | 结论 |
|---|---|---|---|---|
| 纠错类型判定 | 无（`recordFailure` 只写审计痕迹，`store.ts` L587-589 / L529-531） | 分不清"原始记错 / 记忆过时 / 纯措辞 / 冲突"，痕迹对 `memory_recall` 隐身、无法沉淀为可召回教训 | **高** | **介入（核心）** 见 §2 lesson pipeline |
| 被纠正记忆的遗忘保护 | `pendingCorrectionIn` 纯规则（`heat.ts` L107-119） | 正确、已实现，保留 | — | 保留 |

### 1.3 delete / forget（遗忘）

| 判定点 | 当前实现 | 局限 | LLM 轻量介入 | 结论 |
|---|---|---|---|---|
| demote/archive/delete 决策 | 纯热度+重要性规则（`heat.ts`，`store.ts forgetRun` L1118-1215） | `window_freq` 是"召回命中代理信号"，非真实价值；重要但冷门的记忆会被误降级/误归档 | **中高** | **介入（可选，§3.2）** 低频批量操作，成本低、防误删价值真实 |

### 1.4 refine 凝练（L0 / L1 / L2）

| 判定点 | 当前实现 | LLM 介入现状 | 结论 |
|---|---|---|---|
| L0 会话→情景摘要 | 已是"LLM 增强 + 规则兜底"（`l0.ts` L186-229） | 已是旁路 | 保留 |
| L1 情景→稳定事实 | 已 LLM 决策（`refine.ts buildL1Prompt` L137-147） | 已是旁路，但只抽"stable facts"，**未显式识别会话内失误/纠正** | **强化（§2.4）**：让判断器同时产出 lesson 候选 |
| L2 语义簇合并/仲裁 | 已 LLM 决策（`refine.ts buildL2Prompt` L148-160） | 已是旁路 | 保留 |

### 1.5 inject / recall

| 判定点 | 当前实现 | 结论 |
|---|---|---|
| Tier0 注入仅 preference/env（`inject.ts` L65） | 教训/决策不常驻、召回式呈现 | 保留（教训是被动防御知识，不碰 KV 前缀） |
| `recall` FTS5 + 加权（`store.ts` L737-） | 纯检索 | 保留（无 LLM 收益） |

---

## 2. 核心：纠错→教训沉淀管道（lesson pipeline）

### 2.1 数据流

```
信号源                    LLM 判定(旁路 seam)           沉淀              保证
replace/合并冲突 ──▶ recordFailure（零LLM，即时，永不失败）
    (现成hook)          │
                        ├(可选)即时判定: 极小 prompt(old/new+主题)
                        │    └ LLM 判定 → 值得: memory add kind=lesson（LLM重写自然语言）
                        │                     不值得: 仅留审计              ← 非阻塞/不入当前上下文
                        └ 后台周期兜底（lesson_drafts 累积，继承 runRefine
                            调度/峰时/重入锁/审计）→ 批量 LLM 升格           ← 全继承，零接线成本
```

### 2.2 schema 增补（`schema.ts`，幂等 `CREATE TABLE IF NOT EXISTS`）

```sql
CREATE TABLE IF NOT EXISTS lesson_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id    TEXT NOT NULL,               -- 被纠正的源记忆
  topic        TEXT NOT NULL DEFAULT 'general',
  old_content  TEXT,
  new_content  TEXT,
  lesson       TEXT,                         -- 预拼装的教训草案 / LLM 重写自然语言
  source       TEXT NOT NULL DEFAULT 'replace',  -- replace | merge-conflict | l1
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft | promoted | dropped
  draft_count  INTEGER NOT NULL DEFAULT 1,       -- 同 memory_id 被纠正次数（聚合防堆叠）
  drafted_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lesson_drafts_status ON lesson_drafts(status, drafted_at);
```

### 2.3 留痕（零 LLM 底座，即时）

`recordFailure(memoryId, old, new)`（`store.ts` L1083-1086）内并联一次 upsert：
- 同 `memory_id` 未决草案 → `draft_count += 1`（聚合频繁纠错为元信号，防堆 lesson）
- 否则插入新草案，`lesson` 先填规则模板：`判断曾被纠正：原记"{old}"，更正为"{new}"。`

### 2.4 升格（旁路 LLM，即 ①即时 + ②周期 双通道）

`runRefineLessonPromote(store, {llm, provider, model, maxTokens, timeoutMs, instant})`：

- **输入**：一条/一批草案的 `{old_content, new_content, topic, draft_count}`。
- **判定 prompt**（复用 `llmText`，旁路；maxTokens 低、输入极小）：
  ```
  You are the lesson judge of an AI memory system. A stored fact was corrected.
  Classify: (a) wrong-original 原始记错 → 教训"关于X应记Y,因曾误记为Z";
  (b) stale 旧记忆过时 → 教训"此类事实易变,用前须复查";
  (c) trivial 纯措辞微调 → drop, 不沉淀.
  Also output kind=lesson importance(1-5) epistemic. JSON only.
  ```
- **决策**：`(a)/(b)` → `memory add kind=lesson`（走 `store.batch`，自动过 findCanonical 去重 / quality / tier / heat），`status=promoted`；`(c)` → `status=dropped`；LLM 失败/超时 → 草案保留待下次，`refine_runs` 记 `degraded`。
- **L1 增强**：`buildL1Prompt` system 追加一行"若摘要中出现判断失误/被纠正，额外输出一条 kind=lesson 候选"，把会话内事故也接进沉淀闭环（覆盖"replace 未发生"的口头纠正场景）。

### 2.5 调度接线（`index.ts runRefine` L475-528 末尾）

```ts
if (lessonDraftEnabled) await runRefineLessonPromote(store, { llm, provider: route?.provider,
  model: route?.model, maxTokens, timeoutMs })   // instant=true 由 replace 现场 fire-and-forget 触发
```
新 pass 自动**继承**：`refining` 重入锁、`peakHourSuppress` 峰时抑制（force 例外）、`scheduleRefine` 周期、`runNow` 面板「立即整理」、`writeRefineRun` 审计、路由解析。改动近乎零。

### 2.6 设置项（面板可 toggle，live 生效，沿用 `settings.ts` 模式）

- `lessonDraftEnabled`（默认 true）：开关沉淀管道
- `lessonInstantJudge`（默认 true）：replace 现场即时判定（false → 仅周期）
- `lessonUseLlm`（默认 true）：false → 纯规则模板升格（降级兜底），不调 LLM

---

## 3. 扩展点（可选，标注是否阻塞主设计）

### 3.1 add 的 kind+importance 轻量注入（**高价值，建议含在第一版**）

`applyOne` 的 add 分支在写库前，旁路调 `judgeAddMeta(content)`：
- 纯规则 `inferKind` + 默认 importance 先兜底（LLM 缺路/失败/峰时抑制时用规则，绝不阻塞写入）
- LLM 可用时返回 `{kind, importance}`，修正 `store.ts` L456/L410 的默认值
- **收益**：kind 决定遗忘桶与常驻资格、importance 决定免疫，判准后记忆寿命与保护真实生效
- **代价**：每次 add 一次极小旁路调用（输入=content 单条），峰时抑制可关

### 3.2 forgetRun 候选删除复核（**可选**，非阻塞，第二阶段）

`forgetRun` 的 delete 前提集（已过 `shouldDelete` 门槛者）在硬删前旁路批量复核一次：
- prompt：给一批{content, importance, heat}，问"这些里有无高价值不应删的"，标保护
- 命中 → 该条跳过硬删并记审计（`forget_runs` decisions 记 `protection:llm:<id>`）
- 收益：对冲 heat 代理信号的误删；低频批量，成本低
- 风险：遗忘会延迟一个观察期（复核即保护）；需审计可回滚

> 开始建议范围：先做 §2（lesson pipeline）+ §3.1（kind/importance 注入）。§3.2 独立、可后置，不阻塞。

---

## 4. 迁移 / 回滚 / 兼容

- 新表走 `schema.ts` 幂等 DDL，老库自动升级，无破坏性迁移
- 新 pass 全部在 `runRefine` 内串行、异常 try/catch 包裹（复用现有 `catch → console.warn`），不影响核心读写
- 关闭 `lessonDraftEnabled` → 回退到当前行为（仅 `recordFailure` 审计），存量 `lesson_drafts` 滞留在表内无害
- 所有 LLM 调用沿用 `llmText` / `summarizeLlm` 形态：独立 seam、无 dsh 依赖泄漏、可被测试 stub

---

## 5. 验证（smoke.mjs G 组）

| # | 断言 |
|---|---|
| G26 | `replace` 后 `lesson_drafts` 出现草案（双写）且 `draft_count` 聚合正确 |
| G27 | `runRefineLessonPromote` 把 (a)/(b) 类写成 `memories kind=lesson` 行 |
| G28 | 二度升格同主题被 `findCanonical` 去重（仍 1 条） |
| G29 | (c) 类草案 `status=dropped`，且 `refine_runs` 记录决策 |
| G30 | LLM 降级/缺路时：即时判定跳过、周期保留草案、`recordFailure` 仍写入（零 LLM 底座健壮性） |
| G31 | **判定过程不入 agent 上下文**：断言判定所用的 seam 调用 messages 与主 agent 执行上下文无关（输入仅含草案字段） |
| G32 | `lessonInstantJudge=false` 时即时判定不触发，仅周期 |
| G33 | `lessonUseLlm=false` 时纯规则模板升格，无 seam 调用 |

真机（沿用 2026-08-31 联调模式）：手动 `memory replace` 一条记忆 → 面板「立即整理」→ `sqlite3` 查 `memories where kind='lesson'` 出现教训，`memory_recall` 能召回。

---

## 6. 文件改动清单（全部在插件内）

| 文件 | 改动 |
|---|---|
| `src/schema.ts` | `lesson_drafts` 表 + 索引 |
| `src/store.ts` | `recordFailure` 内并联写草案；`listLessonDrafts/markLessonDraftStatus`；add 分支接 `judgeAddMeta`（§3.1） |
| `src/refine.ts` | `runRefineLessonPromote` + `judgeAddMeta` + 判定 prompt；`buildL1Prompt` 增强 |
| `src/index.ts` | `runRefine` 末尾接新 pass；recordFailure 现场 fire-and-forget 即时判定 |
| `src/settings.ts` | 三设置项 |
| `smoke.mjs` | G26–G33 |

---

## 7. 实现记录（2026-09-02）

- **基线修复（前置）**：deepseek-harness 升级后 `Session.events` public 属性移除 → 改为 `Session.snapshotEvents()`（index.ts 三处）。**仅改 dsh-memory 插件，未侵入 harness**。
- **§2 lesson pipeline 已实现**：schema `lesson_drafts` 表；store `recordFailure` 零 LLM 双写（`upsertLessonDraft` 聚合 draft_count）+ `listLessonDrafts`/`getLessonDraft`/`markLessonDraftStatus` + 可选 `onLessonDraft` 钩子；refine `runRefineLessonPromote`（LLM 判定 / 纯规则兜底 / degraded 保留）+ `buildLessonJudgePrompt`/`parseLessonJudgements`；index `runRefine` 周期末 pass + `store.onLessonDraft` 即时 fire-and-forget。`refine_runs.level=3` 记 lesson 决策。
- **§3.1 kind/importance**：~~实现 `judgeAddMeta` + `buildAddMetaPrompt`/`parseAddMetaJson` 能力 seam~~（**2026-09-03 审计后删除**：全项目零调用的死代码，接入 add 热路径的方案仍延后；需要时从 git 历史恢复）；lesson 升格已正确标注 `kind=lesson` 与 LLM 判 importance。**普通 add 热路径的异步旁路修订**（对存量 `kind=general/importance=3` 条目批量校准）按"绝不阻塞 + 只落库不回流"原则作为独立校准 pass **延后**（侵入 add 热路径需异步重构，风险高，不做坏本轮稳定交付）。
- **§3.2 forgetRun 删除复核**：未实现（设计稿明确为非阻塞、第二阶段）。forgetRun 处留思路注释。
- **L1 增强已实现**：`buildL1Prompt` system 追加"若摘要含纠正/失误，额外输出 kind=lesson 候选"。
- **三设置项** `lessonDraftEnabled`/`lessonInstantJudge`/`lessonUseLlm` 已接入 settings 面板 + runtime live watch。
- **验证**：`npm run build` EXIT=0（tsc strict 零错误），`npm run smoke` **204 passed / 0 failed**（基线 187 + 新增 G26–G33 17 项全绿）。

