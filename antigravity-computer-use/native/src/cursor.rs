use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, AC_SRC_ALPHA,
    AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, PeekMessageW, RegisterClassW,
    ShowWindow, TranslateMessage, UpdateLayeredWindow, CS_HREDRAW, CS_VREDRAW, MSG, PM_REMOVE,
    SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

pub const OVERLAY_CLASS_NAME: &str = "AntigravityAgentVirtualCursorOverlay";
const CANVAS_SIZE: i32 = 64;
const HOTSPOT_X: i32 = 20;
const HOTSPOT_Y: i32 = 20;
const IDLE_HOLD_MS: u64 = 2200;
const FADE_OUT_MS: u64 = 450;

#[derive(Debug, Clone, Serialize)]
pub struct VirtualCursorState {
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub target_hwnd: Option<isize>,
    pub last_action: String,
}

struct SharedCursorInner {
    visible: bool,
    initialized: bool,
    current_x: f32,
    current_y: f32,
    target_x: f32,
    target_y: f32,
    target_hwnd: Option<isize>,
    last_action: String,
    last_activity: Option<Instant>,
    ripple_until: Option<Instant>,
    ripple_color: (u8, u8, u8),
    dirty: bool,
}

#[derive(Clone)]
pub struct VirtualCursor {
    inner: Arc<Mutex<SharedCursorInner>>,
}

impl VirtualCursor {
    pub fn start() -> Self {
        let inner = Arc::new(Mutex::new(SharedCursorInner {
            visible: true,
            initialized: false,
            current_x: 0.0,
            current_y: 0.0,
            target_x: 0.0,
            target_y: 0.0,
            target_hwnd: None,
            last_action: "idle".to_string(),
            last_activity: None,
            ripple_until: None,
            ripple_color: (0, 212, 255),
            dirty: false,
        }));

        let thread_inner = inner.clone();
        thread::spawn(move || {
            run_overlay_thread(thread_inner);
        });

        Self { inner }
    }

    pub fn move_to(&self, screen_x: i32, screen_y: i32, hwnd: Option<isize>, action: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if !g.initialized {
                g.current_x = screen_x as f32;
                g.current_y = screen_y as f32;
                g.initialized = true;
            }
            g.target_x = screen_x as f32;
            g.target_y = screen_y as f32;
            g.target_hwnd = hwnd;
            g.last_action = action.to_string();
            g.last_activity = Some(Instant::now());
            g.dirty = true;
        }
    }

    pub fn trigger_click(&self, screen_x: i32, screen_y: i32, hwnd: Option<isize>, button: &str) {
        if let Ok(mut g) = self.inner.lock() {
            if !g.initialized {
                g.current_x = screen_x as f32;
                g.current_y = screen_y as f32;
                g.initialized = true;
            }
            let now = Instant::now();
            g.target_x = screen_x as f32;
            g.target_y = screen_y as f32;
            g.target_hwnd = hwnd;
            g.last_action = format!("click:{}", button);
            g.last_activity = Some(now);
            g.ripple_until = Some(now + Duration::from_millis(360));
            g.ripple_color = match button {
                "right" => (168, 85, 247),  // purple
                "middle" => (250, 204, 21), // amber
                _ => (0, 212, 255),         // cyan
            };
            g.dirty = true;
        }
    }

    pub fn set_visible(&self, visible: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.visible = visible;
            if visible && g.initialized {
                g.last_activity = Some(Instant::now());
            }
            g.dirty = true;
        }
    }

    pub fn state(&self) -> VirtualCursorState {
        match self.inner.lock() {
            Ok(g) => VirtualCursorState {
                visible: g.visible,
                x: g.target_x.round() as i32,
                y: g.target_y.round() as i32,
                target_hwnd: g.target_hwnd,
                last_action: g.last_action.clone(),
            },
            Err(_) => VirtualCursorState {
                visible: false,
                x: 0,
                y: 0,
                target_hwnd: None,
                last_action: "error".to_string(),
            },
        }
    }
}

