---
name: computer-use
description: 通过原生 Rust 后台引擎操作 Windows 桌面应用窗口：支持直接截取并操控被遮挡或位于 Z-Order 底部的窗口，全程使用独立透明虚拟指针（绝不移动用户物理鼠标、绝不抢夺前台焦点）。当用户需要自动化操作桌面软件、查看后台窗口状态或执行多步 GUI 任务时使用。
---

# Antigravity Background Computer Use 指南

本插件通过内置原生 Rust `MCP` Server（`antigravity-computer-use`）提供毫秒级、无干扰的 Windows 后台桌面操作能力：
- **底层捕获**：优先使用 `Windows.Graphics.Capture (WGC)` 从 DWM GPU 合成树直接取帧，自动以 `PrintWindow(PW_RENDERFULLCONTENT)` 兜底。窗口在底部或被其他窗口完全遮挡时依然可高清截屏。
- **独立虚拟指针**：引擎维护独立的虚拟光标与透明点击穿透悬浮指示器（`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`），绝不移动用户物理鼠标，绝不拦截用户点击或抢夺焦点。
- **双通道后台交互**：优先使用 `IUIAutomation2`（强制 `AutoSetFocus = FALSE`）执行控件语义操作，配合 `ChildWindowFromPointEx` + `PostMessageW` 投递后台坐标/滚轮/Unicode 键盘消息。

## 标准操作工作流

1. **发现目标窗口**：调用 `cu_list_windows(filter=...)` 获取目标窗口的 `hwnd`、`rect`、`z_order` 与 `is_minimized` 状态。
   - 若目标为桌面宠物、悬浮球、无标题小组件或 `WS_EX_TOOLWINDOW` 悬浮窗口，请传入 `include_tool_windows=true`。
   - 注意：Windows 对**最小化到任务栏**的窗口会暂停 DWM 渲染；若 `is_minimized` 为 `true`，请提示用户将其恢复为非最小化状态（可以放在最底层被遮挡，无需置顶）。
2. **感知窗口状态**：
   - 调用 `cu_screenshot(hwnd=...)` 获取目标窗口实时画面（返回 `orig_width`、`orig_height`、`width`、`height`、`scale_x`、`scale_y`）。
   - 对于标准 Windows / WPF / Electron / 浏览器控件，建议同时调用 `cu_ui_tree(hwnd=...)` 获取精确控件名称、`automation_id`、相对坐标与支持的 `patterns`。
3. **执行后台操作（优先语义，次选坐标）**：
   - **优先 UIA**：如果目标控件在 `cu_ui_tree` 中具备 `invoke` / `value` / `toggle` / `select` / `expand_collapse`，优先调用 `cu_ui_action`，响应最快且最不受缩放影响。
   - **坐标操作**：使用 `cu_click` / `cu_move` / `cu_drag` / `cu_scroll` / `cu_type_text` / `cu_key_press`。
   - **坐标换算**：`cu_click` 等工具接收的是**目标窗口原生像素的相对坐标**（相对于窗口左上角）。如果你是在缩放后的截图（如 `max_width=1280`）上读取的像素位置 `(sx, sy)`，务必换算：
     `x = round(sx * scale_x)`, `y = round(sy * scale_y)`。
4. **闭环验证**：每完成关键一步操作后，再次调用 `cu_screenshot` 确认后台窗口画面已按预期更新。

## 独立虚拟光标控制

- 默认开启青色独立虚拟指针与点击波纹提示，方便用户观察 Agent 正在后台操作的区域。
- 若用户希望完全静默隐藏视觉光标，调用 `cu_cursor_config(visible=false)` 即可。

## 兜底高危方案：「完全控制电脑」全屏模式

仅当窗口级无干扰方案无法正常获取目标窗口或界面（例如特殊无句柄悬浮层、自绘全屏程序、跨窗口复杂交互）时，才允许启用兜底方案：
1. **向用户申请权限**：调用 `cu_full_control_request(reason=...)`（默认租期 `300s`、步数上限 `50` 步，超限自动退出），底层会弹出系统原生置顶确认框向用户说明原因并征得明确同意。
2. **双保险安全提示与急停**：用户同意后，屏幕四周会立即显示**醒目的黄色边框**，右下角常驻红色 **「停止获取」** 急停按钮，并自动激活全局急停热键 **`Ctrl + Alt + Esc`**（边框与按钮均自动排除在截屏画面之外）。
3. **全屏截屏与控制**：在权限激活期间，使用 `cu_screen_capture`（主屏优先 WGC GPU 捕获，自动回退 BitBlt）获取整屏画面，并通过 `cu_screen_click`（含虚拟桌面坐标边界校验）执行屏幕绝对坐标点击。
4. **急停中止与主动退出**：
   - 若用户点击右下角 **「停止获取」** 按钮或按下 **`Ctrl + Alt + Esc`**，权限会立即撤销并触发 15 秒防骚扰冷却，后续所有 `cu_screen_*` 调用都会返回 `PERMISSION_REVOKED_BY_USER` 并被硬拦截；此时**必须立即停止操作，禁止擅自反复弹窗重新申请**。
   - 任务完成后，务必主动调用 `cu_full_control_stop` 退出完全控制模式并隐藏黄色边框与急停按钮。
