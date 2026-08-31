# DESIGN 修订提案 — 记忆去重与身份权威化

> **状态：已实施（IMPLEMENTED 2026-08-31）**。本文件最初是提案；方案 1/2/3 的核心
>（`findCanonical` 写时合并、`crossTopicNearDupGroups` L2 周期去重、user.md 人写权威 +
> user-layer 移出 Tier0）已落地到 `src/`。文档其余部分保留决策依据；落地后仅存活的差异：
> 「identity 写时闸门」「L2 M7 增量面扩展」按约定不实施（见 §7 实施纪要）。
> **未动的 DESIGN.md 本体**。

---

## 0. 动机（为什么要改）

实测当前库（`~/.dsh/memory/memory.db`）已积累 123 条语义记忆 + 64 段情景，三层闭环
（L0 收口 → L1 → L2 → 主动遗忘）**全部按设计在跑**，soul.md 未被污染。但暴露三类问题：

1. **近重复爆炸**：同一个稳定事实以"同义改写"被反复写入多条。抽查：`approval-policy` 7 条
   （EN×5+CN×2，全是一个意思）、`workspace` 9 条（同一路径录 4+ 次，中英双写）、
   `file-policy` 7 条（几乎全是 workspace-write）、`available-skills` 7 条（同一批名单）。
2. **用户画像三重冗余**：同一"付强画像 + OSpace"同时出现在 `user.md`、
   `user/0|decision 付强-身份与角色总览`（Tier0 每次现算注入）、`user/1|general Obsidian库OSpace整体结构`
   三处——违背 M9"user.md 是画像唯一恒定 section"的意图，且白占 Tier0 预算 + 破坏前缀缓存。
3. **脏数据**：`user/0|env 测试环境 dsh-memory-v3` 携带错误路径 `C:\Users\fuqia.dsh\memory-v3`
   （正确为 `C:\Users\fuqia\.dsh\memory`），占着 Tier0 名额。

**目标**：从源头消除重复，并确立 soul.md / user.md 的"决定性权威"地位——二者已有的内容
不得再以记忆副本形式双份出现。

---

## 1. 现状盘点（已核对代码）

| # | 机制 | 现状 | 代码位置 | 残缺点 |
|---|---|---|---|---|
| D1 | 写入精确去重 | **已存在**：contentId + `WHERE content=?`，字节相同 → upsert 不新建 | `store.ts:344-350` | 只抓字节相同，**同义改写放行** |
| D2 | 近重复质量惩罚 | `contentSimilarity`(LCS/len, ≥0.85) 只**扣 quality 30 分**，不拦截不合并 | `quality.ts:33-53` | 扣分可能被 imp/tier 掩盖，照建新行 |
| D3 | 近重复候选集 | `nearCandidates` 只扫**前 12 字符相同**的范围 | `store.ts:288-295` | 开头不同的改写直接漏出候选，比不到 |
| D4 | L2 周期性去重 | merge/drop/correct/keep **已存在**，已跑 32 次 ok | `refine.ts:385-421` | **按 topic 字符串严格聚类**，跨 topic 同义重复永不共框 |
| D5 | 身份文件方向 | `maintainUserIdentity` **记忆→user.md 单向**增量 append | `identity.ts:66-96` | user.md 是记忆的派生品，非权威源 |
| D6 | 身份注入 | `coreUser = list({layer:'user', tier:0})`，user 层**不过 kind 过滤**全部注入 Tier0 | `inject.ts:53,69-72` | 与 user.md(M9) 双份呈现；无 kind 闸门 |
| D7 | 身份文件上限 | `IDENTITY_MAX_BYTES=2000`，**永不截断** | `identity.ts:31,83-95` | 溢出时新用户事实被跳过 |
| D8 | L1 写通道 | L1 提取走 `store.batch(ops)→add` | `refine.ts:318-319` | **与交互 `memory add` 共用同一去重路径**（红利点） |

---

## 2. 核心设计：一个共享判定原语 `findCanonical`

三个方案（写入去重 / 凝练去重 / 身份权威）**都需要同一个"语义近重复判定"**。
现状它散落 D1/D2/D4 三处、各自残缺且可能对同一条给出相反裁决（如 D1 说"相似→插入"、
D2 说"相似→扣分"、D4 说"按 topic 才合并"）。收敛为一个原语统一四处：

```ts
// 新增于 store.ts（纯函数 + 有界候选）
findCanonical(content: string, layer: Layer, kind?: Kind): MemoryEntry | null
// 语义：返回与 content"近重复"的唯一权威行；无 → null。
// 命中 = 同一 layer 下任一行，满足：
//   - contentSimilarity(content, row.content) >= SIM_DUP（默认 0.85），且
//   - （可选收紧）同 kind
// 候选集来自 mem_fts 召回（FTS5，保持有界，替代 D3 的前 12 字符前缀）。
```

