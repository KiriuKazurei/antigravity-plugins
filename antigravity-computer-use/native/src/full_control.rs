use base64::Engine;
use image::{ImageFormat, RgbaImage};
use serde::Serialize;
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, Interface, PCWSTR};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleDC, CreateDIBSection, CreateFontW, CreateRoundRectRgn,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetDC,
    InvalidateRect, MonitorFromPoint, ReleaseDC, SelectObject, SetBkMode, SetTextColor,
    SetWindowRgn, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DEFAULT_QUALITY, DIB_RGB_COLORS, DT_CENTER, DT_SINGLELINE, DT_VCENTER, FF_SWISS, FW_BOLD,
    MONITOR_DEFAULTTOPRIMARY, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, SendInput, TrackMouseEvent, UnregisterHotKey, HOT_KEY_MODIFIERS, INPUT,
    INPUT_0, INPUT_MOUSE, MOD_ALT, MOD_CONTROL, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, TME_LEAVE,
    TRACKMOUSEEVENT, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetSystemMetrics, GetWindowLongPtrW,
    MessageBoxW, PeekMessageW, RegisterClassW, SetLayeredWindowAttributes,
    SetWindowDisplayAffinity, SetWindowLongPtrW, SetWindowPos, ShowWindow, SystemParametersInfoW,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HWND_TOPMOST, IDYES, LWA_ALPHA,
    MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, MSG, PM_REMOVE, SM_CXSCREEN,
    SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SPI_GETWORKAREA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WINDOW_DISPLAY_AFFINITY, WM_HOTKEY, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_PAINT, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::cursor::VirtualCursor;

pub const BORDER_CLASS_NAME: &str = "AntigravityFullControlBorderOverlay";
pub const STOP_BTN_CLASS_NAME: &str = "AntigravityFullControlStopButton";

const BORDER_THICKNESS: i32 = 5;
const STOP_BTN_WIDTH: i32 = 148;
const STOP_BTN_HEIGHT: i32 = 42;
const WDA_EXCLUDEFROMCAPTURE: u32 = 0x00000011;
const HOTKEY_EMERGENCY_STOP_ID: i32 = 0x4147;
const WM_MOUSELEAVE_MSG: u32 = 0x02A3;

const DEFAULT_TTL_SECS: u64 = 300;
const MAX_TTL_SECS: u64 = 900;
const DEFAULT_MAX_ACTIONS: u32 = 50;
const MAX_ALLOWED_ACTIONS: u32 = 200;
const REVOKED_COOLDOWN_SECS: u64 = 15;

