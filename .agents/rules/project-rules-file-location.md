---
name: project-rules-file-location
description: 用户对项目的约定、规则、限制一条一份 markdown 放在 .agents/rules/
metadata:
  origin: dsh-memory
  title: 项目规则的文件约定
  created-at: 2026-11-07T09:40:00+08:00
---
# 项目规则的文件约定

用户对项目的约定、规则、限制等规则性要求，存放在项目根目录的 `.agents/rules/`；每条规则单独建一份 markdown 文件（kebab-case 文件名，frontmatter 含 name/description/metadata.title），不要把规则混进工作记录或记忆摘要。
