# Antigravity 模型 Usage 侧边栏浮动仪表盘 (`antigravity-usage-dashboard`)

为 Google `Antigravity` 2.0 桌面应用提供**完全自包含、跨小版本兼容、更新自动自愈**的侧边栏浮动模型 Usage Dashboard 插件。在左侧边栏底部（`设置` / `Settings` 按钮上方）实时展示模型配额池（Quota）、重置倒计时、Credits 余额、当前轮次/会话 Token 消耗、TPS 及分模型持久化历史统计。

---

## 核心特性

1. **完全自包含可独立部署**：
   - 内置通用宿主加载器（`scripts/pluginLoader.js`）、跨平台宿主安装器（`scripts/plugin_host.py` / `scripts/install_dashboard.py`）与 `SessionStart` 更新自愈钩子（`hooks.json`），无需依赖其他外部插件即可独立部署。
   - 若同时安装有 `antigravity-zh-cn` 等使用同源 `pluginLoader.js` 的插件，可无缝共存、共享同一宿主挂载点。
2. **原位悬浮卡片（Shadow DOM 隔离）**：
   - 自动追踪左侧边栏与底部 `设置` / `Settings` 按钮几何位置，悬浮停靠于侧边栏底部留白区域，支持拖拽调整卡片高度及折叠为单行摘要胶囊。
   - 使用 Shadow DOM 隔离样式与节点，完全不干扰宿主 React 渲染树。
3. **双通道数据获取与持久化**：
   - 通过 `EARLY_RPC_TAP` 非侵入式网络监听 + 主动 Connect-RPC 调用（`RetrieveUserQuotaSummary`、`GetUserStatus`、`GetAvailableModels`、`GetAllCascadeTrajectories`、`GetCascadeTrajectoryGeneratorMetadata`）获取实时配额、Credits 与 Token/TPS 指标。
   - 将分轮次、分模型、分会话的 Token 消耗自动去重并原子持久化到 `runtime/usage-history.json`，重启后历史消耗不丢失。
4. **便捷交互**：
   - 支持切换 `页: 剩余`（共享额度池）与 `页: 消耗`（逐模型历史 Token），支持在 `设置` 面板筛选隐藏特定额度池/模型，支持深浅色主题与中英文界面自适应。
   - 内置 `SessionStart` 自愈钩子：`Antigravity` 自动更新覆盖 `resources/app.asar` 后，下次开启对话会自动预构建校验并恢复插件注入。

---

## 快速安装与部署

### 环境要求

- `Python 3`
- `Git`（可选，也可直接下载仓库 ZIP 解压）

### Windows (PowerShell)

```powershell
# 1. 克隆插件合集仓库
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 2. 完全退出 Antigravity 后执行一次接入（可仅安装本插件）
python scripts/manage_plugins.py install --only antigravity-usage-dashboard
```

### macOS / Linux (Bash / Zsh)

```bash
# 1. 克隆插件合集仓库
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 2. 完全退出 Antigravity 后执行一次接入（可仅安装本插件）
python3 scripts/manage_plugins.py install --only antigravity-usage-dashboard
```

> [!TIP]
> 你也可以直接进入 `antigravity-usage-dashboard` 子目录单独运行 `python scripts/install_dashboard.py install`，脚本会自动将插件文件同步到 `~/.gemini/config/plugins/antigravity-usage-dashboard/` 并完成宿主接入。
> 如果执行 `install` 时 `Antigravity` 正在运行，脚本会先生成 `app.asar.staged`，退出后再次运行 `install` 或在下一次启动会话时由自愈钩子自动完成替换。

---

## 常用管理命令

```powershell
# 仅同步前端脚本更新（app.asar 已接入过宿主加载器时，在窗口内按 Ctrl+R 即可热生效）
python scripts/install_dashboard.py sync

# 查看插件、宿主版本、备份与自愈状态
python scripts/install_dashboard.py status

# 仅预构建 app.asar.staged，不立即替换
python scripts/install_dashboard.py stage

# 彻底还原官方原版 app.asar（需先完全退出 Antigravity）
python scripts/install_dashboard.py restore
```

也可以直接调用 `python scripts/plugin_host.py <install|status|stage|restore>`。

---

## 运行单元测试

```bash
node runtime/test_usage_dashboard.js
```

---

## 目录结构

```text
antigravity-usage-dashboard/
├── .gitignore
├── LICENSE                         # MIT 开源协议
├── README.md                       # 说明文档
├── plugin.json                     # 插件清单
├── hooks.json                      # SessionStart 更新自愈钩子
├── scripts/
│   ├── install_dashboard.py        # 同步与安装便捷入口
│   ├── plugin_host.py              # 自包含宿主安装、校验与自动自愈脚本
│   ├── session_hook.py             # SessionStart 钩子安全入口
│   └── pluginLoader.js             # 注入 app.asar 的通用插件宿主加载器
└── runtime/
    ├── usage-dashboard.js          # 侧边栏浮动仪表盘运行时（Shadow DOM）
    └── test_usage_dashboard.js     # 仪表盘与宿主加载器单元测试
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
