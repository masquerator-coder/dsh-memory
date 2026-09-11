# dsh-memory 全面代码审核报告

| 项目 | 值 |
| --- | --- |
| 审核对象 | `D:\Coding\DSH-Plugin\dsh-memory`（dev clone） |
| 审核版本 | `454dea2` — *feat(memory 2026-09-11): P3 剩余三子项 —— 向量/图真实化 + 研究Agent Profile + 观测* |
| 审核日期 | 2026-09-11 |
| 审核方式 | 全量源码精读（src 40 文件 / lib 产物 / 设计说明）+ 离线工具链 + 端到端行为复现 |
| 是否改动代码 | **否**。仅新增本报告与 `docs/audit-2026-09-11/` 下的复现脚本，未触碰 `src/`、`tests/`、`lib/`、配置 |

## 0. 基线状态（审核前）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node_modules/.bin/tsc -p tsconfig.json --noEmit` | ✅ 0 错误 |
| 单元测试 | `node_modules/.bin/vitest run` | ✅ **117 passed / 117**（23 文件，1.07s） |
| 项目自带冒烟 | `node --experimental-transform-types scripts/p2-smoke.mts` | ✅ 19 项全过 |
| Lint | — | ⚠️ **仓库无 ESLint 配置**（无 `eslint.config.*`、devDeps 无 eslint），`src/util/timeout.ts:19` 却留着 `eslint-disable` 注释 |
| `lib/` 与 `src/` 同步 | 产物特征串比对（未跑 build，避免重写跟踪产物） | ✅ 同步：`lib/index.mjs` 含最新特性（`composeIndexRead`:1043、`profileKind`:196、`TraceBuffer`:2325）**且含最新缺陷**（`:3363` render 优先级 bug、`:3592` `purpose: "session-title"`） |

> **关键结论：所有质量门禁全绿，而 P0 级缺陷仍然存在。** `matchRules` / `redactForRecall` / `filterByPrivacy` 在 `lib/index.mjs` 中**完全不存在**（被 tree-shake），这既是"死代码"的铁证，也说明产物确实由当前 src 重新构建。现有 117 个用例对下面 P0 的命中率为 **0**——它们覆盖的是"引擎内部调用"，不是"引擎是否被接线"。

---

## 第 1 部分：历史审核基线的核对

**结论：本仓库当前这套 memory 代码此前没有审计基线。** 依据：

- `git log --diff-filter=D --name-only -- 'docs/*'` 显示 `docs/CODE-AUDIT-2026-09-03.md`、`docs/CODE-AUDIT-2026-09-05.md`、`docs/CODE-REVIEW-2026-09-01.md` 等全部在 **`fc72290`（2026-09-08「依据设计说明重构为 P0 原子事实记忆插件」）** 这一步被删除。
- `git show --stat 9b38bd7 / 6bf1522 / 9f79e26 / 1732131` 表明这几条"fix(audit …)"提交改的是**另一个插件**（`src/heat.ts`、`src/inject.ts`、`src/refine.ts`、`src/store.ts`、`smoke.mjs`、`lib/client.js` 的 lesson/identity 插件），与 memory 插件无任何文件交集。
- `fc72290` 之后只有 `497f83c`（P1 两项纯代码加固，源自设计说明而非审计）与后续 P2/P3 特性提交。

因此本报告是当前 memory 代码的**首份完整审计**；第 2 部分全部为新发现。第 3 部分给出"文档声称 vs 实测"对照（这是本次最高产的一类问题来源）。

---

## 第 2 部分：新发现问题

### 汇总

| 级别 | 数量 | 性质 |
| --- | --- | --- |
| **P0** | 8 | 数据丢失 / 隐私泄漏 / 核心行为静默错误 / 出厂默认即触发 |
| **P1** | 8 | 功能声称失效、跨会话污染、一致性屏障导致事实永久消失 |
| **P2** | 22 | 持久化健壮性、并发、语义细节、打包与文档一致性 |
| **P3** | 14 | 死代码、注释失真、无界增长、可观测性瑕疵 |

**最危险的 3 条**（建议优先处理，且彼此独立）：

1. **P0-1 谓词规范化把中文谓词抹成下划线** → 语义相反的事实共享同一 `semantic_key`，后写入者把前者置 `superseded`，**静默丢数据**。这是本插件面向中文用户的**主路径**。
2. **P0-3 `user.md` 往返不幂等** → 用户（或 Obsidian 自动保存）对渲染出的文件做一次"未改动"保存，就会把**视图中看不到的事实全部归档**；配合 P0-4，`profile: research` 下一次保存可清空整个画像。
3. **P0-5 / P0-6 存储层** → 一次写失败永久毒化整条读写链；文件损坏时**首次写入用空文档覆盖全部记忆**，且无备份。

> **进展（2026-09-11 同日）**：批次 A（数据正确性：P0-1 / P0-3 / P0-4 / P0-5+P0-6）与**批次 B（隐私与接线：P0-2 / P0-7 / P0-8 / P1-4）**均已修复并验证，见 **第 6、7 部分**。剩余：P1-1/2/3/5/6/7/8 与 P2/P3。

---

### P0-1 非 ASCII 谓词被规范化成同一串下划线 → 语义键碰撞、相反事实互相覆盖

- **位置**：`src/domain/predicate.ts:58-59`
- **证据**：
  ```ts
  // Unknown predicates pass through lowercased & dash-normalized.
  return key.replace(/[\s]+/g, '_').replace(/[^a-z0-9_]/g, '_')
  ```
- **影响**：`SYNONYMS` 表只有 12 条中文别名（`喜欢素食`、`爱吃`、`位于`…），任何**不在表内**的中文谓词（也就是绝大多数）会被整串替换为 `_`。于是 `喜欢瑜伽` 与 `讨厌瑜伽` → 同一 canonical predicate → 同一 `semantic_key` → `rememberOne`（`src/application/remember.ts:63`）把第 2 条判定为"同一断言的新版本"，在第 80 行把第 1 条置为 `superseded`；或当 `incomingWins` 为假时**丢弃新事实且 `events: []`**（静默）。`json-repo` 的 `byKey` 又按 key 只留一条（`src/infrastructure/json-repo.ts:188`），内容不可恢复。
- **复现（已实跑，`.audit/repro.mts`）**：
  ```
  喜欢瑜伽 -> "____"      讨厌瑜伽 -> "____"      爱吃甜食 -> "____"
  uses-tool -> "uses_tool"（与 'uses' 的 canonical 相同）
  ```
- **附带**：文件头注释 `:7-8` 声称 "Unknown predicates pass through verbatim (lowercased) so we never lose a fact to an incomplete dictionary" —— 与实现相反。
- **建议修复**：未知谓词只做 trim/lowercase + 空白折叠，保留 `\p{L}\p{N}`（或对非 ASCII 段做稳定编码），并新增"任意两个不同谓词 canonical 必不相同"的碰撞回归测试。

---

### P0-2 PII / 疑似secret 原文原样进入模型可见面

- **位置**：`src/application/recall.ts:109-116`（构造 `FactFilter` 时**没有** PII 维度）、`src/application/ports.ts:16`（`pii?: boolean` 只能表达"仅取 PII"）、`src/infrastructure/json-repo.ts:62`、`src/service.ts:486`
- **证据**：
  ```ts
  const filter: FactFilter = { scope: q.scope, status: statuses, privacy: policy.privacy.retrievalFilter, now, indexState: … }
  // json-repo.applyFilter —— 只有"取 PII"，没有"排除 PII"
  if (filter.pii === true && fact.pii !== true) return false
  ```
  而慢通道 fallback 存的是**未脱敏原文**：`src/service.ts:486` `content: input.text` 同时置 `pii: pii.detected`；`src/adapters/context.ts:74` 把 recall 结果推进 `assembly.contexts`（模型可见），`memory_recall` 工具同样原样返回 `content`（`src/adapters/tools.ts:57`）。对照 `src/application/card.ts:69` —— 画像卡片**会**过滤 PII，于是形成"画像里看不到、系统提示里看得到"的错位。
