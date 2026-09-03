# dsh-memory 全面代码审核报告

- **日期**: 2026-09-03
- **范围**: `src/` 全部 14 个源文件（约 2900 行）、`build.mjs`、`smoke.mjs`、`cordis.patch.yml`、`package.json`
- **方法**: 逐文件通读 + 跨文件引用图谱（识别死代码）+ 与 vendored schemastery 源码交叉验证（`z.union([...])` / `z.const` 写法均确认合法）+ lib/ 与 src/ 时间戳一致性核对（构建产物无过期）
- **总体评价**: 代码整体质量**高**。事务/SAVEPOINT 原子性、LLM 超时与 AbortController、prompt-injection 防护（P0-5）、loopback 路由鉴权、定时器 unref、dispose 时 in-flight 任务收敛等均处理细致，且带有完整的 review 历史注释。本次发现的问题集中在**少数边界条件**与**一处与既定修复哲学（P2-1/P2-37"未指定字段保留原值"）不一致的路径**。

---

## 一、严重（可能导致数据语义错误）

### C1. `replace` 未指定字段时会静默重置 layer / kind / importance / epistemic

- **文件**: `src/store.ts:592-595`（默认值计算）、`src/store.ts:699-741`（replace 写入路径）
- **描述**: `applyOne` 在 add/replace 共用段计算了
  ```ts
  const layer: Layer = op.layer ?? 'memory'
  const kind: Kind = op.kind ?? inferKind(content)
  const importance: Importance = op.importance ?? 3
  const epistemic: Epistemic = op.epistemic ?? 'observed'
  ```
  这四个默认值对 `add` 是合理的，但 **replace 路径直接把它们写入 target**（`src/store.ts:733-734`）。后果：
  1. 对 `layer=user` 的条目执行 `replace(id, { content })`（不传 layer）→ 条目被翻转为 `layer=memory`，**静默丢失 user 层不死性**（heat 恒 1、永不归档/删除的保护全部失效，之后会被主动遗忘流程正常淘汰）；
  2. 不传 `importance` → 被重置为 3，**击穿 importance≥5 永不硬删保护**（与 P2-1 修掉的合并路径同类问题）；
  3. `kind` 被重置为按新内容推断值、`epistemic` 被重置为 `observed`。
  这与代码自身已确立的语义相矛盾：P2-37 已为 `topic` 修复了完全相同的问题（未指定则保留原值），P2-1 也为 add-merge 路径修复了 importance 保留；G4 注释还明确写着 "An explicit layer change belongs on replace(id, { layer })"——即未显式传 layer 时**不应**改变 layer，但当前实现恰恰改了。
- **影响**: 模型最常见的 replace 调用就是只给 `id + content`（tools.ts 中其余参数均为可选），每次都在悄悄降格元数据。属于高频路径上的数据语义错误。
- **修复建议**: replace 分支改为从 target 取默认值：
  ```ts
  const layer = op.layer ?? target.layer
  const kind = op.kind ?? target.kind
  const importance = op.importance ?? target.importance
  const epistemic = op.epistemic ?? target.epistemic
  ```
  并在 smoke.mjs 增加断言：replace(id, {content}) 后 layer/importance 不变。

---

## 二、中等（逻辑缺陷 / 契约违反 / 误导性行为）

### M1. 空查询 recall 退化为全库扫描并污染热度信号

- **文件**: `src/store.ts:874-965`（`recall`）、`src/store.ts:1045-1111`（`recallEpisodes`）、`src/tools.ts:192`
- **描述**: `query = ''` 时：`keywords = []`，但 `addTerm(qLower)` 仍会推入 `LIKE '%%'` 子句（匹配**所有行**）；打分层 `text.includes('') === true` 使每行 base=4。结果：返回按热度排序的任意 top-8 条目，且 `touchAccess` 会**错误提升这些条目的 last_accessed / window_freq**（频率信号被污染、遗忘被推迟）。工具层 `str(args.query) ?? ''` 不拒绝空串，模型传空 query 即触发。`recallEpisodes` 存在完全相同的问题。
- **修复建议**: `recall` / `recallEpisodes` 开头 `if (!query.trim()) return []`；tools.ts 对空 query 返回引导性 FAIL 文案。

### M2. `runRefineL1` 的 catch 块内 store 调用未防护，违反 "Never throws" 契约

