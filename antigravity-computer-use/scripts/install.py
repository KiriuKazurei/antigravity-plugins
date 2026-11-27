"""
Install / sync antigravity-computer-use plugin into ~/.gemini/config/plugins/antigravity-computer-use
and resolve the native Rust MCP binary path in mcp_config.json.
"""

import json
import os
import shutil
import sys

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_NAME = "antigravity-computer-use"
DST_DIR = os.path.join(os.path.expanduser("~"), ".gemini", "config", "plugins", PLUGIN_NAME)

SYNC_ITEMS = [
    "plugin.json",
    "README.md",
    "assets",
    "bin",
    "rules",
    "skills",
]


def copy_file_safe(src, dst):
    try:
        shutil.copy2(src, dst)
    except PermissionError:
        if os.path.exists(dst):
            backup = dst + ".old"
            try:
                if os.path.exists(backup):
                    os.remove(backup)
            except OSError:
                import time
                backup = f"{dst}.{int(time.time())}.old"
            os.replace(dst, backup)
            shutil.copy2(src, dst)
        else:
            raise


def main():
    exe_src = os.path.join(PLUGIN_DIR, "bin", "antigravity-computer-use-mcp.exe")
    if not os.path.isfile(exe_src):
        print(f"[ERROR] Missing binary: {exe_src}. Run `cargo build --release` in native/ first.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(DST_DIR, exist_ok=True)
    for item in SYNC_ITEMS:
        src = os.path.join(PLUGIN_DIR, item)
        dst = os.path.join(DST_DIR, item)
        if not os.path.exists(src):
            continue
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True, copy_function=copy_file_safe)
        else:
            copy_file_safe(src, dst)

    exe_dst = os.path.join(DST_DIR, "bin", "antigravity-computer-use-mcp.exe")

    # Remove plugin-scoped mcp_config.json to avoid duplicate MCP processes and
    # ensure all 15 tools remain individually toggleable in global MCP Servers UI.
    plugin_mcp_cfg = os.path.join(DST_DIR, "mcp_config.json")
    if os.path.exists(plugin_mcp_cfg):
        os.remove(plugin_mcp_cfg)

    global_mcp_path = os.path.join(os.path.expanduser("~"), ".gemini", "config", "mcp_config.json")
    os.makedirs(os.path.dirname(global_mcp_path), exist_ok=True)
    global_cfg = {"mcpServers": {}}
    if os.path.isfile(global_mcp_path):
        with open(global_mcp_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                global_cfg = loaded
    if not isinstance(global_cfg.get("mcpServers"), dict):
        global_cfg["mcpServers"] = {}
    global_cfg["mcpServers"]["antigravity-computer-use"] = {
        "command": exe_dst,
        "args": [],
    }
    with open(global_mcp_path, "w", encoding="utf-8") as f:
        json.dump(global_cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[OK] Installed {PLUGIN_NAME} -> {DST_DIR}")
    print(f"[OK] Registered global MCP server in: {global_mcp_path}")
    print(f"[OK] MCP binary: {exe_dst}")


if __name__ == "__main__":
    main()