- **复现（已实跑）**：写入 `我的手机号 13800138000 和身份证 110105199003078272`（`pii: true`）→ `recall({query:'手机号'})` 返回 1 条，`content` 完整原文。
- **建议修复**：`FactFilter` 增加 `excludePii`（或 `pii: 'exclude' | 'only'`），recall 默认排除 PII 并改存 `pii.redacted`；注入前按 policy 复检。**该修复涉及隐私语义，需人工复核后合入。**

---

### P0-3 `user.md` 往返不幂等：一次"未改动"的保存即归档视图中不可见的事实

- **位置**：`src/application/usermd-sync.ts:65-69`（未被消费的事实一律 `archive`）、`src/service.ts:271`（基线是 `listScope(scope)` **全部 active 事实**）、`src/application/card.ts:23` 与 `:42`（卡片隐私 tier 硬编码 `['public','private']`，不读 `policy.privacy.retrievalFilter`）
- **证据**：
  ```ts
  // usermd-sync.ts:65-69 —— 只要没出现在编辑视图里就归档
  for (const fact of deps.facts) { … if (!consumed.has(fact.id)) actions.push({ kind: 'archive', factId: fact.id }) }
  ```
  渲染侧只渲染"主用户实体 + public/private tier + 非 PII"的事实，而回写侧拿到的是**整个 scope 的 active 事实**（含其它实体、PII、以及 research profile 默认 `confidential` 的事实）。两边的可见集合不一致 → 视图里从未出现的事实被当成"用户删掉了"。
- **复现（已实跑）**：同 scope 写 3 条（用户偏好 / PII 事实 / 其它实体的部署事实）→ `renderUserMd` 只渲染 2 行 → `applyUserMdEdits(scope, 渲染结果)`（内容**完全未改动**）得到 `added=0 superseded=0 archived=2`，active 由 **3 → 1**。
- **触发路径**：`index.ts:148-156` 首启导入 + `userMdFile.watch(applyAndRefresh)`（`src/index.ts:156`）——用户用 Obsidian 打开文件随手保存一次即可触发。
- **建议修复**：回写基线必须是"该卡片视图可见的事实集合"（同实体 + 同 privacy tier + 非 PII + `PROFILE_TYPES`），不可见事实**跳过而非归档**；`card` 的 tier 默认值改为从 policy 取。

---

### P0-4 Research Agent Profile 在真实装配下完全失效

- **位置**：`src/build-policy.ts:32,35,37,38,53-56,60-73,78,80,99`；装配点 `src/index.ts:44-45`
- **证据**：Cordis 在调用 `apply()` 之前会经插件导出的 schema 解析配置（`node_modules/@deepseek-ai/cordis/lib/index.js:955-961`：`runtime.Config["~standard"].validate(config)` → `result.value`），而 `Config` 用 schemastery `.default()` 填满**所有嵌套键**（`src/index.ts:32` `export { Config }`）。于是 `build-policy.ts` 里每个 `config.x ?? (research ? A : B)` 的右侧永远不可达。
- **复现（已实跑）**：
  ```
  Config({profile:'research'}).retrieval.versions            = "active"     ← 非 undefined
  Config({profile:'research'}).forgetting.semantic          = {"ttl":"365d","lambda":0.001}
  buildPolicy(schema 解析结果) → versions=active fanout=30 ttl=365d filter=public,private
  buildPolicy(裸对象 {profile:'research'}) → versions=all   fanout=60 ttl=730d filter=…,confidential
  ```
  且 `profileKind` 全仓**只写不读**（`build-policy.ts:99` 写入、`policies.ts:103` 声明类型，无消费者）。research 的唯一可观测效果是 `index.ts:176` 的日志。
- **为什么测试没发现**：`tests/profile.test.ts:21` 传的是**裸部分对象** `buildPolicy({ profile: 'research' })`，绕过了 schema —— 测的是一个生产不存在的装配。
- **影响**：CHANGELOG 第 22-29 行宣称的"全版本检索 / 更大剪枝 fan-out / 更弱衰减 / 更长 TTL / 可露出 confidential 证据"**一条都不生效**；研究场景静默按个人助理策略运行（且 P0-3 会因 tier 不匹配清空画像）。
- **建议修复**：把 profile 差异做成**显式分支**（不依赖 `??` 兜底）：解析 config 后按 `kind` 覆盖，或把 research 差异收敛进同一 `resolveProfile(config)` 并对抗 schema 默认值写回归测试（用 `Config({profile:'research'})` 而非裸对象）。顺带实现 `policies.ts:84-97` 声明的 §10.3 热更新（当前 `index.ts:45-49` 的 `policyRef` 是静态闭包，注释自认只是"seam"）。

---

### P0-5 一次写失败即永久毒化整条存储链（此后所有读写以陈旧错误拒绝）

- **位置**：`src/infrastructure/json-repo.ts:177-183`
- **证据**：
  ```ts
  private enqueue(mutation: Mutation): Promise<void> {
    this.chain = this.chain.then(async () => { … await this.persist() })   // 无 rejection 分支
    return this.chain
  }
  ```
  `persist()` 抛一次（Windows 上 AV/OneDrive/索引器占用 `facts.json.tmp` → `EPERM/EBUSY`、目录只读、磁盘满），`this.chain` 就变成**永久 rejected**；此后 `get/listScope/bySemanticKey/query/neighbors/byEntity/stats/snapshotFacts` 全部 `await this.chain` → 立即以**同一条陈旧错误**拒绝。对照 `src/infrastructure/outbox-journal.ts:33` 用的是 `this.chain.then(task, () => task())` —— 同一作者在另一个文件里写对了，这里是漏写。
- **复现（已实跑，`.audit/storage.mts`）**：
  ```
  put#1 -> EEXIST | put#2 -> EEXIST | get -> EEXIST | stats -> EEXIST    （全部同一条陈旧错误）
  ```
- **真实后果**：`memory_remember` 抛错被模型看到；`adapters/context.ts:75` 的 `catch` 把 recall 静默降级为"无记忆"；会话抓取经 `queue.ts:79` 的 `catch {}` 完全吞掉 → **用户零报错，记忆却再也写不进去**。
- **建议修复**：`this.chain = this.chain.then(run, run)`（或用 `.catch(() => undefined)` 只记录失败不携带失败）+ 让 `enqueue` 返回本次操作自身的 promise + `persist` 有限重试 + 通过 `ctx.logger` 上报。

---

### P0-6 文档损坏时 `open()` 抛出且无人处理 → 首次写入用空文档覆盖整库

- **位置**：`src/infrastructure/json-repo.ts:166-175`、`src/index.ts:52`
- **证据**：
  ```ts
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error      // SyntaxError 直接抛出
  }
  ```
  而调用点是 `void repo.open()` —— **没有 await、没有 catch**（未处理拒绝），仓库内存 `facts` 保持空。之后任何一次 `put()` 都会 `JSON.stringify(Object.fromEntries(this.facts))`（`json-repo.ts:239`）并 `rename` 到 `config.dataFile`。
- **复现（已实跑）**：写正常文件 → 手动截断成 `{"facts":{"keep-me":{"id":"keep-me"` → `open()` 抛 `SyntaxError` → 一次 `put()` 之后磁盘变成 `{"facts":{"new-fact":…}}`，**`keep-me` 及其全部旧记忆消失，无备份**。
- **触发前提很现实**：崩溃时的半截写（`json-repo.ts:242-243` 无 `fsync`）、满盘、外部工具写坏、两个进程共用固定 `.tmp` 名互踩。
- **建议修复**：`open()` 捕获解析失败 → 把坏文件改名备份为 `facts.json.corrupt-<ts>`、置 `degraded` 并**拒绝写入**（或至少首写前告警）；`index.ts:52` 改为 `repo.open().catch(e => ctx.logger(...))`；文档加入 `schema_version` 与校验和。

---

### P0-7 快通道规则匹配根本没接线：每条直连用户消息被无条件落库

