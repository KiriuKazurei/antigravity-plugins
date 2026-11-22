# Antigravity 任务通知与远程推送插件 (`antigravity-notifier`)

为 Google `Antigravity` 2.0 桌面应用提供**完全自包含、跨小版本兼容、更新自动自愈**的任务完成 / 等待用户授权 / 异常中断提醒插件。支持本地桌面系统弹窗、Web Audio 合成提示音、后台标题闪烁以及飞书 / 企业微信 / Discord / Telegram / 自定义 Webhook 远程推送。

---

## 核心特性

1. **三类关键状态感知（防误报设计）**：
   - **任务完成**：监听 `GetAllCascadeTrajectories` 状态从 `RUNNING` 转为 `IDLE`，支持按最短耗时阈值过滤（默认 `5` 秒，避免短问候刷屏）。
   - **等待用户授权 / 输入**：结合 RPC `WAITING` 状态与界面真实审批按钮组（`批准`/`拒绝`、`仅允许本次` 等）双通道识别，自动跳过对话正文中的普通文字。
   - **异常中断**：捕获执行错误或超出上限暂停，第一时间提醒。
2. **本地多通道不打扰提醒**：
   - **桌面弹窗**：调用系统 `Notification` API，点击通知可直接拉起聚焦窗口。
   - **柔和提示音**：基于 Web Audio API 实时合成不同音色提示音（完成 / 确认 / 报错），零外部音频依赖，支持音量调节与试听。
   - **后台标题闪烁 & 免打扰**：可配置仅在切出窗口时触发提醒，支持一键开启免打扰与通知历史回看（快捷键 `Alt+N`）。
3. **Webhook 远程推送（基于 `Stop` Hook，零 CORS 限制）**：
   - 通过 [hooks.json](hooks.json) 挂载 `Stop` 钩子调用 [notify_hook.py](scripts/notify_hook.py)，以独立后台子进程发出 HTTP 请求，不阻塞 Agent 对话流。
   - 支持 **飞书（含签名校验） / 企业微信 / Discord / Telegram / 自定义 JSON Webhook**，可在 `Alt+N` 面板的「Webhook 远程推送」标签页中可视化生成配置。

---

## 快速安装与部署

### 方式一：复制提示词让 Agent 自动安装

```text
请帮我下载并安装 https://github.com/KiriuKazurei/antigravity-plugins 仓库中的 antigravity-notifier 插件：先克隆仓库到临时目录，运行 python scripts/manage_plugins.py test 验证，再执行 python scripts/manage_plugins.py sync --only antigravity-notifier（如果宿主 app.asar 尚未接入 pluginLoader.js，请改用 install 或 stage 并提醒我退出后重启 Antigravity），最后用 status 确认安装结果。
```

### 方式二：命令行手动安装

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# 首次接入需先完全退出 Antigravity：
python scripts/manage_plugins.py install --only antigravity-notifier
```

> [!TIP]
> 若已接入过宿主加载器（如已安装同源其他插件），仅需同步并在窗口按 **`Ctrl+R`** 即可热生效：
> ```powershell
> python antigravity-notifier/scripts/install_notifier.py sync
> ```

---

## 使用说明与 Webhook 配置

### 1. 打开控制面板

- 在左侧边栏顶部点击 **`远程推送`** 入口，或使用全局快捷键 **`Alt+N`**。
- 在面板中可查看近期通知历史、切换「仅后台时提醒」、开启/关闭免打扰、调节提示音类型与音量。

### 2. 配置 Webhook 远程推送

1. 打开 `Alt+N` 面板，切换到 **「Webhook 远程推送」** 标签，填写对应平台参数（飞书 / 企业微信 / Discord / Telegram / 自定义 JSON）并点击 **「复制配置 JSON」**。
2. 将复制的内容保存为（可参考 [notifier-config.example.json](runtime/notifier-config.example.json)）：
   - Windows: `%USERPROFILE%\.gemini\config\plugins\antigravity-notifier\runtime\notifier-config.json`
   - macOS / Linux: `~/.gemini/config/plugins/antigravity-notifier/runtime/notifier-config.json`
3. 运行一次连通性测试确认推送正常：

```powershell
python "$env:USERPROFILE\.gemini\config\plugins\antigravity-notifier\scripts\notify_hook.py" --test
```

---

## 常用管理命令 & 单元测试

```powershell
# 查看插件、宿主版本、备份与自愈状态
python antigravity-notifier/scripts/install_notifier.py status

# 预构建 app.asar.staged
python antigravity-notifier/scripts/install_notifier.py stage

# 还原官方原版 app.asar（需先完全退出 Antigravity）
python antigravity-notifier/scripts/install_notifier.py restore

# 运行单元测试
node antigravity-notifier/runtime/test_notifier.js
```

---

## 目录结构

```text
antigravity-notifier/
├── .gitignore
├── LICENSE                         # MIT 开源协议
├── README.md                       # 说明文档
├── plugin.json                     # 插件清单（声明 runtime/notifier.js）
├── hooks.json                      # SessionStart 自愈 + Stop Webhook 推送钩子
├── scripts/
│   ├── install_notifier.py         # 同步与安装便捷入口
│   ├── notify_hook.py              # Stop Hook 远程 Webhook 推送脚本
│   ├── plugin_host.py              # 自包含宿主安装、校验与自动自愈脚本
│   ├── session_hook.py             # SessionStart 钩子安全入口
│   └── pluginLoader.js             # 注入 app.asar 的通用插件宿主加载器
└── runtime/
    ├── notifier-config.example.json # Webhook 远程推送配置示例
    ├── notifier.js                 # 状态监听与通知面板运行时（Shadow DOM）
    └── test_notifier.js            # 单元测试与状态机集成测试
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
