---
name: project-memory-file-location
description: 项目工作记录按日期写在 .agents/memory/<YYYY-MM-DD>.md
metadata:
  origin: dsh-memory
  title: 项目记忆文件位置
  created-at: 2026-11-07T09:40:00+08:00
---
# 项目记忆文件位置

项目的工作记录（派生摘要）按日期存放在项目根目录的 `.agents/memory/<YYYY-MM-DD>.md`，一个日期一个文件；不要再写单文件 `.agents/memory/MEMORY.md`（旧布局，插件首次写入时会自动迁移并删除）。也不要写回仓库根目录的 `DSH_MEMORY.md`。这些文件由 dsh-memory 从 L2 工作记录自动派生，文件名日期取记录时间戳的 UTC 日期，可随时重新生成。