#[derive(Debug, Clone, Serialize)]
pub struct FullControlStatus {
    pub active: bool,
    pub revoked_by_user: bool,
    pub expired_reason: Option<String>,
    pub reason: String,
    pub remaining_seconds: u64,
    pub remaining_actions: u32,
    pub emergency_hotkey: String,
    pub screen_width: i32,
    pub screen_height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenCaptureResult {
    pub capture_method: String,
    pub capture_ms: u64,
    pub origin_x: i32,
    pub origin_y: i32,
    pub orig_width: u32,
    pub orig_height: u32,
    pub width: u32,
    pub height: u32,
    pub scale_x: f64,
    pub scale_y: f64,
    pub mime_type: String,
    pub remaining_seconds: u64,
    pub remaining_actions: u32,
    #[serde(skip_serializing)]
    pub base64_data: String,
    pub saved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenInputResult {
    pub ok: bool,
    pub screen_x: i32,
    pub screen_y: i32,
    pub remaining_seconds: u64,
    pub remaining_actions: u32,
    pub detail: String,
}

struct FullControlInner {
    active: bool,
    revoked_by_user: bool,
    revoked_at: Option<Instant>,
    expired_reason: Option<String>,
    reason: String,
    expires_at: Option<Instant>,
    actions_used: u32,
    max_actions: u32,
    dirty: bool,
}

impl FullControlInner {
    fn check_and_expire(&mut self) {
        if !self.active {
            return;
        }
        if let Some(exp) = self.expires_at {
            if Instant::now() >= exp {
                self.active = false;
                self.expired_reason = Some("TTL_EXPIRED".to_string());
                self.dirty = true;
            }
        }
    }

    fn remaining_seconds(&self) -> u64 {
        if !self.active {
            return 0;
        }
        self.expires_at
            .map(|e| e.saturating_duration_since(Instant::now()).as_secs())
            .unwrap_or(0)
    }

    fn remaining_actions(&self) -> u32 {
        if !self.active {
            return 0;
        }
        self.max_actions.saturating_sub(self.actions_used)
    }
}

#[derive(Clone)]
pub struct FullControlManager {
    inner: Arc<Mutex<FullControlInner>>,
}

impl FullControlManager {
    pub fn start() -> Self {
        let inner = Arc::new(Mutex::new(FullControlInner {
            active: false,
            revoked_by_user: false,
            revoked_at: None,
            expired_reason: None,
            reason: String::new(),
            expires_at: None,
            actions_used: 0,
            max_actions: DEFAULT_MAX_ACTIONS,
            dirty: false,
        }));

        let thread_inner = inner.clone();
        thread::spawn(move || {
            run_full_control_ui_thread(thread_inner);
        });

        Self { inner }
    }

    pub fn status(&self) -> FullControlStatus {
        let (sw, sh) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        match self.inner.lock() {
            Ok(mut g) => {
                g.check_and_expire();
                FullControlStatus {
                    active: g.active,
                    revoked_by_user: g.revoked_by_user,
                    expired_reason: g.expired_reason.clone(),
                    reason: g.reason.clone(),
                    remaining_seconds: g.remaining_seconds(),
                    remaining_actions: g.remaining_actions(),
                    emergency_hotkey: "Ctrl+Alt+Esc".to_string(),
                    screen_width: sw,
                    screen_height: sh,
                }
            }
            Err(_) => FullControlStatus {
                active: false,
                revoked_by_user: true,
                expired_reason: Some("STATE_LOCK_ERROR".to_string()),
                reason: "state_error".to_string(),
                remaining_seconds: 0,
                remaining_actions: 0,
                emergency_hotkey: "Ctrl+Alt+Esc".to_string(),
                screen_width: sw,
                screen_height: sh,
            },
        }
    }

    /// Ask the user via a native topmost confirmation dialog to grant Full-Screen Control permission.
    pub fn request_permission(
        &self,
        reason: &str,
        ttl_seconds: Option<u64>,
        max_actions: Option<u32>,
    ) -> Result<FullControlStatus, String> {
        let ttl = ttl_seconds.unwrap_or(DEFAULT_TTL_SECS).clamp(30, MAX_TTL_SECS);
        let limit = max_actions
            .unwrap_or(DEFAULT_MAX_ACTIONS)
            .clamp(5, MAX_ALLOWED_ACTIONS);

        {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| "FullControl state lock poisoned".to_string())?;
            g.check_and_expire();
            if g.active {
                drop(g);
                return Ok(self.status());
            }
            // Anti-nagging cooldown after user clicked emergency stop
            if g.revoked_by_user {
                if let Some(rev_at) = g.revoked_at {
                    let elapsed = rev_at.elapsed().as_secs();
                    if elapsed < REVOKED_COOLDOWN_SECS {
                        return Err(format!(
                            "PERMISSION_REVOKED_COOLDOWN: 用户刚刚触发急停中止了完全控制权限，冷却期剩余 {} 秒。请勿擅自重复弹窗申请，等待用户明确指令。",
                            REVOKED_COOLDOWN_SECS - elapsed
                        ));
                    }
                }
            }
        }

        let prompt = format!(
            "Antigravity 正在申请「完全控制电脑」高危权限。\n\n\
             申请原因：{}\n\
             本次租期：最多 {} 秒，或最多 {} 次全屏操作（先到即自动退出）\n\n\
             授权后：\n\
             1. 获取方式将切换为全屏截图（WGC 优先），屏幕四周会显示醒目的黄色边框；\n\
             2. 屏幕右下角常驻「停止获取」红色急停按钮，或随时按 Ctrl+Alt+Esc 可立即中止权限。\n\n\
             是否允许本次「完全控制电脑」权限？",
            if reason.trim().is_empty() {
                "窗口级后台方案无法正常获取目标窗口或界面"
            } else {
                reason.trim()
            },
            ttl,
            limit
        );

        let title = "Antigravity - 完全控制电脑权限申请";
        let prompt_w: Vec<u16> = prompt.encode_utf16().chain(std::iter::once(0)).collect();
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();

        let resp = unsafe {
            MessageBoxW(
                None,
                PCWSTR(prompt_w.as_ptr()),
                PCWSTR(title_w.as_ptr()),
                MB_YESNO | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
            )
        };

        if resp == IDYES {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| "FullControl state lock poisoned".to_string())?;
            g.active = true;
            g.revoked_by_user = false;
            g.revoked_at = None;
            g.expired_reason = None;
            g.reason = reason.to_string();
            g.expires_at = Some(Instant::now() + Duration::from_secs(ttl));
            g.actions_used = 0;
            g.max_actions = limit;
            g.dirty = true;
            drop(g);
            // Give the UI thread a brief moment to paint the yellow border and stop button
            thread::sleep(Duration::from_millis(60));
            Ok(self.status())
        } else {
            let mut g = self
                .inner
                .lock()
                .map_err(|_| "FullControl state lock poisoned".to_string())?;
            g.active = false;
            g.dirty = true;
            drop(g);
            Err("User denied the '完全控制电脑' (Full-Screen Control) permission request.".into())
        }
    }