- **位置**：`src/extraction/rules.ts:44`（`matchRules` 在 `src/` 内**无调用点**）、`src/service.ts:450-493`、`src/adapters/session.ts:43`
- **证据**：
  ```ts
  // service.ts:450-457
  extractAndRemember(input) {
    // Fast channel: deterministic-rule capture (mode B) always applies first.
    const accepted = this.captureEnabled
    if (accepted) { this.queue.enqueue(input.scope, () => this.slowPath(input)) }   // 没有任何规则判定
  ```
  无 LLM 时 `slowPath` 走 fallback 分支（`service.ts:478-493`），把**整段原文**存为 `predicate='stated'`、`confidence=ruleConfidence(0.5)` 的语义事实。默认 `captureEnabled: true`（`config.ts:77`）+ `fallback: 'store_raw_event'`（`config.ts:104`）⇒ 关掉 LLM 的默认部署下，**每条用户消息都变成一条记忆**。佐证：`lib/index.mjs` 中 `matchRules`/`looksFactWorthy`/`stripTrigger`/`guessSubject` **0 处命中**（整模块被 tree-shake）。
- **复现（已实跑）**：`extractAndRemember({text:'今天天气不错，帮我把 README 的第 3 节改一下，另外 2024 年我去过东京'})` → 落库 1 条：`predicate=stated`、`confidence=0.5`、`content` 即原文（**无任何触发词**）。
- **与文档冲突**：README `:37-39`、`:68-70`，CHANGELOG `:181`，设计说明 `:444`（"快通道规则匹配在此层完成，命中后投递后台队列"）与 `:711-721`（模式 B 触发词）均宣称规则闸门存在。
- **附带**：`config.extraction.triggers`（8 个触发词）因此成为死配置；无界抓取还会持续放大存储/召回体积。
- **建议修复**：在 `extractAndRemember` 内先跑 `matchRules`/`looksFactWorthy`，未命中直接返回 `{accepted:false}`；把 `triggers` 接进规则匹配；补 `session.ts`→`service` 的集成测试（当前**没有任何测试 import `src/adapters/tools.ts` / `context.ts` / `session.ts`**）。

---

### P0-8 `confidential` 脱敏与 `secret` 硬闸门未实现（安全声明与实际不符）

- **位置**：`src/application/privacy.ts:62-71`（`filterByPrivacy`，含 `secret` 硬阻止）、`:74-82`（`redactForRecall`，`piiRedaction` 的唯一读取点）
- **证据**：两者在 `src/` 内**除测试外零调用**（全仓 grep 仅命中定义处与 `tests/privacy.test.ts`），且**不在 `lib/index.mjs`**（被 tree-shake）。真正生效的隐私闸门只有层级过滤 `src/application/recall.ts:112`（`privacy: policy.privacy.retrievalFilter`）。
- **影响**：
  - README `:44-46`、`:93-94` 与设计说明 `:1216`（"confidential → 脱敏后注入"）未落地。
  - `privacy.secretRequiresExplicitAuth`（默认 `true`）**无任何读取方**（`config.ts:121` → `build-policy.ts:81` → `policies.ts:69` 链条到此为止）。"secret 永不自动注入"目前**只**依赖默认 `retrievalFilter` 不含 `secret`；用户把它加进列表（或笔误）即可让 secret 直接进入提示词，闸门不会拦截。
  - `config.ts:120` 用 `z.array(z.string())` 而非枚举校验，typo 也能通过。
- **复现（已实跑）**：`buildPolicy({privacy:{retrievalFilter:['public','private','secret']}})` + 一条 `privacy='secret'` 事实 → recall 返回它，而 `secretRequiresExplicitAuth === true`。
- **建议修复**：recall 内真正调用 `filterByPrivacy(items, policy, false)` 或显式剔除 secret；`retrievalFilter` 改枚举校验；`redactForRecall` 接入注入路径。**属于安全相关改动，需人工复核。**

---

### P1-1 冲突解析跨 scope：另一会话的写入会把本会话事实置 superseded 且不可召回

- **位置**：`src/application/remember.ts:63`；端口签名 `src/application/ports.ts:58`；`json-repo.ts:153/188` 的 `byKey` 是**全局单映射**
- **证据**：`const existing = await deps.repo.latestBySemanticKey(built.semantic_key)` —— 无 scope 维度。而 scope 是隔离边界（`recall`/`forgetAll` 均按 scope），`src/invariant.ts:33` 还写着 "Scope isolation: no fact leaks across scope boundaries"。
- **复现（已实跑）**：
  ```
  写 session:A → 写 session:B（同断言）→ B.superseded = A 的 factId，A.status = superseded
  recall({scope:'session:A', query:'素食'}) = 0 条        ← 会话 A 再也找不回自己的记忆
  ```
- **建议修复**：`latestBySemanticKey(key, scope)` 或 `rememberOne` 先按 scope 收敛候选；跨 scope 同键应各自成链。

---

### P1-2 索引后端不健康时"跳过"却仍 markReady + 结算 → 该后端永久缺索引

- **位置**：`src/application/index-worker.ts:132-152`
- **证据**：`const live = this.backends.filter(b => b.health().ok)` → `for (const b of live) await b.upsert(fact)` → `await this.markReady(fact)` → `await this.settleDone(entry)`。只要**至少一个**后端存活就照常置 `ready` 并删除 outbox 条目。
- **复现（已实跑）**：两个后端（`vector` 健康、`mirror` 不健康）→ tick 后 `fact.index_state=ready`、`outbox.total=0`、`vector.has=true`、**`mirror.has=false`**；把 `mirror` 恢复健康再 tick → `attempted=0`，**永远不会补上**。若 `mirror` 是 recall 的 `search` 源（`composeIndexRead` 取第一个具备 search 能力的后端），该事实即永久不可检索。
- **测试契约问题**：`tests/index-worker.test.ts:134-149` 把这一丢数据行为**断言成了期望行为**（unhealthy-skip 用例），修复时需同步改断言。
- **建议修复**：仅当**所有**注册后端成功才 `markReady`+`settleDone`；或为被跳过的 `(factId, backend)` 保留补偿记录 + 启动/周期 reconcile。

---

### P1-3 `pending_indexing` 事实无启动对账，配合 `requireReadyIndex` 默认开启 → 永久不可召回

- **位置**：`src/infrastructure/outbox-journal.ts:21`（纯内存）、`src/service.ts:597-603`（先落盘 `pending_indexing` 再 append）、`src/application/recall.ts:115`、`src/config.ts:132`（`requireReadyIndex` 默认 `true`）
- **证据**：两步之间进程被杀 → JSON 里留下永远 `pending_indexing` 的事实，而 worker 只从**内存** outbox 取活（无可选 `rebuild` 的调用者），启动时不做任何 `index_state != ready` 扫描。
- **复现（已实跑）**：重启后带一条 `pending_indexing` 事实 + 空 outbox → `worker.tick()` `attempted=0`、`outbox.total=0`；该事实在 `requireReadyIndex=true` 下**永不召回**，却仍计入 `stats().total`（用户以为"记住了"）。
- **建议修复**：`open()` 之后（或 worker 启动时）扫描 `index_state !== 'ready'` 的 active 事实重新入队；或让 outbox 落盘。README 的 Known Limitations 需明确"崩溃可能使事实停留在 pending_indexing"。

---

### P1-4 `read_user_profile` 有摘要时丢弃全部分组（README 明的功能失效）

- **位置**：`src/adapters/tools.ts:173`（产物同一处：`lib/index.mjs:3363`）
- **证据**：
  ```ts
  return [{ type: 'text', text: head || '（暂无画像）' + (body ? `\n\n${body}` : '') }]
  ```
  `+` 优先级高于 `||` ⇒ 等价于 `head || ('（暂无画像）' + …)`。Node 实测：`head='- x'` 时输出 `"- x"`，**body 被丢弃**。
- **影响**：只要画像有摘要（正常情况），`read_user_profile` 的"按主题分组的详细偏好"永不出现；README `:26-27` 明确宣称返回"核心摘要 + 按主题分组"。修复还需同时处理 `:184`（`topic` 只过滤 groups、不收敛 summary）。
- **建议修复**：`text: [head || '（暂无画像）', body].filter(Boolean).join('\n\n')`，并补 `adapters/tools.ts` 的 render 单测（该文件**当前无任何测试 import**）。

---

### P1-5 BM25 长度归一化把"文档总数"当成"平均文档长度"

