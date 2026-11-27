"""
End-to-end verification script for antigravity-computer-use-mcp.exe:
- MCP initialize & tools/list handshake
- cu_list_windows discovery
- Background/occluded window screenshot via WGC/PrintWindow without stealing focus
- Background UIA tree inspection (AutoSetFocus=false)
- Independent virtual cursor state check
"""

import base64
import ctypes
import json
import os
import subprocess
import sys

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE_PATH = os.path.join(PLUGIN_DIR, "bin", "antigravity-computer-use-mcp.exe")


def get_fg_hwnd():
    return ctypes.windll.user32.GetForegroundWindow()


def rpc(proc, req_id, method, params=None):
    payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    resp_line = proc.stdout.readline()
    if not resp_line:
        raise RuntimeError(f"EOF waiting for response to {method}")
    return json.loads(resp_line)


def main():
    if not os.path.isfile(EXE_PATH):
        print(f"[FAIL] Binary not found: {EXE_PATH}", file=sys.stderr)
        sys.exit(1)

    fg_before = get_fg_hwnd()
    proc = subprocess.Popen(
        [EXE_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )

    try:
        # 1. Initialize
        init_res = rpc(proc, 1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}})
        server_name = init_res["result"]["serverInfo"]["name"]
        assert server_name == "antigravity-computer-use", f"Unexpected server name: {server_name}"
        print(f"[PASS] initialize -> {server_name}")

        # 2. tools/list
        tools_res = rpc(proc, 2, "tools/list")
        tools = [t["name"] for t in tools_res["result"]["tools"]]
        assert len(tools) == 15, f"Expected 15 tools, got {len(tools)}: {tools}"
        print(f"[PASS] tools/list -> {len(tools)} tools: {', '.join(tools)}")

        # 3. cu_list_windows
        win_res = rpc(proc, 3, "tools/call", {"name": "cu_list_windows", "arguments": {}})
        win_data = json.loads(win_res["result"]["content"][0]["text"])
        windows = win_data["windows"]
        print(f"[PASS] cu_list_windows -> {len(windows)} visible windows")

        # 4. Pick a background (non-foreground) window if available, else first window
        bg_wins = [w for w in windows if not w["is_foreground"] and not w["is_minimized"] and w["rect"]["width"] >= 200]
        target = bg_wins[0] if bg_wins else (windows[0] if windows else None)
        if target:
            hwnd = target["hwnd"]
            print(f"[INFO] Testing background window: hwnd={hwnd} z_order={target['z_order']} title={target['title']!r}")

            # 4a. Screenshot
            shot_res = rpc(proc, 4, "tools/call", {"name": "cu_screenshot", "arguments": {"hwnd": hwnd, "max_width": 800, "format": "jpeg"}})
            assert not shot_res["result"].get("isError"), f"Screenshot failed: {shot_res}"
            meta = json.loads(shot_res["result"]["content"][0]["text"])
            img_block = shot_res["result"]["content"][1]
            raw_bytes = base64.b64decode(img_block["data"])
            assert len(raw_bytes) > 500, f"Screenshot too small: {len(raw_bytes)} bytes"
            print(f"[PASS] cu_screenshot -> method={meta['capture_method']} {meta['width']}x{meta['height']} in {meta['capture_ms']}ms ({len(raw_bytes)} bytes)")

            # 4b. UIA tree
            uia_res = rpc(proc, 5, "tools/call", {"name": "cu_ui_tree", "arguments": {"hwnd": hwnd, "max_depth": 3, "max_elements": 20}})
            assert not uia_res["result"].get("isError"), f"UIA tree failed: {uia_res}"
            uia_data = json.loads(uia_res["result"]["content"][0]["text"])
            print(f"[PASS] cu_ui_tree -> {uia_data['count']} elements inspected in background")

            # 4c. Background move (independent virtual cursor)
            move_res = rpc(proc, 6, "tools/call", {"name": "cu_move", "arguments": {"hwnd": hwnd, "x": 40, "y": 40}})
            assert not move_res["result"].get("isError"), f"Move failed: {move_res}"
            print("[PASS] cu_move -> independent virtual cursor updated")

        # 5. Cursor config
        cur_res = rpc(proc, 7, "tools/call", {"name": "cu_cursor_config", "arguments": {}})
        cur_data = json.loads(cur_res["result"]["content"][0]["text"])
        print(f"[PASS] cu_cursor_config -> {cur_data}")

        # 6. Verify foreground window did NOT change!
        fg_after = get_fg_hwnd()
        assert fg_before == fg_after, f"Focus stolen! before={fg_before}, after={fg_after}"
        print(f"[PASS] Focus integrity preserved (foreground HWND unchanged: {fg_after})")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