    pub fn stop(&self, by_user: bool) -> FullControlStatus {
        if let Ok(mut g) = self.inner.lock() {
            g.active = false;
            g.expires_at = None;
            if by_user {
                g.revoked_by_user = true;
                g.revoked_at = Some(Instant::now());
            }
            g.dirty = true;
        }
        self.status()
    }

    pub fn ensure_active(&self) -> Result<(u64, u32), String> {
        let mut g = self
            .inner
            .lock()
            .map_err(|_| "FullControl state lock poisoned".to_string())?;
        g.check_and_expire();
        if g.active {
            if g.actions_used >= g.max_actions {
                g.active = false;
                g.expired_reason = Some("MAX_ACTIONS_REACHED".to_string());
                g.dirty = true;
                return Err(format!(
                    "FULL_CONTROL_STEP_LIMIT_REACHED: 已达到本次授权的最大操作步数上限（{} 步），已自动退出完全控制模式并隐藏警示边框。",
                    g.max_actions
                ));
            }
            return Ok((g.remaining_seconds(), g.remaining_actions()));
        }
        if g.revoked_by_user {
            return Err(
                "PERMISSION_REVOKED_BY_USER: 用户已通过「停止获取」按钮或 Ctrl+Alt+Esc 急停中止完全控制权限。请立即停止屏幕获取与控制操作，勿擅自重试。"
                    .to_string(),
            );
        }
        if let Some(ref exp_reason) = g.expired_reason {
            return Err(format!(
                "FULL_CONTROL_EXPIRED ({}): 本次「完全控制电脑」租期已自动结束并收起警示边框。如需继续，请向用户说明原因后重新申请。",
                exp_reason
            ));
        }
        Err(
            "FULL_CONTROL_NOT_ACTIVE: 当前未启用「完全控制电脑」权限。请优先使用窗口级后台工具（cu_list_windows/cu_screenshot/cu_click）；仅在无法正常获取窗口或界面时，调用 cu_full_control_request 向用户申请权限。"
                .to_string(),
        )
    }

    pub fn consume_action(&self) -> Result<(u64, u32), String> {
        let mut g = self
            .inner
            .lock()
            .map_err(|_| "FullControl state lock poisoned".to_string())?;
        g.check_and_expire();
        if !g.active {
            drop(g);
            return self.ensure_active();
        }
        if g.actions_used >= g.max_actions {
            g.active = false;
            g.expired_reason = Some("MAX_ACTIONS_REACHED".to_string());
            g.dirty = true;
            return Err(format!(
                "FULL_CONTROL_STEP_LIMIT_REACHED: 已达到本次授权的最大操作步数上限（{} 步），已自动退出完全控制模式。",
                g.max_actions
            ));
        }
        g.actions_used += 1;
        let rem_secs = g.remaining_seconds();
        let rem_acts = g.remaining_actions();
        if rem_acts == 0 {
            // Auto-close after final permitted action completes
            g.active = false;
            g.expired_reason = Some("MAX_ACTIONS_REACHED".to_string());
            g.dirty = true;
        }
        Ok((rem_secs, rem_acts))
    }
}

