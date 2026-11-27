"""
同步并安装 antigravity-context-menu 插件至 ~/.gemini/config/plugins/，
并调用自包含的 plugin_host.py 完成 Antigravity 宿主加载器接入、状态检查或还原。
"""

import os
import shutil
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
PLUGINS_ROOT = os.path.join(os.path.expanduser("~"), ".gemini", "config", "plugins")
PLUGIN_NAME = "antigravity-context-menu"


def sync_context_menu_plugin():
    dst_dir = os.path.join(PLUGINS_ROOT, PLUGIN_NAME)
    if os.path.abspath(PLUGIN_DIR) == os.path.abspath(dst_dir):
        return dst_dir
    os.makedirs(dst_dir, exist_ok=True)
    preserve = {"loader.log", "heal.log", "heal_state.json", "context-menu-config.json"}
    for root, dirs, files in os.walk(PLUGIN_DIR):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        rel_root = os.path.relpath(root, PLUGIN_DIR)
        dst_root = dst_dir if rel_root == "." else os.path.join(dst_dir, rel_root)
        os.makedirs(dst_root, exist_ok=True)
        for fn in files:
            if fn.endswith((".pyc", ".tmp")):
                continue
            if rel_root == "runtime" and fn in preserve and os.path.exists(os.path.join(dst_root, fn)):
                continue
            shutil.copy2(os.path.join(root, fn), os.path.join(dst_root, fn))
    print(f"已同步右键菜单增强框架插件至: {dst_dir}")
    return dst_dir


def load_plugin_host():
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    import plugin_host  # noqa: E402

    return plugin_host


def main():
    args = sys.argv[1:]
    explicit = None
    if "--resources-dir" in args:
        idx = args.index("--resources-dir")
        if idx + 1 < len(args):
            explicit = args[idx + 1]
            args = args[:idx] + args[idx + 2 :]
    cmd = args[0] if args else "install"

    if cmd == "sync":
        sync_context_menu_plugin()
        return

    plugin_host = load_plugin_host()
    if cmd == "status":
        plugin_host.cmd_status(explicit)
    elif cmd == "stage":
        sync_context_menu_plugin()
        plugin_host.cmd_install(stage_only=True, explicit_dir=explicit, do_sync=False)
    elif cmd == "install":
        sync_context_menu_plugin()
        plugin_host.cmd_install(stage_only=False, explicit_dir=explicit, do_sync=False)
    elif cmd == "restore":
        plugin_host.cmd_restore(explicit)
    else:
        print(f"未知参数: {cmd} (支持: sync, stage, install, status, restore)")
        sys.exit(1)


if __name__ == "__main__":
    main()
