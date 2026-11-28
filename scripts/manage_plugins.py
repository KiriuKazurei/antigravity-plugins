"""
Antigravity 工作区统一插件基座与总控管理脚本
基于 plugins.registry.json（唯一注册真相源）与 core/（唯一宿主基座源码）协同管理全部插件：
- check   : 静态 + 进程内 MCP Apps 门禁校验（64 字符工具名上限、serverKey/URI/入口去重、core 一致性、纯 MCP App 零补丁约束）
- build   : 打包全部 MCP App 单文件 HTML，并将 core/plugin_host.py + core/pluginLoader.js 内联同步至需要 DOM 注入的插件
- test    : 依次执行 check、Python 语法检查、全部 MCP App Python 单元测试、DOM 插件 Node.js 单元测试与宿主共存测试
- status  : 查看注册表分类、入口分布、core 一致性、app.asar 状态及各插件同步状态
- sync    : 先通过 check 门禁，再同步插件至 ~/.gemini/config/plugins/（保留用户运行数据，自动清理纯 MCP App 的旧版宿主残留文件）
- install : build -> check -> sync；仅当所选插件包含 needsHostLoader=true 时才接入/更新 app.asar，纯 MCP App 零补丁
- stage   : 同 install，但预构建 app.asar.staged
- restore : 通过 core/plugin_host.py 还原官方原版 app.asar

用法示例:
  python scripts/manage_plugins.py check
  python scripts/manage_plugins.py build
  python scripts/manage_plugins.py test
  python scripts/manage_plugins.py sync
  python scripts/manage_plugins.py install --only antigravity-kb,antigravity-context-doctor
"""

import hashlib
import importlib.util
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.dirname(SCRIPT_DIR)
CORE_DIR = os.path.join(WORKSPACE_DIR, "core")
REGISTRY_PATH = os.path.join(WORKSPACE_DIR, "plugins.registry.json")
MCP_BUILD_SCRIPT = os.path.join(WORKSPACE_DIR, "tools", "mcp-app-build", "build.mjs")
PLUGINS_ROOT = os.path.join(os.path.expanduser("~"), ".gemini", "config", "plugins")
CONFIG_JSON_PATH = os.path.join(os.path.expanduser("~"), ".gemini", "config", "config.json")

TOOL_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
MAX_HTML_BYTES = 10 * 1024 * 1024

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

LEGACY_HOST_FILES = [
    "hooks.json",
    os.path.join("scripts", "plugin_host.py"),
    os.path.join("scripts", "pluginLoader.js"),
    os.path.join("scripts", "session_hook.py"),
]

SKIP_DIRS = {"__pycache__", ".git", "node_modules", "target"}

ENTRYPOINT_TYPE_MAP = {
    "aux_pane": "aux_pane",
    "global": "global",
}


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


def load_registry():
    reg = read_json_safe(REGISTRY_PATH)
    if not isinstance(reg, dict) or not isinstance(reg.get("plugins"), list):
        raise RuntimeError(f"无法读取有效注册表: {REGISTRY_PATH}")
    return reg


