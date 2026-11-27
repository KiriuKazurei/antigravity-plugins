use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetClientRect, GetForegroundWindow, GetWindowLongW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};
use windows::core::PWSTR;

use crate::cursor::OVERLAY_CLASS_NAME;
use crate::full_control::{BORDER_CLASS_NAME, STOP_BTN_CLASS_NAME};

#[derive(Debug, Clone, Serialize)]
pub struct RectInfo {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub hwnd_hex: String,
    pub title: String,
    pub class_name: String,
    pub pid: u32,
    pub process_name: String,
    pub rect: RectInfo,
    pub client_rect: RectInfo,
    pub dpi: u32,
    pub is_minimized: bool,
    pub is_foreground: bool,
    pub is_tool_window: bool,
    pub z_order: usize,
}

pub fn is_valid_window(hwnd: HWND) -> bool {
    unsafe { IsWindow(hwnd).as_bool() }
}

pub fn hwnd_from_isize(val: isize) -> Result<HWND, String> {
    let hwnd = HWND(val as *mut std::ffi::c_void);
    if !is_valid_window(hwnd) {
        return Err(format!("Invalid or closed window handle (HWND: {})", val));
    }
    Ok(hwnd)
}

pub fn get_window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buf);
        if copied <= 0 {
            return String::new();
        }
        OsString::from_wide(&buf[..copied as usize])
            .to_string_lossy()
            .into_owned()
    }
}

pub fn get_class_name(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut buf);
        if len <= 0 {
            return String::new();
        }
        OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .into_owned()
    }
}

pub fn get_process_name(pid: u32) -> String {
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if ok.is_err() || size == 0 {
            return String::new();
        }
        let full = OsString::from_wide(&buf[..size as usize])
            .to_string_lossy()
            .into_owned();
        std::path::Path::new(&full)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or(full)
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    unsafe {
        let mut cloaked: u32 = 0;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        hr.is_ok() && cloaked != 0
    }
}

pub fn get_raw_window_rect(hwnd: HWND) -> RectInfo {
    unsafe {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        RectInfo {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
        }
    }
}

pub fn get_window_rect(hwnd: HWND) -> RectInfo {
    unsafe {
        let mut rect = RECT::default();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if hr.is_err() {
            let _ = GetWindowRect(hwnd, &mut rect);
        }
        RectInfo {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
        }
    }
}

pub fn get_client_rect_screen(hwnd: HWND) -> RectInfo {
    unsafe {
        let mut crect = RECT::default();
        let _ = GetClientRect(hwnd, &mut crect);
        let mut pt = POINT { x: 0, y: 0 };
        let _ = ClientToScreen(hwnd, &mut pt);
        RectInfo {
            x: pt.x,
            y: pt.y,
            width: (crect.right - crect.left).max(0),
            height: (crect.bottom - crect.top).max(0),
        }
    }
}

#[allow(dead_code)]
pub fn get_window_info(hwnd: HWND, z_order: usize) -> Result<WindowInfo, String> {
    if !is_valid_window(hwnd) {
        return Err("Invalid window handle".into());
    }
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let title = get_window_title(hwnd);
        let class_name = get_class_name(hwnd);
        let process_name = get_process_name(pid);
        let rect = get_window_rect(hwnd);
        let client_rect = get_client_rect_screen(hwnd);
        let dpi = GetDpiForWindow(hwnd);
        let is_minimized = IsIconic(hwnd).as_bool();
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let is_tool_window = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
        let hwnd_val = hwnd.0 as isize;
        Ok(WindowInfo {
            hwnd: hwnd_val,
            hwnd_hex: format!("0x{:X}", hwnd_val as usize),
            title,
            class_name,
            pid,
            process_name,
            rect,
            client_rect,
            dpi: if dpi == 0 { 96 } else { dpi },
            is_minimized,
            is_foreground: hwnd == fg,
            is_tool_window,
            z_order,
        })
    }
}

struct EnumContext {
    windows: Vec<WindowInfo>,
    filter: Option<String>,
    include_minimized: bool,
    include_tool_windows: bool,
    fg: HWND,
    z_counter: usize,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumContext);

    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let class_name = get_class_name(hwnd);
    if class_name == OVERLAY_CLASS_NAME
        || class_name == BORDER_CLASS_NAME
        || class_name == STOP_BTN_CLASS_NAME
    {
        return BOOL(1);
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let is_tool_window = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
    if is_tool_window && !ctx.include_tool_windows {
        return BOOL(1);
    }

    if is_cloaked(hwnd) {
        return BOOL(1);
    }

    let is_minimized = IsIconic(hwnd).as_bool();
    if is_minimized && !ctx.include_minimized {
        return BOOL(1);
    }

    let title = get_window_title(hwnd);
    if title.is_empty() && !ctx.include_tool_windows {
        return BOOL(1);
    }

    let rect = get_window_rect(hwnd);
    if !is_minimized && (rect.width < 16 || rect.height < 16) {
        return BOOL(1);
    }

    let z_order = ctx.z_counter;
    ctx.z_counter += 1;

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process_name = get_process_name(pid);

    if let Some(ref f) = ctx.filter {
        let title_l = title.to_lowercase();
        let proc_l = process_name.to_lowercase();
        let cls_l = class_name.to_lowercase();
        if !title_l.contains(f) && !proc_l.contains(f) && !cls_l.contains(f) {
            return BOOL(1);
        }
    }

    let client_rect = get_client_rect_screen(hwnd);
    let dpi = GetDpiForWindow(hwnd);
    let hwnd_val = hwnd.0 as isize;

    ctx.windows.push(WindowInfo {
        hwnd: hwnd_val,
        hwnd_hex: format!("0x{:X}", hwnd_val as usize),
        title,
        class_name,
        pid,
        process_name,
        rect,
        client_rect,
        dpi: if dpi == 0 { 96 } else { dpi },
        is_minimized,
        is_foreground: hwnd == ctx.fg,
        is_tool_window,
        z_order,
    });

    BOOL(1)
}

pub fn list_windows(
    filter: Option<&str>,
    include_minimized: bool,
    include_tool_windows: bool,
) -> Vec<WindowInfo> {
    unsafe {
        let mut ctx = EnumContext {
            windows: Vec::new(),
            filter: filter.map(|s| s.to_lowercase()),
            include_minimized,
            include_tool_windows,
            fg: GetForegroundWindow(),
            z_counter: 0,
        };
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut EnumContext as isize));
        ctx.windows
    }
}