- **位置**：`src/infrastructure/json-repo.ts:108`（`const avgDocLen = Math.max(1, this.total)`，而 `this.total` 是文档数，见 `:89`）、消费点 `:116`
- **证据**：`tfNorm = (tf*1.5) / (tf + 1.5*(0.25 + 0.75*(docLen/avgDocLen)))`；`docLen/avgDocLen` 本应 ≈1，实际是 "本文档词数 / 库内文档数" ≈0.01 且随库增长趋 0 → k1 项塌缩为常数（分母 1.9375@4 文档 → 1.3773@1000），**BM25 退化为裸 tf**：长而跑题的文档被系统性高估，聚焦的短事实被压掉。
- **影响**：`recall` 的相关性维度（权重 `w1=0.45`，最大项）排序质量与文件头注释 `:6-7`（"small BM25-style lexical score"）不符。
- **建议修复**：增量维护真实平均文档长度，或改用标准形式 `tf*(k1+1)/(tf + k1*(1-b+b*len/avg))`；给 `score()` 加确定性 tiebreak（当前依赖 Map 插入序）。
- **测试为何没发现**：`tests/recall.test.ts:61` 的容差是 `maxTokens + 400`（容忍 50% 预算超支），且没有"长跑题文档不得胜出"的用例。

---

### P1-6 索引退避/重试配置在装配点未传入 → 用户改配置静默无效

- **位置**：`src/index.ts:64`（`new IndexWorker({ repo, outbox: outbox!, backends })`）vs `src/build-policy.ts:88-93`（组装了 `policy.indexing.backoff`）
- **证据**：`IndexWorker` 构造函数 `index-worker.ts:65` 用 `{ ...DEFAULT_BACKOFF, ...options.backoff }`，`options.backoff` 恒为 undefined → 永远使用 `domain/outbox.ts` 的 `DEFAULT_BACKOFF`。因默认值数字恰好相同（5/50/2/5000），**完全静默**。
- **影响**：`indexing.maxRetries / backoffBaseMs / backoffFactor / backoffCapMs` 四个键无效；CHANGELOG `:76-77` 宣称该配置生效。
- **建议修复**：`new IndexWorker({ …, backoff: policy.indexing.backoff })` + 断言用例。

---

### P1-7 若干已声明配置为死键

| 配置键 | 声明 | 唯一"读取" | 结论 |
| --- | --- | --- | --- |
| `consolidation.enabled` | `config.ts:125` | 无（`index.ts:162-167` 无条件 `setInterval`） | ❌ 设 `false` 无效 |
| `consolidation.batchSize` | `config.ts:127` | 无（`consolidate.ts:31` 硬编码 `budget = 500`） | ❌ |
| `extraction.batchWindowMs` | `config.ts:103` | 无（仅 `build-policy.ts:105` 搬运） | ❌ 设计 §10.1 有意暴露的旋钮 |
| `extraction.selfContainmentCheck.*` | `config.ts:105-108` | 无 | ❌ |
| `extraction.triggers` | `config.ts:109` | 无（见 P0-7） | ❌ |
| `privacy.secretRequiresExplicitAuth` | `config.ts:121` | 无（见 P0-8） | ❌ |
| `privacy.piiRedaction` | `config.ts:122` | 仅在死函数 `redactForRecall` 内 | ❌ 实质无效 |
| `indexing.{maxRetries,backoff*}` | `config.ts:133-136` | 无（见 P1-6） | ❌ |

- **建议修复**：要么接线，要么从 schema 删除并在 README 标注"未实现"——当前状态是**对用户的静默欺骗**。

---

### P1-8 并发同键写入竞态 → 重复 active 事实，且 `consolidate` 永不合并

- **位置**：`src/application/remember.ts:63-68`（`latestBySemanticKey` → `put`，两个 await 之间无串行化）；`src/service.ts:372`/`:298` 直接调用，未走 `ScopeQueue`
- **证据**：`remember.ts:8` 的注释假设 "caller serializes per scope (see queue)"，但 `service.remember` / `applyUserMdEdits` 都不入队；`consolidate.ts:55` 的合并条件是 `latest.version > fact.version`，两条 `version=1` 永不成立。
- **复现（已实跑）**：`Promise.all([rememberOne(同键), rememberOne(同键)])` → 2 条 active、`version` 均为 1、`superseded` 均为 undefined。
- **建议修复**：`rememberOne` 内部按键串行化（键级互斥），或让 store 提供原子 compare-and-supersede。

---

## P2 明细（22 条）

### 持久化与文件

| # | 问题 | 位置 | 影响 / 说明 |
| --- | --- | --- | --- |
| P2-1 | 私人记忆**明文落盘 + 默认权限**，README 未披露 | `json-repo.ts:241-243`、`usermd-file.ts:52`（全仓无 `mode: 0o600` / `chmod`） | Unix 上 `0o644`，同机他人可读含 `secret` 事实的 `facts.json`；README Security model 未提"明文、无加密" |
| P2-2 | **无 fsync**；临时文件名固定为 `<file>.tmp` | `json-repo.ts:240-243` | rename 只保证目录项原子；断电可能留下 0 长度/半截 JSON（正好触发 P0-6）；两进程互踩同一 tmp 会产出混合 JSON |
| P2-3 | `~` 不展开、相对路径按 `process.cwd()` 解析 | `cordis.patch.yml:13`（示例用 `~/.dsh/memory/facts.json`）→ `json-repo.ts:160/167/241` | Windows 上会在**当前工作目录**下创建名为 `~` 的真实目录；换工作目录启动即"记忆消失"。README 的示例配置**照抄即错** |
| P2-4 | `user.md` 写入非原子（注释声称 "atomically"），且 `lastRendered` 在写之前赋值 | `usermd-file.ts:46-55` | 用户编辑器可能把半截 Markdown 存回并被 watcher 回灌（结合 P0-3 会误归档）；写失败后 `hasExternalChange()` 结果错误 |
| P2-5 | `watch()` 可重入守卫写反 + 文件缺失时同步抛 `ENOENT` | `usermd-file.ts:63-65,78` | `disposed` 在进入时即置位并兼作"已装"标志：一旦首次 `fs.watch` 抛错（文件尚不存在），**同实例后续所有 watch 都静默 no-op**，watcher 永久缺失且无报错 |
| P2-6 | `watch()` 行为**零测试覆盖** | `tests/usermd-file.test.ts:20-37`（只调 `read/write/hasExternalChange`） | 自写抑制、防抖、Windows 上"原地写 / 换名替换 / 删除重建"的事件差异全部无断言——正是 README 主推的外部编辑回写路径 |
| P2-7 | `read()` 把所有错误折算成 `''`，与 `if (content.length === 0) return` 组合 | `usermd-file.ts:40-43,73` | "文件被删/无权限"与"文件为空"不可区分，watcher 静默失效 |
| P2-8 | DLQ 条目永不回收 | `index-worker.ts:169-177`（`remove` 只在 `settleDone`） | 长跑进程内存无界增长，`outbox.stats().dead` 只增不减 |
| P2-9 | `tick()` 无重入锁 | `index-worker.ts:71`（`:59 running` 只作停止标志） | 公开 API `service.drainIndexing` 并发调用 → 同批条目被处理两次、`attempts` 跳 2、提前进 DLQ、指标双计 |
| P2-10 | `applyDelete` 不校验 `byKey` 当前指向 | `json-repo.ts:231` | 删除**旧版本**会抹掉当前 active 版本在 key 索引中的映射 → 之后同键写入不再 supersede，产生永久共存且 `consolidate` 永不合并的重复事实（`memory_forget(delete)`/`forgetAll` 可触发） |
| P2-11 | `byKey` 每 key 只留 1 条，且"最新"依赖 JSON 属性顺序 | `json-repo.ts:188` + `:174` | superseded 版本经 `bySemanticKey` 不可达；外部工具重排属性后可致同键重复写入 |

