---
name: diagnose-memory-anchor-missing
description: 排查摘要/锚点为何没进系统提示词
whenToUse: 当系统提示词里的记忆摘要缺失、显示「正在读取记忆摘要…」或「还没有全局摘要」，或刚生成摘要但提示词没更新时。
metadata:
  origin: dsh-memory
  title: 诊断记忆锚点不显示
  triggers: ["记忆锚点", "摘要没进提示词", "还没有全局摘要"]
  requires-tools: ["pwsh", "read", "grep"]
  created-at: 2026-10-27T15:01:08.786025+00:00
  updated-at: 2026-10-27T15:01:08.786025+00:00
---

# 诊断记忆锚点不显示

## 适用场景
当系统提示词里的记忆摘要缺失、显示「正在读取记忆摘要…」或「还没有全局摘要」，或刚生成摘要但提示词没更新时。

触发词：记忆锚点、摘要没进提示词、还没有全局摘要

前置工具：pwsh, read, grep

## 步骤
1. `read` 读 dsh-memory-plugin/index.js 的 anchor section，确认缓存槽、15 秒刷新周期与三处占位分支（正在读取/读取失败/尚未生成） **(关键)**
2. `pwsh` 用 python 打开 ~/.dsh/memory/memory.db，查 memory_digests 最新一行的 status/content 长度与 l4_skills 计数
   - 参数提示: 注意加载 sqlite_vec 扩展，否则 vec0 虚拟表会让查询报错
3. `pwsh` 在安装副本（~/.dsh/profiles/desktop/node_modules/dsh-memory）运行 python -m memory_system digest.anchor '{"include_summary":true,"include_profile":true}'，确认返回的 text 是否含摘要行 **(关键)**
4. `pwsh` 用 python zstandard 解压 ~/.dsh/sessions 下相关项目当天的 session.v4.jsonl.zstd，统计每个系统提示词事件是否含「全局记忆摘要」或占位文案 **(关键)**
5. `read` 对照时间线判定：status=error 属生成失败；摘要行在数据层存在但某步缺失属冷启动/缓存；全程缺失再查锚点 section 是否注册

## 成功标准
能明确问题在数据层（没有 ok 摘要）、锚点缓存层（冷启动/刷新）还是提示词装配层，并给出对应修复。