**裁决规则（纯规则，确定性）**——合并时 `canonical` 行的元数据如何定：
- importance：取各候选 `max`；
- created：保留**最早**（canonical 稳定，外部 handle 不漂移）；
- layer / kind / topic：以 canonical 源行为准；命中 canonical 后以新内容更新 content；
- archived：若 canonical 已归档，合并视为**复活**（对齐现有 R1/`archived:false` 语义）；
- 歧义：两候选 similarity 接近阈值下沿且属不同 kind → 不自动并，标记待审。

**冲突裁决表**（一处原语，各方不再各自为政）：

| 场景 | 原语统一行为 |
|---|---|
| 交互 `memory add` 遇近重复 | 更新 canonical，不 INSERT（方案 2） |
| L1 抽取写事实 | 走 `store.batch→add`，自动获得同一行为（方案 2+3） |
| L2 跨簇合并 | 用原语找跨-topic 近重对，再交 LLM 出 judgment（方案 3） |
| 写入 vs 身份文件 | 先查 `soul.md`/`user.md` 是否已含同义内容（方案 1） |

---

## 3. 方案细化与落点

### 3.1 写入前去重（方案 2）——最高杠杆，先落地

**现状**：D1 精确去重已存在，D2/D3 使近重写放行。
**改动**：
1. `store.ts add`：把 `nearCandidates` 命中从"qualityScore 扣分"升级为"当作 existing
   （canonical）处理"——`let existing = this.findCanonical(content, layer)`；命中则走
   现有 update 分支（`store.ts:355-366`），否则 INSERT。
2. 候选集弃用 D3 前缀扫描，改用 `mem_fts` 召回 + 相似度过滤（有界 cap=8~16，沿用 P2-16
   的成本考量）。
3. 原 `contentId` 精确分支保留（最快路径，先精确、不命中再相似）。

**红利**：L1 走同一 `store.batch→add`（D8），改 add 一处，交互与凝练同时受益。

**风险**：相似合并可能误并"共享长短语但实为两件事"（如两个不同 workspace）。对策=
同 layer 约束 + 高阈值 + 歧义进待审，不强制自动并。

### 3.2 凝练循环去重（方案 3）——必须破除 D4 聚类边界

**现状**：L2 已存在（merge/drop/correct/keep），但 `semanticClusters` 按 **topic 字符串严格
分组**，跨 topic 同义改写永不共框。
**改动**：
1. **保留**现有按 topic 簇（处理同 topic 多版本）；
2. **新增跨簇近重对扫描**：对全库（非 archived/lq）做近重复对检测（复用 `findCanonical`），
   把"不同 topic 但高相似"的对并入一个合成簇，喂给 L2 出 merge/drop——扩大 L2 视野，
   使 `approval-policy`/`approval policy`/`审批策略` 同框。
3. **M7 增量面扩展**：目前只重审"成员有变"的簇，跨会话攒下的稳定重定义簇永不共审；
   把跨簇对也纳入增量审计面。

**成本**：跨簇对检测为 O(候选有界) 扫描，复用 FTS 保持有界；LLM 只处理"近重对/簇"，
不放大每周期 LLM 调用量。

### 3.3 身份权威化（方案 1）——最后落地，先定方向

**核心矛盾**：D5 使 user.md 是记忆的**派生品**，若直接加"file 有→勿写记忆"会造成
鸡生蛋（记忆喂文件→文件又有→拒绝记忆）。故需先**反转权威方向**：

1. **定义**：soul.md / user.md 为角色**决定性定义**（权威源）；语义记忆库中的
   `layer=user` 降级为"喂文件的中间台账"，**不再作为第二呈现源**。
2. **注入侧摘除**：`inject.ts` 的 `coreUser` 从 Tier0 注入中移除（画像只经 user.md 恒定
   section 呈现，KV 友好）。user-layer 记忆留存仅供 identity 同步与召回引用，
   不重复注入。→ 从根上消除"画像双份"，无需"写时反查文件"这一弱闸门。
3. **写入闸门（配合 findCanonical）**：`add` 时若 `layer=user`，先以 `findCanonical`
   对照已同步进 user.md 的内容；命中则视为"喂文件的重复"，跳过记忆写入（或仅更新
   canonical 台账行，不新建）。
4. **溢出丢失策略（D7 冲突必须解决）**：user.md 到 2000B 上限且不截断时，identity pass
   会 overflow 跳过。若此时再叠加"file 有→勿写记忆"，新用户事实**两条路都堵死**。
   方案：溢出后 user.md 保护，但**记忆台账**照常供召回；并提示"user.md 已满，需人工
   整理/扩容"（人决策，不自动截断——对齐"人逐格审阅"）。
5. **soul.md**：纯人写、插件永不写（现状正确），且库中无 soul 重复 → 此项仅需在写入
   闸门里加入"soul 内容同义匹配"作防御，优先级最低。

---

## 4. 冲突与不可行点（如实记录）

1. **D5 方向矛盾**：不从"记忆→文件"改为"文件权威 + 记忆降级为台账"，方案 1 会循环自锁
   （鸡生蛋）。必须连同注入侧摘除一起做，单加"写时反查文件"无效。
2. **D7 上限丢失**：user.md 2000B 不截断 + "file 有勿写"双闸门叠加 → 新用户知识丢
   失。必须定义溢出回退（记忆台账照存 + 人工提示）。