def discover_plugins(only_names=None, include_optional_local=True):
    reg = load_registry()
    plugins = []
    seen_dirs = set()

    for spec in reg["plugins"]:
        dname = str(spec.get("dir") or "").strip()
        if not dname:
            continue
        seen_dirs.add(dname)
        pdir = os.path.join(WORKSPACE_DIR, dname)
        manifest = read_json_safe(os.path.join(pdir, "plugin.json")) or {}
        name = str(manifest.get("name") or dname).strip()
        if only_names and name not in only_names and dname not in only_names:
            continue
        plugins.append(
            {
                "dir_name": dname,
                "name": name,
                "display_name": str(manifest.get("displayName") or name),
                "version": str(manifest.get("version") or "0.0.0"),
                "kind": str(spec.get("kind") or "dom-only"),
                "needs_host_loader": bool(spec.get("needsHostLoader", False)),
                "mcp": spec.get("mcp"),
                "ui_scripts": manifest.get("uiScripts") if isinstance(manifest.get("uiScripts"), list) else [],
                "disabled_by_default": manifest.get("disabled") is True,
                "path": pdir,
                "manifest": manifest,
                "host_path": os.path.join(pdir, "scripts", "plugin_host.py"),
                "loader_path": os.path.join(pdir, "scripts", "pluginLoader.js"),
                "optional_local": False,
            }
        )

    # 兼容本地独立仓库（如 gitignored 的 antigravity-zh-cn）
    if include_optional_local and os.path.isdir(WORKSPACE_DIR):
        for entry in sorted(os.listdir(WORKSPACE_DIR)):
            if entry in seen_dirs:
                continue
            pdir = os.path.join(WORKSPACE_DIR, entry)
            manifest_path = os.path.join(pdir, "plugin.json")
            host_path = os.path.join(pdir, "scripts", "plugin_host.py")
            if not (os.path.isdir(pdir) and os.path.exists(manifest_path) and os.path.exists(host_path)):
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
                    "kind": "dom-only",
                    "needs_host_loader": True,
                    "mcp": None,
                    "ui_scripts": manifest.get("uiScripts") if isinstance(manifest.get("uiScripts"), list) else [],
                    "disabled_by_default": manifest.get("disabled") is True,
                    "path": pdir,
                    "manifest": manifest,
                    "host_path": host_path,
                    "loader_path": os.path.join(pdir, "scripts", "pluginLoader.js"),
                    "optional_local": True,
                }
            )
    return plugins


