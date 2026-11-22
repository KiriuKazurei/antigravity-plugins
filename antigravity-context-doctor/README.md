# Antigravity 上下文洞察与诊断面板 (`antigravity-context-doctor`)

模仿 [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context) 为 Google `Antigravity` 2.0 桌面应用打造的**右侧边栏上下文可视化与无痛交接插件**。完全自包含、跨小版本兼容、更新自动自愈，并与现有 `antigravity-zh-cn`、`antigravity-usage-dashboard`、`antigravity-snippets`、`antigravity-notifier` 无缝共存。

---

## 核心特性

1. **深度融入原生右侧边栏（`插件 > 上下文洞察` / `Alt+C`）**：
   - 不新增额外悬浮标签或独立侧边栏，保持界面清爽：直接在 `Antigravity` 原生右侧边栏的 **「插件 >」** 菜单中挂载 **「上下文洞察」**（附带实时上下文水位 `%` 徽章），与 `Swarm` 等原生插件并列。
   - 打开后自动贴合停靠在原生右侧边栏容器内（Shadow DOM 隔离，深浅色主题与中英文自适应），点击 `← 返回面板` 或切换到 `终端` / `浏览器` / `Swarm` 等原生标签时自动退回；按 `Alt+C` 也可快速唤起或收起。
2. **上下文窗口水位与分段占比**：
   - 实时展示最新单轮 `Prompt Context` 占用率（区分 `Cache Read`、`New Input`、`Output/Thinking`），支持点击模型标签快速切换窗口上限预设（`128K / 200K / 400K / 1M / 2M`）。
   - 超过预警阈值（默认 `75%` / `90%`）自动提示，一键直达交接面板。
3. **5 大洞察标签页**：
   - **总览（Overview）**：4 项关键指标 KPI、6 类上下文内容构成拆解（用户提问、AI & Thinking、文件读取/搜索、终端命令日志、代码编辑/写入、Subagent/MCP）、近 24 轮上下文演进趋势图（自动标出压缩/剪枝与激增拐点）以及健康诊断建议。
   - **大户排行（Heavy Hitters）**：按估算 Token 体积对轨迹步骤排行，支持按类型过滤、关键字搜索及展开查看内容与复制，一眼抓出“上下文大户”。
   - **文件 & 编队（Files & Fleet）**：聚合追踪会话内每个文件的读/改/写/搜次数（标出重复读取）与 Multi-Agent 子代理编队网络。
   - **全局洞察（Insights）**：近 7 天跨会话 Token 消耗柱状图、Cache 平均命中率与可过滤会话卡片，点击任意会话即可在侧边栏切入透视。
   - **交接（Handoff）**：自动提炼任务目标、改动文件、关键命令、结论与待排查问题，生成精简交接 Prompt，支持**一键填入当前/新对话输入框**、复制或导出诊断 JSON。

---

## 安装与使用

### 通过总控脚本一键同步并安装

```powershell
python scripts/manage_plugins.py test
python scripts/manage_plugins.py install
```

### 或单独安装本插件

```powershell
# 仅同步脚本更新（宿主已接入时在窗口内按 Ctrl+R 即可热生效）
python antigravity-context-doctor/scripts/install_context_doctor.py sync

# 首次接入宿主（需先完全退出 Antigravity）
python antigravity-context-doctor/scripts/install_context_doctor.py install
```

### 运行单元测试

```bash
node antigravity-context-doctor/runtime/test_context_doctor.js
```
