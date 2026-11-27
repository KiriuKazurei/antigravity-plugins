# Background Computer Use 操作准则

- 执行 Windows 桌面应用操作任务时，优先使用 `antigravity-computer-use` MCP 工具（`cu_list_windows`、`cu_screenshot`、`cu_ui_tree`、`cu_ui_action`、`cu_click`、`cu_type_text`、`cu_key_press`、`cu_scroll`），避免使用会抢占前台焦点或移动用户物理鼠标的外部脚本。
- 若目标窗口支持 UI Automation 模式，优先调用 `cu_ui_action`；若使用坐标点击，务必根据 `cu_screenshot` 返回的 `scale_x` / `scale_y` 换算为窗口原生相对坐标。
- 涉及删除文件、提交表单、发送消息或修改系统设置等不可逆桌面操作前，先向用户确认。
- **窗口级优先、完全控制兜底**：仅在无法正常获取目标窗口或指定界面时，才允许调用 `cu_full_control_request` 申请「完全控制电脑」全屏权限；任务完成后必须主动调用 `cu_full_control_stop` 退出；一旦用户点击屏幕右下角「停止获取」急停按钮中止权限，必须立即停止后续屏幕获取与操作，禁止擅自重新弹窗申请。