/// Capture primary monitor via WGC (CreateForMonitor) for GPU/HDR/hardware-accelerated reliability.
fn capture_primary_monitor_wgc() -> Result<RgbaImage, String> {
    unsafe {
        let hmonitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        if hmonitor.is_invalid() {
            return Err("MonitorFromPoint returned invalid HMONITOR".into());
        }

        let mut d3d_device: Option<ID3D11Device> = None;
        let mut d3d_context: Option<ID3D11DeviceContext> = None;
        let feature_levels = [D3D_FEATURE_LEVEL_11_0];
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut d3d_device),
            None,
            Some(&mut d3d_context),
        )
        .map_err(|e| format!("D3D11CreateDevice failed: {}", e))?;

        let d3d_device = d3d_device.ok_or("No D3D11 device")?;
        let d3d_context = d3d_context.ok_or("No D3D11 context")?;
        let dxgi_device: IDXGIDevice = d3d_device
            .cast()
            .map_err(|e| format!("Cast IDXGIDevice failed: {}", e))?;

        let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
            .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice failed: {}", e))?;
        let winrt_device: IDirect3DDevice = inspectable
            .cast()
            .map_err(|e| format!("Cast IDirect3DDevice failed: {}", e))?;

        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| format!("IGraphicsCaptureItemInterop factory failed: {}", e))?;
        let item: GraphicsCaptureItem = interop
            .CreateForMonitor(hmonitor)
            .map_err(|e| format!("CreateForMonitor failed: {}", e))?;

        let size = item
            .Size()
            .map_err(|e| format!("item.Size() failed: {}", e))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("Monitor capture size is zero".into());
        }

        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(|e| format!("CreateFreeThreaded failed: {}", e))?;

        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("CreateCaptureSession failed: {}", e))?;

        // Disable OS duplicate border (we render our own crisp yellow border + stop button)
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);

        let signal = Arc::new((Mutex::new(false), Condvar::new()));
        let signal_cb = signal.clone();

        let token = frame_pool
            .FrameArrived(&TypedEventHandler::new(
                move |_pool: &Option<Direct3D11CaptureFramePool>, _| {
                    let (lock, cvar) = &*signal_cb;
                    if let Ok(mut ready) = lock.lock() {
                        *ready = true;
                        cvar.notify_one();
                    }
                    Ok(())
                },
            ))
            .map_err(|e| format!("FrameArrived subscribe failed: {}", e))?;

        struct WgcMonitorGuard {
            frame_pool: Direct3D11CaptureFramePool,
            session: GraphicsCaptureSession,
            token: windows::Foundation::EventRegistrationToken,
        }
        impl Drop for WgcMonitorGuard {
            fn drop(&mut self) {
                let _ = self.frame_pool.RemoveFrameArrived(self.token);
                let _ = self.session.Close();
                let _ = self.frame_pool.Close();
            }
        }
        let _guard = WgcMonitorGuard {
            frame_pool: frame_pool.clone(),
            session: session.clone(),
            token,
        };

        session
            .StartCapture()
            .map_err(|e| format!("StartCapture failed: {}", e))?;

        {
            let (lock, cvar) = &*signal;
            let guard = lock
                .lock()
                .map_err(|_| "WGC monitor signal mutex poisoned".to_string())?;
            let (guard, _) = cvar
                .wait_timeout_while(guard, Duration::from_millis(500), |ready| !*ready)
                .map_err(|_| "WGC monitor condvar wait failed".to_string())?;
            if !*guard {
                return Err("WGC monitor frame timeout".into());
            }
        }

        let frame = frame_pool
            .TryGetNextFrame()
            .map_err(|e| format!("TryGetNextFrame failed: {}", e))?;

        let surface = frame
            .Surface()
            .map_err(|e| format!("frame.Surface() failed: {}", e))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|e| format!("IDirect3DDxgiInterfaceAccess cast failed: {}", e))?;
        let src_tex: ID3D11Texture2D = access
            .GetInterface()
            .map_err(|e| format!("GetInterface ID3D11Texture2D failed: {}", e))?;

        let mut desc = D3D11_TEXTURE2D_DESC::default();
        src_tex.GetDesc(&mut desc);

        let mut staging_desc = desc;
        staging_desc.Usage = D3D11_USAGE_STAGING;
        staging_desc.BindFlags = 0;
        staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        staging_desc.MiscFlags = 0;

        let mut staging_tex: Option<ID3D11Texture2D> = None;
        d3d_device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging_tex))
            .map_err(|e| format!("CreateTexture2D staging failed: {}", e))?;
        let staging_tex = staging_tex.ok_or("No staging texture")?;

        d3d_context.CopyResource(&staging_tex, &src_tex);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        d3d_context
            .Map(&staging_tex, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| format!("Map staging texture failed: {}", e))?;

        let w = desc.Width as usize;
        let h = desc.Height as usize;
        let pitch = mapped.RowPitch as usize;
        if w == 0 || h == 0 || pitch < w * 4 {
            d3d_context.Unmap(&staging_tex, 0);
            let _ = frame.Close();
            return Err(format!("Invalid WGC monitor layout: {}x{}, pitch={}", w, h, pitch));
        }

        let mut rgba = vec![0u8; w * h * 4];
        let src_base = mapped.pData as *const u8;
        for y in 0..h {
            let src_row = std::slice::from_raw_parts(src_base.add(y * pitch), w * 4);
            let dst_row = &mut rgba[y * w * 4..(y + 1) * w * 4];
            for x in 0..w {
                let i = x * 4;
                dst_row[i] = src_row[i + 2];
                dst_row[i + 1] = src_row[i + 1];
                dst_row[i + 2] = src_row[i];
                dst_row[i + 3] = 255;
            }
        }

        d3d_context.Unmap(&staging_tex, 0);
        let _ = frame.Close();

        RgbaImage::from_raw(desc.Width, desc.Height, rgba)
            .ok_or_else(|| "Failed to build RgbaImage from WGC monitor buffer".to_string())
    }
}

