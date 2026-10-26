# dsh-memory

DSH 记忆插件：把 `D:\Coding\dsh-memory\memory_system` 的长期记忆接入 DeepSeek Harness。

插件本身**不含任何记忆逻辑**。全局摘要生成、按预算控制详细程度、用户画像、条目编辑、
Markdown 备份与项目根摘要文件全部由 `memory_system` 实现，插件只做三件事：

1. 把记忆锚点（全局规模/时间 + **本项目最近工作**）与**本项目技能索引**注入系统提示词；
2. 在回合结束、会话结束时驱动**一份覆盖全部项目的全局工作摘要**；
3. 在设置页提供「记忆」入口，用来调参、看摘要、改画像、编辑条目、备份恢复。

两者之间通过子进程 + 行分隔 JSON 协议通信（`memory_system.bridge`），因此 Python 侧可以脱离 DSH 单独测试。

## 模型可用的 12 个工具

| 工具 | 作用 |
| --- | --- |
| `memory_recall` / `memory_search` / `memory_add` / `memory_forget` | 记忆的读、写、归档 |
| `memory_profile_read` / `memory_digest_read` / `memory_digest_generate` | 画像与全局摘要 |
| `skill_create` | 把验证过的做法存成**本项目**技能 |
| `skill_list` / `skill_get` | 列出 / 读取技能 |
| `skill_run` / `skill_retire` | 记录执行结果 / 退役 |

技能只做 project 作用域：org / sys 级晋升是用户决策，工具与桥接命令都不提供。

## 设置页功能

设置 → 记忆：

| 区块 | 作用 |
| --- | --- |
| 记忆库 | 连接状态、当前项目 id、条目数、存储位置、检索后端 |
| 记忆摘要长度 | 滑块，档位 `300 / 500 / 800 / 1000 / 1500 / 2000 / 3000` 字。预算只决定模型写多详细：预算大就展开细节，预算小就写结论，**不再截断输出**；自动生成固定空闲时运行 |
| 用户画像 | 直接编辑并保存；系统提示词会告诉模型"需要时可以查看用户画像" |
| 全局记忆摘要 | **生成**（调用模型）、**查看全文**（弹窗）、历史版本。摘要覆盖所有项目，只记录已做过的工作，不记录经验教训与偏好 |
| 记忆条目 | **记忆查看与编辑**：列出、搜索、改内容/重要度/类型/标签、归档与恢复 |
| 备份与恢复 | 导出 Markdown；从 Markdown 预览并恢复 |

除全局摘要外，每个项目根目录会由 `memory_system` 自动维护一个 `DSH_MEMORY.md`，
按时间记录该项目做过的工作，方便其他 Agent 或人直接阅读。

## 安装

仓库根就是组合包：根目录 `package.json` 声明 `dsh.bundle`，指向
`dsh-memory-plugin/cordis.patch.yml`。因此安装的 spec 是**仓库根**（Git 地址或本仓库目录），
不是 `dsh-memory-plugin` 子目录——子目录本身不声明组合包，DSH 会报「这个包没有声明组合包」。

```powershell
# 1. 确保 Python 能 import memory_system（插件默认把仓库根放进子进程 PYTHONPATH）
python -c "import sys; sys.path.insert(0, r'D:\Coding\dsh-memory'); import memory_system; print(memory_system.__file__)"

# 2a. 在 DSH 里安装：插件页「添加插件」，或
#     plugin_manager action=install_bundle target=D:\Coding\dsh-memory
# 2b. 或直接用 CLI（目录形式以 link: 记在 profile 里）：
dsh plugin --profile web add D:\Coding\dsh-memory
```

patch 里的模块名是相对路径（`./index.js`），所以仓库放在哪里都能被解析。

