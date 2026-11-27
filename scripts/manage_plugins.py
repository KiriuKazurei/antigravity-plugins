"""
Antigravity 工作区插件总控管理脚本
一键发现、检查、测试、同步与安装工作区下的全部 Antigravity 插件：
- status  : 检查宿主 app.asar 状态、pluginLoader.js 一致性及各插件同步/启用状态
- sync    : 一键同步全部插件到 ~/.gemini/config/plugins/（保留用户运行时数据与配置）
- install : 先同步全部插件，再按需一次性接入/更新 app.asar 宿主加载器
- stage   : 先同步全部插件，再预构建 app.asar.staged
- test    : 一键执行全部插件的 Python 语法检查、pluginLoader.js 一致性校验与 Node.js 单元测试
- restore : 还原官方原版 app.asar

用法示例:
  python scripts/manage_plugins.py status
  python scripts/manage_plugins.py sync
  python scripts/manage_plugins.py install
  python scripts/manage_plugins.py test
  python scripts/manage_plugins.py sync --only antigravity-notifier,antigravity-snippets
"""

import hashlib
import importlib.util
import json
import os
import py_compile
import shutil
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.dirname(SCRIPT_DIR)
PLUGINS_ROOT = os.path.join(os.path.expanduser("~"), ".gemini", "config", "plugins")
CONFIG_JSON_PATH = os.path.join(os.path.expanduser("~"), ".gemini", "config", "config.json")

PRESERVE_RUNTIME_FILES = {
    "loader.log",
    "heal.log",
    "heal_state.json",
    "usage-history.json",
    "snippets.json",
    "notifier-config.json",
    "context-doctor-config.json",
    "context-menu-config.json",
    "kb-config.json",
    "notify.log",
}

SKIP_DIRS = {"__pycache__", ".git", "node_modules"}


def read_json_safe(path):
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def discover_plugins(only_names=None):
    plugins = []
    if not os.path.isdir(WORKSPACE_DIR):
        return plugins
    for entry in sorted(os.listdir(WORKSPACE_DIR)):
        pdir = os.path.join(WORKSPACE_DIR, entry)
        if not os.path.isdir(pdir):
            continue
        manifest_path = os.path.join(pdir, "plugin.json")
        host_path = os.path.join(pdir, "scripts", "plugin_host.py")
        if not (os.path.exists(manifest_path) and os.path.exists(host_path)):
            continue
        manifest = read_json_safe(manifest_path) or {}
        name = str(manifest.get("name") or entry).strip()
        if only_names and name not in only_names and entry not in only_names:
            continue
        plugins.append(
            {
                "dir_name": entry,
                "name": name,
                "display_name": str(manifest.get("displayName") or name),
                "version": str(manifest.get("version") or "0.0.0"),
                "disabled_by_default": manifest.get("disabled") is True,
                "path": pdir,
                "host_path": host_path,
                "loader_path": os.path.join(pdir, "scripts", "pluginLoader.js"),
            }
        )
    return plugins


