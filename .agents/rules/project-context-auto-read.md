---
name: project-context-auto-read
description: 打开项目时记忆插件自动扫描并注入项目记忆与规则
metadata:
  origin: dsh-memory
  title: 会话开始先读项目记忆与规则
  created-at: 2026-11-07T09:40:00+08:00
---
# 会话开始先读项目记忆与规则

再次打开该项目时，记忆插件在会话首次装配系统提示词时自动扫描并注入 `.agents/memory/MEMORY.md` 与 `.agents/rules/*.md`，让模型先了解项目的工作记录和规则要求；不需要模型再手动读取。