## 配置（`cordis.patch.yml` 中的 `dsh-memory` 行）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonPath` | `''` | 指定解释器；留空则依次尝试 `DSH_MEMORY_PYTHON`、`DSH_PYTHON`、`python` |
| `memorySystemRoot` | `''` | 含 `memory_system` 包的仓库根目录，会加入子进程 `PYTHONPATH`；留空则按插件自身位置推导（`bridge.js` 的上一级目录），不绑定某台机器 |
| `memoryHome` | `''` | 记忆库目录，留空为 `~/.dsh/memory`（或 `$DSH_HOME/memory`） |
| `projectOverride` | `''` | 固定项目 id，不再按会话工作目录推导 |
| `captureTurns` | `false` | **当前版本未读取，无实际效果**：插件不会自动采集会话。记忆只由模型通过 `memory_add` 主动写入，会话结束时再由一次模型调用补漏。保留该键只为兼容旧配置 |
| `autoSummary` | `true` | 回合结束、空闲后自动生成全局摘要；常开，界面不提供开关。摘要是**读**记忆，不受 `captureTurns` 影响 |
| `autoSummaryDelayMs` | `15000` | 回合结束到生成摘要之间的空闲间隔 |
| `systemPromptAnchor` | `true` | 是否注入记忆锚点 |
| `skillIndex` | `true` | 是否注入本项目技能索引（一行一个技能，30 秒缓存） |
| `skillAuthoring` | `true` | 是否在提示词里告诉模型何时可以 `skill_create`；默认每个会话最多新建 1 个 |
| `heartbeatSteps` | `20` | 距上次 `memory_add` 经过多少个模型步（`step/start`，一次模型调用算一步）后，在系统提示词里追加一次记忆提醒；`0` 关闭 |
| `sessionEndCheck` | `true` | 会话结束时调用一次模型，检查还有没有未写入的记忆 |
| `requestTimeoutMs` | `60000` | 单次桥接调用超时；超时会重启子进程，避免响应错位 |
| `embeddingPreset` | `''` | 传给 `MemoryConfig` 的向量化预设 |

## 记忆库位置

默认 `~/.dsh/memory/memory.db`，**跨项目共享**；项目通过会话工作目录（优先 `git remote`）推导为 `project_id`，
因此 `D:\Coding\dsh-memory` 与别的仓库各自拥有独立的记忆，却共用一个数据库文件。

## 桥接协议

子进程：`python -W ignore -m memory_system --serve`，stdin/stdout 每行一个 JSON。

```jsonc
// 请求
{"id": "h1", "command": "memory.recall", "payload": {"home": "...", "project_id": "...", "query": "..."}}
// 成功
{"id": "h1", "ok": true, "result": { ... }}
// 失败
{"id": "h1", "ok": false, "error": {"code": "validation", "message": "..."}}
```

每次请求可带 `home`、`db_path`、`embedding_preset`。stdio **强制 UTF-8**：Windows 旧控制台代码页（GBK）
曾把中文解码成乱码，`memory_system.__main__` 因此按字节读取并按 UTF-8 解码。

查看支持的命令：

```powershell
python -m memory_system --list
python -m memory_system status '{\"cwd\": \"D:\\\\Coding\\\\dsh-memory\"}'
```

## 模型调用

摘要由「宿主侧」调用模型：插件先 `digest.plan` 拿到材料与提示词，用会话当前使用的 provider/model 流式调用
`ctx.llm.stream`，再 `digest.commit` 原样落库。预算写在提示词里（预算越大要求越详细），
**提交时不再裁剪文本**。因此：

- 摘要生成需要一个已经用过模型的会话进程（插件会记录最近的模型路由）；
- 记忆库为空时不会硬编摘要，而是记录「还没有可总结的工作记录」；
- 自动生成与手动生成走同一条路径，只有 `reason` 不同；
- 每次提交还会刷新各项目根目录的 `DSH_MEMORY.md`；该文件由 L2 工作记录派生，失败不会影响摘要。

## 数据安全

- 记忆条目只做**软删除**（`archived`），随时可恢复；
- 恢复备份只新增条目，从不删除现有记忆；
- 记忆锚点只包含摘要规模、时间、用户画像规模、**本项目最近 ≤400 字的工作条目**与工具指引，**不含摘要正文**，全文通过工具按需读取；
- 全局摘要只记录“做过什么工作”，不写入经验教训与用户偏好；
- 项目根目录的 `DSH_MEMORY.md` 是派生文件，只包含该项目的工作记录，可随时重新生成；
- 会话结束检查存的是模型整理后的一句话摘要，不存模型输出全文或完整对话。