def load_python_module(mod_name, file_path):
    spec = importlib.util.spec_from_file_location(mod_name, file_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_core_host_module():
    core_host = os.path.join(CORE_DIR, "plugin_host.py")
    if not os.path.isfile(core_host):
        raise FileNotFoundError(f"缺少统一基座文件: {core_host}")
    return load_python_module("_agy_core_plugin_host", core_host)


def check_core_consistency(plugins):
    core_host = os.path.join(CORE_DIR, "plugin_host.py")
    core_loader = os.path.join(CORE_DIR, "pluginLoader.js")
    if not (os.path.isfile(core_host) and os.path.isfile(core_loader)):
        return False, ["core/plugin_host.py 或 core/pluginLoader.js 缺失"]
    host_sha = file_sha256(core_host)
    loader_sha = file_sha256(core_loader)
    errors = []
    for p in plugins:
        if p["needs_host_loader"]:
            if not os.path.isfile(p["host_path"]) or file_sha256(p["host_path"]) != host_sha:
                errors.append(f"{p['dir_name']}: scripts/plugin_host.py 与 core/ 不一致（请运行 build）")
            if not os.path.isfile(p["loader_path"]) or file_sha256(p["loader_path"]) != loader_sha:
                errors.append(f"{p['dir_name']}: scripts/pluginLoader.js 与 core/ 不一致（请运行 build）")
        elif p["kind"] == "mcp-app":
            if p["ui_scripts"]:
                errors.append(f"{p['dir_name']}: 纯 mcp-app 插件不应在 plugin.json 中声明 uiScripts")
            for rel in LEGACY_HOST_FILES:
                if os.path.exists(os.path.join(p["path"], rel)):
                    errors.append(f"{p['dir_name']}: 纯 mcp-app 插件存在残留宿主文件 {rel}")
    return len(errors) == 0, errors


def validate_registry_and_mcp(plugins):
    reg = load_registry()
    max_len = int(reg.get("maxMcpToolNameLength") or 64)
    errors = []

    seen_server_keys = {}
    seen_resource_uris = {}
    seen_entrypoints = {}

    for p in plugins:
        if not os.path.isdir(p["path"]):
            errors.append(f"{p['dir_name']}: 插件目录不存在")
            continue
        if not os.path.isfile(os.path.join(p["path"], "plugin.json")):
            errors.append(f"{p['dir_name']}: 缺少 plugin.json")
            continue

        mcp_spec = p.get("mcp")
        if not mcp_spec:
            continue

        skey = str(mcp_spec.get("serverKey") or "").strip()
        if not skey:
            errors.append(f"{p['dir_name']}: registry 缺少 mcp.serverKey")
            continue
        if skey.startswith("antigravity-"):
            errors.append(f"{p['dir_name']}: serverKey '{skey}' 不应包含冗余前缀 antigravity-")
        if skey in seen_server_keys:
            errors.append(f"{p['dir_name']}: serverKey '{skey}' 与 {seen_server_keys[skey]} 冲突")
        seen_server_keys[skey] = p["dir_name"]

        mcp_cfg_path = os.path.join(p["path"], "mcp_config.json")
        mcp_cfg = read_json_safe(mcp_cfg_path)
        if not isinstance(mcp_cfg, dict) or not isinstance(mcp_cfg.get("mcpServers"), dict):
            errors.append(f"{p['dir_name']}: 缺少有效 mcp_config.json")
            continue
        cfg_keys = list(mcp_cfg["mcpServers"].keys())
        if cfg_keys != [skey]:
            errors.append(f"{p['dir_name']}: mcp_config.json server keys {cfg_keys} 与 registry ['{skey}'] 不一致")
        else:
            args = mcp_cfg["mcpServers"][skey].get("args") or []
            expected_arg = f"${{PLUGIN_ROOT}}/{mcp_spec['script']}"
            if expected_arg not in args:
                errors.append(f"{p['dir_name']}: mcp_config.json args 应包含 '{expected_arg}'")

        html_path = os.path.join(p["path"], "app", "dist", "app.html")
        if not os.path.isfile(html_path):
            errors.append(f"{p['dir_name']}: 缺少构建产物 app/dist/app.html（请运行 build）")
        else:
            size = os.path.getsize(html_path)
            if size == 0 or size > MAX_HTML_BYTES:
                errors.append(f"{p['dir_name']}: app/dist/app.html 大小异常 ({size} bytes)")

        script_path = os.path.join(p["path"], mcp_spec["script"])
        if not os.path.isfile(script_path):
            errors.append(f"{p['dir_name']}: 缺少 MCP 入口脚本 {mcp_spec['script']}")
            continue

        try:
            mod = load_python_module(f"_agy_check_{p['dir_name'].replace('-', '_')}", script_path)
            init_resp = mod.handle_rpc_request(
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}
            )
            caps = (init_resp or {}).get("result", {}).get("capabilities", {})
            if "tools" not in caps or "resources" not in caps:
                errors.append(f"{p['dir_name']}: initialize capabilities 必须同时声明 tools 和 resources")

            rlist = mod.handle_rpc_request({"jsonrpc": "2.0", "id": 2, "method": "resources/list", "params": {}})
            res_items = (rlist or {}).get("result", {}).get("resources", [])
            expected_uri = mcp_spec["resourceUri"]
            if expected_uri in seen_resource_uris:
                errors.append(f"{p['dir_name']}: resourceUri '{expected_uri}' 与 {seen_resource_uris[expected_uri]} 冲突")
            seen_resource_uris[expected_uri] = p["dir_name"]

            matched_res = [r for r in res_items if r.get("uri") == expected_uri]
            if not matched_res:
                errors.append(f"{p['dir_name']}: resources/list 未声明 {expected_uri}")
            elif matched_res[0].get("mimeType") != "text/html;profile=mcp-app":
                errors.append(f"{p['dir_name']}: resource mimeType 必须为 text/html;profile=mcp-app")

            rread = mod.handle_rpc_request(
                {"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {"uri": expected_uri}}
            )
            contents = (rread or {}).get("result", {}).get("contents", [])
            if not contents or not str(contents[0].get("text") or "").strip():
                errors.append(f"{p['dir_name']}: resources/read({expected_uri}) 返回空内容")

            tlist = mod.handle_rpc_request({"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}})
            tools = (tlist or {}).get("result", {}).get("tools", [])
            tool_map = {}
            for t in tools:
                tname = str(t.get("name") or "")
                tool_map[tname] = t
                full_name = f"mcp_{p['dir_name']}_{skey}_{tname}"
                if len(full_name) > max_len or not TOOL_NAME_RE.match(full_name):
                    errors.append(
                        f"{p['dir_name']}: 工具全名 '{full_name}' 长度 {len(full_name)} 违反 ^[a-zA-Z0-9_-]{{1,{max_len}}}$"
                    )

            actual_eps = []
            for tname, t in tool_map.items():
                meta = t.get("_meta") or {}
                agy_ui = meta.get("com.google.antigravity/ui") or {}
                for ep in agy_ui.get("entrypoints") or []:
                    if not (meta.get("ui") or {}).get("resourceUri"):
                        errors.append(f"{p['dir_name']}.{tname}: 声明了 entrypoint 但缺少 _meta.ui.resourceUri")
                    ep_tuple = (tname, ep.get("type"), ep.get("title"))
                    actual_eps.append(ep_tuple)
                    uniq_key = (ep.get("type"), ep.get("title"))
                    if uniq_key in seen_entrypoints:
                        errors.append(
                            f"{p['dir_name']}: 入口 ({ep.get('type')}, '{ep.get('title')}') 与 {seen_entrypoints[uniq_key]} 重复"
                        )
                    seen_entrypoints[uniq_key] = p["dir_name"]

            expected_eps = [(e["tool"], e["type"], e["title"]) for e in (mcp_spec.get("entrypoints") or [])]
            if sorted(actual_eps) != sorted(expected_eps):
                errors.append(f"{p['dir_name']}: 实际 entrypoints {actual_eps} 与 registry {expected_eps} 不一致")
        except Exception as exc:
            errors.append(f"{p['dir_name']}: MCP 校验异常: {exc}")

    core_ok, core_errs = check_core_consistency(plugins)
    if not core_ok:
        errors.extend(core_errs)
    return len(errors) == 0, errors


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
        return None
    diff_count = 0
    for src_file, rel_root, fn, rel_path in iter_syncable_files(plugin["path"]):
        dst_file = os.path.join(dst_dir, rel_path)
        if rel_root == "runtime" and fn in PRESERVE_RUNTIME_FILES and os.path.exists(dst_file):
            continue
        if not os.path.exists(dst_file) or file_sha256(src_file) != file_sha256(dst_file):
            diff_count += 1
    if plugin["kind"] == "mcp-app":
        for rel in LEGACY_HOST_FILES:
            if os.path.exists(os.path.join(dst_dir, rel)):
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
    if plugin["kind"] == "mcp-app":
        for rel in LEGACY_HOST_FILES:
            stale = os.path.join(dst_dir, rel)
            if os.path.isfile(stale):
                try:
                    os.remove(stale)
                    copied += 1
                except OSError:
                    pass
    return copied


def cmd_check(plugins):
    print("=== Antigravity 插件统一注册表与基座门禁校验 ===")
    ok, errors = validate_registry_and_mcp(plugins)
    if ok:
        print(f"PASS: 共校验 {len(plugins)} 个插件（MCP 工具名 ≤ 64、入口/URI/Key 唯一、core 基座一致、纯 MCP App 零补丁）。")
        return 0
    print(f"FAIL: 发现 {len(errors)} 项问题:")
    for err in errors:
        print(f"  - {err}")
    return 1


def cmd_build(plugins):
    print("=== 1. 构建 MCP App 单文件 HTML 产物 ===")
    if os.path.isfile(MCP_BUILD_SCRIPT):
        proc = subprocess.run(["node", MCP_BUILD_SCRIPT], cwd=WORKSPACE_DIR, check=False)
        if proc.returncode != 0:
            print(f"FAIL: MCP App 构建失败 (exit={proc.returncode})")
            return proc.returncode

    print("\n=== 2. 从 core/ 内联同步基座至 needsHostLoader 插件 ===")
    core_host = os.path.join(CORE_DIR, "plugin_host.py")
    core_loader = os.path.join(CORE_DIR, "pluginLoader.js")
    if not (os.path.isfile(core_host) and os.path.isfile(core_loader)):
        print("FAIL: 缺少 core/plugin_host.py 或 core/pluginLoader.js")
        return 1

    updated = 0
    for p in plugins:
        if not p["needs_host_loader"]:
            continue
        sdir = os.path.join(p["path"], "scripts")
        os.makedirs(sdir, exist_ok=True)
        for src, dst in ((core_host, p["host_path"]), (core_loader, p["loader_path"])):
            if not os.path.exists(dst) or file_sha256(src) != file_sha256(dst):
                shutil.copy2(src, dst)
                updated += 1
                print(f"  [core->plugin] {os.path.relpath(dst, WORKSPACE_DIR)}")
    print(f"基座内联同步完成（更新 {updated} 个文件）。")
    return 0


def cmd_status(plugins, explicit_res=None):
    if not plugins:
        print("未在工作区发现任何插件。")
        return 1

    core_ok, core_errs = check_core_consistency(plugins)
    host_mod = load_core_host_module()
    res_dir, asar_path, _, staged_path, _ = host_mod.get_paths(explicit_res)

    print("=== Antigravity 双层基座插件总览 ===")
    print(f"- 工作区根目录: {WORKSPACE_DIR}")
    print(f"- 统一基座目录: {CORE_DIR} (一致性={core_ok})")
    print(f"- 用户插件目录: {PLUGINS_ROOT}")
    print(f"- 探测到安装目录: {res_dir or '未找到'}")
    if res_dir:
        has_loader = host_mod.has_plugin_loader(asar_path)
        is_latest = host_mod.has_current_plugin_loader(asar_path)
        print(
            f"- app.asar: v{host_mod.get_asar_version(asar_path)} | "
            f"已接入宿主={has_loader} | 宿主最新={is_latest} | staged={os.path.exists(staged_path)}"
        )
    if not core_ok:
        for e in core_errs:
            print(f"    ! {e}")

    print("\n--- 插件清单、入口与同步状态 ---")
    for p in plugins:
        enabled = is_plugin_enabled_in_config(p)
        diff = count_unsynced_files(p)
        sync_label = "未同步" if diff is None else ("已同步 (最新)" if diff == 0 else f"有 {diff} 项待同步")
        mcp_info = ""
        if p.get("mcp"):
            eps = ",".join(f"{e['type']}:{e['title']}" for e in (p["mcp"].get("entrypoints") or []))
            mcp_info = f" | key={p['mcp']['serverKey']} | eps=[{eps}]"
        print(f"- {p['name']} (v{p['version']}, {p['kind']}) | 启用={enabled} | {sync_label}{mcp_info}")
    return 0


def cmd_sync(plugins):
    if not plugins:
        print("未找到可同步的插件。")
        return 1
    if cmd_check(plugins) != 0:
        print("\n已中止同步：请先修复上述 check 门禁错误。")
        return 1
    total_copied = 0
    for p in plugins:
        copied = sync_single_plugin(p)
        total_copied += copied
        dst_dir = os.path.join(PLUGINS_ROOT, p["name"])
        print(f"[sync] {p['name']} ({p['kind']}, v{p['version']}): 更新 {copied} 项 -> {dst_dir}")
    print(f"\n全部 {len(plugins)} 个插件同步完成（共更新 {total_copied} 项）。")
    return 0


def cmd_install(plugins, stage_only=False, explicit_res=None):
    if not plugins:
        print("未找到可安装的插件。")
        return 1
    if cmd_build(plugins) != 0:
        return 1
    if cmd_sync(plugins) != 0:
        return 1

    need_host = [p for p in plugins if p["needs_host_loader"]]
    if not need_host:
        print("\n所选插件均为纯原生 MCP App，无需修改 app.asar，重启或刷新 MCP Server 即可生效。")
        return 0

    host_mod = load_core_host_module()
    res_dir, asar_path, _, _, _ = host_mod.get_paths(explicit_res)
    if not res_dir:
        print("错误: 未找到 Antigravity 安装目录（可用 --resources-dir 指定）。")
        return 1

    if not stage_only and host_mod.has_plugin_loader(asar_path) and host_mod.has_current_plugin_loader(asar_path):
        print("\n宿主 app.asar 已接入最新通用加载器，无需重新打包。")
        return 0

    print("\n开始通过 core/plugin_host.py 接入/更新 Antigravity 宿主加载器...")
    host_mod.cmd_install(stage_only=stage_only, explicit_dir=explicit_res, do_sync=False)
    return 0


def cmd_test(plugins):
    if not plugins:
        print("未找到可测试的插件。")
        return 1

    if cmd_check(plugins) != 0:
        return 1

    print("\n=== 1. Python 语法检查 (py_compile) ===")
    py_files = [os.path.abspath(__file__), os.path.join(CORE_DIR, "plugin_host.py")]
    for p in plugins:
        sdir = os.path.join(p["path"], "scripts")
        if os.path.isdir(sdir):
            for fn in sorted(os.listdir(sdir)):
                if fn.endswith(".py"):
                    py_files.append(os.path.join(sdir, fn))
    for pf in py_files:
        if not os.path.isfile(pf):
            continue
        try:
            py_compile.compile(pf, doraise=True)
            print(f"- OK: {os.path.relpath(pf, WORKSPACE_DIR)}")
        except Exception as exc:
            print(f"- FAIL: {pf}: {exc}")
            return 1

    ran = 0
    failed = 0

    print("\n=== 2. 运行 MCP App Python 单元测试 ===")
    for p in plugins:
        if not p.get("mcp"):
            continue
        sdir = os.path.join(p["path"], "scripts")
        if not os.path.isdir(sdir):
            continue
        py_tests = sorted(fn for fn in os.listdir(sdir) if fn.startswith("test_") and fn.endswith("_mcp.py"))
        for t in py_tests:
            ran += 1
            tpath = os.path.join(sdir, t)
            print(f"\n>>> 运行 {p['name']}/scripts/{t}")
            proc = subprocess.run([sys.executable, "-m", "unittest", tpath], cwd=p["path"], check=False)
            if proc.returncode != 0:
                failed += 1
                print(f"!!! 失败: {p['name']}/scripts/{t} (exit={proc.returncode})")

    print("\n=== 3. 运行 DOM 插件 Node.js 单元测试 ===")
    for p in plugins:
        if not p["needs_host_loader"]:
            continue
        rdir = os.path.join(p["path"], "runtime")
        if not os.path.isdir(rdir):
            continue
        tests = sorted(fn for fn in os.listdir(rdir) if fn.startswith("test_") and fn.endswith(".js"))
        for t in tests:
            ran += 1
            tpath = os.path.join(rdir, t)
            print(f"\n>>> 运行 {p['name']}/runtime/{t}")
            proc = subprocess.run(["node", tpath], cwd=p["path"], check=False)
            if proc.returncode != 0:
                failed += 1
                print(f"!!! 失败: {p['name']}/runtime/{t} (exit={proc.returncode})")

    print("\n=== 4. 运行宿主防冲突与增量合并单元测试 ===")
    coexist_test = os.path.join(SCRIPT_DIR, "test_plugin_host_coexistence.py")
    if os.path.exists(coexist_test):
        ran += 1
        print(">>> 运行 scripts/test_plugin_host_coexistence.py")
        proc = subprocess.run([sys.executable, coexist_test], cwd=WORKSPACE_DIR, check=False)
        if proc.returncode != 0:
            failed += 1
            print(f"!!! 失败: scripts/test_plugin_host_coexistence.py (exit={proc.returncode})")

    print(f"\n=== 测试汇总: 共 {ran} 项，失败 {failed} 项 ===")
    return 0 if failed == 0 else 1


def cmd_restore(explicit_res=None):
    host_mod = load_core_host_module()
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

    if cmd == "check":
        sys.exit(cmd_check(plugins))
    elif cmd == "build":
        sys.exit(cmd_build(plugins))
    elif cmd == "status":
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
        sys.exit(cmd_restore(explicit_res))
    else:
        print(f"未知命令: {cmd} (支持: check, build, status, sync, install, stage, test, restore)")
        sys.exit(1)


if __name__ == "__main__":
    main()