### 语义与算法

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| P2-12 | TTL 解析对空白/垃圾串静默失效，方向相反 | `policies.ts:133-139` | `'   '` → `Number('   ')=0` → **写入即过期**；`'365 days'`/`'not-a-ttl'` → `null` → **永不过期**；`'-100'` → 负 TTL（已实跑） |
| P2-13 | 嵌套 qualifier 被整体丢弃 → 情景事件身份塌陷 | `semantic-key.ts:67` + `:25-30` | `{time:{event_time:…}}` 与"无 qualifier"得到**同一签名**（已实跑：两签名前 12 位相同 `44136fa355b3`）；而设计说明 `:164-168` 的 canonical 形态正是嵌套 `time.valid_from`，`extraction/extractor.ts:116` 又把 LLM 的 qualifiers 原样透传 → 同一三元组的不同事件互相覆盖 |
| P2-14 | 日期串按**本机时区**解析，且不同写法结果不同 | `semantic-key.ts:86-99` | `'2024-01-01'` 与 `'2024/01/01'` 得到不同 key（同一日历日）；同一事实在 UTC 容器与 Asia/Shanghai 宿主上键不同 → 去重失效、跨机重复入库 |
| P2-15 | `nil:` 实体 id **不含类型命名空间** | `entity.ts:138` + `:148-152` | `user:Alice` 与 `project:Alice` 得到同一 id（已实跑：均为 `nil:46qn5v`）→ 同 predicate/object 时 `semantic_key` 相同 → 用户与项目的事实互相覆盖 |
| P2-16 | `EntityResolver` 在生产**从不装载**，别名/模糊匹配全为死代码 | `index.ts:54`（`new EntityResolver()`；全 src 无 `resolver.upsert`）→ `entity.ts:123-136` | `fuzzyMatch` 分支条件要求显式传参，唯一调用方 `factory.ts:56` 不传 ⇒ 模糊分支不可达；`registerSynonym`/`levenshteinSimilarity`/`DEFAULT_FUZZY_THRESHOLD` 无消费者。测试之所以通过，是因为 `tests/fact-factory.test.ts:25-27`、`tests/card.test.ts:12-16` **手工 upsert 了实体表** |
| P2-17 | 实体匹配缺 Unicode 归一化；模糊平局不确定 | `entity.ts:143-145`（无 NFC/NFKC）、`:130`（`score > best.score`） | `josé`(NFC) 与 `jose\u0301`(NFD) 解析成两个实体（卡片/语义键分裂）；等分时"先注册者胜"，而注册顺序取决于 JSON 属性序 |
| P2-18 | working 记忆 `ttl: ''` → `expires_at: null` → **永久落盘并参与召回** | `config.ts:116` + `policies.ts:133` + `factory.ts:82` | 与设计说明 `:312`/`:321`（"工作记忆：不入库，仅在上下文内"）直接冲突；入口为 `memory_remember` 的 `type: 'working'`（`tools.ts:67`）与 LLM 抽取（`extractor.ts:53`） |
| P2-19 | 同键去重按 `relevance` 而非融合分选幸存者 | `recall.ts:264` vs 文档 `:94`（"highest score survives"） | 高可信 `user_edit`（credibility 1.0）可能被低可信候选挤出 |
| P2-20 | 预算装箱用 `break`，一个装不下的条目终止整轮 | `recall.ts:199` vs 注释 `:191` | 排名中间一条超长事实会让后面本可容纳的小事实**全部被丢弃**；而首条 `result.length > 0` 例外又没有单条硬上限，超大事实可把任意 token 量注入提示 |
| P2-21 | `card.updatedAt` 取的是"最高置信度"而非最新事实的时间 | `application/card.ts:98`（`visible` 已按 confidence 排序）vs `domain/card.ts:63` 的定义 | 消费方（缓存失效/新鲜度）拿到过期时间戳 |
| P2-22 | `consolidate` 用陈旧快照整对象回写 | `consolidate.ts:37-48`（写前无新鲜度复检） | 扫描期间用户的 archive 等状态变更被回滚（已由子审计交错注入复现），并发出与实际原因不符的事件 |
| P2-23 | supersede 把旧版本 `updated_at` 抬到新版本时刻 | `remember.ts:80`、`consolidate.ts:56` | `fact.ts:123` 注释是 "last version bump"，但旧版本并未 bump；research（`versions:'all'`）下一年前的过时断言 recency≈1，压过真正较新的活跃事实 |

### 打包、依赖与文档

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| P2-24 | `peerDependencies` 不接纳实际使用版本 | `package.json:20-25`（dev `0.1.3-alpha.2`）vs `:34-39`（`>=0.1.0-rc.8 <0.2.0`） | 按 node-semver 的 prerelease 规则，比较器集合中不存在与 `0.1.3` 同 `[major,minor,patch]` 且带 prerelease 的比较器 ⇒ `0.1.3-alpha.2` 不满足该范围，pnpm 会报 unmet peer。⚠️ 本机未安装 `semver` 模块，此条为**规范推导**，建议修复时以 `pnpm install` 输出实测确认 |
| P2-25 | CHANGELOG 自相矛盾 | `CHANGELOG.md:158`（"**64** unit tests (was **53** at P0…)"）vs `:190`（"**50** unit tests"） | 实际为 **117**（与 `:46` 一致，已实测） |
| P2-26 | `src/invariant.ts` 无任何 `src/` 调用者，README 却称其为核心所"推理依据" | `README.md:172-174` | 结构性保证只存在于测试里 |
| P2-27 | 抽取调用的 `purpose` 与实际用途不符；用户文本同时进入 `system` 与 user 角色 | `adapters/llm-extractor.ts:75-77` | `system: buildExtractionPrompt(input)` 把不可信文本拼进 **system 消息**，`:67-70` 又作为 user 消息重复发送；README `:90-91` 的"user text cannot alter it / 强隔离"属过度宣称（模板常量确实不可变，但隔离强度仅等价于分隔符） |
| P2-28 | `files` 只发 `lib` + `cordis.patch.yml` | `package.json:8-11` | npm 会自动带上 README/LICENSE/package.json，但 README `:8-9` 指向的设计说明 `.md` 与 `:99` 的 "declared in `src/config.ts`" 对 tarball 消费者**悬空**；同生态插件多随发行 `src` |
| P2-29 | 仓库根 8 个未跟踪且未被 `.gitignore` 覆盖的产物 | `git status --porcelain`：`candidate.json`、`dsh-memory-architecture.html`、4 张 `*.visual-check.*.png`、`.visual-check.html/json` | 极易被 `git add -A` 带入提交（`.gitignore` 仅 5 行，且忽略的 `docs/diagrams/` 目录并不存在） |

---

## P3 明细（14 条，摘要）

- **死代码 / 未接线**：`predicateEntry` 结果在 `domain/factory.ts:77` 赋值后从未使用；`SCHEMA_VERSION`（`fact.ts:10`）未接入工厂（`factory.ts:85` 硬编码 `'1.0'`）；`newEntityId`（`id.ts:39`）无调用者且注释称"stable / content-addressed"实为 `randomUUID().slice(0,8)`；`stepsFromContent`（`procedural.ts:109`）无生产调用者，且会把普通 bullet 列表误判为步骤；`index-backends.ts:75` 的 `rebuild()` 只循环 `gate()` 不重建任何结构（名不符实，将来用于恢复会静默得到空索引）。
- **无界增长**：`index-backends.ts:134` 的全局 `df` 词表只增不淘汰；`outbox` 的 `dead`/`done` 条目无 TTL 兜底；`Metrics` 计数器无界。
- **队列**：`queue.ts:38-51` 的 `whenDrained/idle` 是 5ms 轮询，永不 settle 的任务会让其永久挂起；`:80` 的 `errored` 只增不减。
- **可观测性**：`service.ts:217` 直写字面量 `'memory.recall'` 而 `:216` 用常量 `MetricKeys.recall`；`service.ts:218` 会把"成功但恰好 ≥ 预算"的 recall 计成 timeout；histogram 的 `.count/.sum_ms` 实为 256 样本窗口而非累计。
- **数值边界**：`policies.ts:125-129` 的 `recencyScore` 无 `Number.isFinite` 防护（`ageMs=NaN` → 分数 NaN → 排序比较器返回 NaN）；配置 `lambda` 无 clamp（负值使分数随年龄增长且 >1）；`semantic-key.ts:81` 的大数 qualifier `Math.round(v*1e10)` 溢出为 `Infinity` → `JSON.stringify` 成 `'null'`。
- **拼接歧义**：`semantic-key.ts:144-146` 用裸 `|` 拼接（`buildSemanticKey('x|p|y','p','z',…)` 与 `buildSemanticKey('x','p','y|p|z',…)` 同键，已实跑）；树内当前无注入点（`memory_remember` 不暴露 subject/object id），但第三方经 `ctx.memory` 可触发。
- **procedural 校验**：`procedural.ts:81-90` 不拦 `depends_on` 自环与重复 step id，`steps/preconditions/tool` 无长度上限。
- **参数命名不符实**：`recall.ts:145` 的 `let fan = 0` 位于 depth 循环内、实体循环外 ⇒ `maxFanoutPerEntity` 实为"整层共享"（research 配 60 几乎无效）。
- **陈旧注释**：`tsdown.config.mjs:4` 仍称 "Serves as the self-contained `prepare` script"（`prepare` 已在 `d8546be` 删除）；`fact.ts:4`/`:136` 指向不存在的 `docs/atomic-fact.md`、`docs/events.md`；`util/timeout.ts:19` 的 `eslint-disable` 无对应 lint 配置。
- **`scripts/p2-smoke.mts` 未纳入工程**：`package.json` 无对应 script，README Development 段未提；它是当前唯一覆盖 card/user.md/程序记忆的冒烟入口（本次审核已实跑通过）。
- **`pnpm-workspace.yaml:5-6`** 声明 `allowBuilds: esbuild: true`，与 README `:136` 的小标题 "Git installs need no `allowBuilds` key" 措辞冲突（功能上消费者确实不需要，已验证）。
- **`cordis.patch.yml:17-22`** 重复声明 schema 默认值（`profile/injectContext/captureEnabled/llmExtractionEnabled/dataFile`），默认值改动时会出现两处真相。
- **`id.ts` 的 `base36`** 对负值/非有限值静默退化：`newFactId(-1)` → `fact_ndefined_de0aa12683d7`（`ALPHABET[-1]` 为 `undefined` 被字符串拼接吞掉）。

