# dsh-memory 全面代码审核报告（2026-09-01）

- **审核范围**：`src/` 全部 15 个源文件（~3,300 行）、`build.mjs`、`smoke.mjs`、`cordis.patch.yml`、`tsconfig*.json`、`lib/` 编译产物一致性抽查
- **审核基准**：项目内已有 2026-08-30 / 08-31 两轮审查（P0-x / P1-x / P2-x / P3-x / P4-1 / R-x / M-x 修复标记），本轮**不重复已修复问题**，重点为验证修复正确性与发现新问题
- **总体结论**：代码质量整体**优秀**——零运行时依赖、SQL 全参数化、纯函数设计、修复留痕注释、190 项 smoke 断言。本轮发现 **1 项严重**（去重度量缺陷可致数据丢失）、**7 项一般**、**10 项建议**。

---

## 一、严重（应尽快修复）

### S1. 相似度按 min 长度归一 → 短片段可静默覆盖既有长条目（数据丢失）

| 项 | 内容 |
|---|---|
| 位置 | `src/quality.ts:33-37`（`contentSimilarity`）→ `src/store.ts:331-355`（`findCanonical`）→ `src/store.ts:481-510`（add 合并路径） |
| 原因 | `contentSimilarity = LCS / min(a.len, b.len)`。当新内容是既有条目的**子串**时 LCS = 新内容长度，相似度恒为 1.0 ≥ SIM_DUP(0.85)，`findCanonical` 判为近重复并返回既有行；add 合并路径随后用**新内容覆写**该行 `content`。P0-3 只给 `replace` 路径加了 `MIN_REPLACE_FRAGMENT=8` 防护，`add` 路径没有任何长度/比例守卫。且覆写不经过 `recordFailure`（只挂在 replace 路径），丢失内容**无痕、不可回滚**。触发示例：库中已有「用户偏好深色主题且使用VSCode开发」，模型 add「用户偏好深色主题」→ 长条目内容被 8 字片段替换，细节永久丢失 |
| 修复建议 | ① `contentSimilarity` 加长度比守卫：`max(len)/min(len) > 2` 时直接返回 0（或改用 `LCS / max(len)` 归一）；② add 合并路径要求新内容长度 ≥ 既有内容长度的某比例（如 50%）才允许覆写 content，否则保留较长一方；③ 合并覆写 content 时同步写 `failure_memories` 留痕，保持「误删能回滚」契约 |

---

## 二、一般（应列入近期修复计划）

### G1. `l1RetryDegraded` 默认值三方不一致，且实际默认引发审计表膨胀

| 项 | 内容 |
|---|---|
| 位置 | `src/index.ts:115`（注释 "Default false"）、`src/index.ts:230`（代码 `?? true`）、`README.md:211`（示例 `false`） |
| 原因 | 代码实际默认 `true`。叠加「L1 enabled 但无 LLM 路由」的常见场景（未配 l0/l1Provider、无 learned 路由、hostDefault 缺失），`retryDegraded=true` 使每个 `extracted=2` 的 episode 在**每小时**的 refine 定时器中被重新处理一遍，每次都写一行 `refine_runs` 审计（degraded）。100 个降级 episode → 每天约 2,400 行、180 天保留窗内可达 40 万+ 行，同时每轮还输出一次 console.warn |
| 修复建议 | 默认值改回 `?? false` 与注释/README 对齐（若确需 true，同步改注释与 README 并说明理由）；另在 `runRefineL1` 中对「无路由」的降级重试跳过审计写入（状态未变，无审计价值） |

### G2. Host/Origin 头均可被非浏览器客户端伪造，loopback 写保护仅对浏览器有效

| 项 | 内容 |
|---|---|
| 位置 | `src/identity-routes.ts:42-56`（`isTrustedWriteRequest`） |
| 原因 | Host 与 Origin 都是客户端可自设的请求头。直连 TCP 的攻击者可发送 `Host: 127.0.0.1` 且不带 Origin，即满足全部校验。当前防护实际只拦住「DNS rebinding 网页 + 正常浏览器」两类场景；一旦 webServer 绑定非回环地址（README §3.3 仅文字声明"自行加鉴权"，未提供机制），LAN 内任意客户端可写 soul.md/user.md——这两个文件直接注入系统提示词，属持久提示注入面 |
| 修复建议 | 若 seam 暴露了 socket 信息，改判 `req.socket.remoteAddress ∈ {127.0.0.1, ::1}`（传输层事实，不可伪造）；否则至少：① 提供可配置的写令牌（settings 面板生成、POST 必带）；② 无鉴权且绑定非回环时启动告警 |