unsafe extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn run_overlay_thread(inner: Arc<Mutex<SharedCursorInner>>) {
    unsafe {
        let hinstance: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let class_name = w!("AntigravityAgentVirtualCursorOverlay");

        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_wnd_proc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        let _ = RegisterClassW(&wc);

        // Strictly click-through, non-activating, topmost, hidden from Alt+Tab/Taskbar
        let ex_style = WS_EX_LAYERED
            | WS_EX_TRANSPARENT
            | WS_EX_TOPMOST
            | WS_EX_NOACTIVATE
            | WS_EX_TOOLWINDOW;

        let hwnd = match CreateWindowExW(
            ex_style,
            class_name,
            PCWSTR::null(),
            WS_POPUP,
            -200,
            -200,
            CANVAS_SIZE,
            CANVAS_SIZE,
            None,
            None,
            hinstance,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };

        let mut is_shown = false;
        let mut last_alpha: u8 = 0;
        let mut msg = MSG::default();

        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let now = Instant::now();
            let (should_show, pos_x, pos_y, ripple_progress, ripple_rgb, alpha, need_redraw) = {
                let mut g = match inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                };
                let dx = g.target_x - g.current_x;
                let dy = g.target_y - g.current_y;
                let dist = (dx * dx + dy * dy).sqrt();
                let mut moved = false;
                if dist > 0.8 {
                    let step = 0.35f32;
                    g.current_x += dx * step;
                    g.current_y += dy * step;
                    moved = true;
                } else if dist > 0.01 {
                    g.current_x = g.target_x;
                    g.current_y = g.target_y;
                    moved = true;
                }

                let ripple_prog = if let Some(until) = g.ripple_until {
                    if now < until {
                        let rem = until.duration_since(now).as_secs_f32();
                        Some(1.0 - (rem / 0.36).clamp(0.0, 1.0))
                    } else {
                        g.ripple_until = None;
                        g.dirty = true;
                        None
                    }
                } else {
                    None
                };

                // Auto fade-out and hide after idle so virtual cursor never lingers after tasks end
                let computed_alpha: u8 = if !g.visible || !g.initialized {
                    0
                } else if moved || ripple_prog.is_some() {
                    255
                } else if let Some(last_act) = g.last_activity {
                    let elapsed_ms = now.saturating_duration_since(last_act).as_millis() as u64;
                    if elapsed_ms <= IDLE_HOLD_MS {
                        255
                    } else if elapsed_ms < IDLE_HOLD_MS + FADE_OUT_MS {
                        let fade_t = (elapsed_ms - IDLE_HOLD_MS) as f32 / FADE_OUT_MS as f32;
                        ((1.0 - fade_t).clamp(0.0, 1.0) * 255.0).round() as u8
                    } else {
                        0
                    }
                } else {
                    0
                };

                let active = computed_alpha > 0;
                let alpha_changed = computed_alpha != last_alpha;
                let redraw = g.dirty || moved || ripple_prog.is_some() || alpha_changed;
                g.dirty = false;
                (
                    active,
                    g.current_x.round() as i32,
                    g.current_y.round() as i32,
                    ripple_prog,
                    g.ripple_color,
                    computed_alpha,
                    redraw,
                )
            };

            if !should_show {
                if is_shown {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    is_shown = false;
                }
                last_alpha = 0;
                thread::sleep(Duration::from_millis(30));
                continue;
            }

            if need_redraw {
                render_cursor_window(hwnd, pos_x, pos_y, ripple_progress, ripple_rgb, alpha);
                last_alpha = alpha;
                if !is_shown {
                    let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    is_shown = true;
                }
            }

            thread::sleep(Duration::from_millis(16));
        }
    }
}

unsafe fn render_cursor_window(
    hwnd: HWND,
    screen_x: i32,
    screen_y: i32,
    ripple_progress: Option<f32>,
    ripple_rgb: (u8, u8, u8),
    source_alpha: u8,
) {
    let mem_dc = CreateCompatibleDC(None);
    if mem_dc.is_invalid() {
        return;
    }

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: CANVAS_SIZE,
            biHeight: -CANVAS_SIZE, // top-down DIB
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
        Err(_) => {
            let _ = DeleteDC(mem_dc);
            return;
        }
    };

    if !bits_ptr.is_null() {
        let buf = std::slice::from_raw_parts_mut(
            bits_ptr as *mut u8,
            (CANVAS_SIZE * CANVAS_SIZE * 4) as usize,
        );
        buf.fill(0);

        // 1. Draw click ripple ring centered at (HOTSPOT_X, HOTSPOT_Y)
        if let Some(p) = ripple_progress {
            let radius = 6.0 + p * 18.0;
            let alpha = ((1.0 - p) * 220.0) as u8;
            draw_ring(
                buf,
                CANVAS_SIZE,
                HOTSPOT_X as f32,
                HOTSPOT_Y as f32,
                radius,
                2.2,
                ripple_rgb.0,
                ripple_rgb.1,
                ripple_rgb.2,
                alpha,
            );
        }

        // 2. Draw glowing halo dot at hotspot
        draw_circle(
            buf,
            CANVAS_SIZE,
            HOTSPOT_X as f32,
            HOTSPOT_Y as f32,
            4.5,
            0,
            212,
            255,
            110,
        );

        // 3. Draw crisp Agent arrow cursor pointing to (HOTSPOT_X, HOTSPOT_Y)
        // Polygon vertices relative to hotspot
        let poly = [
            (HOTSPOT_X as f32, HOTSPOT_Y as f32),
            (HOTSPOT_X as f32, (HOTSPOT_Y + 22) as f32),
            ((HOTSPOT_X + 6) as f32, (HOTSPOT_Y + 17) as f32),
            ((HOTSPOT_X + 11) as f32, (HOTSPOT_Y + 25) as f32),
            ((HOTSPOT_X + 14) as f32, (HOTSPOT_Y + 23) as f32),
            ((HOTSPOT_X + 9) as f32, (HOTSPOT_Y + 15) as f32),
            ((HOTSPOT_X + 16) as f32, (HOTSPOT_Y + 14) as f32),
        ];
        // Outer dark border for contrast on light backgrounds
        fill_polygon_with_border(buf, CANVAS_SIZE, &poly, (0, 212, 255, 245), (15, 23, 42, 255));
    }

    let old_bmp = SelectObject(mem_dc, hbitmap);
    let dst_pt = POINT {
        x: screen_x - HOTSPOT_X,
        y: screen_y - HOTSPOT_Y,
    };
    let size = SIZE {
        cx: CANVAS_SIZE,
        cy: CANVAS_SIZE,
    };
    let src_pt = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: source_alpha,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };

    let _ = UpdateLayeredWindow(
        hwnd,
        None,
        Some(&dst_pt),
        Some(&size),
        mem_dc,
        Some(&src_pt),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );

    SelectObject(mem_dc, old_bmp);
    let _ = DeleteObject(hbitmap);
    let _ = DeleteDC(mem_dc);
}

