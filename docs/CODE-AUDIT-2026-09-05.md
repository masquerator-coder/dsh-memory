# dsh-memory 全面代码审核报告（2026-09-05 复审）

- **日期**: 2026-09-05
- **前置**: 上次审核 `docs/CODE-AUDIT-2026-09-03.md` 的 P0/P1 修复（C1/M1/M2/M3/M4/M5/M6 + 死代码清理）已在 commit `9b38bd7` 落地。本次是**复审 + 新增面复核**。
- **范围**: `src/` 全部 14 个源文件（约 4700 行）、`build.mjs`、`smoke.mjs`（1259 行，G1–G38）、`cordis.patch.yml`、`package.json`、两份 tsconfig。
- **方法**: 逐文件通读 + 跨文件引用图谱 + 与 `lib/` 构建产物时间戳核对 + 实际运行验证（见下）。
- **运行验证**:
  - `node build.mjs`：两个 tsconfig（Node + client）tsc **strict 零错误**（构建在 esbuild 打包 client 一步因沙箱 spawn EPERM 中断，属本机限制，非代码缺陷；tsc 阶段已通过）。
  - `node smoke.mjs`：**251 passed / 0 failed**（含 G38 回归组 13 断言）。
  - 工作区 git 无未提交改动；`lib/` 时间戳全晚于 `src/`，构建产物无过期。
- **总体评价**: 代码质量高，事务/SAVEPOINT 原子性、LLM 超时、prompt-injection 防护、loopback 路由鉴权、dispose 收口等均处理细致。本次复审确认上次全部 P0/P1 修复在位且被 G38 锁定。**新增 1 个 P1 级新发现（`remove force=true` 击穿删除快照/不可逆/用户层永生契约，已实测证实）**，外加若干遗留的 P3/P4 清理项。

---

## 一、新增发现（非上次审核内容）

### N1. 【严重】`remove force=true` 击穿「删除快照 / 可回滚 / 用户层永生」三层契约（已实测证实）

- **文件**: `src/store.ts:758-767`（remove 分支）、`src/store.ts:577-586`（`hardDeleteMemory`）
- **路径**: 模型可传 `memory action=remove force=true`。`applyOne` 的 remove 分支在 `op.force` 时直接调 `hardDeleteMemory(target.id)`，**既不落 `forget_deleted` 快照，也不对 `layer=user` 设任何保护**。
- **对比**: 主动遗忘硬删路径（`src/store.ts:1410-1413`）在物理删除**前**插入 `forget_deleted`（内容+原因，P1-13）；`heat.ts:shouldDelete` 明确 `layer=user` 永远返回 false。而 `remove force=true` 这条模型可达的硬删路径两条都绕开了。
- **实测**（本机直连 `lib/store.js` 验证）:
  ```
  user force-remove -> forget_deleted rows: 0 | row still exists: false
  after 2nd force-remove -> forget_deleted rows: 0
  ```
  即一条 `layer=user, importance=5` 的记忆被 `remove force=true` 后**物理消失且 0 快照**，永久不可恢复。
- **违背的既定契约**:
  1. README §5.1「真删前落快照（forget_deleted 表）内容+原因可查、可回滚」「每步可回滚」——此路径 0 快照；
  2. README/heat.ts「user 层永生 / 永不真删」——此路径一击即毁；
  3. DESIGN §5.2「删了能查、误删能回滚」仅覆盖 forgetRun 面，模型显式 force 面漏了。
- **影响**: 模型在纠正/清理时若误传 `force=true`，或攻击者诱导模型删 user 层，都会造成**不可逆、无审计**的数据丢失（含被设计为永生的用户画像事实）。属高频可达路径上的契约违反。
- **修复建议**（择一或组合）:
  1. remove-force 分支在 `hardDeleteMemory` 前先插 `forget_deleted`（reason 用 `explicit-remove`，带 importance/quality/heat 快照），与 forgetRun 对齐；
  2. 对 `layer=user` 的 `force=true` 拒绝或要求二次确认（`layer=user` 只允许软归档）；
  3. smoke 增补 G39：断言 force 删除落 `forget_deleted` 且有原因；断言 user 层 force 删除要么被拒、要么也落快照。
- 说明：软归档 `remove`（默认）无此问题（archived=1，可 recall/recorrect）。

---

## 二、中等 / 轻微（含上次遗留未清理项）

### 上次审核 P3/P4 项的状态核实