### G3. GET `/memory/identity` 无任何来源限制，个人画像数据可被任意可达客户端读取

| 项 | 内容 |
|---|---|
| 位置 | `src/identity-routes.ts:138-139` |
| 原因 | 写操作有 loopback 校验，读操作完全开放（注释自称 "GET is read-only and unrestricted"）。soul.md/user.md 是用户画像与 AI 人格数据，服务器绑定 LAN 时任何同网段客户端可完整拉取，与写保护不对称 |
| 修复建议 | GET 套用与 POST 相同的来源校验，或纳入 G2 的鉴权方案统一处理 |

### G4. add 去重的 content-hash id 路径忽略 layer，静默改写条目层级

| 项 | 内容 |
|---|---|
| 位置 | `src/store.ts:471-483`（`this.get(cid)` 分支） |
| 原因 | `findCanonical(content, layer)` 带 layer 过滤，但先于它的 `this.get(cid)` 精确命中**不校验 layer**，随后 `writeMemory` 用 op 的 layer 覆写。两个后果：① 已有 user 层事实被不带 layer 的重加（默认 `layer='memory'`）覆写为 memory 层，**静默丢失永生保护**；② 反向则把 memory 层条目静默提升为 user 层（永久免疫遗忘 + 计入 user 预算）。同一内容因 id 是否漂移而走两种去重语义，行为不可预测 |
| 修复建议 | cid 命中后校验 `existing.layer === layer`，不匹配时与 `findCanonical` 同语义（跳过该 existing，走 near-dup / 新行路径）；与 P2-1「未指定字段保留既有值」的哲学保持一致 |

### G5. replace 按片段匹配不校验唯一性，错误信息却声称 "unambiguous"

| 项 | 内容 |
|---|---|
| 位置 | `src/store.ts:530-533` |
| 原因 | `activeEntries().find(e => ...includes...)` 取 `updated DESC` 排序后的**第一条**命中；多条目包含同一片段时静默替换任意一条（最近更新的那条），而错误提示要求 "an unambiguous ≥8-char fragment"。P0-3 修了长度下限，没修歧义 |
| 修复建议 | 收集全部匹配；匹配数 >1 时拒绝并提示改用 id；=1 时才执行 |

### G6. identity 维护先记账后写盘，文件写失败则该批内容永久不再同步

| 项 | 内容 |
|---|---|
| 位置 | `src/identity.ts:83-94`（`maintainUserIdentity`） |
| 原因 | 循环内逐条 `markIdentitySynced`（写 DB 账本），`writeFileSync` 在循环结束后才执行且无 try/catch。磁盘满/权限错误时文件未写入，但账本已记——这些内容此后永不再进入 user.md，且异常直接抛给上层（`runIdentity` 有 catch，但数据已丢） |
| 修复建议 | 先在内存完成拼装并 `writeFileSync`，成功后再统一 `markIdentitySynced`；写盘失败时账本不落，下轮重试 |

### G7. README 断言数过时、smoke.mjs 头注释缺 G13–G24

| 项 | 内容 |
|---|---|
| 位置 | `README.md:293`（称 175 项）、`smoke.mjs:1-16`（头注释仅列 G1–G12） |
| 原因 | 实测 `smoke.mjs` 含 **190** 项断言、G1–G24 全部存在。头部注释与实际组数脱节，README 数字也滞后——测试文档失真会让"全绿"声明的可信度打折 |
| 修复建议 | 更新 README 数字与 smoke.mjs 头注释；或在 smoke 结束时打印组数/断言数并让 README 引用输出而非硬编码 |

---

