use base64::Engine;
use image::{ImageFormat, RgbaImage};
use serde::Serialize;
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::IsIconic;

use crate::window::{get_raw_window_rect, get_window_rect, hwnd_from_isize};

const PW_RENDERFULLCONTENT: u32 = 0x00000002;

#[derive(Debug, Clone, Serialize)]
pub struct CaptureResult {
    pub hwnd: isize,
    pub capture_method: String,
    pub capture_ms: u64,
    pub orig_width: u32,
    pub orig_height: u32,
    pub width: u32,
    pub height: u32,
    pub scale_x: f64,
    pub scale_y: f64,
    pub mime_type: String,
    #[serde(skip_serializing)]
    pub base64_data: String,
    pub saved_path: Option<String>,
}

pub fn capture_window(
    hwnd_val: isize,
    max_width: u32,
    format: &str,
    quality: u8,
    save_path: Option<&str>,
) -> Result<CaptureResult, String> {
    let start = Instant::now();
    let hwnd = hwnd_from_isize(hwnd_val)?;

    unsafe {
        if IsIconic(hwnd).as_bool() {
            return Err(
                "Target window is minimized to taskbar (Windows DWM suspends rendering for minimized windows). Restore it behind other windows (un-minimized at bottom of Z-order) to capture in the background."
                    .to_string(),
            );
        }
    }

    // Try WGC first (fast GPU composition, works on occluded Chrome/Electron/DirectX/WPF)
    let (img, method) = match capture_wgc(hwnd) {
        Ok(image) => (image, "wgc".to_string()),
        Err(_wgc_err) => {
            // Seamless fallback to PrintWindow(PW_RENDERFULLCONTENT)
            let image = capture_print_window(hwnd)?;
            (image, "print_window".to_string())
        }
    };

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
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, quality.clamp(30, 98));
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

    Ok(CaptureResult {
        hwnd: hwnd_val,
        capture_method: method,
        capture_ms,
        orig_width,
        orig_height,
        width,
        height,
        scale_x,
        scale_y,
        mime_type,
        base64_data,
        saved_path,
    })
}

fn capture_wgc(hwnd: HWND) -> Result<RgbaImage, String> {
    unsafe {
        // 1. Create D3D11 device
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

        // 2. Create GraphicsCaptureItem for HWND
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(|e| format!("IGraphicsCaptureItemInterop factory failed: {}", e))?;
        let item: GraphicsCaptureItem = interop
            .CreateForWindow(hwnd)
            .map_err(|e| format!("CreateForWindow failed: {}", e))?;

        let size = item
            .Size()
            .map_err(|e| format!("item.Size() failed: {}", e))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("Window capture size is zero".into());
        }

        // 3. Create free-threaded frame pool & session
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

        // Best-effort: hide yellow capture border (Win11+) & disable user physical cursor in capture
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

        struct WgcCleanupGuard {
            frame_pool: Direct3D11CaptureFramePool,
            session: windows::Graphics::Capture::GraphicsCaptureSession,
            token: windows::Foundation::EventRegistrationToken,
        }
        impl Drop for WgcCleanupGuard {
            fn drop(&mut self) {
                let _ = self.frame_pool.RemoveFrameArrived(self.token);
                let _ = self.session.Close();
                let _ = self.frame_pool.Close();
            }
        }
        let _guard = WgcCleanupGuard {
            frame_pool: frame_pool.clone(),
            session: session.clone(),
            token,
        };

        session
            .StartCapture()
            .map_err(|e| format!("StartCapture failed: {}", e))?;

        // Wait up to 400ms for the first frame
        {
            let (lock, cvar) = &*signal;
            let guard = lock
                .lock()
                .map_err(|_| "WGC signal mutex poisoned".to_string())?;
            let (guard, _) = cvar
                .wait_timeout_while(guard, Duration::from_millis(400), |ready| !*ready)
                .map_err(|_| "WGC condvar wait failed".to_string())?;
            if !*guard {
                return Err("WGC frame timeout".into());
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
            return Err(format!("Invalid WGC frame layout: {}x{}, pitch={}", w, h, pitch));
        }
        let mut rgba = vec![0u8; w * h * 4];
        let src_base = mapped.pData as *const u8;

        for y in 0..h {
            let src_row = std::slice::from_raw_parts(src_base.add(y * pitch), w * 4);
            let dst_row = &mut rgba[y * w * 4..(y + 1) * w * 4];
            for x in 0..w {
                let i = x * 4;
                dst_row[i] = src_row[i + 2];     // R
                dst_row[i + 1] = src_row[i + 1]; // G
                dst_row[i + 2] = src_row[i];     // B
                dst_row[i + 3] = 255;            // A
            }
        }

        d3d_context.Unmap(&staging_tex, 0);
        let _ = frame.Close();

        RgbaImage::from_raw(desc.Width, desc.Height, rgba)
            .ok_or_else(|| "Failed to build RgbaImage from WGC buffer".to_string())
    }
}

fn capture_print_window(hwnd: HWND) -> Result<RgbaImage, String> {
    unsafe {
        let raw_rect = get_raw_window_rect(hwnd);
        let ext_rect = get_window_rect(hwnd);
        if raw_rect.width <= 0 || raw_rect.height <= 0 {
            return Err("Window has zero dimensions".into());
        }
        let raw_w = raw_rect.width;
        let raw_h = raw_rect.height;

        let mem_dc = CreateCompatibleDC(None);
        if mem_dc.is_invalid() {
            return Err("CreateCompatibleDC failed".into());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: raw_w,
                biHeight: -raw_h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbitmap = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits_ptr, None, 0)
            .map_err(|e| {
                let _ = DeleteDC(mem_dc);
                format!("CreateDIBSection failed: {}", e)
            })?;

        let old_bmp = SelectObject(mem_dc, hbitmap);
        let ok = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));
        if !ok.as_bool() {
            let _ = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(0));
        }

        // Crop from GetWindowRect buffer to DWMWA_EXTENDED_FRAME_BOUNDS so coordinates match WGC & get_window_rect
        let crop_x = (ext_rect.x - raw_rect.x).clamp(0, (raw_w - 1).max(0));
        let crop_y = (ext_rect.y - raw_rect.y).clamp(0, (raw_h - 1).max(0));
        let out_w = if ext_rect.width > 0 {
            ext_rect.width.min(raw_w - crop_x).max(1)
        } else {
            raw_w
        };
        let out_h = if ext_rect.height > 0 {
            ext_rect.height.min(raw_h - crop_y).max(1)
        } else {
            raw_h
        };

        let mut rgba = vec![0u8; (out_w * out_h * 4) as usize];
        if !bits_ptr.is_null() {
            let src = std::slice::from_raw_parts(bits_ptr as *const u8, (raw_w * raw_h * 4) as usize);
            let raw_stride = (raw_w * 4) as usize;
            let out_stride = (out_w * 4) as usize;
            for y in 0..(out_h as usize) {
                let src_row_off = (crop_y as usize + y) * raw_stride + (crop_x as usize) * 4;
                let dst_row_off = y * out_stride;
                for x in 0..(out_w as usize) {
                    let si = src_row_off + x * 4;
                    let di = dst_row_off + x * 4;
                    rgba[di] = src[si + 2];
                    rgba[di + 1] = src[si + 1];
                    rgba[di + 2] = src[si];
                    rgba[di + 3] = 255;
                }
            }
        }

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(hbitmap);
        let _ = DeleteDC(mem_dc);

        RgbaImage::from_raw(out_w as u32, out_h as u32, rgba)
            .ok_or_else(|| "Failed to build RgbaImage from PrintWindow buffer".to_string())
    }
}
