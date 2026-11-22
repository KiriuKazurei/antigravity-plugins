# Antigravity Plugins Suite (`antigravity-plugins`)

面向 Google `Antigravity` 2.0 桌面应用的实用增强插件合集。所有插件采用**完全自包含、Shadow DOM 样式隔离、共用字节一致的宿主加载器（`pluginLoader.js`）以及 `SessionStart` 更新自动自愈**设计，既可全套一键安装，也可按目录独立选用并无缝共存。

> [!NOTE]
> 简体中文汉化插件维护在独立仓库：[KiriuKazurei/antigravity-zh-cn-plugin](https://github.com/KiriuKazurei/antigravity-zh-cn-plugin)，与本仓库内全部插件共用同源宿主加载器，可无缝共存。

---

## 插件清单

| 子目录 | 插件名称 | 版本 | 核心能力 | 快捷键 / 入口 |
| :--- | :--- | :--- | :--- | :--- |
| [`antigravity-context-doctor/`](./antigravity-context-doctor/README.md) | **上下文洞察与诊断面板** | `v1.0.0` | 融入原生右侧边栏顶部标签分页，实时可视化上下文窗口占用、内容构成拆解、上下文大户排行、文件活动追踪、Multi-Agent 编队、7 天跨会话洞察及一键生成无痛交接 Prompt | 右侧栏 `+ > 插件 > 上下文洞察` / `Alt+C` |
| [`antigravity-usage-dashboard/`](./antigravity-usage-dashboard/README.md) | **模型 Usage 侧边栏仪表盘** | `v1.0.1` | 左侧边栏底部悬浮卡片，实时显示各模型配额池剩余百分比、重置倒计时、Credits 余额、当前轮次/会话 Token 消耗、TPS 与持久化历史统计 | 左侧边栏底部（`Settings` 上方） |
| [`antigravity-snippets/`](./antigravity-snippets/README.md) | **高频 Prompt 模板库** | `v1.0.0` | 输入框 `#` 实时检索模板（标题/缩写优先），支持动态变量（`{{date}}` / `{{clipboard}}` / `{{selection}}`）、光标锚点 `{{$cursor}}` 与可视化模板管理 | 输入 `#` / `Alt+P` / 右下角胶囊 |
| [`antigravity-notifier/`](./antigravity-notifier/README.md) | **任务通知与远程推送** | `v1.0.0` | 感知任务完成、等待授权、异常中断，支持桌面弹窗、Web Audio 合成提示音、后台标题闪烁及飞书/企业微信/Discord/Telegram Webhook 远程推送 | 左侧栏 `远程推送` / `Alt+N` |

---

## 快速安装

### 环境要求

- `Python 3`
- `Node.js`（仅运行单元测试时需要）
- `Git`（可选，也可直接下载 Release 压缩包）

### 1. 一键安装全部插件

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 先完全退出 Antigravity 桌面端，然后执行安装
python scripts/manage_plugins.py install
```

### 2. 按需安装指定插件

```powershell
# 示例：仅同步并安装上下文洞察与模板库
python scripts/manage_plugins.py install --only antigravity-context-doctor,antigravity-snippets
```

> [!TIP]
> 如果已接入过一次宿主加载器（`app.asar` 已启用 `pluginLoader.js`），后续更新或新增插件只需执行：
> ```powershell
> python scripts/manage_plugins.py sync
> ```
> 然后在 `Antigravity` 窗口内按 **`Ctrl+R`** 即可热生效，无需重启应用。
> 若安装时 `Antigravity` 正在运行，脚本会自动生成 `app.asar.staged`，退出后再次运行 `install` 或在下次开启会话时由 `SessionStart` 自愈钩子自动完成替换。

---

## 常用管理与校验命令

```powershell
# 查看宿主状态、加载器一致性与各插件同步状态
python scripts/manage_plugins.py status

# 运行全套校验（pluginLoader.js 一致性 + py_compile + 各插件 Node.js 单元测试）
python scripts/manage_plugins.py test

# 彻底还原官方原版 app.asar（需先完全退出 Antigravity）
python scripts/manage_plugins.py restore
```

---

## 仓库结构

```text
antigravity-plugins/
├── LICENSE
├── README.md
├── scripts/
│   └── manage_plugins.py             # 多插件总控脚本（status/sync/install/stage/test/restore）
├── antigravity-context-doctor/       # 上下文洞察与诊断面板
├── antigravity-notifier/             # 任务通知与 Webhook 远程推送
├── antigravity-snippets/             # # 触发 Prompt 模板库
└── antigravity-usage-dashboard/      # 模型配额与 Token 用量仪表盘
```

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
