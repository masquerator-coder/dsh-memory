# 系统提示词重复/冲突分析 — dsh-memory 查检侧优化

> 状态：P0 + P1 + P2-①/P2-② 已实施（IMPLEMENTED 2026-09-06）；P3（顺带项）未动。
> 范围：仅 dsh-memory **查检侧**（注入器逻辑、记忆数据、soul.md/user.md、设置项），**不动 dsh 宿主源码**。
> 配套代码：`src/inject.ts`、`src/index.ts`、`src/time-ctx.ts`、`src/settings.ts`、`src/identity.ts`。

---

## 0. 结论（TL;DR）

dsh-memory 注入到系统提示词的六段（time / custom / protocol / tier0 / soul / user）中，真正与 **dsh 固定提示词重复或冲突**的有两处：

1. **硬冲突（过时记忆 vs 宿主实时状态）**——Tier0 记忆条目 `workspace configuration` 固化了路径
   `D:\Coding\DSH-Plugin\dsh-im-gateway`，而宿主固定提示词实时注入的当前工作目录是
   `D:\Coding\DSH-Plugin\dsh-memory`。记忆会误导模型以为工作在错误目录。这是「库内快照」与
   「宿主真相」碰撞的典型：**凡能从宿主上下文动态读到的状态，就不应固化为语义记忆**。
2. **近重复冗余（同义条目各占 Tier0 预算）**——`project-config` 与 `security and git` 两条记忆
   内容几乎逐字相同（config.json gitignored + 含 secrets），同时注入，浪费预算并重复教导。

另有 **3 个次要问题（非与 dsh 冲突，但属上下文噪音/张力）**：
- `model limitations` 记忆（"AI 不知道当前日期时间"）与 `memory:time` 注入真实日期方向张量，
  在已有 time-injection 后该条信息增益趋近于零；
- `memory:tier0` 每次现算的**统计行**（tier1 领域数 / 情景段数 / 占用比）随库增长变动，
  体积大但信息增益低；
- soul.md 中部分「工程纪律」表述（如"结果必须落真实工具输出"）与 dsh 固定提示词的工具纪律
  语义重叠（温和冗余，非冲突）。

**全部可在查检侧解决，无需动 dsh 源码。**

---

## 1. 注入结构映射（谁是谁）

| 系统提示词位置 | 插件 section（order） | 来源 | 内容性质 |
|---|---|---|---|
| 今天日期 | `memory:time`（5）| `time-ctx.ts` | 数据（KV 稳定，按天）|
| 资深科研助理身份 | `memory:custom`（8）| `settings.customSystemPrompt` | 用户指令（逐字注入）|
| 记忆工具调用 | `memory:protocol`（9）| `inject.ts PROTOCOL_TEXT` | 插件唯一指令段 |
| Persistent memory | `memory:tier0`（10）| `inject.ts buildSection` | 数据（受控）|
| 身份AI 本人 | `memory:soul`（11）| `identity.ts` soul.md | 数据（人写）|
| 用户画像指针 | `memory:user`（12）| `identity.ts` user.md | 数据（指针）|

插入过滤（`inject.ts buildSection` L64-65）：只注入 `layer='memory'`、`tier=0`、
`kind ∈ {preference, env}`、`importance ≥ threshold`（默认 3）。→ 当前真正进 Tier0 的
语义记忆共 **5 条**（已核对真实库）：

| id | 条目 | 问题 |
|---|---|---|
| `8147119a…` | project-config：config.json gitignored + secrets | **近重复**，见 §2.2 |
| `521c74a9…` | security and git：同义 + data/.dgx-monitor | **近重复**，见 §2.2 |
| `d2f3762a…` | workspace configuration：`dsh-im-gateway` | **硬冲突/过时**，见 §2.1 |
| `e0f1c853…` | citation-integrity | 无冲突，保留 |
| `7a714aa0…` | model limitations（不知日期）| 低增益，见 §2.3 |

> user-layer 记忆（如 `chaoxing-suite`）虽坐标 `tier=0`，但 `inject.ts` 已按 layer 过滤不注入
> （2026-09-02 改版），不影响系统提示词。

