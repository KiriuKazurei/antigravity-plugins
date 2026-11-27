use serde::Serialize;
use std::thread;
use std::time::Duration;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, MapWindowPoints, ScreenToClient};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, MAPVK_VK_TO_VSC, VK_BACK, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1,
    VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME,
    VK_INSERT, VK_LEFT, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, PostMessageW, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE,
    CWP_SKIPTRANSPARENT, WM_CHAR, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDBLCLK,
    WM_RBUTTONDOWN, WM_RBUTTONUP,
};

const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;
const MK_MBUTTON: usize = 0x0010;

use crate::cursor::VirtualCursor;
use crate::window::{get_window_rect, hwnd_from_isize};

#[derive(Debug, Clone, Serialize)]
pub struct InputResult {
    pub ok: bool,
    pub hwnd: isize,
    pub target_child_hwnd: isize,
    pub screen_x: i32,
    pub screen_y: i32,
    pub detail: String,
}

fn make_lparam(x: i32, y: i32) -> LPARAM {
    let lx = (x as i16 as u16) as usize;
    let ly = (y as i16 as u16) as usize;
    LPARAM(((ly << 16) | lx) as isize)
}

unsafe fn post_msg(target: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> Result<(), String> {
    PostMessageW(target, msg, wparam, lparam).map_err(|e| {
        format!(
            "PostMessageW(0x{:X}) failed: {} (if the target window is running as Administrator, Windows UIPI blocks background messages from non-elevated processes)",
            msg, e
        )
    })
}

/// Convert window-relative (x, y) into (deepest child HWND, child client x, child client y, screen x, screen y)
unsafe fn resolve_target_point(
    top_hwnd: HWND,
    win_x: i32,
    win_y: i32,
) -> (HWND, i32, i32, i32, i32) {
    let rect = get_window_rect(top_hwnd);
    let screen_x = rect.x + win_x;
    let screen_y = rect.y + win_y;

    let mut cur_hwnd = top_hwnd;
    let mut pt = POINT {
        x: screen_x,
        y: screen_y,
    };
    let _ = ScreenToClient(cur_hwnd, &mut pt);

    // Descend through child windows to find the deepest visible non-transparent control
    for _ in 0..16 {
        let child = ChildWindowFromPointEx(
            cur_hwnd,
            pt,
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
        );
        if child.0.is_null() || child == cur_hwnd {
            break;
        }
        let mut child_pt = pt;
        MapWindowPoints(cur_hwnd, child, std::slice::from_mut(&mut child_pt));
        cur_hwnd = child;
        pt = child_pt;
    }

    // Recompute exact screen coords from final client point
    let mut final_screen = pt;
    let _ = ClientToScreen(cur_hwnd, &mut final_screen);

    (cur_hwnd, pt.x, pt.y, final_screen.x, final_screen.y)
}

pub fn background_move(
    hwnd_val: isize,
    x: i32,
    y: i32,
    cursor: &VirtualCursor,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    unsafe {
        let (target, cx, cy, sx, sy) = resolve_target_point(top_hwnd, x, y);
        cursor.move_to(sx, sy, Some(hwnd_val), "move");
        post_msg(target, WM_MOUSEMOVE, WPARAM(0), make_lparam(cx, cy))?;
        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx,
            screen_y: sy,
            detail: format!("Moved independent virtual pointer to ({}, {})", x, y),
        })
    }
}

pub fn background_click(
    hwnd_val: isize,
    x: i32,
    y: i32,
    button: &str,
    double_click: bool,
    cursor: &VirtualCursor,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    unsafe {
        let (target, cx, cy, sx, sy) = resolve_target_point(top_hwnd, x, y);
        cursor.trigger_click(sx, sy, Some(hwnd_val), button);

        let lp = make_lparam(cx, cy);
        let (down_msg, up_msg, dbl_msg, mk_flag) = match button {
            "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
            "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
            _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
        };

        post_msg(target, WM_MOUSEMOVE, WPARAM(0), lp)?;
        thread::sleep(Duration::from_millis(8));
        post_msg(target, down_msg, WPARAM(mk_flag), lp)?;
        thread::sleep(Duration::from_millis(12));
        post_msg(target, up_msg, WPARAM(0), lp)?;

        if double_click {
            thread::sleep(Duration::from_millis(25));
            post_msg(target, dbl_msg, WPARAM(mk_flag), lp)?;
            thread::sleep(Duration::from_millis(12));
            post_msg(target, up_msg, WPARAM(0), lp)?;
        }

        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx,
            screen_y: sy,
            detail: format!(
                "Background {} {} at window({}, {}) -> child({}, {}) without stealing focus",
                button,
                if double_click { "double-click" } else { "click" },
                x,
                y,
                cx,
                cy
            ),
        })
    }
}

