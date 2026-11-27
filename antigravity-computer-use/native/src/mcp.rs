use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

use crate::capture;
use crate::cursor::VirtualCursor;
use crate::full_control::{self, FullControlManager};
use crate::input;
use crate::uia;
use crate::window;

pub fn run_stdio_server(cursor: VirtualCursor, full_control: FullControlManager) {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line_res in stdin.lock().lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                let _ = writeln!(out, "{}", err_resp);
                let _ = out.flush();
                continue;
            }
        };

        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

        // Notifications have no id and require no response
        if id.is_none() {
            continue;
        }
        let id_val = id.unwrap();

        let resp = match method {
            "initialize" => {
                let proto = params
                    .get("protocolVersion")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("2024-11-05");
                json!({
                    "jsonrpc": "2.0",
                    "id": id_val,
                    "result": {
                        "protocolVersion": proto,
                        "capabilities": {
                            "tools": {
                                "listChanged": false
                            }
                        },
                        "serverInfo": {
                            "name": "antigravity-computer-use",
                            "version": "1.0.0"
                        }
                    }
                })
            }
            "ping" => json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": {}
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": {
                    "tools": tool_definitions()
                }
            }),
            "tools/call" => {
                let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let result = dispatch_tool(tool_name, &args, &cursor, &full_control);
                json!({
                    "jsonrpc": "2.0",
                    "id": id_val,
                    "result": result
                })
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {}", method)
                }
            }),
        };

        if writeln!(out, "{}", resp).is_err() || out.flush().is_err() {
            break;
        }
    }
}

fn ok_text(val: Value) -> Value {
    json!({
        "content": [
            { "type": "text", "text": serde_json::to_string_pretty(&val).unwrap_or_default() }
        ]
    })
}

fn err_text(msg: String) -> Value {
    json!({
        "isError": true,
        "content": [
            { "type": "text", "text": msg }
        ]
    })
}

fn get_hwnd(args: &Value) -> Result<isize, String> {
    if let Some(n) = args.get("hwnd").and_then(|v| v.as_i64()) {
        return Ok(n as isize);
    }
    if let Some(f) = args.get("hwnd").and_then(|v| v.as_f64()) {
        if f.is_finite() {
            return Ok(f.trunc() as isize);
        }
    }
    if let Some(s) = args.get("hwnd").and_then(|v| v.as_str()) {
        let s = s.trim();
        if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            return isize::from_str_radix(hex, 16)
                .map_err(|_| format!("Invalid hex hwnd: {}", s));
        }
        return s
            .parse::<isize>()
            .map_err(|_| format!("Invalid hwnd string: {}", s));
    }
    Err("Missing required integer parameter 'hwnd'".to_string())
}