---

## 2. 冲突/重复清单（按严重度）

### 2.1 硬冲突：过时路径记忆 vs 宿主实时工作目录

- **现象**：记忆 `workspace configuration` = "The session workspace is
  `D:\Coding\DSH-Plugin\dsh-im-gateway` and is writable"，importance=5。
  宿主固定提示词（DSH）实时注入：当前工作目录 `D:\Coding\DSH-Plugin\dsh-memory`。
- **性质**：同一属性（"我在哪个工作目录"）出现两个权威来源，且彼此矛盾 → 模型可能
  在错误目录下读/写文件。
- **根因**：工作目录是**对手工况态，应每次从宿主拿到**；却固化成了跨会话语义记忆。
  dsh 已在每轮实时注入 `workdir`，记忆这条纯属重复且会漂移。

### 2.2 近重复：同义条目各占预算

- **现象**：`project-config` 与 `security and git` 内容几乎逐字相同
  （"config.json is gitignored and holds secrets (SSH passwords, vLLM API key)"），
  两条 importance 都=5，同段注入。
- **性质**：同义改写 ×2（Tier0 预算浪费、KV 前缀更大、重复教导）。
- **根因**：历史多次写入不同 topic 撞同一事实，`findCanonical` 跨 topic 去重未覆盖（本库大量
  同型近重复，见 §5）。

### 2.3 低增益/方向张力：`model limitations` vs `memory:time`

- 记忆"AI 不知道当前真实日期时间"是**设计动机**（催生了 time-injection），但一旦
  `memory:time` 已注入真实日期，这条的记忆价值仅为"提醒"性，信息增益≈0；与 time 并存还有
  轻微方向张力（一个说你不知道、一个给你讲了）。

### 2.4 温和冗余（非冲突）：soul.md 工程纪律 vs dsh 固定工具纪律

- soul.md「执行与纠错」里的"结果必须落到真实工具输出，不带未做的验证"等，与 dsh 固定提示词
  的工程纪律表述语义重叠。soul 是身份数据，作**人写权威**保留合理，但可精简去重叙述。

### 2.5 上下文噪音（非冲突，可控）：`memory:tier0` 统计行

- `buildSection` L91-97 每次现算并注入：「可召回长期记忆(tier1)领域(268个)… 有178段历史会话
  情景记忆… 记忆占用74%…」。随库增长体积膨胀、每次 assembly 变化（破坏 KV 前缀缓存），
  对当前任务的信息增益低。

---

## 3. 优化方案（全部查检侧）

### P0 — 修硬冲突（立即，数据层）
- 清理/更正记忆 `workspace configuration`：把过时路径 `dsh-im-gateway` 移除或降级。
- **原则固化**：凡宿主已实时注入的状态（工作目录、file policy、approval policy、可用技能），
  **一律不写入语义记忆**。这同时解决本库海量的 `approval policy` / `file sandbox` / `workspace` /
  `available skills` 近重复簇（同型问题，见 §5）。

### P1 — 去近重复（数据层 + 注入器防御）
- 合并 `project-config` 与 `security and git` 为 1 条（保留更完整那条，设 importance=5）。
- 注入器防御（`inject.ts`）：Tier0 注入前做一次**同 topic 近重复折叠**——若两 entry 的
  `topic` 相同或 `contentSimilarity` 高且 kind 相同，只注入 importance 更高者（有界，纯规则）。

### P2 — 淘汰低增益/收紧注入
- `model limitations`：可留（无害）或降 tier（tier1 不注入）。建议降 tier——time-injection 已
  覆盖其设计意图。