fn blend_pixel(buf: &mut [u8], size: i32, x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
    if x < 0 || y < 0 || x >= size || y >= size || a == 0 {
        return;
    }
    let idx = ((y * size + x) * 4) as usize;
    let sa = a as f32 / 255.0;
    let inv = 1.0 - sa;
    // Premultiplied BGRA
    let pb = (b as f32 * sa) + (buf[idx] as f32 * inv);
    let pg = (g as f32 * sa) + (buf[idx + 1] as f32 * inv);
    let pr = (r as f32 * sa) + (buf[idx + 2] as f32 * inv);
    let pa = (a as f32) + (buf[idx + 3] as f32 * inv);
    buf[idx] = pb.clamp(0.0, 255.0) as u8;
    buf[idx + 1] = pg.clamp(0.0, 255.0) as u8;
    buf[idx + 2] = pr.clamp(0.0, 255.0) as u8;
    buf[idx + 3] = pa.clamp(0.0, 255.0) as u8;
}

fn draw_circle(buf: &mut [u8], size: i32, cx: f32, cy: f32, radius: f32, r: u8, g: u8, b: u8, a: u8) {
    let min_x = (cx - radius - 1.0).floor() as i32;
    let max_x = (cx + radius + 1.0).ceil() as i32;
    let min_y = (cy - radius - 1.0).floor() as i32;
    let max_y = (cy + radius + 1.0).ceil() as i32;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            if d <= radius {
                let edge = ((radius - d).clamp(0.0, 1.0) * a as f32) as u8;
                blend_pixel(buf, size, x, y, r, g, b, edge);
            }
        }
    }
}

fn draw_ring(
    buf: &mut [u8],
    size: i32,
    cx: f32,
    cy: f32,
    radius: f32,
    thickness: f32,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) {
    let min_x = (cx - radius - thickness - 1.0).floor() as i32;
    let max_x = (cx + radius + thickness + 1.0).ceil() as i32;
    let min_y = (cy - radius - thickness - 1.0).floor() as i32;
    let max_y = (cy + radius + thickness + 1.0).ceil() as i32;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
            let diff = (d - radius).abs();
            if diff <= thickness {
                let fade = 1.0 - (diff / thickness);
                blend_pixel(buf, size, x, y, r, g, b, (fade * a as f32) as u8);
            }
        }
    }
}

fn point_in_poly(px: f32, py: f32, poly: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        let intersect = ((yi > py) != (yj > py))
            && (px < (xj - xi) * (py - yi) / ((yj - yi) + 1e-6) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn dist_to_segment(px: f32, py: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-6 {
        return ((px - x1).powi(2) + (py - y1).powi(2)).sqrt();
    }
    let t = (((px - x1) * dx + (py - y1) * dy) / len_sq).clamp(0.0, 1.0);
    let proj_x = x1 + t * dx;
    let proj_y = y1 + t * dy;
    ((px - proj_x).powi(2) + (py - proj_y).powi(2)).sqrt()
}

fn fill_polygon_with_border(
    buf: &mut [u8],
    size: i32,
    poly: &[(f32, f32)],
    fill: (u8, u8, u8, u8),
    border: (u8, u8, u8, u8),
) {
    let n = poly.len();
    for y in 0..size {
        for x in 0..size {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let mut min_d = f32::MAX;
            for i in 0..n {
                let (x1, y1) = poly[i];
                let (x2, y2) = poly[(i + 1) % n];
                let d = dist_to_segment(fx, fy, x1, y1, x2, y2);
                if d < min_d {
                    min_d = d;
                }
            }
            if min_d <= 1.35 {
                let a = ((1.35 - min_d).clamp(0.0, 1.0) * border.3 as f32).max(180.0) as u8;
                blend_pixel(buf, size, x, y, border.0, border.1, border.2, a);
            } else if point_in_poly(fx, fy, poly) {
                blend_pixel(buf, size, x, y, fill.0, fill.1, fill.2, fill.3);
            }
        }
    }
}