pub fn background_drag(
    hwnd_val: isize,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    steps: u32,
    cursor: &VirtualCursor,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    let steps = steps.clamp(2, 40);
    unsafe {
        let (target, cx1, cy1, sx1, sy1) = resolve_target_point(top_hwnd, x1, y1);
        let (_, _cx2_other, _cy2_other, sx2, sy2) = resolve_target_point(top_hwnd, x2, y2);
        // Convert end screen coordinates into the start target window's client space
        let mut end_client = POINT { x: sx2, y: sy2 };
        let _ = ScreenToClient(target, &mut end_client);
        let cx2 = end_client.x;
        let cy2 = end_client.y;

        cursor.trigger_click(sx1, sy1, Some(hwnd_val), "left");
        post_msg(target, WM_MOUSEMOVE, WPARAM(0), make_lparam(cx1, cy1))?;
        post_msg(
            target,
            WM_LBUTTONDOWN,
            WPARAM(MK_LBUTTON),
            make_lparam(cx1, cy1),
        )?;

        for i in 1..=steps {
            let t = i as f32 / steps as f32;
            let ix = (cx1 as f32 + (cx2 - cx1) as f32 * t).round() as i32;
            let iy = (cy1 as f32 + (cy2 - cy1) as f32 * t).round() as i32;
            let isx = (sx1 as f32 + (sx2 - sx1) as f32 * t).round() as i32;
            let isy = (sy1 as f32 + (sy2 - sy1) as f32 * t).round() as i32;
            cursor.move_to(isx, isy, Some(hwnd_val), "drag");
            post_msg(
                target,
                WM_MOUSEMOVE,
                WPARAM(MK_LBUTTON),
                make_lparam(ix, iy),
            )?;
            thread::sleep(Duration::from_millis(12));
        }

        post_msg(target, WM_LBUTTONUP, WPARAM(0), make_lparam(cx2, cy2))?;

        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx2,
            screen_y: sy2,
            detail: format!("Background drag from ({},{}) to ({},{})", x1, y1, x2, y2),
        })
    }
}

pub fn background_scroll(
    hwnd_val: isize,
    x: i32,
    y: i32,
    delta_y: i32,
    delta_x: i32,
    cursor: &VirtualCursor,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    unsafe {
        let (target, _cx, _cy, sx, sy) = resolve_target_point(top_hwnd, x, y);
        cursor.move_to(sx, sy, Some(hwnd_val), "scroll");

        // WM_MOUSEWHEEL expects screen coordinates in lParam!
        let lp = make_lparam(sx, sy);
        if delta_y != 0 {
            let wheel_delta = (delta_y as i16 as u16) as usize;
            let wp = WPARAM(wheel_delta << 16);
            post_msg(target, WM_MOUSEWHEEL, wp, lp)?;
        }
        if delta_x != 0 {
            let wheel_delta = (delta_x as i16 as u16) as usize;
            let wp = WPARAM(wheel_delta << 16);
            post_msg(target, WM_MOUSEHWHEEL, wp, lp)?;
        }

        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx,
            screen_y: sy,
            detail: format!(
                "Background scroll (delta_y={}, delta_x={}) at ({}, {})",
                delta_y, delta_x, x, y
            ),
        })
    }
}

