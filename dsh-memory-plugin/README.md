# dsh-memory

DSH 记忆插件：把 `D:\Coding\dsh-memory\memory_system` 的长期记忆接入 DeepSeek Harness。

插件本身**不含任何记忆逻辑**。摘要生成、预算截断、用户画像、条目编辑、Markdown 备份全部由
`memory_system` 实现，插件只做三件事：

1. 把记忆锚点注入系统提示词；
2. 采集会话回合，并调用模型生成记忆摘要；
3. 在设置页提供「记忆」入口，用来调参、看摘要、改画像、编辑条目、备份恢复。

两者之间通过子进程 + 行分隔 JSON 协议通信（`memory_system.bridge`），因此 Python 侧可以脱离 DSH 单独测试。

## 设置页功能

设置 → 记忆：

| 区块 | 作用 |
| --- | --- |
| 记忆库 | 连接状态、当前项目 id、条目数、存储位置、检索后端 |
| 记忆摘要长度 | 滑块 + `100k / 300k / 500k / 800k` 快捷档 + 自定义数字输入；同时可切换自动生成模式 |
| 用户画像 | 直接编辑并保存；系统提示词会告诉模型"需要时可以查看用户画像" |
| 记忆摘要 | **记忆摘要生成**（调用模型）、**查看记忆摘要**（全文弹窗）、历史版本 |
| 记忆条目 | **记忆查看与编辑**：列出、搜索、改内容/重要度/类型/标签、归档与恢复 |
| 备份与恢复 | 导出 Markdown；从 Markdown 预览并恢复 |

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
| `captureTurns` | `true` | 自动把用户消息与回合结果记入情景记忆 |
| `autoSummary` | `false` | 回合结束后自动生成摘要 |
| `autoSummaryDelayMs` | `15000` | 自动生成的最短空闲间隔（防抖） |
| `systemPromptAnchor` | `true` | 是否注入记忆锚点 |
| `requestTimeoutMs` | `60000` | 单次桥接调用超时；超时会重启子进程，避免响应错位 |
| `digestScope` | `project` | 设置页「记忆摘要生成」的默认范围 |
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
`ctx.llm.stream`，再 `digest.commit` 落库（含预算截断）。因此：

- 摘要生成需要一个已经用过模型的会话进程（插件会记录最近的模型路由）；
- 记忆库为空时不会硬编摘要，而是记录「还没有可总结的记忆」；
- 自动生成与手动生成走同一条路径，只有 `reason` 不同。

## 数据安全

- 记忆条目只做**软删除**（`archived`），随时可恢复；
- 恢复备份只新增条目，从不删除现有记忆；
- 记忆锚点只包含规模、时间与工具指引，**不含摘要正文**，正文通过工具按需读取；
- 会话采集存的是用户消息与回合结果的一句话摘要，不存模型输出全文。