"""
同步并安装 antigravity-kb 原生 MCP App 插件至 ~/.gemini/config/plugins/。
纯官方 MCP Apps 协议，无需修改 Antigravity app.asar 宿主文件。
"""

import os
import shutil
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
PLUGINS_ROOT = os.path.join(os.path.expanduser("~"), ".gemini", "config", "plugins")
PLUGIN_NAME = "antigravity-kb"

LEGACY_FILES = [
    "hooks.json",
    os.path.join("scripts", "plugin_host.py"),
    os.path.join("scripts", "pluginLoader.js"),
    os.path.join("scripts", "session_hook.py"),
]


def sync_kb_plugin():
    app_html = os.path.join(PLUGIN_DIR, "app", "dist", "app.html")
    if not os.path.isfile(app_html):
        raise FileNotFoundError(f"缺少 MCP App 产物 {app_html}，请先执行 node tools/mcp-app-build/build.mjs")
    dst_dir = os.path.join(PLUGINS_ROOT, PLUGIN_NAME)
    if os.path.abspath(PLUGIN_DIR) == os.path.abspath(dst_dir):
        return dst_dir
    os.makedirs(dst_dir, exist_ok=True)
    preserve = {"loader.log", "heal.log", "heal_state.json", "kb-config.json"}
    for root, dirs, files in os.walk(PLUGIN_DIR):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git", "node_modules")]
        rel_root = os.path.relpath(root, PLUGIN_DIR)
        dst_root = dst_dir if rel_root == "." else os.path.join(dst_dir, rel_root)
        os.makedirs(dst_root, exist_ok=True)
        for fn in files:
            if fn.endswith((".pyc", ".tmp")):
                continue
            if rel_root == "runtime" and fn in preserve and os.path.exists(os.path.join(dst_root, fn)):
                continue
            shutil.copy2(os.path.join(root, fn), os.path.join(dst_root, fn))
    for rel in LEGACY_FILES:
        stale = os.path.join(dst_dir, rel)
        if os.path.isfile(stale):
            try:
                os.remove(stale)
            except OSError:
                pass
    print(f"已同步原生 MCP App 知识库插件至: {dst_dir}")
    return dst_dir


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "install"
    if cmd in ("sync", "install", "stage"):
        sync_kb_plugin()
    elif cmd == "status":
        dst_dir = os.path.join(PLUGINS_ROOT, PLUGIN_NAME)
        has_html = os.path.isfile(os.path.join(dst_dir, "app", "dist", "app.html"))
        has_mcp = os.path.isfile(os.path.join(dst_dir, "mcp_config.json"))
        print(f"antigravity-kb (native MCP App): installed={os.path.isdir(dst_dir)}, mcp={has_mcp}, html={has_html}")
    else:
        print(f"未知参数: {cmd} (支持: sync, install, status)")
        sys.exit(1)


if __name__ == "__main__":
    main()