fn dispatch_tool(
    name: &str,
    args: &Value,
    cursor: &VirtualCursor,
    full_control: &FullControlManager,
) -> Value {
    match name {
        "cu_list_windows" => {
            let filter = args.get("filter").and_then(|v| v.as_str());
            let include_minimized = args
                .get("include_minimized")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let include_tool_windows = args
                .get("include_tool_windows")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let list = window::list_windows(filter, include_minimized, include_tool_windows);
            ok_text(json!({
                "count": list.len(),
                "windows": list
            }))
        }
        "cu_screenshot" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let max_width = args
                .get("max_width")
                .and_then(|v| v.as_u64())
                .unwrap_or(1280) as u32;
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("jpeg");
            let quality = args
                .get("quality")
                .and_then(|v| v.as_u64())
                .unwrap_or(82) as u8;
            let save_path = args.get("save_path").and_then(|v| v.as_str());

            match capture::capture_window(hwnd, max_width, format, quality, save_path) {
                Ok(res) => {
                    let meta = serde_json::to_string_pretty(&res).unwrap_or_default();
                    json!({
                        "content": [
                            { "type": "text", "text": meta },
                            {
                                "type": "image",
                                "data": res.base64_data,
                                "mimeType": res.mime_type
                            }
                        ]
                    })
                }
                Err(e) => err_text(e),
            }
        }
        "cu_ui_tree" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let max_depth = args
                .get("max_depth")
                .and_then(|v| v.as_u64())
                .unwrap_or(6) as usize;
            let max_elements = args
                .get("max_elements")
                .and_then(|v| v.as_u64())
                .unwrap_or(120) as usize;
            match uia::get_ui_tree(hwnd, max_depth, max_elements) {
                Ok(els) => ok_text(json!({
                    "hwnd": hwnd,
                    "count": els.len(),
                    "elements": els
                })),
                Err(e) => err_text(e),
            }
        }
        "cu_ui_action" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let action = args
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("invoke");
            let target_name = args.get("name").and_then(|v| v.as_str());
            let target_id = args.get("automation_id").and_then(|v| v.as_str());
            let value = args.get("value").and_then(|v| v.as_str());
            match uia::perform_ui_action(hwnd, action, target_name, target_id, value, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_click" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let x = match args.get("x").and_then(|v| v.as_i64()) {
                Some(v) => v as i32,
                None => return err_text("Missing integer parameter 'x'".into()),
            };
            let y = match args.get("y").and_then(|v| v.as_i64()) {
                Some(v) => v as i32,
                None => return err_text("Missing integer parameter 'y'".into()),
            };
            let button = args
                .get("button")
                .and_then(|v| v.as_str())
                .unwrap_or("left");
            let double_click = args
                .get("double_click")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            match input::background_click(hwnd, x, y, button, double_click, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_move" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            match input::background_move(hwnd, x, y, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_drag" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let x1 = args.get("x1").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y1 = args.get("y1").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let x2 = args.get("x2").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let y2 = args.get("y2").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let steps = args.get("steps").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
            match input::background_drag(hwnd, x1, y1, x2, y2, steps, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_scroll" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let x = args.get("x").and_then(|v| v.as_i64()).unwrap_or(100) as i32;
            let y = args.get("y").and_then(|v| v.as_i64()).unwrap_or(100) as i32;
            let delta_y = args
                .get("delta_y")
                .and_then(|v| v.as_i64())
                .unwrap_or(-120) as i32;
            let delta_x = args.get("delta_x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            match input::background_scroll(hwnd, x, y, delta_y, delta_x, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_type_text" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let text = match args.get("text").and_then(|v| v.as_str()) {
                Some(t) => t,
                None => return err_text("Missing string parameter 'text'".into()),
            };
            let x = args.get("x").and_then(|v| v.as_i64()).map(|v| v as i32);
            let y = args.get("y").and_then(|v| v.as_i64()).map(|v| v as i32);
            match input::background_type_text(hwnd, text, x, y, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_key_press" => {
            let hwnd = match get_hwnd(args) {
                Ok(h) => h,
                Err(e) => return err_text(e),
            };
            let key = match args.get("key").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return err_text("Missing string parameter 'key'".into()),
            };
            let x = args.get("x").and_then(|v| v.as_i64()).map(|v| v as i32);
            let y = args.get("y").and_then(|v| v.as_i64()).map(|v| v as i32);
            match input::background_key_press(hwnd, key, x, y) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        "cu_cursor_config" => {
            if let Some(vis) = args.get("visible").and_then(|v| v.as_bool()) {
                cursor.set_visible(vis);
            }
            ok_text(json!(cursor.state()))
        }
        "cu_full_control_request" => {
            let reason = args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("无法通过窗口级后台方案正常获取目标窗口或界面");
            let ttl_seconds = args.get("ttl_seconds").and_then(|v| v.as_u64());
            let max_actions = args
                .get("max_actions")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            match full_control.request_permission(reason, ttl_seconds, max_actions) {
                Ok(status) => ok_text(json!(status)),
                Err(e) => err_text(e),
            }
        }
        "cu_full_control_stop" => {
            let status = full_control.stop(false);
            ok_text(json!(status))
        }
        "cu_screen_capture" => {
            let all_monitors = args
                .get("all_monitors")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let max_width = args
                .get("max_width")
                .and_then(|v| v.as_u64())
                .unwrap_or(1280) as u32;
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("jpeg");
            let quality = args
                .get("quality")
                .and_then(|v| v.as_u64())
                .unwrap_or(82) as u8;
            let save_path = args.get("save_path").and_then(|v| v.as_str());

            match full_control::capture_screen(
                full_control,
                all_monitors,
                max_width,
                format,
                quality,
                save_path,
            ) {
                Ok(res) => {
                    let meta = serde_json::to_string_pretty(&res).unwrap_or_default();
                    json!({
                        "content": [
                            { "type": "text", "text": meta },
                            {
                                "type": "image",
                                "data": res.base64_data,
                                "mimeType": res.mime_type
                            }
                        ]
                    })
                }
                Err(e) => err_text(e),
            }
        }
        "cu_screen_click" => {
            let x = match args.get("x").and_then(|v| v.as_i64()) {
                Some(v) => v as i32,
                None => return err_text("Missing integer parameter 'x'".into()),
            };
            let y = match args.get("y").and_then(|v| v.as_i64()) {
                Some(v) => v as i32,
                None => return err_text("Missing integer parameter 'y'".into()),
            };
            let button = args
                .get("button")
                .and_then(|v| v.as_str())
                .unwrap_or("left");
            let double_click = args
                .get("double_click")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            match full_control::screen_click(full_control, x, y, button, double_click, cursor) {
                Ok(res) => ok_text(json!(res)),
                Err(e) => err_text(e),
            }
        }
        other => err_text(format!("Unknown tool: {}", other)),
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "cu_list_windows",
            "description": "List visible Windows desktop windows (including background/bottom Z-order occluded windows) with HWND, title, process name, rect, DPI, and z_order. Never steals focus.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filter": { "type": "string", "description": "Optional case-insensitive substring filter for title, process name, or class name." },
                    "include_minimized": { "type": "boolean", "description": "Include windows minimized to taskbar (default false)." },
                    "include_tool_windows": { "type": "boolean", "description": "Include WS_EX_TOOLWINDOW and untitled floating/desktop-pet windows (default false)." }
                }
            }
        },
        {
            "name": "cu_screenshot",
            "description": "Capture a high-speed screenshot of ANY target window (even occluded at the bottom of Z-order) using Windows.Graphics.Capture (with PrintWindow fallback). Never brings the window to front or moves user's physical mouse.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND from cu_list_windows." },
                    "max_width": { "type": "integer", "description": "Optional max width for downscaling (default 1280; set 0 for native resolution)." },
                    "format": { "type": "string", "enum": ["jpeg", "png"], "description": "Image format (default 'jpeg' for speed)." },
                    "quality": { "type": "integer", "description": "JPEG quality 30-98 (default 82)." },
                    "save_path": { "type": "string", "description": "Optional absolute file path to also save the captured image." }
                },
                "required": ["hwnd"]
            }
        },
        {
            "name": "cu_ui_tree",
            "description": "Inspect the UI Automation (UIA) control tree of a background window with AutoSetFocus=false. Returns interactive controls, relative window coordinates, and supported patterns (invoke/value/toggle/select/expand_collapse).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "max_depth": { "type": "integer", "description": "Maximum tree depth (1-12, default 6)." },
                    "max_elements": { "type": "integer", "description": "Maximum elements to return (1-300, default 120)." }
                },
                "required": ["hwnd"]
            }
        },
        {
            "name": "cu_ui_action",
            "description": "Execute a UI Automation pattern (invoke, set_value, toggle, select, expand, collapse) on a control in a background window with AutoSetFocus=false. Strictly never steals focus or moves physical cursor; updates the Agent's independent visual pointer.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "action": { "type": "string", "enum": ["invoke", "set_value", "toggle", "select", "expand", "collapse"], "description": "UIA pattern action to execute." },
                    "name": { "type": "string", "description": "Case-insensitive substring match against control Name." },
                    "automation_id": { "type": "string", "description": "Exact case-insensitive match against control AutomationId." },
                    "value": { "type": "string", "description": "Text value to set (required when action is 'set_value')." }
                },
                "required": ["hwnd", "action"]
            }
        },
        {
            "name": "cu_click",
            "description": "Click at window-relative coordinates (x, y) inside a background/occluded window via independent virtual pointer + Win32 PostMessageW. Never steals focus or moves the user's physical mouse.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "x": { "type": "integer", "description": "X coordinate relative to the target window's top-left corner (in native window pixels; multiply by scale_x if measured on a downscaled screenshot)." },
                    "y": { "type": "integer", "description": "Y coordinate relative to the target window's top-left corner." },
                    "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button (default 'left')." },
                    "double_click": { "type": "boolean", "description": "Whether to double-click (default false)." }
                },
                "required": ["hwnd", "x", "y"]
            }
        },
        {
            "name": "cu_move",
            "description": "Move the Agent's independent virtual pointer to window-relative (x, y) and send background WM_MOUSEMOVE without touching user's physical mouse.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "x": { "type": "integer", "description": "Window-relative X." },
                    "y": { "type": "integer", "description": "Window-relative Y." }
                },
                "required": ["hwnd", "x", "y"]
            }
        },
        {
            "name": "cu_drag",
            "description": "Drag from (x1, y1) to (x2, y2) inside a background window via independent virtual pointer + PostMessageW.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "x1": { "type": "integer" },
                    "y1": { "type": "integer" },
                    "x2": { "type": "integer" },
                    "y2": { "type": "integer" },
                    "steps": { "type": "integer", "description": "Interpolation steps (default 10)." }
                },
                "required": ["hwnd", "x1", "y1", "x2", "y2"]
            }
        },
        {
            "name": "cu_scroll",
            "description": "Scroll the mouse wheel at (x, y) inside a background window without stealing focus. Positive delta_y scrolls up (e.g. 120), negative scrolls down (e.g. -120).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "x": { "type": "integer", "description": "Window-relative X." },
                    "y": { "type": "integer", "description": "Window-relative Y." },
                    "delta_y": { "type": "integer", "description": "Vertical wheel delta in 120-unit notches (default -120)." },
                    "delta_x": { "type": "integer", "description": "Horizontal wheel delta (default 0)." }
                },
                "required": ["hwnd", "x", "y"]
            }
        },
        {
            "name": "cu_type_text",
            "description": "Type Unicode text (supports Chinese & English) into a background window via WM_CHAR without stealing keyboard focus or touching IME. Optional (x, y) targets a specific child control.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "text": { "type": "string", "description": "Text to type." },
                    "x": { "type": "integer", "description": "Optional window-relative X of child control." },
                    "y": { "type": "integer", "description": "Optional window-relative Y of child control." }
                },
                "required": ["hwnd", "text"]
            }
        },
        {
            "name": "cu_key_press",
            "description": "Send a single key press (Enter, Tab, Escape, Backspace, Delete, Space, Up/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, A-Z, 0-9) to a background window via WM_KEYDOWN/WM_KEYUP.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hwnd": { "type": "integer", "description": "Target window HWND." },
                    "key": { "type": "string", "description": "Key name (e.g. 'Enter', 'Tab', 'Escape', 'Backspace', 'F5')." },
                    "x": { "type": "integer", "description": "Optional window-relative X of child control." },
                    "y": { "type": "integer", "description": "Optional window-relative Y of child control." }
                },
                "required": ["hwnd", "key"]
            }
        },
        {
            "name": "cu_cursor_config",
            "description": "Show/hide or query the Agent's independent transparent click-through virtual cursor overlay.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "visible": { "type": "boolean", "description": "Set whether the independent visual virtual pointer overlay is visible." }
                }
            }
        },
        {
            "name": "cu_full_control_request",
            "description": "Fallback elevated mode: ask the user via a native Windows confirmation dialog to grant '完全控制电脑' (Full-Screen Control) permission ONLY when window-level background capture/input cannot access the target interface. When granted, displays a bright yellow border around the screen, a red '停止获取' emergency stop button at bottom-right, and activates global hotkey Ctrl+Alt+Esc with automatic TTL and step-limit expiration.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "description": "Clear explanation of why window-level mode could not access the target window or UI." },
                    "ttl_seconds": { "type": "integer", "description": "Optional auto-expiration lease in seconds (30-900, default 300)." },
                    "max_actions": { "type": "integer", "description": "Optional maximum full-screen actions/captures before auto-stop (5-200, default 50)." }
                },
                "required": ["reason"]
            }
        },
        {
            "name": "cu_full_control_stop",
            "description": "Exit '完全控制电脑' (Full-Screen Control) mode immediately, hiding the yellow screen border and the bottom-right '停止获取' emergency stop button.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "cu_screen_capture",
            "description": "Capture the full desktop screen (primary monitor or all monitors). Requires active '完全控制电脑' permission granted via cu_full_control_request; immediately blocked if the user clicks the '停止获取' emergency stop button.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "all_monitors": { "type": "boolean", "description": "Capture the entire virtual desktop across all monitors (default false = primary monitor)." },
                    "max_width": { "type": "integer", "description": "Optional max width for downscaling (default 1280; set 0 for native resolution)." },
                    "format": { "type": "string", "enum": ["jpeg", "png"], "description": "Image format (default 'jpeg')." },
                    "quality": { "type": "integer", "description": "JPEG quality 30-98 (default 82)." },
                    "save_path": { "type": "string", "description": "Optional absolute file path to also save the screenshot." }
                }
            }
        },
        {
            "name": "cu_screen_click",
            "description": "Click at absolute screen physical coordinates (x, y) via SendInput when '完全控制电脑' permission is active. Immediately blocked if the user clicks '停止获取'.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "integer", "description": "Absolute physical screen X coordinate (origin_x + round(sx * scale_x))." },
                    "y": { "type": "integer", "description": "Absolute physical screen Y coordinate (origin_y + round(sy * scale_y))." },
                    "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "Mouse button (default 'left')." },
                    "double_click": { "type": "boolean", "description": "Whether to double-click (default false)." }
                },
                "required": ["x", "y"]
            }
        }
    ])
}