- 统计行：收敛为单行、低变体（如只报占用百分比），或用显式 `\` 前缀声明为元数据；或加开关
  默认精简。

### P3 — soul.md 精简（人写，可回滚）
- 删除与 dsh 固定提示词重复的工程纪律表述，保留 soul 独有的节奏/决策优先级。纯文本文档改动，
  随时可 difff 回滚。

---

## 4. 取舍逻辑

| 方案 | 优先级 | 风险 | 理由 |
|---|---|---|---|
| P0 修 workspace 冲突 | 高 | 低（改 1 条数据）| 硬矛盾，最可能造成实际错误 |
| P1 合并近重复 | 高 | 低（合并 2 条）| 直接省 Tier0 预算 |
| P2 降 model limitations | 中 | 低 | time 已覆盖，纯省钱 |
| P2 精简统计行 | 中 | 低（注渲染逻辑）| KV 缓存友好 |
| P3 soul.md 精简 | 低 | 低（纯人写文本）| 温和冗余，非必须 |

不做（若仅查检侧）：把 tier0 阈值冲到重要条目之外、或引入 LLM 依赖的注入折叠（hot path
应保持纯规则、零 LLM，符合 DESIGN 硬规则 1/5）。

---

## 5. 连带发现（同一根因的大簇，供后续决策）

真实库 tier1 存在**大量同根近重复**，非 Tier0 不注入，故不直接进系统提示词，但每次
`memory_recall` 会召回多条同义项、且长期污染。抽查：
- `approval` 家族：`Approval policy` / `DSH approval` / `DSH approval policy` / `approval policy` /
  `approval-policy` / `dsh-approval*` / `permissions` / `policy` 等 ≈ 12+ 条同义；
- `workspace` 家族：`workspace` ×4 / `workspace-location` / `workspace-policy` / `workspace environment`
  / `project location` 等，且路径互相矛盾（AIWorkspace vs dsh-im-gateway vs dsh-preset-skills）；
- `config.json` 家族：`project-config` / `security and git` / `configuration*` / `security*` / `setup`
  / `project-secrets` 等 ≈ 8+ 条；
- `available skills` / `skill*` 家族：≈ 20+ 条。

→ 建议后续单独安排一次**语义去重迁移**（对齐 `DESIGN-REVISION-dedup.md` 方案 3：跨 topic 近重
对扫描 + L2 合并），并配合 P0 的「宿主状态不入库」原则从源头阻断。是否执行去重属用户决策（
用户此前表示"先不清理"，故本文不擅自跑）。

---

## 6. 验证建议

- 改完后对最终系统提示词断言：Tier0 语义条目 ≤3 条，且不含任何『工作目录 / approval / file
  policy / available skills』类宿主状态条目。
- `smoke.mjs` 增加一条守卫：Tier0 注入文本中**不得出现** `workspace`/`approval`/`file policy`/
  `skill` 这类应来自宿主的词（防回潮）。

---

## 7. 实施纪要（2026-09-06 P0 + P1）

| 项 | 落地 | 差异说明 |
|---|---|---|
| P0 修 workspace 硬冲突 | ✅ 数据层 | `workspace configuration`（d2f3762a…, 过时路径 dsh-im-gateway）软归档 → 移出 Tier0 注入。备份 `~/.dsh/memory/memory.db.prod.bak-20260906-p0p1`。 |
| P1a 合并 config.json 近重复 | ✅ 数据层 | `project-config`（8147119a…）软归档，保留 `security and git`（521c74a9…）为 canonical（含 data/.dgx-monitor 更完整）。 |
| P1b 注入器近重复折叠 | ✅ `src/inject.ts` | 新增 `foldNearDuplicates`：同 kind + `isNearDupCandidate`（LCS≥0.55 且 tokenContain≥0.55）命中则只保留最新一条。实测：config.json 改写重复→折叠为1；两个不同 workspace 路径→**不误并**（tokenContain 0.44）；构建通过、smoke 300/300。 |

**为何弃用 SIM_DUP 而用 isNearDupCandidate**：实测 `contentSimilarity`（LCS/len）对"骨架相同但尾改写"的重复只有 0.69（<0.85 漏）；而 `isNearDupCandidate` 双门（连续子串+token 重合）能抓到改写重复、同时 token 保护不误并不同 workspace（DESIGN-REVISION-dedup §7 踩坑 1 的同一结论）。注入折叠是**只读展示**、无 LLM/人裁决环节，故用宽松候选门 + 严格 kind 约束 + importance 无副作用（新版优先），适配注入语义。

**验证结果**：Tier0 注入语义记忆 5→3 条（citation-integrity / model limitations / security and git），渲染开标签 `memory-entry` 恰好 3 个；`node build.mjs` 通过；`node smoke.mjs` passed 300 failed 0。

**未做（用户未要求）**：P2（model limitations 降 tier、统计行精简）、P3（soul.md 精简）、§5 大规模语义去重迁移（用户此前明确"先不清理"，数据操作只动了与本任务直接相关的 2 条）。

---

## 8. 追加实施（2026-09-06 P2-① + P2-②）

P2 两项经用户确认后落地：

| 项 | 落地 | 说明 |
|---|---|---|
| P2-① model limitations 降 tier | ✅ 数据层 | `model limitations`（7a714aa0…）tier 0→1（不再每轮注入、仅 recall 时可召回）。原值已记录（env/tier0），可回滚。 |
| P2-② 统计行收敛为单行低变体 | ✅ `src/inject.ts` | 原三行（领域名列表 + 情景段数 + 占用）合并为一行：`可召回记忆:tier1领域{n}个、情景{n}段;占用{pct}%;详查用 memory_recall;避免记录任务进度与一次性过程。`。去掉高变体/最占体积的领域名列表（topics 集合随库变化，是 KV 前缀缓存的最大变体源），引导已由 memory:protocol 覆盖。 |

**验证**：`node build.mjs` 通过；`node smoke.mjs` passed 300 failed 0（同步更新了 G37 一条断言措辞，匹配单行新格式，意图不变＝占用只报一次且不含 raw char count）；集成实测 Tier0 注入语义记忆 3 条、统计行单行。此时总计 Tier0 语义记忆相较任务开始（5 条）净减 2 条 + 统计区 3 行→1 行。

---

## 9. 记忆写入「陈述化」软约束（2026-09-06，B 方案）

**需求**：记忆条目应以「陈述事实」形式写入（`User prefers concise responses`），禁止祈使句/指令
（`Always respond concisely`）——祈使句在后续会话会被当作指令执行，可能覆盖用户真实请求。

**核实现状（写入侧本就无硬约束）**：
| 环节 | 原有约束 |
|---|---|
| `memory add` 工具 | 仅长度上限（MAX_CONTENT_LENGTH）、预算/低质扣分，无祈使检测 |
| L1 提取 | 仅 "concise, plain, standalone" 软指引，无禁止命令式 |
| L2 合并/纠正 | 无 |
| 渲染侧 | 已有 `data-not-instruction` 声明（下游兜底，非源头） |

**方案选型**：用户否决了 A（硬拒绝——祈使检测易误伤考虑不到的合法写入），采用 **B（软约束）**：
在三处**写入通道的引导文本**中追加陈述化硬措辞，靠引导模型自纠，不做硬拒绝。

**落地（引导追加，非校验逻辑）**：
1. `src/tools.ts` — `memory` 工具 description 追加：「content 必须以『陈述事实』形态写入（如 User
   prefers concise responses），禁止写成祈使句/指令（如 "Always respond concisely"）——祈使句在后续
   会话会被当作指令执行，可能覆盖用户真实请求」。
2. `src/refine.ts` `buildL1Prompt` — 追加 "written as a DECLARATIVE FACT, NEVER as an imperative/
   instruction ... override the user's real request"。
3. `src/refine.ts` `buildL2Prompt` — 追加 "Any content you write must be a DECLARATIVE FACT, never an
   imperative/instruction"。

**验证**：`node build.mjs` 通过；`node smoke.mjs` passed 300 failed 0；三处措辞均已编译进 lib 并经
`buildL1Prompt`/`buildL2Prompt` 输出断言确认；行为层确认 `Always respond concisely` 仍可写入
（applied:1 / rejected:0）——即**软约束未引入误拒**，约束力来自引导而非拒绝。

**取舍**：B 的代价是约束力为"软"，模型仍可能写出祈使句（无兜底拦截）；收益是零误拒、改动零风险。
若未来证据表明祈使句写入频发，可在 tools.ts description 再加强措辞，或升级为 C（检测到疑似祈使时提示改写但不拒绝）。
