# Antigravity 增强插件套件 (`antigravity-plugins`)

[English](./README.md) | **简体中文**

面向 Google `Antigravity` 2.0 桌面应用的自包含增强插件合集。全部插件共用字节一致的宿主加载器（`scripts/pluginLoader.js`），采用 `Shadow DOM` 样式隔离，并内置 `SessionStart` 更新自愈钩子（`hooks.json`），既可全套一键安装，也可按子目录按需选用并无缝共存。

> [!NOTE]
> 简体中文汉化插件维护在独立仓库：[KiriuKazurei/antigravity-zh-cn-plugin](https://github.com/KiriuKazurei/antigravity-zh-cn-plugin)，与本仓库内的全部插件共用同源宿主加载器，可完全兼容共存。

---

## 插件清单

| 子目录 | 插件名称 | 版本 | 核心功能 | 入口 / 快捷键 |
| :--- | :--- | :--- | :--- | :--- |
| [`antigravity-context-doctor/`](./antigravity-context-doctor/README.md) | **上下文洞察与诊断面板** | `v1.0.0` | 以原生分页形式融入右侧边栏，实时可视化上下文窗口占用、内容构成拆解、上下文大户排行、文件活动追踪、Multi-Agent 编队、7 天跨会话洞察及一键生成交接 Prompt | 右侧栏 `+ > 插件 > 上下文洞察` / `Alt+C` |
| [`antigravity-kb/`](./antigravity-kb/README.md) | **轻量化 Markdown 知识库** | `v1.0.0` | 本地真实 `.md` 知识库：右侧边栏原生 Tab 浏览/编辑/实时预览、`[[` 快捷引用插入、一键收藏 AI 回复与代码块、`[[双向链接]]` 与 `#标签` 检索，自带轻量 `MCP` 服务 | 右侧栏 `+ > 插件 > 知识库` / `[[` |
| [`antigravity-usage-dashboard/`](./antigravity-usage-dashboard/README.md) | **模型 Usage 侧边栏仪表盘** | `v1.0.1` | 停靠在左侧边栏底部，实时显示模型配额池剩余百分比、重置倒计时、Credits 余额、当前轮次/会话 Token 消耗、TPS 与持久化历史统计 | 左侧边栏底部（`Settings` 上方） |
| [`antigravity-snippets/`](./antigravity-snippets/README.md) | **高频 Prompt 模板库** | `v1.0.0` | 在对话框输入 `#` 实时检索模板（标题/缩写优先），支持动态变量（`{{date}}`、`{{clipboard}}`、`{{selection}}`）、光标锚点 `{{$cursor}}` 与可视化模板管理 | 输入 `#` / `Alt+P` / 右下角胶囊 |
| [`antigravity-notifier/`](./antigravity-notifier/README.md) | **任务通知与远程推送** | `v1.0.0` | 感知任务完成、等待授权、异常中断，支持桌面弹窗、Web Audio 合成提示音、后台标题闪烁与飞书 / 企业微信 / Discord / Telegram / 自定义 Webhook 远程推送 | 左侧栏 `远程推送` / `Alt+N` |

### 各插件详细定位

- **[`antigravity-context-doctor`](./antigravity-context-doctor/README.md)** — 灵感源自 `dsh-context`，作为与 `审查确认`、`浏览器`、`终端` 并列的原生分页运行在右侧边栏。帮你快速定位“到底哪一步把上下文吃满了”（区分 `Cache Read` / `New Input` / `Output`、大日志命令、重复读文件），并在接近窗口上限时一键提炼交接 Prompt 填入输入框。
- **[`antigravity-kb`](./antigravity-kb/README.md)** — 面向 `Antigravity` 的本地 `.md` 知识库插件，提供右侧边栏原生编辑与预览、`[[` 对话框快捷引用、一键收藏 AI 回复与代码块，并内置 `MCP` 工具让 Agent 直接检索与沉淀知识。
- **[`antigravity-usage-dashboard`](./antigravity-usage-dashboard/README.md)** — 在左侧边栏实时观测各模型共享配额池剩余量、重置倒计时、Credits 与历史消耗统计，重启后历史数据不丢失。
- **[`antigravity-snippets`](./antigravity-snippets/README.md)** — 内置 8 套高频研发模板，兼容中文输入法 `#` 检索、`Tab` 直接插入且不误触发送，支持一键收藏当前输入内容与 `JSON` 导入导出。
- **[`antigravity-notifier`](./antigravity-notifier/README.md)** — 通过 RPC 状态与审批按钮组双通道防误报识别，长任务跑完或卡在审批确认时第一时间通过本地弹窗/音效或 `Stop` Hook Webhook 通知你。

---

## 给 Agent 的快速下载安装提示词（直接复制）

直接复制下面这段话发给 `Antigravity` 或其他 AI Agent，即可自动完成下载、校验与安装：

```text
请帮我下载并安装 https://github.com/KiriuKazurei/antigravity-plugins.git 仓库中的插件：
1. 将 https://github.com/KiriuKazurei/antigravity-plugins.git 克隆到本地临时目录。
2. 运行 `python scripts/manage_plugins.py test` 验证多插件加载器一致性、Python 语法与全部单元测试。
3. 运行 `python scripts/manage_plugins.py status` 检查宿主 `app.asar` 是否已接入最新 `pluginLoader.js`：
   - 如果已接入且为最新，执行 `python scripts/manage_plugins.py sync`，并提醒我在 Antigravity 窗口内按 Ctrl+R 热刷新生效。
   - 如果尚未接入或版本较旧，在 Antigravity 已退出时执行 `install`（若正在运行则先执行 `stage`），并告诉我需要重启 Antigravity 完成接入。
4. 最后再执行一次 `python scripts/manage_plugins.py status` 向我汇报所有插件的安装状态。
```

> [!TIP]
> 如果只想安装其中某几个插件，可以把上面提示词里的 `sync` / `install` 加上 `--only antigravity-context-doctor,antigravity-usage-dashboard`（逗号分隔任意子目录名）。

---

## 手动安装与常用命令

### 环境要求

- `Python 3`
- `Git`（可选，也可直接下载 Release 压缩包）
- `Node.js`（仅运行单元测试时需要）

### 命令行安装

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 首次接入宿主需先完全退出 Antigravity 桌面端：
python scripts/manage_plugins.py install

# 或仅安装指定插件：
python scripts/manage_plugins.py install --only antigravity-context-doctor,antigravity-snippets
```

### 日常管理命令

```powershell
# 仅同步插件代码更新（已接入宿主时，在窗口内按 Ctrl+R 即可热生效）
python scripts/manage_plugins.py sync

# 查看宿主状态、加载器一致性与各插件同步状态
python scripts/manage_plugins.py status

# 运行全套校验（pluginLoader.js 一致性 + py_compile + Node.js 单元测试）
python scripts/manage_plugins.py test

# 彻底还原官方原版 app.asar（需先完全退出 Antigravity）
python scripts/manage_plugins.py restore
```

---

## 仓库结构

```text
antigravity-plugins/
├── LICENSE
├── README.md                         # 英文总览与快速安装指南
├── README_zh.md                      # 简体中文总览与快速安装指南
├── scripts/
│   └── manage_plugins.py             # 多插件总控脚本（status/sync/install/stage/test/restore）
├── antigravity-context-doctor/       # 上下文洞察与诊断面板
├── antigravity-kb/                   # 轻量化 Markdown 知识库与 MCP 服务
├── antigravity-usage-dashboard/      # 模型配额与 Token 用量仪表盘
├── antigravity-snippets/             # # 触发 Prompt 模板库
└── antigravity-notifier/             # 任务通知与 Webhook 远程推送
```

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
