# 记忆分层导出为 Markdown（MD-EXPORT）设计方案

> 状态：草案待评审 ｜ 关联：`docs/DESIGN.md`、`src/identity-routes.ts`（备份路由）、`src/store.ts`（数据访问）、`src/format.ts`（展示格式化）
> 目标读者：dsh-memory 维护者 ｜ 评审后进入实现

## 1. 需求与目标

用户要求在 dsh-memory 中新增"把所有记忆导出为 Markdown"的能力，**分层导出——不同层级的记忆放进不同的文件**。经澄清，核心决策已定：

- **分层的维度**：按**存储载体**分文件 —— 语义记忆 / 情景摘要 / 身份文件。
- **导出的范围**：**全量** —— 含有效、**已归档、低质量**的语义记忆；情景摘要；身份文件。状态作为 `01-memories.md` 内部的第二层。
- **导出物的形态**：浏览器点击后下载**三个 `.md` 文件（分别下载，不打 zip）**。

### 1.1 与现有「导出备份」的边界（为什么两者并存）

| | 导出备份 `.db` | 导出 Markdown（本方案） |
|---|---|---|
| 面向对象 | 整库一致快照，含 FTS/审计轨 | 人可读、可迁移的档案 |
| 消费场景 | 离线保存、迁移、`导入备份`回滚 | 阅读、分享、纳入文档仓库 |
| 是否可回滚 | 可（再导入） | 只读只出不入，不参与回滚 |
| 实现 | `VACUUM INTO`（node:sqlite 原生） | SQLite 读取 + 纯函数渲染成文本 |

两者互补：`.db` 是"机器的真相源快照"，Markdown 是"人的档案"。本功能**只读、零 LLM、可纯函数测试**，与插件"零 LLM 主循环"的工程纪律一致。

## 2. 导出文件布局（按载体分层）

导出为一组 Markdown 文件，文件名**带序号前缀**保证直觉排序，日期戳保证可追溯：

```
dsh-memory-export-20260906T123000/
├── 01-memories.md      # 语义记忆（有效，主体）
├── 02-episodes.md      # 情景会话摘要
└── 03-identity.md      # soul.md / user.md 身份文件
```

> 交付形态：浏览器一次下载多个文件。实现上最简做法是**逐个触发下载**（与现有 `exportBackup` 一致，零新增依赖）；若后续需要单一压缩包可另议（见 §7 H2）。

### 2.1 文件头（三文件共用模板）

```markdown
# dsh-memory 导出 — <载体中文名>

> 导出时间：2026-09-06 12:30:00（Asia/Shanghai）
> 来源：dsh-memory 插件分层导出
> 共 <N> 条 ｜ 文件：<fileName>
```

时间用本机时钟（`time-ctx` 已有的时区渲染逻辑可复用），避免引入授时复杂度。

## 3. 各文件内容结构

### 3.1 `01-memories.md` —— 全部语义记忆（核心交付）

数据源：`store.list({ includeArchived: true })`（取**全部**记忆，含已归档；低质量字段 `low_quality` 在返回条目上区分）。不排除任何状态——**全量导出**。

**两层结构**：先按**状态**（第二层）分大节 → 再按 `layer` 分中节 → 再按 `kind` 分小节 → 小节内按 `importance` 降序：

```
## 一、有效记忆（未归档，非低质）
### 用户记忆（layer=user）
#### 偏好 preference
- **<topic>**：...
### 一般记忆（layer=memory）
#### 教训 lesson
- ...

## 二、已归档记忆（archived=1，软删待遗忘）
（同样按 layer → kind 组织）

## 三、低质量记忆（low_quality=1，被排除出召回/注入）
（同样按 layer → kind 组织）
```

> 状态优先级：一条记忆若同时归档且低质 → 归入"已归档"节（归档优先），避免重复出现。分组轴按 `layer` 与 `kind` 与"查看记忆"弹窗对齐。

单条条目渲染模板（各节通用）：

```
- **<topic>**
  - 内容：<content>（多行→按 markdown 展开，安全转义防注入）
  - 元数据：id | layer | kind | tier | importance | epistemic | created | updated | archived | low_quality
  - 签名：`<short-hash>`
```

**格式化的三条安全/一致性约束**（沿用 `format.ts` 的 `oneLine` 思路，但此处**保留换行**以利可读，改为对 `content` 做 markdown 转义）：