| 上次编号 | 位置 | 状态 | 说明 |
|---|---|---|---|
| L5 smoke 双 `node:fs` import | `smoke.mjs:36,47` | **未修** | 两处 `from 'node:fs'`，合并不影响功能，纯整洁 |
| L7 `hostDefault` 遮蔽 | `index.ts:722` vs `:419` | **未修** | `controls.loadModels` 内 `let hostDefault` 遮蔽外层同名 const，可读性 |
| L11 拥塞提前 return 跳过缓冲 | `index.ts:462` | **未修** | `l0InFlight >= L0_MAX_INFLIGHT` 时整个 handler `return`，**同时跳过** turn 文本缓冲（idle-settle）与 `kickRefine()`；拥塞期间新回合既不进缓冲也无即时凝练kick。建议把 return 改为仅跳过 `runL0`，仍执行下方缓冲+kick |
| L12 `runNow` 未 track | `index.ts:695-712` | **未修** | `controls.runNow` `await runRefine(true)` 未计入 `inFlightTasks`，dispose 的 `allSettled` 可能先 `store.close()` 再让手动 pass 写已关库（有 catch 不崩，结果丢弃） |
| L3 残留 `L0Options` 死导出 | `l0.ts:32-51` | **未修** | 死 import 已删（index.ts），但 `L0Options` 接口本身仍导出且全项目零引用 |
| L14 client/server 类型重复 | `client.tsx:44-113` vs `identity-routes.ts:44-100` | 架构约束 | 因 client 无法 import server 类型，结构性重复；可抽零依赖 `shared-types.ts` |

### 本次新注意到的轻微一致性

- **M7a（轻微）**：`runRefineL2`（`src/refine.ts:477`）`store.batch(ops...)` 的返回值未检查 `overflowed`。若某簇合并/删除触发过 tier-0 预算，L2 仍写 `ok` 审计并 `upsertL2Refined`，而实际零写入（事实保留、无数据丢失，但审计与实况不符）。对比 L1 路径显式处理了 overflow（1-by-1 重试）。建议 L2 也读取返回值，overflow 时按 `ok-noop` 记账。
- **M7b（轻微）**：`runRefineLessonPromote` instant 走 `limit 5 + desc`，而上次 M6 建议是「limit 1 精确判刚更新的那条」。改为 5 条并判最新已消除「审旧不审新」的原始缺陷，但**同毫秒**内多次 `recordFailure`（聚合到同一 draft，`drafted_at` 会刷新为 now）时 desc 仍可能把并发纠错判给同一 draft——功能上可接受，属剩余边界。

---

## 三、上次审核 P0/P1 修复复核（全部确认在位，smoke G38 锁定）

| 项 | 修复位置 | 代码确认 | G38 断言 |
|---|---|---|---|
| C1 replace 未指定字段取 target | `store.ts:744-748` | ✅ layer/kind/importance/epistemic 均 `?? target.*` | G38 5 条 |
| M1 空 query 早退 | `store.ts:892, 1066` | ✅ `if (!query.trim()) return []` | G38 3 条 |
| M2 L1 catch 内 store 防护 | `refine.ts:399-402` | ✅ 双层 try/catch 与 L2 对齐 | — |
| M3 无路由 continue 不标记 | `refine.ts:320-327` | ✅ 不置 extracted=2 | G38 1 条 |
| M4 跨层冲突诚实拒绝 | `store.ts:622, 644` | ✅ `ok:false` + 可操作 reason | G38 2 条 |
| M5 openInLocalEditor spawn 数组 | `identity-routes.ts:135-151` | ✅ cmd/open/xdg-open + 数组参数 | — |
| M6 instant 判最新 draft | `store.ts:1290-1294`；`refine.ts:587` | ✅ `order: desc` | G38 1 条 |
| 死代码清理 | `quality.ts:103-106`、`l0.ts` 导入 | ✅ `weightOf`/`judgeAddMeta` 段已删 | — |

---

## 四、值得肯定（维持上月结论，无需改动）

- 事务/原子性：episode+FTS、batch、hard-delete 全 SAVEPOINT；forgetRun BEGIN IMMEDIATE+ROLLBACK。
- 资源：LLM 全 AbortController 端到端超时 + R8 有界一次纠错；定时器全 unref；dispose 等 in-flight 再关库并退订 settings watcher。
- 安全：loopback 基于 `socket.remoteAddress`（防 DNS-rebinding）；注入内容统一 sanitize+escHtml+「数据非指令」声明；`validateBackup` 先验再覆盖 + pre-import 回滚快照。
- 测试：smoke.mjs 251 断言覆盖 G1–G38；`ci` 用 `git diff --exit-code lib/` 锁定构建产物一致性；smoke 直测 `lib/` 产物（非 src），确保发布面被验证。

---

## 五、建议的修复优先级清单