- **文件**: `src/refine.ts:384-389`
- **描述**: L1 每集处理循环的 catch 中直接调用 `store.markEpisodeExtracted(ep.id, 2)` 与 `store.writeRefineRun(...)`。若原始异常正是"DB 已关闭"（dispose 期间后台 pass 仍在 await LLM），这两句会**再次抛出**，异常逃出 `runRefineL1`，中断本轮剩余 episode 循环。对比：`runRefineL2` 的同类 catch 已做防护（A3 修复，`src/refine.ts:469-477`），L1 漏掉了同样的处理。
- **修复建议**: 仿照 L2，将 catch 内两句包进 `try { ... } catch { /* count only */ }`。

### M3. 无可用路由时 L1 立即把 episode 永久标记为 degraded(2)

- **文件**: `src/refine.ts:316-317`（`if (!hasRoute) status = 'degraded'`）、`src/refine.ts:343-344`（标记 2）；关联 `src/index.ts:532-555`
- **描述**: "路由暂时不可解析"（冷启动时 `agentDefaultModel` 尚未就绪、learned 会话路由尚未捕获）与"LLM 真正失败"被混为同一状态 `extracted=2`。后台 pass 默认 `l1RetryDegraded=false`，因此**冷启动窗口内写入的所有 episode 永久失去 L1 抽取机会**（除非用户手动点"立即整理"，R9 才会复活）。boot 后 2 分钟的首次定时 pass 恰好是最容易无路由的时刻。
- **修复建议**: `!hasRoute` 时 `continue` 跳过且**不标记**（保持 extracted=0 留待下轮）；仅 LLM 调用/解析失败才置 2。

### M4. 跨层内容冲突时返回 `ok:true` 零写入，工具层却报告"已记入"

- **文件**: `src/store.ts:618-620`（G4 case-1）、`src/store.ts:634-642`（G4 case-2）、`src/tools.ts:162`
- **描述**: add 与已有**不同 layer** 的同内容条目冲突时，直接 `return { ok: true }`——什么都不写。batch 把它计入 `applied`，工具层拼出"已记入"。模型据此相信事实已持久化，实际什么都没发生（且不会再尝试）。G4 防止跨层翻转的动机正确，但**静默成功**是错误的通知语义。
- **修复建议**: 返回结构化说明（如 `{ ok: true, note: '内容已存在于另一 layer，未改动' }`），tools.ts 将 note 拼进结果文本；或干脆 reject 并给出理由。

### M5. `openInLocalEditor` 命令拼接的转义不可靠，存在命令注入面

