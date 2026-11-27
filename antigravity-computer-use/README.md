# Antigravity 后台无干扰桌面操控（Computer Use）

面向 Windows 平台的 **Antigravity** 高性能后台 Computer Use 插件，底层由原生 **Rust** `MCP` Server（`antigravity-computer-use-mcp.exe`）驱动。

## 核心特性

- **底部 / 被遮挡窗口极速截屏（<30ms）**：优先通过 `Windows.Graphics.Capture (WGC)` + Direct3D 11 从 DWM GPU 合成树直接捕获目标窗口，自动以 `PrintWindow(PW_RENDERFULLCONTENT)` 兜底。只要窗口未最小化到任务栏，即使完全被其他窗口遮挡在 Z-Order 底部也能高清截屏，**绝不置顶窗口**。
- **Agent 独立虚拟鼠标指针**：内置独立虚拟光标状态机，并渲染极轻量的透明点击穿透悬浮层（`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE`），带平滑移动与点击波纹。**全程绝不调用 `SetCursorPos` 或 `SendInput`**，不移动你的物理鼠标，也不拦截你的任何点击。
- **双层无焦点后台交互**：
  - **UI Automation 语义层**：使用 `IUIAutomation2` 并强制 `AutoSetFocus = FALSE`，后台无焦点执行 `Invoke`、`SetValue`、`Toggle`、`Select`、`Expand` / `Collapse`。
  - **Win32 消息层**：通过 `ChildWindowFromPointEx` 精准穿透子控件并投递 `WM_MOUSEMOVE`、`WM_LBUTTONDOWN` / `UP`、`WM_MOUSEWHEEL`、`WM_CHAR`（完整中英文 Unicode）与 `WM_KEYDOWN` / `UP`。

## 内置 `MCP` 工具一览

| 工具名 | 说明 |
| :--- | :--- |
| `cu_list_windows` | 列出所有可见窗口（含底部/被遮挡窗口）的 `hwnd`、标题、进程名、坐标、DPI 与 `z_order` |
| `cu_screenshot` | 通过 WGC / `PrintWindow` 后台截取目标窗口画面（支持自动缩放与 JPEG/PNG） |
| `cu_ui_tree` | 获取后台窗口的 UIA 控件树（`AutoSetFocus = false`），含相对坐标与支持的 Pattern |
| `cu_ui_action` | 后台无焦点执行 UIA 控件操作（`invoke` / `set_value` / `toggle` / `select` / `expand` / `collapse`） |
| `cu_click` | 使用独立虚拟指针在后台窗口相对坐标处执行左/中/右键单击或双击 |
| `cu_move` | 移动 Agent 独立虚拟指针并向后台窗口发送 `WM_MOUSEMOVE` |
| `cu_drag` | 在后台窗口内从 `(x1, y1)` 平滑拖拽至 `(x2, y2)` |
| `cu_scroll` | 在后台窗口指定坐标发送垂直/水平滚轮消息 |
| `cu_type_text` | 通过 `WM_CHAR` 向后台窗口输入中英文 Unicode 文本，不抢焦点、不影响输入法 |
| `cu_key_press` | 向后台窗口发送功能键/方向键/字母数字按键（`Enter`、`Tab`、`Escape`、`F1-F12` 等） |
| `cu_cursor_config` | 显示/隐藏或查询独立透明虚拟光标悬浮层状态 |
| `cu_full_control_request` | 兜底高危模式：弹窗向用户申请「完全控制电脑」权限，开启全屏黄色警示边框与右下角「停止获取」急停按钮 |
| `cu_full_control_stop` | 主动退出「完全控制电脑」模式并隐藏黄色边框与急停按钮 |
| `cu_screen_capture` | 全屏模式下截取主屏/全部显示器画面（自动排除警示边框与急停按钮，受急停硬门控） |
| `cu_screen_click` | 全屏模式下按屏幕绝对物理坐标执行点击/双击（受急停硬门控） |

## 从源码重新编译与安装

```powershell
cd native
cargo build --release
Copy-Item target\release\antigravity-computer-use-mcp.exe ..\bin\antigravity-computer-use-mcp.exe -Force
cd ..
python scripts\install.py
```