| 优先级 | 问题 | 文件:行 | 一句话修复 |
|---|---|---|---|
| **P0** | N1 `remove force=true` 无快照 + 可删 user 永生层 | store.ts:758,577 | force 前落 `forget_deleted` 快照；user 层 force 拒绝或同样落快照；补 G39 |
| P1 | M7a L2 overflow 未记账 | refine.ts:477 | 检查 batch 返回值，overflow 记 `ok-noop` |
| P2 | L11 拥塞跳缓冲 | index.ts:462 | return 移到缓冲+kick 之后 |
| P2 | L12 runNow 未 track | index.ts:695 | `track(runRefine(true).then(...))` |
| P3 | L3 `L0Options` 死导出 | l0.ts:32 | 删除接口 |
| P3 | L5/L7 整洁项 | smoke.mjs / index.ts | 合并 import、重命名遮蔽变量 |
| P3 | M7b instant limit/并发判同 | refine.ts:587 | 用 draft id 精确锚定刚更新的 draft |
| P4 | L14 shared-types 抽取 | — | 择机重构 |

---

## 六、修复记录（2026-09-05 本次已按清单完成并验证）

已完成复审提出的全部 N1 + 大部分低风险清理项。`tsc`（Node + client）strict **零错误**；`smoke.mjs` **258 passed / 0 failed**（含新增 G39 7 断言 + G38 回归组全绿）；`lib/` 已随 src 重新构建并一致。

| 级别 | 修复 | 位置 |
|---|---|---|
| **P0 N1** | `remove force=true`：① `layer=user` 拒绝强制物理删除（可软归档/可 replace 修订）；② 其余层 force 删除前落 `forget_deleted` 快照（reason=`explicit-remove`），与 forgetRun 的 P1-13 对齐 | `store.ts` remove 分支 |
| P1 | **M7a** L2 批量 overflow 时记 `ok-noop` 审计并 `continue`（不 `upsertL2Refined`，簇留待预算宽松再审） | `refine.ts` runRefineL2 |
| P2 | **L11** 拥塞时仅跳过 `runL0`，turn 文本缓冲 + `kickRefine()` 照常执行 | `index.ts` session/event handler |
| P2 | **L12** `controls.runNow` 内 `runRefine(true)` 经 `track()` 收口，dispose 会等待手动 pass | `index.ts` |
| P3 | **L3** 删除 `L0Options` 死导出接口（已同步 `lib/l0.d.ts`） | `l0.ts` |
| P3 | **L5** `smoke.mjs` 合并两处 `node:fs` import | `smoke.mjs` |
| P3 | **L7** `loadModels` 内 `let hostDefault` 重命名为 `hostDefaultModel`，消除遮蔽 | `index.ts` |
| P3 | **M7b** lesson instant 精确判**最新单条** draft（`limit 1 + desc`），不再把积压旧 draft 卷入即时判定 | `refine.ts` runRefineLessonPromote |
| P4 | **L14** 抽 `src/shared-types.ts` 纯类型文件，server（identity-routes/index）与 client（client.tsx）两端统一引用 `RunNowResult`/`RefineModelCandidate`/`RefineModelsPayload`/`ViewMemory`/`ViewPayload`；client 端重复定义删除，两端不再漂移 | 新建 `src/shared-types.ts` + 两端 import |
| — | **tsconfig 去泄漏**：`tsconfig.json`/`tsconfig.client.json` 里的开发机真实绝对路径改为 `${DSH_HARNESS_ROOT}` 占位符 + 说明注释，不再暴露本机路径；`build.mjs:emitTsconfig` 同步改为替换占位符（并放宽 react 版本占位匹配），构建在任何机器可用 | `tsconfig*.json` + `build.mjs` |
| 测试 | 新增 smoke **G39**（N1：user 层 force 拒绝 + 保留、普通 remove 仍软归档；memory 层 force 删除落快照 + reason 正确） | smoke.mjs |

> **L14 已落地**：shared-types 为纯类型，`import type` 编译期擦除、零运行时字节——已实测 `lib/client.js` 不含任何 shared-types 引用，且 client.js 逐字节与改动前一致（仅 sourcemap 变），确认零行为影响。构建产物 `lib/shared-types.js`/`.d.ts` 已生成，`lib/client.js` 已随全量构建重建。
> **tsconfig 去泄漏已落地**：提交的两份 tsconfig 不再含 `D:/Apps/deepseek-harness` 之类的真实路径；`${DSH_HARNESS_ROOT}` 占位符由 `build.mjs:emitTsconfig` 在构建时才替换为实测根目录。IDE 直接读占位符时类型解析需先跑 `build.mjs`（已写入文件头注释）。build.mjs 的 `findHarnessRoot` 仍保留 `D:/`/`C:/Apps/...` 作为运行时自动探测的候选默认值（功能必需，非 tsconfig 硬编码）——如需彻底去字面量可改用 `DSH_HARNESS_ROOT` 环境变量驱动，属可选后续。