---

## 第 3 部分：文档声称 vs 实测 对照

| 声称 | 出处 | 实测 | 判定 |
| --- | --- | --- | --- |
| 配置默认值表（11 行） | `README.md:102-114` | 与 `src/config.ts:73-126` 逐行一致（含 `15*60_000`） | ✅ |
| "117 unit tests" | `CHANGELOG.md:46` | vitest 实测 117 | ✅ |
| `memory` 服务 9 个方法 | `README.md:20-21` | 全部存在（`service.ts:195/342/382/400/413/437/450/507/545`） | ✅ |
| 6 个工具 | `README.md:23-24` | 全部注册（`tools.ts:41/62/100/120/139/160`） | ✅ |
| "LLM 抽取默认关闭" | `README.md:59-61` | `config.ts:78` 默认 false；`llm-extractor.ts:59-61` 缺 provider/model 即返回 undefined | ✅ |
| "git 安装无需 allowBuilds" | `README.md:136-143` | 无 `prepare`；`lib/` 已跟踪且与 src 同 commit | ✅ |
| "No KV cache effect" | `README.md:164-168` | src 中无 `ctx.kv`/cache 读写 | ✅ |
| 快通道"确定性、零 LLM 规则（记住…/我的偏好是…）" | `README.md:37-39`、`:68-70`、`CHANGELOG.md:181`、设计 `:444` | `matchRules` 无调用点、bundle 中被 tree-shake；**每条消息无条件落库** | ❌ **P0-7** |
| "confidential 内容在非授权召回时脱敏" | `README.md:44-46`、`:94`、设计 `:1216` | `redactForRecall` 无调用者、不在 bundle | ❌ **P0-8** |
| "secrets are never auto-injected" | `README.md:93-94` | 仅在默认 `retrievalFilter` 下成立；`secretRequiresExplicitAuth` 是死键 | ⚠️ **P0-8** |
| Research Profile 的全部差异 | `CHANGELOG.md:22-29`、设计 §10.2 | schema 默认值抹平，差异**全部失效** | ❌ **P0-4** |
| `read_user_profile` 返回"摘要 + 按主题分组" | `README.md:26-27` | 有摘要时分组被丢弃 | ❌ **P1-4** |
| `indexing.{maxRetries,backoff*}` 配置生效 | `CHANGELOG.md:76-77` | 装配点未传入 | ❌ **P1-6** |
| "user.md 是原子写" | `usermd-file.ts:46` 注释 | 实为直接 `writeFile` 截断重写 | ❌ P2-4 |
| "outbox 是 durable / replay-safe log" | `domain/outbox.ts:1-3`、`ports.ts:77` | 实现为纯内存 Map（`outbox-journal.ts:7-9` 自述 in-memory） | ⚠️ 措辞矛盾（P1-3 的根因） |
| "user text cannot alter the extraction prompt / 强隔离" | `README.md:90-91` | 模板常量不可变成立，但不可信文本进 system 角色且重复发送 | ⚠️ 过度宣称 P2-27 |
| `src/invariant.ts` 是"核心推理的结构性保证" | `README.md:172-174` | 无任何 `src/` 调用者 | ⚠️ P2-26 |
| 测试计数 | `CHANGELOG.md:158` vs `:190` | 64 vs 50 vs 实际 117 | ❌ P2-25 |
| 设计 §10.3 配置热更新 | 设计 `:1118-1123` | `index.ts:45-49` 的 `policyRef` 是静态闭包（注释自认只是 seam） | ⚠️ 未实现 |
| 设计 §3.12 情景记忆扩展字段（participants/outcome/duration/artifacts，设计 `:319`/`:329-330`）、§3.5 `embedding_ref`（`:191`/`:221`）、`qualifier_signature` | 设计 | 均未实现（`fact.ts` 无对应字段） | ⚠️ 设计未落地 |
| 设计 §10.1 consolidation（`fullInterval`/`timeoutMs`/`batchSize`）、§4.5 `tools/pre-execute` 隐私拦截、§8.6 摘要前置、§12.5 背压、§12.7 `forgetAll` 墓碑/审计 | 设计 | 未实现 | ⚠️ |

---

## 第 4 部分：已核查且未发现问题（覆盖证据）

以下均经**直接读码**（非仅子报告）核对，未发现缺陷：

- **产物同步链路**：`lib/index.mjs` 同时包含最新特性与最新缺陷，且死代码（`matchRules`/`redactForRecall`/`filterByPrivacy`）被 tree-shake ⇒ `src → lib` 无漂移，`README` 的"src 与 lib 同 commit"纪律被遵守。
- **存储的进程内串行化**：`json-repo.ts:177-183` 把读-改-写整体纳入单链，同实例并发 `put()` 不交错、不丢更新（缺陷在错误处理，不在串行化）；`applyDelete` 对 `facts/byKey/byScope/adjacency/bm25` 的级联清理完整（含空集删除、`total` 递减不越界）。
- **Outbox journal 的链**：`outbox-journal.ts:33-34` 用 `then(task, () => task())` + `run.then(()=>undefined,()=>undefined)`，任务拒绝**不会**毒化链；`(op,factId)` pending 合并正确；`remove` 同步清 `byOpFact`；`backoffDelayMs` 有 `Math.max(0,…)`/`Math.min(…,capMs)` 兜底，不产生 NaN/Infinity。
- **ScopeQueue 核心语义**：同 scope 严格 FIFO 不重叠；单任务 reject 不 wedge 后续任务；排空后 `scopes` 被删除（无表泄漏）；`pump()` 不会重复启动同一 scope 的 worker。
- **recall 主流程次序**：先排序 → 再预算装箱 → 末尾判 `topK`；`excludeIds` 在装箱内生效且不占预算；按类型的衰减 lambda 正确（working λ=0→recency=1，episodic 快于 semantic）。
- **无 NaN 分数路径**：BM25 的 `max>0` 归一化分支正确；vector cosine 的 0/0 被 `dot > 0` 与空向量遮蔽；`extractor.ts` 的 `asNumber` 强制 `Number.isFinite` 且 confidence clamp 到 `[0,1]`。
- **vector / graph 后端**：`upsert` 先 `remDf(prev)` 再重建（不虚增 df）；`remove` 从 items+df 同步移除；`graphNeighbors` 正确按 `relationWhitelist` 过滤；实测三后端结构同步移除（与 `tests/index-backends.test.ts:49-55` 一致）。
- **CJK 检索可用**：`json-repo.ts:40-45` 按单字切分 CJK 并保留 ASCII 词，中文无空格不影响召回；索引侧与查询侧口径一致。
- **usermd 解析对 Windows 文本兼容**：`split(/\r?\n/)` 处理 CRLF，`trim()` 吃掉 BOM ⇒ Notepad/Obsidian 写出的 BOM+CRLF 文件仍可解析（此前的编码顾虑不成立）。
- **`withTimeout`**：`finally` 清理 timer；`Promise.race` 已为底层 promise 挂 handler ⇒ 超时后不会产生 `unhandledRejection`（缺陷只是"放弃而非取消"，端口层无 AbortSignal）。
- **`scanPii`**：识别/替换顺序（身份证→银行卡→手机→邮箱→密码提示）正确，`$` 锚定的替换不会漏改已匹配片段。
- **card 分组确定性**：按 canonical predicate 分组、组内 confidence desc + updated_at desc、组序由首次出现决定；摘要预算"首个超限条目仍保留"与 `domain/card.ts` 注释一致。
- **`dependencies: {}` 是自洽的**：`lib/index.mjs` 的运行时外链（`@deepseek-ai/schemastery`、`dsh-tools`、`dsh-llm`）都在 `peerDependencies` 内，与同生态插件惯例一致。
- **观测层无基数泄漏/无热路径抛错**：`incr/record` 的 name 均为常量；Histogram 上限 256；TraceBuffer 由 capacity 截断且 `finish` 对已驱逐 span 安全 no-op。
- **`engines`/`packageManager` 自洽**：本机 node v24.16.0、pnpm 11.25.0 均满足。
- **未发现认证/加密/支付/密钥管理代码**（`src/` 中无此类逻辑），本次审核的安全面集中在隐私分级、PII 处理与不可信输入的注入隔离。