fn capture_screen_bitblt(origin_x: i32, origin_y: i32, w: i32, h: i32) -> Result<RgbaImage, String> {
    if w <= 0 || h <= 0 {
        return Err("Failed to query screen dimensions".into());
    }
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC(screen) failed".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC failed".into());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbitmap = match CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0) {
            Ok(b) => b,
            Err(e) => {
                let _ = DeleteDC(mem_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err(format!("CreateDIBSection failed: {}", e));
            }
        };

        let old_bmp = SelectObject(mem_dc, hbitmap);
        let blt_res = BitBlt(mem_dc, 0, 0, w, h, screen_dc, origin_x, origin_y, SRCCOPY);

        let mut rgba = vec![0u8; (w * h * 4) as usize];
        if blt_res.is_ok() && !bits_ptr.is_null() {
            let src = std::slice::from_raw_parts(bits_ptr as *const u8, (w * h * 4) as usize);
            for i in (0..src.len()).step_by(4) {
                rgba[i] = src[i + 2];
                rgba[i + 1] = src[i + 1];
                rgba[i + 2] = src[i];
                rgba[i + 3] = 255;
            }
        }

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(hbitmap);
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);

        if let Err(e) = blt_res {
            return Err(format!("BitBlt screen capture failed: {}", e));
        }

        RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or_else(|| "Failed to build RgbaImage from BitBlt screen buffer".to_string())
    }
}

