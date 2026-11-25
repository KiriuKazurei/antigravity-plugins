---
name: manage-kb
description: 管理与检索用户的 Antigravity 轻量化 Markdown 知识库（~/.gemini/kb 与已挂载工作区笔记）。当用户要求查询历史笔记/经验、把排查结论/代码规范沉淀到知识库、或整理知识库标签与双链时使用。
---

# Antigravity 轻量化 Markdown 知识库指南

本插件通过内置 `antigravity-kb` MCP Server 为你提供直接访问用户本地真实 `.md` 知识库的能力，并与右侧边栏 UI（`+ > 插件 > 知识库` / `Alt+K`）共享同一份目录配置（`~/.gemini/config/plugins/antigravity-kb/runtime/kb-config.json`）。

## 可用 MCP 工具

1. `kb_list`：列出当前激活 Vault（或 `vault: "all"`）下的笔记清单、标签与更新时间。
2. `kb_search`：按关键词或 `#标签` 检索知识库（建议在排查重复问题或编写架构方案前先搜一下用户过往笔记）。
3. `kb_read`：读取笔记正文、Frontmatter 元数据以及反向链接（`backlinks`），支持直接传相对路径或 `[[笔记标题]]`。
4. `kb_write`：创建或更新 `.md` 笔记（支持自动生成 `title`、`tags` Frontmatter）。
5. `kb_append`：向已有笔记末尾追加分段记录（如追加排查结论或操作备忘），若目标笔记不存在则自动新建。

## 使用建议

- **沉淀知识时**：尽量提炼清晰标题、1~3 个精准 `tags`、可复用的命令/代码片段与根因结论，避免把整段无意义对话日志原文丢进知识库。
- **双链关联**：若与已有笔记相关，可在正文中使用 `[[其他笔记标题]]` 建立双向链接，UI 面板会自动识别并支持点击跳转与反向链接展示。
- **修改现有笔记前**：先用 `kb_read` 读取全文，确认结构后再决定用 `kb_append` 追加还是 `kb_write` 整体更新，避免覆盖用户原有手写内容。
