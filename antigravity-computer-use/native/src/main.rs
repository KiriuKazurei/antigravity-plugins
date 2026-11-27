mod capture;
mod cursor;
mod full_control;
mod input;
mod mcp;
mod uia;
mod window;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

fn main() {
    // Enable Per-Monitor DPI Awareness v2 so all coordinates and captures are exact physical pixels.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // Check for self-test CLI flag for automated verification without MCP client
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "--self-test" {
        run_self_test();
        return;
    }

    // Start the independent transparent click-through virtual cursor overlay thread
    let cursor = cursor::VirtualCursor::start();
    // Start the full-screen control overlay & emergency stop button manager
    let full_control = full_control::FullControlManager::start();

    // Run MCP stdio server loop
    mcp::run_stdio_server(cursor, full_control);
}

fn run_self_test() {
    let cursor = cursor::VirtualCursor::start();
    let windows = window::list_windows(None, false, false);
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "status": "ok",
            "window_count": windows.len(),
            "cursor_state": cursor.state(),
            "sample_windows": windows.iter().take(5).collect::<Vec<_>>(),
        }))
        .unwrap_or_default()
    );
}