/// Capture the entire primary screen (WGC first, BitBlt fallback) or virtual desktop when Full-Control is active.
pub fn capture_screen(
    mgr: &FullControlManager,
    all_monitors: bool,
    max_width: u32,
    format: &str,
    quality: u8,
    save_path: Option<&str>,
) -> Result<ScreenCaptureResult, String> {
    mgr.ensure_active()?;
    let start = Instant::now();

    let (origin_x, origin_y, w, h) = unsafe {
        if all_monitors {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        } else {
            (
                0,
                0,
                GetSystemMetrics(SM_CXSCREEN),
                GetSystemMetrics(SM_CYSCREEN),
            )
        }
    };

    let (img, capture_method) = if !all_monitors {
        match capture_primary_monitor_wgc() {
            Ok(image) => (image, "full_screen_wgc".to_string()),
            Err(_) => {
                let image = capture_screen_bitblt(origin_x, origin_y, w, h)?;
                (image, "full_screen_bitblt_fallback".to_string())
            }
        }
    } else {
        let image = capture_screen_bitblt(origin_x, origin_y, w, h)?;
        (image, "full_screen_virtual_bitblt".to_string())
    };

    // Re-check and consume step budget (also catches emergency stop pressed during capture)
    let (remaining_seconds, remaining_actions) = mgr.consume_action()?;

    let orig_width = img.width();
    let orig_height = img.height();
    let final_img = if max_width > 0 && orig_width > max_width {
        let new_h = ((orig_height as f64) * (max_width as f64 / orig_width as f64))
            .round()
            .max(1.0) as u32;
        image::imageops::resize(&img, max_width, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let width = final_img.width();
    let height = final_img.height();
    let scale_x = orig_width as f64 / width.max(1) as f64;
    let scale_y = orig_height as f64 / height.max(1) as f64;

    let mut bytes = Vec::new();
    let mime_type = if format.eq_ignore_ascii_case("png") {
        let mut cur = Cursor::new(&mut bytes);
        final_img
            .write_to(&mut cur, ImageFormat::Png)
            .map_err(|e| format!("PNG encode failed: {}", e))?;
        "image/png".to_string()
    } else {
        let rgb = image::DynamicImage::ImageRgba8(final_img).to_rgb8();
        let mut cur = Cursor::new(&mut bytes);
        let mut enc =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, quality.clamp(30, 98));
        enc.encode_image(&rgb)
            .map_err(|e| format!("JPEG encode failed: {}", e))?;
        "image/jpeg".to_string()
    };

    let saved_path = if let Some(path) = save_path {
        std::fs::write(path, &bytes).map_err(|e| format!("Failed to save screenshot: {}", e))?;
        Some(path.to_string())
    } else {
        None
    };

    let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let capture_ms = start.elapsed().as_millis() as u64;

    Ok(ScreenCaptureResult {
        capture_method,
        capture_ms,
        origin_x,
        origin_y,
        orig_width,
        orig_height,
        width,
        height,
        scale_x,
        scale_y,
        mime_type,
        remaining_seconds,
        remaining_actions,
        base64_data,
        saved_path,
    })
}

/// Click at absolute screen physical coordinates (x, y) via SendInput when Full-Control is active.
pub fn screen_click(
    mgr: &FullControlManager,
    x: i32,
    y: i32,
    button: &str,
    double_click: bool,
    cursor: &VirtualCursor,
) -> Result<ScreenInputResult, String> {
    mgr.ensure_active()?;

    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);

        // Bounds guard: reject out-of-desktop coordinates
        if x < vx || x >= vx + vw || y < vy || y >= vy + vh {
            return Err(format!(
                "Screen coordinates ({}, {}) are outside virtual desktop bounds [{}..{}, {}..{}]",
                x,
                y,
                vx,
                vx + vw - 1,
                vy,
                vy + vh - 1
            ));
        }

        let norm_x = (((x - vx) as f64 * 65535.0) / ((vw - 1).max(1) as f64)).round() as i32;
        let norm_y = (((y - vy) as f64 * 65535.0) / ((vh - 1).max(1) as f64)).round() as i32;

        cursor.trigger_click(x, y, None, button);

        let (down_flag, up_flag) = match button {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };

        let make_mouse_input = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: norm_x,
                    dy: norm_y,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        let click_seq = [
            make_mouse_input(move_flags),
            make_mouse_input(move_flags | down_flag),
            make_mouse_input(move_flags | up_flag),
        ];

        let sent = SendInput(&click_seq, std::mem::size_of::<INPUT>() as i32);
        if sent == 0 {
            return Err("SendInput failed (target window may be elevated/UIPI protected)".into());
        }

        if double_click {
            thread::sleep(Duration::from_millis(40));
            mgr.ensure_active()?;
            let dbl_seq = [
                make_mouse_input(move_flags | down_flag),
                make_mouse_input(move_flags | up_flag),
            ];
            let _ = SendInput(&dbl_seq, std::mem::size_of::<INPUT>() as i32);
        }

        let (remaining_seconds, remaining_actions) = mgr.consume_action()?;

        Ok(ScreenInputResult {
            ok: true,
            screen_x: x,
            screen_y: y,
            remaining_seconds,
            remaining_actions,
            detail: format!(
                "Full-control {} {} at screen ({}, {})",
                button,
                if double_click { "double-click" } else { "click" },
                x,
                y
            ),
        })
    }
}

