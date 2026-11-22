# Antigravity 上下文洞察与诊断面板 (`antigravity-context-doctor`)

模仿 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 为 Google `Antigravity` 2.0 桌面应用打造的**上下文可视化与无痛交接插件**。以原生分页标签（Tab）的形式融入 `Antigravity` 右侧边栏，完全自包含、跨小版本兼容、更新自动自愈，并与 `antigravity-zh-cn`、`antigravity-usage-dashboard`、`antigravity-snippets`、`antigravity-notifier` 无缝共存。

---

## 核心特性

1. **原生右侧边栏分页形态（`+ > 插件 > 上下文洞察` / `Alt+C`）**：
   - 不新增额外的悬浮胶囊或独立侧边栏：在 `Antigravity` 原生右侧边栏中通过 **`+ > 插件 > 上下文洞察`** 打开，直接在顶部标签栏插入与 `审查确认`、`浏览器`、`终端` 并列的胶囊分页标签 **`上下文洞察`**（附带实时上下文占比 `%`）。
   - 可在 `上下文洞察` 与其他原生分页间随时切换（切换走时保留顶部标签，点一下即可切回），点击标签右侧 `✕` 可关闭该分页；也支持按 `Alt+C` 快速切入/拉起。
   - 使用 Shadow DOM 样式隔离，自动读取宿主主题 Token，完美适配深浅色主题与中英文界面。
2. **常驻上下文窗口水位与分段占比**：
   - 实时展示当前会话最新一轮 `Prompt Context` 占用率，并用分段色条区分 `Cache Read`、`New Input`、`Output / Thinking`。
   - 点击右上角模型标签（如 `Gemini 4 Hydrogen · 1M ▾`）可快速切换该模型的窗口上限预设（`128K / 200K / 400K / 1M / 2M`）。
   - 超过预警阈值（默认 `75%` / `90%`）自动提示，一键跳转交接面板。
3. **5 大洞察标签页**：
   - **总览（Overview）**：4 项关键指标 KPI（最新单轮上下文、Cache 命中率、累计 Token、输出速度与压缩次数）、6 类上下文内容构成拆解（用户提问、AI & Thinking、文件读取/搜索、终端命令日志、代码编辑/写入、`Subagent`/MCP）、近 24 轮演进 SVG 趋势图（标出压缩/剪枝与激增点）以及健康诊断卡片。
   - **大户（Heavy Hitters）**：按估算 Token 体积对轨迹步骤排行，支持分类芯片过滤（读文件/终端/改写/AI/提问/报错）、关键字搜索、切换排序以及点击展开内容预览与复制。
   - **文件 & 编队（Files & Fleet）**：聚合追踪会话内每个文件的 `R`（读）/ `E`（改）/ `W`（写）/ `S`（搜）次数（自动标出 ≥3 次重复读取），并展示当前会话关联的 Multi-Agent `Subagent` 编队节点。
   - **全局（Insights）**：近 7 天跨会话 Token 消耗柱状图、7 天 Cache 平均命中率与可搜索排序的会话卡片，点击任意历史会话即可直接切入分析其上下文（支持一键`← 回到当前会话`）。
   - **交接（Handoff）**：按勾选模块自动提炼任务目标、修改文件、关键命令、阶段结论与待排查问题，生成可编辑的精简交接 Prompt，支持**一键填入当前/新对话输入框**、复制或导出诊断 `JSON`。

---

## 快速安装与使用

### 方式一：复制提示词让 Agent 自动安装

```text
请帮我下载并安装 https://github.com/KiriuKazurei/antigravity-plugins 仓库中的 antigravity-context-doctor 插件：先克隆仓库到临时目录，运行 python scripts/manage_plugins.py test 验证，再执行 python scripts/manage_plugins.py sync --only antigravity-context-doctor（如果宿主 app.asar 尚未接入 pluginLoader.js，请改用 install 或 stage 并提醒我退出后重启 Antigravity），最后用 status 确认安装结果。
```

### 方式二：命令行手动安装

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 首次接入需先完全退出 Antigravity：
python scripts/manage_plugins.py install --only antigravity-context-doctor
```

> [!TIP]
> 若你之前已经接入过同源宿主（`antigravity-zh-cn`、`antigravity-usage-dashboard` 等），只需同步文件后在窗口内按 **`Ctrl+R`** 即可热生效：
> ```powershell
> python antigravity-context-doctor/scripts/install_context_doctor.py sync
> ```

---

## 使用说明

1. **打开面板**：在 `Antigravity` 右上角打开右侧边栏 -> 点击 `+`（或新建分页界面）-> 悬停 **`插件 >`** -> 点击 **`上下文洞察`**，或直接按 **`Alt+C`**。
2. **分页管理**：顶部标签栏中点击 `审查确认` / `终端` / `上下文洞察` 自由切换；点击标签右侧 `✕` 关闭分页。
3. **偏好设置**：点击面板右上角 `⚙` 可调整预警阈值（`65% / 75% / 85%`）、面板语言（自动/中文/EN）、是否额外开启悬浮边缘标签，或重置自定义模型窗口上限。

---

## 常用管理命令 & 单元测试

```powershell
# 查看宿主状态与自愈状态
python antigravity-context-doctor/scripts/install_context_doctor.py status

# 预构建 app.asar.staged（Antigravity 运行中时使用）
python antigravity-context-doctor/scripts/install_context_doctor.py stage

# 还原官方原版 app.asar（需先完全退出 Antigravity）
python antigravity-context-doctor/scripts/install_context_doctor.py restore

# 运行单元测试
node antigravity-context-doctor/runtime/test_context_doctor.js
```

---

## 目录结构

```text
antigravity-context-doctor/
├── .gitignore
├── LICENSE                         # MIT 开源协议
├── README.md                       # 说明文档
├── plugin.json                     # 插件清单（声明 runtime/context-doctor.js）
├── hooks.json                      # SessionStart 更新自愈钩子
├── scripts/
│   ├── install_context_doctor.py   # 同步与安装便捷入口
│   ├── plugin_host.py              # 自包含宿主安装、校验与自动自愈脚本
│   ├── session_hook.py             # SessionStart 钩子安全入口
│   └── pluginLoader.js             # 注入 app.asar 的通用插件宿主加载器
└── runtime/
    ├── context-doctor.js           # 上下文洞察与诊断运行时（Shadow DOM）
    └── test_context_doctor.js      # 单元测试与标签页集成测试
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
