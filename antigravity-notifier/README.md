# Antigravity 任务通知与远程推送插件 (`antigravity-notifier`)

为 Google `Antigravity` 2.0 桌面应用提供**完全自包含、跨小版本兼容、更新自动自愈**的任务完成 / 等待用户授权 / 异常中断提醒插件，支持本地桌面弹窗、Web Audio 合成提示音、后台标题闪烁以及飞书 / 企业微信 / Discord / Telegram / 自定义 Webhook 远程推送。

---

## 核心特性

1. **三类关键状态感知（防误报设计）**：
   - **任务完成**：监听 `GetAllCascadeTrajectories` 状态从 `RUNNING` 转为 `IDLE`，支持按最短耗时阈值过滤（默认 `5` 秒，避免短问候刷屏）。
   - **等待用户授权 / 输入**：结合 RPC `WAITING` 状态与界面真实审批按钮组（`批准`/`拒绝`、`仅允许本次` 等）双通道识别，自动跳过对话正文中的普通文字。
   - **异常中断**：捕获执行错误或超出上限暂停，第一时间提醒。
2. **本地多通道不打扰提醒**：
   - **桌面弹窗**：调用系统 `Notification` API，点击通知可直接拉起聚焦窗口。
   - **柔和提示音**：基于 Web Audio API 实时合成不同音色提示音（完成 / 确认 / 报错），零外部音频依赖，支持音量调节与试听。
   - **后台标题闪烁 & 免打扰**：仅在切出窗口时触发提醒（可配置），支持一键开启免打扰与通知历史回看（快捷键 `Alt+N`）。
3. **Webhook 远程推送（基于 `Stop` Hook，零 CORS 限制）**：
   - 通过 [hooks.json](hooks.json) 挂载 `Stop` 钩子调用 [notify_hook.py](scripts/notify_hook.py)，以独立后台子进程发出 HTTP 请求，不阻塞 Agent 对话流。
   - 支持 **飞书（含签名校验） / 企业微信 / Discord / Telegram / 自定义 JSON Webhook**，可在 `Alt+N` 面板的「Webhook 远程推送」标签页中可视化生成配置。

---

## 配置 Webhook 远程推送

1. 按 `Alt+N`（或点击右下角通知状态胶囊）打开面板，切换到 **「Webhook 远程推送」** 标签填写对应平台参数并点击 **「复制配置 JSON」**。
2. 将复制的内容保存为：
   - Windows: `%USERPROFILE%\.gemini\config\plugins\antigravity-notifier\runtime\notifier-config.json`
   - macOS / Linux: `~/.gemini/config/plugins/antigravity-notifier/runtime/notifier-config.json`
3. 运行一次测试验证通道连通性：

```powershell
python "$env:USERPROFILE\.gemini\config\plugins\antigravity-notifier\scripts\notify_hook.py" --test
```

---

## 运行单元测试

```bash
node runtime/test_notifier.js
```