1. `content` 是模型写的不可信文本 → 行首缩进 + 对 `#`/`*`/`-`/`` ` ``/`[` 等字符转义，**杜绝注入伪造列表行或标题**。需新增纯函数 `mdSafe(text)`（可 smoke 单测）。
2. 日期统一用本机时区 `YYYY-MM-DD` 渲染，避免时间戳裸数字。
3. 每条附"出处 id + 创建/更新时间"，与库内可反查，保证可核验（呼应项目"诚实可核验"原则）。

### 3.2 `02-episodes.md` —— 情景会话摘要

数据源：`store.listEpisodes({ includeArchived: true })`（**全部**会话摘要，含已归档）。

```markdown
## 会话摘要（按时间倒序）

### 2026-09-05 · <topic>
- 摘要：<summary>
- 会话：<session_id> ｜ 工具：tools_used（若有） ｜ 凝练状态：extracted(已抽取/降级/未处理)
```

`summary` 同做 markdown 转义防注入。

### 3.3 `03-identity.md` —— 身份文件

数据源：`readIdentityFiles(store.dir)`（复用现有实现），把 `soul.md` / `user.md` 原文原样搬入对应节：

```markdown
# 身份文件

## soul.md（AI 人格 / 行为准则，人写）
<原文原样>

## user.md（用户画像，人写）
<原文原样>
```

> 注：soul/user 是"人写的恒定身份"，本功能**只原样带入，不参与热度/遗忘**——与插件的身份权威化决策一致。

## 4. 服务端实现要点

### 4.1 新增纯函数（`src/md-export.ts`，零 dsh 依赖，可被 smoke 直接测）

```
renderMemoriesMarkdown(entries): string
renderEpisodesMarkdown(episodes): string
renderIdentityMarkdown(soul, user): string
mdSafe(text): string
exportMarkdownBundle(store): { filename, content }[]   // 组装三文件，含文件头
```

放独立文件而非堆进 `format.ts`，因为它是"档案级渲染"而 `format.ts` 是"模型上下文行渲染"，定位不同（后者强制 single-line 防注入，前者保留换行）。`mdSafe` 与 `oneLine` 思路同源、策略不同，必须分开。

### 4.2 新增路由（`src/identity-routes.ts` 内）

```
GET /memory/export/markdown   → { ok, files: [{name, content}], stub: 三节统计 }
```

- **只读、零 LLM**，任何时点导出都一致（不触发凝练/遗忘）。
- 复用 `isTrustedRequest`，**仅 loopback**，与 `/memory/backup/*` 同一信任模型（`README.md` §3.3 已确立）。
- 返回结构化为 JSON；前端逐个触发浏览器下载。
- 三节各计数（记忆条数 / 会话条数 / 是否含身份文件）供 UI 回显"导出完成"。

### 4.3 route 注册表

在 `routes` 数组追加 `{ path: '/memory/export/markdown', handler: markdownExport }`，并同步 README §3.3 的 loopback 路由清单。

## 5. 前端 UI 入口（`src/client.tsx`）

在设置面板「记忆」的备份区下方新增一行，与"导出备份/导入备份"并列但不混语义：

```
[导出 Markdown]  →  下载 01-memories.md / 02-episodes.md / 03-identity.md（分层档案）
```

- 新增 `exportMarkdown()` 到 `MemoryControlHandlers`，遍历 `files` 逐个 `URL.createObjectURL + a.click()` 触发下载（与现有 `exportBackup` 同款模式）。
- 完成后回显"已导出 3 个文件：语义 N 条 / 会话 M 条 / 身份已含"。
- 骨架/禁用态与现有 `exporting` 一致。

## 6. 测试（smoke.mjs 新增断言组）

- `mdSafe`：注入 `# 标题` / `- 列表` / `*强调*` / 反引号 / 换行 → 均被转义，无法伪造 markdown 结构。
- `renderMemoriesMarkdown`：layer 分节、kind 分节、importance 排序正确；含 `file头` 统计。
- `renderEpisodesMarkdown`：时间倒序、字段齐全。
- `renderIdentityMarkdown`：soul/user 原样落地。
- 空库：三文件仍生成（空节提示"暂无"），不抛错。
- 计数：导出的记忆条数 == `store.list({includeArchived:false, includeLowQuality:false}).length`。

## 7. 已定决策（用户拍板）

- **H1** 三文件**分别下载**（不打 zip，零新增依赖）。
- **H2** **三文件全含**：`01-memories.md` / `02-episodes.md` / `03-identity.md` 都导出。
- **H3** 已归档/低质量**也要导出**——作为 `01-memories.md` 内的"已归档 / 低质量"状态节，全量不遗漏。

---

## 附：为什么这样设计（取舍）

- **零 LLM + 纯函数 + smoke 可测**：延续插件"核心存查零 LLM、纯函数+规则可验证"的工程纪律，导出不出现在不可验证的黑盒里。
- **与 view 弹窗口径一致**：`01-memories.md` 数据源与 `buildViewPayload` 相同，避免"UI 看到的和导出对不上"。
- **只读不回流**：Markdown 是档案，不参与导入/回滚，避免与 `.db` 快照职责重叠造成混淆。
- **保留换行 + 转义**：档案面向人读，需可读性；但模型写的内容不可信，转义是安全底线。