3. **D2/D3 弱判定**：相似度仅扣分不合并、候选仅前缀 12 字符——这是近重放行的直接原因，
   三方案若不含并收敛到 findCanonical 就仍会漏。
4. **D4 聚类边界**：L2 按精确 topic 聚类，跨 topic 同义重复结构性漏网；方案 3 若不破除
   该边界并扩 M7 增量面，L2 继续白跑。
5. **合并元数据裁决**：L2 至今把 importance/layer/kind/topic 裁决交给 LLM 自由发挥，
   不确定；写时合并须用纯规则（§2 裁决规则），歧义进待审。

---

## 5. 落地顺序（建议）

1. **打底**：实现 `findCanonical` 原语 + 有界 FTS 候选（§3.1 改动 2/3）。纯函数、可单测。
2. **方案 2**：`store.ts add` 用原语升级近重去重。一箭双雕堵交互 + L1。
3. **方案 3**：L2 加跨簇近重对扫描 + M7 增量面扩展。
4. **方案 1**：注入侧摘除 user-layer Tier0 + user.md 权威方向 + 溢出回退策略。
5. **迁移（可选，单独决策）**：对现有 123 条做一次 **one-shot 去重**（L2 跨簇模式或脚本），
   清除 `approval-policy`/`workspace`/`file-policy` 等近重复簇与错误路径脏数据。
   ——用户已表示"先不清理"，故迁移暂缓，源头修复后旧重复仍会保留直至遗忘/手动清。

## 6. 验收（修订落地后的硬规则）

- 同一事实（含同义改写）在语义库中至多存在 1 条 active 记录；
- user-layer 事实不同时出现在 Tier0 section 与 user.md（画像仅 user.md 呈现）；
- `findCanonical` 命中率：对现有 approval-policy×7 / workspace×9 等簇，脚本复扫应
  收敛为 1 条/簇；
- L2 周期运行后，跨 topic 近重对被合并/归档（refine_runs 有对应记录）；
- 全程保持硬规则 1（存写热度遗忘主循环零 LLM）+ 硬规则 5（召回只生成候选、注入过闸门）。

---

*本提案只改动文档层；代码未动。审阅通过后再按 §5 顺序实施。*

---

## 7. 实施纪要（2026-08-31 落地实际）

| 计划项 | 落地 | 差异说明 |
|---|---|---|
| `findCanonical` 写时合并 | ✅ `store.ts` | 严格门 `SIM_DUP=0.85`（LCS 比），全量 active 扫描（个人级规模，O(n) 微秒级；FTS 候选对含路径的改写条目不可靠，弃用） |
| L1 同通道 | ✅ 自动获得 | L1 走 `store.batch→add` |
| 跨 topic 分组 | ✅ `crossTopicNearDupGroups` + `runRefineL2` | 用**宽松** `isNearDupCandidate`（tokenContain≥0.55 且 LCS≥0.55，或 LCS≥0.85）分组，交给 L2 的 LLM 判断 merge/drop |
| L2 增量面扩展 | ⭕ 未做 | 实测写时合并 + 一次性迁移已覆盖主要重复；M7 增量面维持原样，避免在活库上加复杂度 |
| 写时 identity 闸门 | ⭕ 未做 | 因 user-layer 已整体移出 Tier0 注入、user.md 改人写，不再有"文件与注入双份"的写入面需拦截 |
| user-layer 移出 Tier0 | ✅ `inject.ts` | 画像只经 user.md 恒定 section 呈现 |
| `identityAuto` 默认 false | ✅ `settings.ts` | user.md 转人写权威；`maintainUserIdentity` 代码保留但默认关闭（可开回） |
| 一次性迁移 | ✅ 活库执行 | 备份 2 份 → 归档 5 条（DSH 开发文档×3 同 URL、律师模式×1 精确重复、错误路径脏数据×1）→ user.md.draft 落盘待审；歧义 5 对交运行时 L2 |

**踩坑（后续照做可绕）**：
1. `contentSimilarity`（LCS/len）对"改写式重复"过严（实测 0.63–0.98 分布）——写时保守 OK，
   候选分组必须配 token 重合宽松门，否则重复根本进不了 L2 视野。
2. 自动去重对"长条目嵌入短条目文本"会产生假阳性（如 file-policy 长文内嵌 workspace 路径，
   tokenContain=1）——加**长度比门**（ratio≤1.67）拦截；歧义一律交判断不放自动归档。
3. `workspace` 之类同名 topic 的多条，很多是**不同路径的独立事实**（D:\ gateway vs C:\ AIWorkspace），
   不可当重复合并——相似度/分组只能给候选，合并必须过 LLM/人。
4. FTS 短语查询把含路径 token 的整串当一个词，分词后零命中——候选引用全量扫描比 FTS 短语可靠。
5. 活库 WAL 正被 dsh 写：迁移用独立连接 + `busy_timeout=6000` + 单事务 `BEGIN IMMEDIATE`，
   先 `VACUUM INTO` 备份再写，多 writer 靠锁串行，实测无冲突。