---

## 第 5 部分：修复路线图（建议批次）

> 我**没有改动任何生产代码**。以下为建议顺序，每批都应"改一处 → 跑门禁 → 补测试"。涉及隐私/安全语义的批次（P0-2、P0-8）建议人工复核后再合入。

**批次 A —— 数据正确性（必须先做，且互不依赖）**

1. `predicate.ts:59` 保留非 ASCII 谓词字符 + 碰撞回归测试（P0-1）。
2. `json-repo.ts:177-183` 修链的 rejection 处理 + `open()` 的损坏文件隔离（改名备份 + 拒绝写入）+ `index.ts:52` 加 `.catch`（P0-5、P0-6）。
3. `usermd-sync` 的回写基线改为"卡片可见集合"（P0-3）——同时把 `card.ts:23/42` 的 tier 默认值改为读 policy。
4. `build-policy.ts` 改为显式分支实现 research 差异（P0-4），测试改用 `Config({profile:'research'})`。

**批次 B —— 隐私与接线**

5. `recall` 增加 PII 排除 + 慢通道存 `pii.redacted`（P0-2，需复核）。
6. `filterByPrivacy(..., false)` 接入 recall 或显式剔除 secret；`retrievalFilter` 枚举校验（P0-8，需复核）。
7. `extractAndRemember` 接入 `matchRules` 闸门；`triggers` 生效（P0-7）。
8. `adapters/tools.ts:173` render 修复 + `adapters/*` 的 render/集成测试（P1-4）。

**批次 C —— 一致性**

9. `latestBySemanticKey` 加 scope 维度（P1-1）。
10. `IndexWorker`：仅全后端成功才 `markReady/settleDone`；启动 reconcile 扫 `index_state != ready`（P1-2、P1-3）。
11. `rememberOne` 键级串行化（P1-8）；`byKey` 改多值 + 删除时校验指针（P2-10、P2-11）。
12. 接线或删除剩余死配置（P1-6、P1-7）；`consolidation.enabled` 落到 `index.ts:162`。
13. BM25 真实 `avgDocLen`（P1-5）。

**批次 D —— 文档同步（与代码同批交付）**

14. `README`：删除/修正 P0-7、P0-8、research、`read_user_profile`、"原子写"、"durable outbox"、`invariant.ts`、明文存储与文件权限、`~` 路径注意事项。
15. `CHANGELOG`：修正 `:158`/`:190` 的测试计数矛盾，补记本次修复项。
16. `.gitignore`：覆盖根目录的架构图产物与 `candidate.json`；`docs/` 若引入则确认不误伤。

**测试补强清单（当前空白，按优先级）**

| 未覆盖对象 | 建议用例 |
| --- | --- |
| `src/adapters/tools.ts` | 6 个工具的 render + `read_user_profile` 分组输出（P1-4） |
| `src/adapters/session.ts` + `service.extractAndRemember` | 触发词命中/未命中（P0-7） |
| `src/adapters/context.ts` | `renderMemoryBlock` 预算截断、`lastUserText` 跳过自身 section |
| `src/index.ts` `apply()` | 装配断言：backoff 传入、`consolidation.enabled` 生效、userMd 初始化链 |
| `usermd-file.watch()` | 自写抑制、防抖、外部原子替换、dispose 后不再回调（P2-5~P2-7） |
| `recall` 隐私 | PII/secret 不得出现在结果里（P0-2、P0-8） |
| `usermd` 全链路 | `render → parse → diff` 必须 no-op（P0-3） |
| 并发 | 同键并发写、并发 `drainIndexing`（P1-8、P2-9） |
| 存储故障 | 写失败后链可恢复、损坏文件不覆盖（P0-5、P0-6） |

---

## 第 6 部分：批次 A 修复记录（2026-09-11 同日）

按确认的范围只修"数据正确性"四项 P0（不触碰隐私语义与接线类缺陷）。所有改动经 `tsc --noEmit`、全量 vitest、`scripts/p2-smoke.mts` 三门禁，`lib/` 已重建且两次构建哈希一致（幂等）。

| 缺陷 | 状态 | 改动点 | 验证 |
| --- | --- | --- | --- |
| **P0-1** 非 ASCII 谓词被抹平 | ✅ 已修 | `src/domain/predicate.ts`：未知谓词保留任意文字系统的 `\p{L}\p{N}`，仅空白与分隔标点折叠为 `_`（不做 `_{2,}` 合并——合并两种写法比留下两个键更危险） | 新增 `tests/predicate.test.ts`（6 例）：`喜欢瑜伽 ≠ 讨厌瑜伽`、不再退化为纯下划线、别名仍归一到 canonical |
| **P0-5** 写失败永久毒化读链 | ✅ 已修 | `src/infrastructure/json-repo.ts` `enqueue`：`this.chain = run.then(()=>undefined, ()=>undefined)`，链只记录完成、不携带失败；每次操作返回自己的 promise（与 `outbox-journal` 的既有正确写法对齐） | `tests/json-repo.test.ts`「recovers from a failed write…」；复现脚本 `[2]` 由"读写全挂"变为"读正常、写如实报错" |
| **P0-6** 损坏文件被空库覆盖 | ✅ 已修 | 同上：`open()` 对不可解析内容改名为 `<file>.corrupt-<ts>`（字节保留）、对完全不可读的文件转只读并拒绝写入；`src/index.ts` 的 `void repo.open()` 补 `.then/.catch` 并把结果写入插件日志 | `tests/json-repo.test.ts`（quarantine / read-only 两例）；复现脚本 `[1]` 三项全部 `not-repro`，`corrupt.json.corrupt-<ts>` 中保留原始字节 |
| **P0-3** `user.md` 往返非幂等 | ✅ 已修 | `src/application/card.ts` 抽出共享判定 `cardVisible()`；`src/service.ts` 的 `getCard` / `applyUserMdEdits` 统一走 `cardOptions()`，卡片隐私层改取 `policy.privacy.retrievalFilter`；回写基线由"scope 全部 active 事实"改为"视图可见集" | 新增 `tests/usermd-roundtrip.test.ts`（4 例，含 research 默认 confidential 场景）；复现脚本 `[h]` 由 `archived=2, active 3→1` 变为 `archived=0, active 3→3` |
| **P0-4** research profile 失效 | ✅ 已修 | `src/config.ts` 移除**所有 profile 相关键**的 `.default()`（并写明"禁止再加回"的理由与守护测试）；`src/build-policy.ts` 改为显式 `PROFILE_DEFAULTS` 表（personal 值逐项等于原 P0 默认） | `tests/profile.test.ts` 新增 4 例：schema 后这些键必须为 unset、research 差异生效、personal 不变、显式值仍优先。复现脚本 `[i]` 由 `versions=active fanout=30 ttl=365d` 变为 `versions=all fanout=60 ttl=730d filter=…,confidential` |

