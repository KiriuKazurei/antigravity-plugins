# Antigravity 轻量化 Markdown 知识库 (`antigravity-kb`)

为 Google `Antigravity` 2.0 桌面应用打造的**本地真实 `.md` 轻量化知识库插件**。以原生右侧边栏分页（`+ > 插件 > 知识库` / `Alt+K`）融入界面，支持多 Vault 目录切换、Markdown 实时预览与双栏编辑、`[[双向链接]]`、对话输入框 `[[` 快捷引用、选中文本一键收藏，并内置零依赖 `MCP` Server 让 AI 直接检索与沉淀知识。

---

## 核心特性

1. **真实本地 `.md` 存储，兼容 Obsidian / VS Code / Git**：
   - 默认个人知识库位于 `~/.gemini/kb/`，所有笔记均为标准 UTF-8 `.md` 文件（支持 YAML Frontmatter `title` / `tags` / `aliases`）。
   - 删除笔记时安全移入 `<vault>/.trash/`，避免误删丢失。
2. **多 Vault 一键切换**：
   - 自动探测当前对话工作区（以及工作区下的 `docs/` 目录），与个人知识库随时切换；也支持通过系统原生目录选择器挂载任意本地目录（如已有 Obsidian Vault）。
3. **右侧边栏原生分页（`+ > 插件 > 知识库` / `Alt+K`）**：
   - 复用 Shadow DOM 隔离样式，支持深浅色自适应与中英文切换，并与 `antigravity-context-doctor` 同栏互斥协同。
   - 支持 **预览 / 编辑 / 分栏** 三种视图，支持点击任务复选框 `- [ ]` 直接写回本地文件、`[[双向链接]]` 点击跳转、反向链接自动统计、代码块一键复制与插入对话。
4. **AI 原生工作流闭环**：
   - **输入框 `[[` 快捷引用**：在对话输入框键入 `[[` 实时检索笔记，`Tab` 一键插入笔记正文 / 引用块 / 文件路径（不与 `antigravity-snippets` 的 `#` 冲突）。
   - **选中文本一键收藏**：在对话区选中 AI 回复或代码块时，点击浮现的 `📥 存到知识库` 胶囊，即可保存为新笔记或追加到已有笔记。
   - **内置 `MCP` Server（`scripts/kb_mcp.py`）**：提供 `kb_list`、`kb_search`、`kb_read`、`kb_write`、`kb_append` 五个工具，让 AI 在对话中主动查库或沉淀经验。

---

## 快速安装与部署

```powershell
# 1. 验证单元测试与一致性
python scripts/manage_plugins.py test

# 2. 同步并更新宿主加载器（因新增本地 KB Bridge，需重启一次 Antigravity 生效）
python scripts/manage_plugins.py install
```

> 若 Antigravity 正在运行导致 `app.asar` 被占用，可先运行 `python scripts/manage_plugins.py stage`，随后退出并重启 Antigravity 即可自动应用。