## 三、建议（择机改进）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| A1 | `src/heat.ts:59-61` + `src/index.ts` schema | `forgetDays` 无正值校验：配 0 → λ=∞ 全库立即降级归档；配负值 → λ<0 热度随时间指数增长 | `resolveForgetDays` 或 schemastery schema 加 `.min(1)`，启动时 clamp |
| A2 | `src/store.ts:1016-1019` | `refineAttemptCount` 统计该 source 的**全部** refine_runs 行（含 degraded/error），降级重试计数被无关审计行膨胀，预算溢出的 episode 可能提前停止重试 | COUNT 加 `AND status IN ('ok','ok-noop')` |
| A3 | `src/refine.ts:343-348` | docstring 称 "Never throws"，但 catch 块内 `store.writeRefineRun` 自身可能抛（DB 已关），异常逃逸 | catch 内再包一层 try/catch，审计写失败时仅计数 |
| A4 | `src/store.ts:452-455` + `src/tools.ts` | `memory` add 的 content 无长度上限，单条超大内容进 DB + FTS，拖慢后续 `findCanonical` 全扫 | 工具层 clamp（如 2,000 字符）或 store 层拒绝超限 |
| A5 | `src/l0.ts:70-98` | `collectTurnTexts` 每 turn-end 全量扫描 `session.events`，长会话 O(turns²) | 维护已处理事件游标，增量收集 |
| A6 | `src/format.ts:47-49` ↔ `src/tools.ts` execute 文案 | `writeFailed` 靠中文消息子串（'未完成'/'预算已满'…）判定卡片状态，文案一改判定即静默失效 | execute 返回结构化 verdict 字段，卡片读字段不猜文本 |
| A7 | `src/identity-routes.ts:71-92` | `readJsonBody` 只限总量不限速率，64KB 内的慢速发送可长期占住连接 | 加 idle timeout（如 5s 无数据即 destroy） |
| A8 | `src/client.tsx:208-219` | webServer 绑定 LAN 时，设置面板自身同源 Host 非 loopback → saveIdentity 必被 403，UI 无提示只回滚 | 与 G2/G3 统一鉴权设计；短期至少在保存失败时给出原因提示 |
| A9 | `src/inject.ts:44-45` | `sanitizeText` 第一个 `replace(/[ \t]+/g,' ')` 被第二个 `\s+ → ' '` 完全覆盖，冗余 | 删除第一个正则 |
| A10 | 仓库根 `lib/` | 编译产物入库靠人肉 build 保持同步（本次时间戳一致，但无流程保障），有漂移风险 | CI 增加 `npm run build && node smoke.mjs && git diff --exit-code lib/` 式校验，或改 .gitignore + 发布时构建 |

---

## 四、各维度正面确认（无问题项）

| 维度 | 结论 |
|---|---|
| SQL 注入 | 全部语句参数化；动态拼接仅限固定子句组合（`list`/`recall`）与 `Math.floor` 后的 LIMIT，LIKE 通配符经 `escapeLike` + `ESCAPE '\'` 处理；FTS 查询词加引号转义。**无注入面** |
| 提示注入防护 | P0-5 体系完整：声明头 + `<memory-entry>` 定界 + 控制字符折叠 + markdown 结构转义 + escHtml（R3）+ 条目/整段双限长；format.ts 列表面同样走 oneLine 折叠 |
| 事务与一致性 | batch/writeEpisode/hardDelete 均用 SAVEPOINT（可嵌套，P1-12/R5）；forgetRun 用 BEGIN IMMEDIATE；真删前先写快照表（P1-13/R7）；hardDelete 级联清理 failure_memories（P3-15） |
| 并发与生命周期 | in-flight 任务追踪后关库（P2-4）、timer 全 unref、并发上限（P1-10）、l0Pending LRU + 过期驱逐（P2-5）、dispose 反订阅（P3-6/P3-6b）——本轮复核 dispose 顺序正确 |
| 既有 P 系列修复 | 抽查 P0-2/P0-3/P1-1/P2-1/P2-37/P4-1 等修复点实现与注释一致，未发现回归 |
| lib/ 一致性 | lib/*.js 时间戳均晚于对应 src 文件（2026-09-01 08:21 构建），当前无漂移 |
| 架构与可维护性 | 模块边界清晰（store 纯存储 / l0·refine 纯函数+注入 seam / tools 边界校验 / inject 渲染），零 npm 运行时依赖，修复留痕注释密度极高，smoke 覆盖纯函数层。1200 行的 store.ts 是唯一偏大的文件，但内聚性尚可，暂无拆分必要 |

---

## 五、修复优先级建议

1. **立即**：S1（数据丢失路径，改 `contentSimilarity` + add 路径守卫，加 smoke 用例锁定）
2. **本周**：G4（layer 覆写）、G5（replace 歧义）、G1（默认值统一 + 审计膨胀）
3. **下个迭代**：G2/G3/G8 统一设计 identity 路由鉴权；G6、G7
4. **择机**：A1–A10

*审核方法：逐文件人工通读全部 src/ 源码与构建/测试脚本，交叉比对 README 声明、schema、smoke 断言与运行时行为；未运行动态测试（smoke 全量跑通属发布流程范畴）。*