pub fn background_type_text(
    hwnd_val: isize,
    text: &str,
    x: Option<i32>,
    y: Option<i32>,
    cursor: &VirtualCursor,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    unsafe {
        let (target, sx, sy) = if let (Some(px), Some(py)) = (x, y) {
            let (t, _cx, _cy, sx, sy) = resolve_target_point(top_hwnd, px, py);
            cursor.move_to(sx, sy, Some(hwnd_val), "type");
            (t, sx, sy)
        } else {
            let r = get_window_rect(top_hwnd);
            (top_hwnd, r.x + r.width / 2, r.y + r.height / 2)
        };

        for ch in text.encode_utf16() {
            if ch == '\n' as u16 {
                send_vk(target, VK_RETURN.0)?;
            } else {
                post_msg(target, WM_CHAR, WPARAM(ch as usize), LPARAM(1))?;
            }
            thread::sleep(Duration::from_millis(2));
        }

        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx,
            screen_y: sy,
            detail: format!("Posted {} UTF-16 chars to background window", text.chars().count()),
        })
    }
}

unsafe fn send_vk(target: HWND, vk: u16) -> Result<(), String> {
    let scan = MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as usize;
    let lparam_down = LPARAM((1 | (scan << 16)) as isize);
    let lparam_up = LPARAM((1 | (scan << 16) | (1 << 30) | (1 << 31)) as isize);
    post_msg(target, WM_KEYDOWN, WPARAM(vk as usize), lparam_down)?;
    thread::sleep(Duration::from_millis(8));
    post_msg(target, WM_KEYUP, WPARAM(vk as usize), lparam_up)?;
    Ok(())
}

fn parse_key_name(key: &str) -> Result<u16, String> {
    let k = key.trim().to_lowercase();
    match k.as_str() {
        "enter" | "return" => Ok(VK_RETURN.0),
        "tab" => Ok(VK_TAB.0),
        "esc" | "escape" => Ok(VK_ESCAPE.0),
        "backspace" | "bs" => Ok(VK_BACK.0),
        "delete" | "del" => Ok(VK_DELETE.0),
        "space" => Ok(VK_SPACE.0),
        "up" | "arrowup" => Ok(VK_UP.0),
        "down" | "arrowdown" => Ok(VK_DOWN.0),
        "left" | "arrowleft" => Ok(VK_LEFT.0),
        "right" | "arrowright" => Ok(VK_RIGHT.0),
        "home" => Ok(VK_HOME.0),
        "end" => Ok(VK_END.0),
        "pageup" | "pgup" => Ok(VK_PRIOR.0),
        "pagedown" | "pgdn" => Ok(VK_NEXT.0),
        "insert" | "ins" => Ok(VK_INSERT.0),
        "f1" => Ok(VK_F1.0),
        "f2" => Ok(VK_F2.0),
        "f3" => Ok(VK_F3.0),
        "f4" => Ok(VK_F4.0),
        "f5" => Ok(VK_F5.0),
        "f6" => Ok(VK_F6.0),
        "f7" => Ok(VK_F7.0),
        "f8" => Ok(VK_F8.0),
        "f9" => Ok(VK_F9.0),
        "f10" => Ok(VK_F10.0),
        "f11" => Ok(VK_F11.0),
        "f12" => Ok(VK_F12.0),
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap().to_ascii_uppercase();
            if c.is_ascii_alphanumeric() {
                Ok(c as u16)
            } else {
                Err(format!("Unsupported key name: {}", key))
            }
        }
        _ => Err(format!("Unsupported key name: {}", key)),
    }
}

pub fn background_key_press(
    hwnd_val: isize,
    key: &str,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<InputResult, String> {
    let top_hwnd = hwnd_from_isize(hwnd_val)?;
    let vk = parse_key_name(key)?;
    unsafe {
        let (target, sx, sy) = if let (Some(px), Some(py)) = (x, y) {
            let (t, _cx, _cy, sx, sy) = resolve_target_point(top_hwnd, px, py);
            (t, sx, sy)
        } else {
            let r = get_window_rect(top_hwnd);
            (top_hwnd, r.x + r.width / 2, r.y + r.height / 2)
        };
        send_vk(target, vk)?;
        Ok(InputResult {
            ok: true,
            hwnd: hwnd_val,
            target_child_hwnd: target.0 as isize,
            screen_x: sx,
            screen_y: sy,
            detail: format!("Posted key '{}' (VK=0x{:X}) to background window", key, vk),
        })
    }
}
