# Antigravity 右键菜单增强框架 (`antigravity-context-menu`)

面向 Google `Antigravity` 2.0 桌面端的**可拓展右键菜单优化框架**。默认内置「路径识别与资源管理器直达」等 5 大高频实用模块，支持可视化扩展管理与外部插件热插拔注册。

## 核心特性

1. **智能路径识别与资源管理器直达（首发核心）**
   - 自动识别 AI 输出、行内 `<code>`、代码块、选区及 `file://` 链接中的本地路径（支持 Windows 盘符、含空格路径、中文路径、UNC/WSL、`~`、`%USERPROFILE%`、POSIX 绝对路径，并自动剥离 `:行号:列号` / `#L10-L20` 后缀）。
   - 右键即可：**在资源管理器中打开/定位文件**、**使用默认应用直接打开文件**、**在终端中打开所在目录**，以及**多格式复制路径**（原生路径、POSIX `/` 路径、所在目录、仅文件名、`file://` 链接）。
   - 若目标路径尚不存在但上级目录存在，自动支持回退打开最近存在的上级目录。
2. **标蓝行内代码与终端命令快捷输入**
   - 完整继承原版「复制」能力，无需手动拖选即可直接复制标蓝行内代码、命令、路径或链接。
   - 自动识别标蓝代码、代码块与选区中的可执行终端命令（排除版本号、文件名与快捷键误判）：
     - **快捷输入到终端**：优先输入到当前已打开的内置终端（若未打开则自动展开/新建终端并等待 Shell 就绪后填入，不自动回车）。
     - **输入并在终端运行**：优先创建一个新的内置终端标签页，待提示符就绪后自动输入并回车执行（支持外部终端桥接）。
3. **可拓展架构（面向未来持续增加功能）**
   - **内置模块化体系**：路径与资源管理器、网页链接增强、基础编辑与代码块、选中文本工具箱（引用到输入框 / JSON 格式化 / URL & Base64 编解码 / 字数统计）、自定义动作模块均可独立启停。
   - **可视化自定义动作面板（`Alt+M`）**：无需写代码即可新增自定义右键菜单项（填入对话 Prompt、复制模板、浏览器打开 URL），支持 `{{selection}}`、`{{selection_encoded}}`、`{{path}}`、`{{dir}}`、`{{filename}}`、`{{url}}` 变量。
   - **全局扩展注册 API**：外部插件或脚本可通过 `window.__AGY_CONTEXT_MENU__` 动态注册模块或单动作：
     ```js
     window.__AGY_CONTEXT_MENU__.registerModule({
       id: 'my-custom-module',
       name: '我的扩展模块',
       description: '示例扩展',
       priority: 60,
       getItems(ctx, helpers) {
         if (!ctx.selectionText) return [];
         return [
           {
             id: 'my-action',
             label: '自定义操作',
             onClick: () => helpers.showToast('触发成功: ' + ctx.selectionText),
           },
         ];
       },
     });
     ```
3. **无干扰原生共存**
   - 按住 **`Shift + 右键`** 随时直达 Antigravity 原生右键菜单。
   - 在侧边栏会话列表、标签页头等原生交互控件上（未命中路径/选区时）自动放行原生菜单，不影响重命名、置顶、删除等原有功能。

## 安装与使用

```powershell
# 在仓库根目录同步全部插件（含 antigravity-context-menu）
python scripts/manage_plugins.py sync

# 如需升级宿主加载器至 v2.4.0 以解锁「默认应用直开文件」「终端打开目录」与路径存在性校验：
# 先完全退出 Antigravity，再执行：
python scripts/manage_plugins.py install
```

> [!TIP]
> 即使尚未重启 Antigravity 升级宿主，执行 `sync` 并在窗口内按 `Ctrl+R` 热刷新后，即可通过降级通道立即使用「在资源管理器中定位路径/文件」与全部纯前端扩展功能。