unsafe extern "system" fn border_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_PAINT {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        // Bright warning yellow #FACC15 -> COLORREF 0x0015CCFA (BGR)
        let brush = CreateSolidBrush(COLORREF(0x0015CCFA));
        FillRect(hdc, &ps.rcPaint, brush);
        let _ = DeleteObject(brush);
        let _ = EndPaint(hwnd, &ps);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

struct StopButtonState {
    inner: Arc<Mutex<FullControlInner>>,
    hovered: bool,
}

unsafe extern "system" fn stop_btn_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut StopButtonState;

    match msg {
        WM_MOUSEMOVE => {
            if !ptr.is_null() {
                let st = &mut *ptr;
                if !st.hovered {
                    st.hovered = true;
                    let mut tme = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    let _ = TrackMouseEvent(&mut tme);
                    let _ = InvalidateRect(hwnd, None, false);
                }
            }
            return LRESULT(0);
        }
        WM_MOUSELEAVE_MSG => {
            if !ptr.is_null() {
                let st = &mut *ptr;
                if st.hovered {
                    st.hovered = false;
                    let _ = InvalidateRect(hwnd, None, false);
                }
            }
            return LRESULT(0);
        }
        WM_HOTKEY => {
            if wparam.0 as i32 == HOTKEY_EMERGENCY_STOP_ID && !ptr.is_null() {
                let st = &mut *ptr;
                st.hovered = false;
                if let Ok(mut g) = st.inner.lock() {
                    if g.active {
                        g.active = false;
                        g.revoked_by_user = true;
                        g.revoked_at = Some(Instant::now());
                        g.expires_at = None;
                        g.dirty = true;
                    }
                }
            }
            return LRESULT(0);
        }
        WM_LBUTTONUP => {
            if !ptr.is_null() {
                let st = &mut *ptr;
                st.hovered = false;
                if let Ok(mut g) = st.inner.lock() {
                    g.active = false;
                    g.revoked_by_user = true;
                    g.revoked_at = Some(Instant::now());
                    g.expires_at = None;
                    g.dirty = true;
                }
            }
            return LRESULT(0);
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let hovered = if !ptr.is_null() { (*ptr).hovered } else { false };

            // Outer border: warning yellow #FACC15; Inner fill: emergency crimson red (#DC2626 / hover #B91C1C)
            let border_brush = CreateSolidBrush(COLORREF(0x0015CCFA));
            FillRect(hdc, &ps.rcPaint, border_brush);
            let _ = DeleteObject(border_brush);

            let inner_rc = RECT {
                left: 2,
                top: 2,
                right: STOP_BTN_WIDTH - 2,
                bottom: STOP_BTN_HEIGHT - 2,
            };
            let bg_color = if hovered {
                COLORREF(0x001C1CB9) // #B91C1C
            } else {
                COLORREF(0x002626DC) // #DC2626
            };
            let bg_brush = CreateSolidBrush(bg_color);
            FillRect(hdc, &inner_rc, bg_brush);
            let _ = DeleteObject(bg_brush);

            let font_name = w!("Microsoft YaHei UI");
            let font = CreateFontW(
                -15,
                0,
                0,
                0,
                FW_BOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET.0 as u32,
                OUT_DEFAULT_PRECIS.0 as u32,
                CLIP_DEFAULT_PRECIS.0 as u32,
                DEFAULT_QUALITY.0 as u32,
                FF_SWISS.0 as u32,
                font_name,
            );
            let old_font = SelectObject(hdc, font);
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, COLORREF(0x00FFFFFF));

            let mut label: Vec<u16> = "■ 停止获取".encode_utf16().collect();
            let mut text_rc = inner_rc;
            DrawTextW(
                hdc,
                &mut label,
                &mut text_rc,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );

            SelectObject(hdc, old_font);
            let _ = DeleteObject(font);
            let _ = EndPaint(hwnd, &ps);
            return LRESULT(0);
        }
        _ => {}
    }

    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn run_full_control_ui_thread(inner: Arc<Mutex<FullControlInner>>) {
    unsafe {
        let hinstance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let border_cls = w!("AntigravityFullControlBorderOverlay");
        let stop_cls = w!("AntigravityFullControlStopButton");

        let _ = RegisterClassW(&WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(border_wnd_proc),
            hInstance: hinstance,
            lpszClassName: border_cls,
            ..Default::default()
        });

        let _ = RegisterClassW(&WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(stop_btn_wnd_proc),
            hInstance: hinstance,
            lpszClassName: stop_cls,
            ..Default::default()
        });

        let border_ex = WS_EX_LAYERED
            | WS_EX_TRANSPARENT
            | WS_EX_TOPMOST
            | WS_EX_NOACTIVATE
            | WS_EX_TOOLWINDOW;

        let mut borders: [HWND; 4] = [HWND::default(); 4];
        for slot in &mut borders {
            match CreateWindowExW(
                border_ex,
                border_cls,
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                10,
                10,
                None,
                None,
                hinstance,
                None,
            ) {
                Ok(h) => {
                    let _ = SetLayeredWindowAttributes(h, COLORREF(0), 235, LWA_ALPHA);
                    let _ = SetWindowDisplayAffinity(
                        h,
                        WINDOW_DISPLAY_AFFINITY(WDA_EXCLUDEFROMCAPTURE),
                    );
                    *slot = h;
                }
                Err(_) => return,
            }
        }

        // Emergency stop button: topmost, non-activating, clickable (NOT WS_EX_TRANSPARENT!)
        let stop_ex = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let stop_hwnd = match CreateWindowExW(
            stop_ex,
            stop_cls,
            w!("停止获取"),
            WS_POPUP,
            0,
            0,
            STOP_BTN_WIDTH,
            STOP_BTN_HEIGHT,
            None,
            None,
            hinstance,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };

        let _ = SetWindowDisplayAffinity(
            stop_hwnd,
            WINDOW_DISPLAY_AFFINITY(WDA_EXCLUDEFROMCAPTURE),
        );
        let rgn = CreateRoundRectRgn(0, 0, STOP_BTN_WIDTH + 1, STOP_BTN_HEIGHT + 1, 10, 10);
        let _ = SetWindowRgn(stop_hwnd, rgn, true);

        let btn_state = Box::new(StopButtonState {
            inner: inner.clone(),
            hovered: false,
        });
        let btn_state_ptr = Box::into_raw(btn_state);
        SetWindowLongPtrW(stop_hwnd, GWLP_USERDATA, btn_state_ptr as isize);

        let mut is_shown = false;
        let mut hotkey_registered = false;
        let mut msg = MSG::default();

        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let (should_show, dirty) = match inner.lock() {
                Ok(mut g) => {
                    g.check_and_expire();
                    let d = g.dirty;
                    g.dirty = false;
                    (g.active, d)
                }
                Err(_) => (false, false),
            };

            if should_show && (!is_shown || dirty) {
                if !hotkey_registered {
                    let mods = HOT_KEY_MODIFIERS(MOD_CONTROL.0 | MOD_ALT.0);
                    if RegisterHotKey(stop_hwnd, HOTKEY_EMERGENCY_STOP_ID, mods, VK_ESCAPE.0 as u32)
                        .is_ok()
                    {
                        hotkey_registered = true;
                    }
                }

                let sw = GetSystemMetrics(SM_CXSCREEN).max(100);
                let sh = GetSystemMetrics(SM_CYSCREEN).max(100);
                let t = BORDER_THICKNESS;

                let rects = [
                    (0, 0, sw, t),              // Top edge
                    (0, sh - t, sw, t),         // Bottom edge
                    (0, t, t, sh - 2 * t),      // Left edge
                    (sw - t, t, t, sh - 2 * t), // Right edge
                ];

                for (i, (x, y, w, h)) in rects.iter().enumerate() {
                    let _ = SetWindowPos(
                        borders[i],
                        HWND_TOPMOST,
                        *x,
                        *y,
                        *w,
                        *h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                    let _ = InvalidateRect(borders[i], None, true);
                }

                // Place emergency stop button at bottom-right above taskbar
                let mut work = RECT {
                    left: 0,
                    top: 0,
                    right: sw,
                    bottom: sh,
                };
                let _ = SystemParametersInfoW(
                    SPI_GETWORKAREA,
                    0,
                    Some(&mut work as *mut RECT as *mut _),
                    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                );
                let btn_x = (work.right - STOP_BTN_WIDTH - 16).max(8);
                let btn_y = (work.bottom - STOP_BTN_HEIGHT - 16).max(8);

                let _ = SetWindowPos(
                    stop_hwnd,
                    HWND_TOPMOST,
                    btn_x,
                    btn_y,
                    STOP_BTN_WIDTH,
                    STOP_BTN_HEIGHT,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                let _ = ShowWindow(stop_hwnd, SW_SHOWNOACTIVATE);
                let _ = InvalidateRect(stop_hwnd, None, true);
                is_shown = true;
            } else if !should_show && is_shown {
                if hotkey_registered {
                    let _ = UnregisterHotKey(stop_hwnd, HOTKEY_EMERGENCY_STOP_ID);
                    hotkey_registered = false;
                }
                for b in &borders {
                    let _ = ShowWindow(*b, SW_HIDE);
                }
                let _ = ShowWindow(stop_hwnd, SW_HIDE);
                is_shown = false;
            }

            thread::sleep(Duration::from_millis(25));
        }
    }
}
