# Antigravity Prompt 模板库插件 (`antigravity-snippets`)

为 Google `Antigravity` 2.0 桌面应用提供**完全自包含、跨小版本兼容、更新自动自愈**的高频 Prompt 模板库插件。在任意对话输入框中键入 `#` 即可实时检索模板，**`title` / 缩写优先匹配**，方向键切换、`Tab` 一键插入，不污染模型 System Context，支持发送前自由编辑与多片段组合。

---

## 核心特性

1. **零负担 `#` 实时触发与精准排序**：
   - 在对话输入框输入 `#` 自动呼出悬浮检索卡片（自动规避 `##`、`# 标题`、URL `#hash`、`C#` 等误触发，且兼容中文输入法 IME 组合态）。
   - **严格分级匹配**：标题精确 / 前缀匹配 > 快捷缩写 `alias`（如 `#cr`、`#bug`、`#ut`） > 标题包含 / 模糊匹配 > 标签 / 分类 > Prompt 正文内容。
   - **键鼠无缝协同**：`↑` / `↓` 切换，`Tab` 快捷确定插入（不误触发送消息），`Esc` 关闭。
2. **动态变量与光标锚点**：
   - `Tab` / 点击零二次确认直接插入输入框，内置 `{{变量:默认值}}` 自动展开为默认值（可直接把需补充的内容放到最后一行或用 `{{$cursor}}` 标出光标位置，插入后直接在输入框里修改）。
   - 支持自动环境变量：`{{date}}`、`{{time}}`、`{{datetime}}`、`{{clipboard}}`、`{{selection}}`、`{{workspace}}`。
   - 支持光标落点锚点 `{{$cursor}}`：插入模板后自动将光标定位到指定位置（例如代码块内部）。
3. **可视化模板库管理（`Alt+P` 或点击右下角 `# 模板库` 胶囊）**：
   - 内置 8 套开箱即用的研发高频模板（Code Review、先对齐方案再动手、Bug 根因排查、单元测试、安全重构、架构速览、Git Commit 总结、性能分析）。
   - 支持**一键从当前输入框收藏为模板**、新增 / 编辑 / 删除 / 置顶、使用次数统计、JSON 导入导出备份。
4. **完全自包含与多插件共存**：
   - 复用通用宿主加载器（`scripts/pluginLoader.js`）与 `SessionStart` 自愈钩子（`hooks.json`），与 `antigravity-zh-cn`、`antigravity-usage-dashboard` 无缝共存，且保持宿主加载器字节一致避免冲突。

---

## 快速安装与部署

### 方式一：复制提示词让 Agent 自动安装

```text
请帮我下载并安装 https://github.com/KiriuKazurei/antigravity-plugins 仓库中的 antigravity-snippets 插件：先克隆仓库到临时目录，运行 python scripts/manage_plugins.py test 验证，再执行 python scripts/manage_plugins.py sync --only antigravity-snippets（如果宿主 app.asar 尚未接入 pluginLoader.js，请改用 install 或 stage 并提醒我退出后重启 Antigravity），最后用 status 确认安装结果。
```

### 方式二：命令行手动安装（Windows PowerShell）

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 首次接入宿主需先完全退出 Antigravity：
python scripts/manage_plugins.py install --only antigravity-snippets

# 若已接入过同源宿主（如 usage-dashboard / zh-cn），只需 sync 后在窗口内按 Ctrl+R 即可热生效：
python scripts/manage_plugins.py sync --only antigravity-snippets
```

## 用法速览

- **快速唤出模板**：在对话输入框任意位置键入 `#`（如 `#cr`、`#bug`、`#ut`），使用 `↑` / `↓` 切换并用 `Tab` 插入（不会误触发送）。
- **管理与收藏模板**：按 **`Alt+P`**（或 `Ctrl+Shift+;` / 点击右下角 `# 模板库` 胶囊）打开管理面板，支持一键把当前输入框内容收藏为新模板、置顶、编辑及 `JSON` 导入导出。
- **变量与光标**：支持 `{{变量:默认值}}`、环境变量（`{{date}}`、`{{time}}`、`{{datetime}}`、`{{clipboard}}`、`{{selection}}`、`{{workspace}}`）以及光标锚点 `{{$cursor}}`。

### 常用管理命令

```powershell
# 仅同步前端脚本更新（已接入宿主时，在窗口内按 Ctrl+R 即可热生效）
python antigravity-snippets/scripts/install_snippets.py sync

# 查看插件、宿主版本、备份与自愈状态
python antigravity-snippets/scripts/install_snippets.py status

# 仅预构建 app.asar.staged，不立即替换
python antigravity-snippets/scripts/install_snippets.py stage

# 彻底还原官方原版 app.asar（需先完全退出 Antigravity）
python antigravity-snippets/scripts/install_snippets.py restore
```

---

## 运行单元测试

```bash
node runtime/test_snippets.js
```

---

## 目录结构

```text
antigravity-snippets/
├── .gitignore
├── LICENSE                         # MIT 开源协议
├── README.md                       # 说明文档
├── plugin.json                     # 插件清单（声明 runtime/snippets.js）
├── hooks.json                      # SessionStart 更新自愈钩子
├── scripts/
│   ├── install_snippets.py         # 同步与安装便捷入口
│   ├── plugin_host.py              # 自包含宿主安装、校验与自动自愈脚本
│   ├── session_hook.py             # SessionStart 钩子安全入口
│   └── pluginLoader.js             # 注入 app.asar 的通用插件宿主加载器
└── runtime/
    ├── snippets.js                 # Prompt 模板库运行时（Shadow DOM）
    └── test_snippets.js            # 单元测试与 DOM 集成测试
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