- **文件**: `src/identity-routes.ts:129-149`
- **描述**: 路径被拼进 shell 命令字符串。win32 分支 `start "" "${path.replace(/"/g,'^\"')}"` 不是可靠的 cmd 转义（`&`、`%VAR%` 等 cmd 元字符未处理，`%` 展开真实发生）；unix 分支的 `\$ \` \" 转义也不完整（如 `!` 在交互 shell 的 history expansion、换行符）。路径来自 `memoryHome` 配置（本地可信），故实际风险受限，但一旦配置值含元字符即行为异常乃至执行任意命令。
- **修复建议**: 放弃字符串拼接 + `exec`，改用 `spawn` 数组参数且 `shell: false`：win32 → `spawn('cmd.exe', ['/c', 'start', '', path])`；darwin → `spawn('open', [path])`；其他 → `spawn('xdg-open', [path])`。

### M6. lesson "instant judge" 实际审判的是最旧的 draft，与设计注释矛盾

- **文件**: `src/store.ts:1267-1273`（`listLessonDrafts` 固定 `ORDER BY drafted_at ASC`）、`src/refine.ts:545-547, 565-567`（instant 取 limit 5）、`src/index.ts:604-627`
- **描述**: 注释与字段文档均说 instant 模式"judge only the single newest draft（纠正数秒内可召回）"。但 `listLessonDrafts` 只支持 ASC（最旧优先），instant limit=5 取的是**最旧的 5 条**。刚由 `recordFailure` 双写的最新 draft 仅在积压 ≤4 条时才被包含；一旦存在积压，"数秒内成课"的核心目的静默失效，且 instant 与周期 pass 抢同一批旧 draft。
- **修复建议**: `listLessonDrafts` 增加 `order?: 'asc' | 'desc'` 参数；instant 路径用 `desc` + `limit 1`（或按 draft id 精确定位刚更新的那条）。

---

## 三、轻微（死代码 / 一致性 / 可维护性）

### 死代码（未被引用）

| # | 位置 | 内容 | 建议 |
|---|------|------|------|
| L1 | `src/refine.ts:629-675` | `buildAddMetaPrompt` / `parseAddMetaJson` / `judgeAddMeta`（§3.1 add-meta judge 整段，约 46 行）全项目无任何调用点 | 删除，或按设计接入 add 写路径 |
| L2 | `src/quality.ts:105-109` | `weightOf` 全项目零引用（注入路径已不再使用质量权重） | 删除 |
| L3 | `src/index.ts:31`、`src/l0.ts:31-51` | `import { type L0Options }` 导入后从未使用；`L0Options` 接口本身也只被这个死导入引用（`runL0` 用的是内联 input 类型） | 删除导入与接口 |
| L4 | `src/heat.ts:59-66`、`src/quality.ts:8,46,60`、`src/store.ts:58`、`src/inject.ts:26-28,38`、`src/refine.ts:22-28`、`src/l0.ts:53-54` | `lambdaOf`/`freqBoost`/`DEMOTE_HEAT`/`ARCHIVE_HEAT`/`longestCommonSubstr`/`tokenize`/`tokenContain`/`SIM_DUP`/`sanitizeText`/`ENTRY_CAP`/`SECTION_CAP`/`DEFAULT_REFINE_*`/`L1_MAX_WRITE_RETRIES`/`DEFAULT_L0_*` 等仅模块内使用却导出（smoke.mjs 亦未用） | 收窄为非导出，缩小公共 API 面；若定位为"供测试的纯函数"则补 smoke 覆盖 |

### 质量与一致性

| # | 位置 | 描述 | 建议 |
|---|------|------|------|
| L5 | `smoke.mjs:35,46` | `node:fs` 被重复 import 两次 | 合并 |
| L6 | `src/index.ts:268-294` | runtime 种子拷贝与 watch 回调是两段几乎相同的 10 行字段赋值 | 提取 `syncRuntime(next)` 复用 |
| L7 | `src/index.ts:722` | `controls.loadModels` 内 `let hostDefault` 遮蔽外层同名 const，易误读 | 重命名局部变量 |
| L8 | `src/store.ts:467-491, 523-555` | `findCanonical` 每次写操作对全部 active 行做 `contentSimilarity`（O(n) 对比，每对最多 200K DP 单元）；`crossTopicNearDupGroups` 为 O(n²) 次该扫描。已有 A4 长度上限 + DP 200K guard 兜底，个人规模（数百行）可接受 | 库增长后用 `tokenContain` 先做 token 预筛（函数已存在但未用于此路径） |
| L9 | `src/store.ts:993` | `addEpisode` id = `contentId(sessionId + ':' + Date.now())`，同 session 同毫秒两次写入生成相同 id 相互覆盖 | 追加进程内计数器或随机后缀 |
| L10 | `src/identity-routes.ts:156,318-329` | `readJsonBody` 类型里声明了 `setTimeout` 却从未调用（死字段）；`/memory/trigger` 不读取 POST body，客户端带 body 请求时连接可能挂起 | 删除死字段；trigger 路由 drain 或拒绝带 body 请求 |
| L11 | `src/index.ts:462` | `L0_MAX_INFLIGHT` 拥塞时 `return` 发生在文本缓冲**之前**，拥塞期间完成的 turn 永远不会进入 idle-settle 的 LLM 升级 | 把 return 改为只跳过 runL0、仍执行下方缓冲 |
| L12 | `src/index.ts:695-712, 769` | `controls.runNow`（HTTP 手动触发）直接 `await runRefine(true)`，**未** 经 `track()` 计入 inFlightTasks——dispose 的 `allSettled` 可能先完成并 `store.close()`，手动 pass 在关闭的 DB 上报错（有 catch、不崩溃，但结果丢弃） | runNow 内也 `track()` 该 promise |
| L13 | `tsconfig.json` / `tsconfig.client.json` | 硬编码 `D:/Apps/deepseek-harness`（build.mjs 已做替换，注释已声明为 IDE 默认值） | 已知取舍；可改为 `${DSH_HARNESS_ROOT}` 文档化 |
| L14 | `src/client.tsx:56-114` vs `src/identity-routes.ts:44-100` | `RefineModelsPayload`/`RunNowResult`/`ViewMemory` 等接口在 client/server 两侧结构性重复（client 无法 import server 类型的架构限制） | 抽一个共享 `shared-types.ts`（零依赖）供两侧引用 |

---

## 四、按优先级排序的修复清单

| 优先级 | 问题 | 文件:行 | 一句话修复 |
|--------|------|---------|-----------|
| P0 | C1 replace 重置 layer/kind/importance/epistemic | store.ts:592,733 | 未指定字段从 `target` 取默认值 + smoke 断言 |
| P1 | M1 空 query 全库扫描 + 热度污染 | store.ts:874,1045; tools.ts:192 | 空白 query 早退返回 [] |
| P1 | M3 无路由即永久 degraded | refine.ts:316,343 | `!hasRoute` → continue 不标记 |
| P2 | M4 跨层冲突静默"成功" | store.ts:618,634; tools.ts:162 | 返回并展示 note |
| P2 | M2 L1 catch 未防护 store 调用 | refine.ts:384 | 仿 L2 加 try/catch |
| P2 | M6 instant judge 审旧不审新 | store.ts:1267; refine.ts:565 | DESC + limit 1 |
| P3 | M5 openInLocalEditor 注入面 | identity-routes.ts:129 | spawn 数组参数、无 shell |
| P3 | L1/L2/L3 死代码删除 | refine.ts:629; quality.ts:105; index.ts:31 | 直接删除 |
| P3 | L11 拥塞跳过缓冲 | index.ts:462 | return 移到缓冲之后 |
| P3 | L12 runNow 未 track | index.ts:695 | track() 包一层 |
| P4 | L4-L14 其余清理项 | 见上表 | 择机处理 |

---

## 五、值得肯定（无需改动）

- **原子性**：episode+FTS、batch、hard-delete 全部走 SAVEPOINT，可安全嵌套（P1-12/R5）；forgetRun 用 BEGIN IMMEDIATE + ROLLBACK。
- **资源管理**：所有 LLM 调用有 AbortController 端到端超时；全部定时器 unref；dispose 等待 in-flight 任务后再关库（P2-4）；settings watcher 显式退订（P3-6）。
- **安全**：路由 loopback 鉴权基于 socket.remoteAddress（防 DNS rebinding）；注入内容统一 sanitize + escHtml + "数据非指令"声明（P0-5）；`validateBackup` 先验证再覆盖 + pre-import 回滚快照。
- **测试**：smoke.mjs 25 组断言覆盖主要纯函数；`ci` 脚本用 `git diff --exit-code lib/` 锁定构建产物一致性。

---

## 六、修复记录（2026-09-03 已按优先级修复并验证）

按报告第三节建议顺序完成全部 P0/P1 修复，`npm run build`（tsc strict）零错误、`npm run smoke` **251 passed / 0 failed**（含新增 G38 回归组）。

| 级别 | 修复 | 位置 |
|---|---|---|
| 严重 | **C1** `replace` 未指定字段时默认值改为取自 target（layer/kind/importance/epistemic），不再静默重置 | `store.ts` replace 分支 |
| 中等 | **M1** `recall`/`recallEpisodes` 空 query 直接返回 `[]`，不再全库 `'%%'` 扫描、不 touchAccess 污染热度 | `store.ts` recall / recallEpisodes 入口 |
| 中等 | **M3** L1 无路由时跳过（`continue`）而非标记 `extracted=2` 永久降级，等有路由再重试 | `refine.ts` runRefineL1 |
| 中等 | **M2** L1 catch 块内 store 调用加防护（与 L2 的 A3 对齐） | `refine.ts` runRefineL1 catch |
| 中等 | **M4** 跨层内容冲突改为 `ok:false` + 可操作 reason（工具据实报 `[FAIL] 未完成`，不再误导"已记入"） | `store.ts` add 两处分支 |
| 中等 | **M6** `listLessonDrafts` 新增 `order` 选项，instant judge 改判**最新** draft（附 id 决胜，修复同毫秒排序） | `store.ts` / `refine.ts` |
| 中等 | **M5** `openInLocalEditor` 由 exec 字符串拼接改 `spawn` 数组参数（cmd 元字符 `&`/`%VAR%` 不再破坏） | `identity-routes.ts` |
| 轻微 | 删除死代码 `judgeAddMeta`/`buildAddMetaPrompt`/`parseAddMetaJson`（refine.ts §3.1 整段）、`weightOf`/`DEGRADED_HIGH`（quality.ts）、`L0Options` 死导入（index.ts） | 相关文件 |
| 测试 | 新增 smoke G38 回归组（C1/M1/M3/M4/M6）；G13 三条旧断言按 M3 新契约更新 | smoke.mjs |
| 文档 | `lesson-pipeline.md` §3.1 接口删除说明已同步 | docs/lesson-pipeline.md |

> 补充：G13 原先 3 条断言（"no-route degrades / not pending / audit null")锁定的是 M3 认定的 bug 行为，已一并改为新契约，构成回归保护。