def load_host_module(host_path):
    spec = importlib.util.spec_from_file_location("_agy_shared_plugin_host", host_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check_loader_consistency(plugins):
    hashes = {}
    for p in plugins:
        lp = p["loader_path"]
        hashes[p["name"]] = file_sha256(lp) if os.path.exists(lp) else None
    valid = {h for h in hashes.values() if h}
    consistent = len(valid) <= 1 and all(v is not None for v in hashes.values())
    return consistent, hashes


def is_plugin_enabled_in_config(plugin):
    cfg = read_json_safe(CONFIG_JSON_PATH)
    if isinstance(cfg, dict):
        plugins_cfg = cfg.get("plugins")
        if isinstance(plugins_cfg, dict):
            entry = plugins_cfg.get(plugin["name"]) or plugins_cfg.get(plugin["dir_name"])
            if isinstance(entry, dict) and isinstance(entry.get("enabled"), bool):
                return entry["enabled"]
    return not plugin["disabled_by_default"]


def iter_syncable_files(plugin_dir):
    for root, dirs, files in os.walk(plugin_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel_root = os.path.relpath(root, plugin_dir)
        for fn in sorted(files):
            if fn.endswith((".pyc", ".tmp")):
                continue
            rel_path = fn if rel_root == "." else os.path.join(rel_root, fn)
            yield os.path.join(root, fn), rel_root, fn, rel_path


def count_unsynced_files(plugin):
    dst_dir = os.path.join(PLUGINS_ROOT, plugin["name"])
    if not os.path.isdir(dst_dir):
        return None  # 未安装到用户插件目录
    diff_count = 0
    for src_file, rel_root, fn, rel_path in iter_syncable_files(plugin["path"]):
        dst_file = os.path.join(dst_dir, rel_path)
        if rel_root == "runtime" and fn in PRESERVE_RUNTIME_FILES and os.path.exists(dst_file):
            continue
        if not os.path.exists(dst_file):
            diff_count += 1
        elif file_sha256(src_file) != file_sha256(dst_file):
            diff_count += 1
    return diff_count


def sync_single_plugin(plugin):
    dst_dir = os.path.join(PLUGINS_ROOT, plugin["name"])
    if os.path.abspath(plugin["path"]) == os.path.abspath(dst_dir):
        return 0
    os.makedirs(dst_dir, exist_ok=True)
    copied = 0
    for src_file, rel_root, fn, rel_path in iter_syncable_files(plugin["path"]):
        dst_file = os.path.join(dst_dir, rel_path)
        os.makedirs(os.path.dirname(dst_file), exist_ok=True)
        if rel_root == "runtime" and fn in PRESERVE_RUNTIME_FILES and os.path.exists(dst_file):
            continue
        if not os.path.exists(dst_file) or file_sha256(src_file) != file_sha256(dst_file):
            shutil.copy2(src_file, dst_file)
            copied += 1
    return copied


def cmd_status(plugins, explicit_res=None):
    if not plugins:
        print("未在工作区发现任何插件。")
        return 1

    consistent, loader_hashes = check_loader_consistency(plugins)
    host_mod = load_host_module(plugins[0]["host_path"])
    res_dir, asar_path, bak_path, staged_path, _ = host_mod.get_paths(explicit_res)

    print("=== Antigravity 工作区插件总览 ===")
    print(f"- 工作区根目录: {WORKSPACE_DIR}")
    print(f"- 用户插件目录: {PLUGINS_ROOT}")
    print(f"- 探测到安装目录: {res_dir or '未找到'}")
    if res_dir:
        has_loader = host_mod.has_plugin_loader(asar_path)
        is_latest = host_mod.has_current_plugin_loader(asar_path)
        print(
            f"- app.asar: v{host_mod.get_asar_version(asar_path)} | "
            f"已接入宿主={has_loader} | 宿主最新={is_latest} | "
            f"staged={os.path.exists(staged_path)}"
        )
    print(f"- pluginLoader.js 多插件一致: {consistent}")
    if not consistent:
        for name, h in loader_hashes.items():
            print(f"    * {name}: {h[:12] if h else '缺失'}")

    print("\n--- 插件清单与同步状态 ---")
    for p in plugins:
        enabled = is_plugin_enabled_in_config(p)
        diff = count_unsynced_files(p)
        sync_label = (
            "未同步"
            if diff is None
            else ("已同步 (最新)" if diff == 0 else f"有 {diff} 个文件待同步")
        )
        print(
            f"- {p['name']} (v{p['version']}) | 启用={enabled} | {sync_label}"
        )
    return 0


def cmd_sync(plugins):
    if not plugins:
        print("未找到可同步的插件。")
        return 1
    total_copied = 0
    for p in plugins:
        copied = sync_single_plugin(p)
        total_copied += copied
        dst_dir = os.path.join(PLUGINS_ROOT, p["name"])
        print(f"[sync] {p['name']} (v{p['version']}): 更新 {copied} 个文件 -> {dst_dir}")
    print(f"\n全部 {len(plugins)} 个插件同步完成（共更新 {total_copied} 个文件）。")
    return 0


def cmd_install(plugins, stage_only=False, explicit_res=None):
    if not plugins:
        print("未找到可安装的插件。")
        return 1

    consistent, _ = check_loader_consistency(plugins)
    if not consistent:
        print("警告: 检测到部分插件的 scripts/pluginLoader.js 哈希不一致，请先统一后再安装宿主！")
        return 1

    cmd_sync(plugins)

    host_mod = load_host_module(plugins[0]["host_path"])
    res_dir, asar_path, _, _, _ = host_mod.get_paths(explicit_res)
    if not res_dir:
        print("错误: 未找到 Antigravity 安装目录（可用 --resources-dir 指定）。")
        return 1

    if not stage_only and host_mod.has_plugin_loader(asar_path) and host_mod.has_current_plugin_loader(asar_path):
        print("\n宿主 app.asar 已接入最新通用加载器，无需重新打包；在 Antigravity 窗口内按 Ctrl+R 即可热生效！")
        return 0

    print("\n开始接入/更新 Antigravity 宿主加载器...")
    host_mod.cmd_install(stage_only=stage_only, explicit_dir=explicit_res, do_sync=False)
    return 0


def cmd_test(plugins):
    if not plugins:
        print("未找到可测试的插件。")
        return 1

    print("=== 1. 校验 pluginLoader.js 多插件一致性 ===")
    consistent, hashes = check_loader_consistency(plugins)
    for name, h in hashes.items():
        print(f"- {name}: {h[:16] if h else 'MISSING'}")
    if not consistent:
        print("失败: pluginLoader.js 在多个插件间不一致！")
        return 1

    print("\n=== 2. Python 脚本语法检查 (py_compile) ===")
    py_files = [os.path.abspath(__file__)]
    for p in plugins:
        sdir = os.path.join(p["path"], "scripts")
        if os.path.isdir(sdir):
            for fn in sorted(os.listdir(sdir)):
                if fn.endswith(".py"):
                    py_files.append(os.path.join(sdir, fn))
    for pf in py_files:
        try:
            py_compile.compile(pf, doraise=True)
            print(f"- OK: {os.path.relpath(pf, WORKSPACE_DIR)}")
        except Exception as exc:
            print(f"- FAIL: {pf}: {exc}")
            return 1

    print("\n=== 3. 运行各插件 Node.js 单元测试 ===")
    failed = 0
    ran = 0
    for p in plugins:
        rdir = os.path.join(p["path"], "runtime")
        if not os.path.isdir(rdir):
            continue
        tests = sorted(
            fn for fn in os.listdir(rdir) if fn.startswith("test_") and fn.endswith(".js")
        )
        for t in tests:
            ran += 1
            tpath = os.path.join(rdir, t)
            print(f"\n>>> 运行 {p['name']}/{t}")
            proc = subprocess.run(["node", tpath], cwd=p["path"], check=False)
            if proc.returncode != 0:
                failed += 1
                print(f"!!! 失败: {p['name']}/{t} (exit={proc.returncode})")

    print(f"\n=== 测试汇总: 共 {ran} 项，失败 {failed} 项 ===")
    return 0 if failed == 0 else 1


def cmd_restore(plugins, explicit_res=None):
    if not plugins:
        print("未找到插件脚本。")
        return 1
    host_mod = load_host_module(plugins[0]["host_path"])
    host_mod.cmd_restore(explicit_res)
    return 0


def parse_args(argv):
    explicit_res = None
    only_names = None
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--resources-dir" and i + 1 < len(argv):
            explicit_res = argv[i + 1]
            i += 2
        elif a == "--only" and i + 1 < len(argv):
            only_names = {x.strip() for x in argv[i + 1].split(",") if x.strip()}
            i += 2
        elif a in ("-h", "--help"):
            print(__doc__.strip())
            sys.exit(0)
        else:
            pos.append(a)
            i += 1
    cmd = pos[0] if pos else "status"
    return cmd, explicit_res, only_names


def main():
    cmd, explicit_res, only_names = parse_args(sys.argv[1:])
    plugins = discover_plugins(only_names)

    if cmd == "status":
        sys.exit(cmd_status(plugins, explicit_res))
    elif cmd == "sync":
        sys.exit(cmd_sync(plugins))
    elif cmd == "install":
        sys.exit(cmd_install(plugins, stage_only=False, explicit_res=explicit_res))
    elif cmd == "stage":
        sys.exit(cmd_install(plugins, stage_only=True, explicit_res=explicit_res))
    elif cmd == "test":
        sys.exit(cmd_test(plugins))
    elif cmd == "restore":
        sys.exit(cmd_restore(plugins, explicit_res))
    else:
        print(f"未知命令: {cmd} (支持: status, sync, install, stage, test, restore)")
        sys.exit(1)


if __name__ == "__main__":
    main()