**修复过程中额外发现并一并修掉的一条同源缺陷**：写盘失败时内存索引已被更新（`applyPut` 先于 `persist`），于是内存里出现一条磁盘上并不存在的"幽灵事实"。现在失败会回滚内存状态，保证内存与磁盘不背离（`tests/json-repo.test.ts` 的失败写用例断言 `stats = {0,0}`）。

**一个必须记住的实现约束**（已写入 `src/config.ts` 头注释 + `tests/profile.test.ts`）：Cordis 会在 `apply()` 之前用插件导出的 schema 解析配置，因此**任何 profile 相关键一旦加回 `.default()`，`profile: research` 就会再次静默退化为 personal**。另外 schemastery 会把缺省的数组物化为 `[]`，故 `buildPolicy` 用 `nonEmpty()` 把"空/缺省"统一读作"未设置"（空白名单会让召回彻底失效）。

**批次 A 后的状态**：`src` 与 `lib/` 同批更新；单测 **117 → 134**（新增 17 例）；未提交（等确认）。仍未处理：P0-2（PII 原文进入模型可见面）、P0-7（快通道规则未接线）、P0-8（confidential 脱敏/secret 闸门未实现）、8 项 P1（跨 scope 覆盖、索引后端丢索引、pending_indexing 无对账、`read_user_profile` 渲染 bug、BM25 归一化、退避配置未接线、死配置、并发同键竞态）以及 P2/P3。

---

## 第 7 部分：批次 B 修复记录（2026-09-11 同日）

范围：隐私与接线类 P0（P0-2 / P0-7 / P0-8）与文档已宣称但渲染失效的 P1-4。这些改动**触及隐私语义**，已按下述口径实现，建议人工复核确认策略是否符合预期。门禁：`tsc` 0 错、全量 vitest **160/160**（连续 4 次稳定）、p2-smoke 全过、`lib/` 重建且两次构建哈希一致。

| 缺陷 | 状态 | 改动点 | 验证 / 复现 |
| --- | --- | --- | --- |
| **P0-2** PII 原文进入模型可见面 | ✅ 已修 | 新增共享门 `factAllowed()`（`application/privacy.ts`），`json-repo.applyFilter` 与 `recall.factPasses` 统一走它（原来两份实现已漂移）；`FactFilter` 增 `excludePii`；`recall()` 的 `excludePii` **默认 true**；**降级兜底路径**（绕过 store 查询）也过滤 PII；慢通道捕获改存 `pii.redacted`（与显式工具路径一致） | `tests/recall-privacy.test.ts`（含超时降级路径）；`repro-behavior.mts [g]` 由"返回原文"变为 `hits=0` |
| **P0-8** secret 无硬闸门 / confidential 未脱敏 | ✅ 已修 | `FactFilter.excludeSecret`；`recall()` 默认取 `policy.privacy.secretRequiresExplicitAuth` 的**反**值；`filterByPrivacy` 接入降级兜底（原为死代码）；`redactForRecall` 改为真正脱敏（confidential 内容做 PII 掩码 + 打 `[confidential]` 标记）；`config.ts` 的 `privacy.default` / `retrievalFilter` 改**枚举校验**，笔误不再静默通过 | `tests/recall-privacy.test.ts`（4 例：含"加了 secret 到列表仍被拦"与"显式放弃鉴权后才放行"） |
| **P0-7** 快通道规则未接线 | ✅ 已修 | `extractAndRemember` 改为 `matchRules(triggers)` 命中 **或** `looksFactWorthy`（数字/日期/专有名词/版本，即设计 §6.4 模式 B 的 pattern）才捕获；命中时存**剥离触发词后的陈述**；`extraction.triggers` 生效；顺带修掉 `stripTrigger` 残留分隔符（`记住，项目…` 会存下前导 `，`）与 `rules.ts` 里那个两分支同为 `'semantic'` 的死三元表达式 | `tests/capture.test.ts`（8 例）；`repro-behavior.mts [k]` 由"1 条落库"变为 `accepted=false, 0 条` |
| **P1-4** `read_user_profile` 有摘要即丢分组 | ✅ 已修 | `adapters/tools.ts` 的 render 改为分段拼接（`head` 与 `body` 各自成段）；`topic` 过滤无匹配时返回"（该主题暂无偏好）"而非空数组 | `tests/adapters-tools.test.ts`（该文件此前**无任何测试 import**） |
| **P3（顺带修）** `recallTimeout` 口径 | ✅ 已修 | 原按"实测耗时 ≥ 预算"计数：既会漏计真实超时（亚毫秒舍入，测试因此偶发失败），又会把"成功但偏慢"的召回误计为降级。改为 `withTimeout` 在**超时真的发生时**回调计数 | 全量 suite 连续 4 次 160/160 稳定（修复前偶发 1 例失败） |

**实现口径（需确认）**：

1. **PII 是"拦截"而非"仅标记"**：`pii: true` 的事实仍然入库（删除是用户的显式选择），但在模型可见面上**永不被召回/注入**；自动捕获路径存的是脱敏文本，因此身份证/银行卡/口令不再进入记忆（设计 §12.7「密码、身份证号、银行卡等默认不进入记忆」）。若你希望 PII 在**显式工具调用**下可见，需要额外开一个 opt-in 参数——当前没有。
2. **`secretRequiresExplicitAuth: false` 的含义**：本插件没有鉴权通道，因此该开关被实现为"操作者显式放弃鉴权要求"，且仍须 `retrievalFilter` 含 `secret` 才会露出（两道闸门）。
3. **`confidential` 的脱敏方式**：PII 掩码 + `[confidential]` 前缀标记（告诉模型不要回述）。若认为前缀噪音过大，可只保留掩码。
4. **快通道仍会捕获"含数字/日期/专有名词"的普通消息**（如"2024 年我去过东京"）——这是设计 §6.4 模式 B 明确列出的 pattern，不是缺陷；要收紧可把 `triggers` 之外的信号关掉（目前写死在 `extractAndRemember`，可改成配置项）。

**批次 B 后的状态**：单测 **134 → 160**（新增 26 例）；`src` 与 `lib/` 同批更新；仍未提交。剩余待办：**P1-1**（跨 scope 覆盖）、**P1-2**（索引后端不健康丢索引）、**P1-3**（`pending_indexing` 无启动对账）、**P1-5**（BM25 归一化）、**P1-6/P1-7**（退避配置与一批死配置）、**P1-8**（并发同键竞态），以及第 2 部分的 P2/P3（例如 `~` 路径不展开、明文落盘权限、`~`/`.tmp` 固定名、DLQ 不回收、`tick` 无重入锁、graph fan-out 共享预算、TTL 解析、嵌套 qualifier 丢键、`nil:` id 不含类型等）。

---

## 附录：复现方式

复现脚本随报告放在 `docs/audit-2026-09-11/`（**只读、纯内存/临时目录，不触碰仓库数据**）：

```powershell
node --experimental-transform-types docs/audit-2026-09-11/repro-behavior.mts   # P0-1~P0-4、P0-7、P1-1/2/3/8 等
node --experimental-transform-types docs/audit-2026-09-11/repro-storage.mts    # P0-5、P0-6、P1-3
```

脚本内的判定约定：**`CONFIRMED` = 缺陷仍可复现，`not-repro` = 缺陷已消失**。修复后重跑，`[1]/[2]/[g]/[h]/[i]/[k]` 已转为 `not-repro`，其余仍为 `CONFIRMED`（即批次 C 的待办）。

> 注：Node 原生类型剥离不支持 TS 参数属性（`constructor(private readonly x)`），故必须带 `--experimental-transform-types`。
> 另：`vitest` 在受限沙箱内会因 esbuild 需以管道 stdio 派生服务进程而报 `spawn EPERM`；本次审核与修复以放宽沙箱授权后运行，结果 160/160 通过。

**审核结论**：引擎内部实现质量尚可（算法、串行化、后端契约等多处经核查无误），但**装配层与文档承诺是重灾区**——8 个 P0 中有 6 个属于"功能没接上/声明与实现不符"，且被 117 个全绿用例完全掩盖。建议按批次 A → B → C 顺序修复，并在批次 D 中把 README/CHANGELOG 与实现重新对齐，避免"文档承诺已实现、实际未接线"的模式继续累积。
