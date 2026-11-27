"""
防冲突、独立 kiriu 命名空间与原地增量合并回归测试：
1. 独立命名空间：使用 app.asar.kiriu.bak / app.asar.kiriu.staged，绝不覆盖第三方 app.asar.bak
2. 原地增量升级：在已注入其他开发者文件与 main.js 代码的 app.asar 上升级或重注入时，100% 保留对方改动
3. 区分官方版本更新 vs 同版本第三方改写（防拉锯保护）：
   - 同版本被第三方改写移除 loader -> detect_asar_change_kind == "external_rewrite"，session-hook 不生成 staged
   - 新版本官方更新移除 loader -> detect_asar_change_kind == "official_update"，正常增量预构建 staged
4. 向下兼容还原：优先使用 app.asar.kiriu.bak，无独立备份时兼容旧 app.asar.bak
"""

import importlib.util
import io
import json
import os
import sys
import tempfile


def load_plugin_host(path):
    spec = importlib.util.spec_from_file_location("_test_plugin_host_mod", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_mock_asar(dst_path, version="2.35.2", extra_files=None, main_extra=""):
    header = {
        "files": {
            "package.json": {"size": 0, "offset": "0"},
            "dist": {
                "files": {
                    "main.js": {"size": 0, "offset": "0"},
                    "tray.js": {"size": 0, "offset": "0"},
                }
            },
        }
    }
    pkg_bytes = json.dumps({"name": "antigravity", "version": version}).encode("utf-8")
    main_js = (
        '"use strict";\n'
        'Object.defineProperty(exports, "__esModule", { value: true });\n'
        'const electron_1 = require("electron");\n'
        'const tray_1 = require("./tray");\n'
        'const scriptJail_1 = require("./scriptJail");\n'
        "electron_1.app.on('web-contents-created', (_event, contents) => {\n"
        "    console.log('created');\n"
        "});\n"
        + main_extra
    ).encode("utf-8")
    tray_js = (
        '"use strict";\n'
        'const electron_1 = require("electron");\n'
        'const utils_1 = require("./utils");\n'
        "function build(actions, options, count, countItem) {\n"
        "    let contextMenu = electron_1.Menu.buildFromTemplate(actions);\n"
        "    const item = new electron_1.MenuItem(options);\n"
        "            countItem.label =\n"
        "                (count > 0 ? `${count}` : 'No') +\n"
        "                    ' agent' +\n"
        "                    (count === 1 ? '' : 's') +\n"
        "                    ' running';\n"
        "    return [contextMenu, item];\n"
        "}\n"
    ).encode("utf-8")
    file_bytes = {
        ("package.json",): pkg_bytes,
        ("dist", "main.js"): main_js,
        ("dist", "tray.js"): tray_js,
    }
    if extra_files:
        for rel_tuple, raw in extra_files.items():
            file_bytes[rel_tuple] = raw
            node = header
            for part in rel_tuple[:-1]:
                node = node.setdefault("files", {}).setdefault(part, {"files": {}})
            node.setdefault("files", {})[rel_tuple[-1]] = {"size": len(raw), "offset": "0"}
    return header, file_bytes


def main():
    workspace = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    host_path = os.path.join(workspace, "antigravity-zh-cn", "scripts", "plugin_host.py")
    mod = load_plugin_host(host_path)

    with tempfile.TemporaryDirectory(prefix="agy_coexist_test_") as tmp:
        res_dir = os.path.join(tmp, "resources")
        plugins_root = os.path.join(tmp, "plugins")
        runtime_dir = os.path.join(tmp, "runtime")
        os.makedirs(res_dir, exist_ok=True)
        os.makedirs(plugins_root, exist_ok=True)
        os.makedirs(runtime_dir, exist_ok=True)

        # 隔离所有全局路径到临时目录，避免污染用户环境
        mod.PLUGINS_ROOT = plugins_root
        mod.RUNTIME_DIR = runtime_dir
        mod.HEAL_STATE_PATH = os.path.join(runtime_dir, "heal_state.json")
        mod.HEAL_LOG_PATH = os.path.join(runtime_dir, "heal.log")
        mod.GLOBAL_HEAL_PREF_PATH = os.path.join(plugins_root, ".kiriu.agy-host-heal.json")
        mod.LEGACY_GLOBAL_HEAL_PREF_PATH = os.path.join(plugins_root, ".agy-host-heal.json")
        mod.GLOBAL_EXIT_WATCHER_LOCK = os.path.join(plugins_root, ".kiriu.agy-exit-watcher.lock")
        mod.GLOBAL_NOTICE_LOCK = os.path.join(plugins_root, ".kiriu.agy-notice.lock")

        asar_path = os.path.join(res_dir, "app.asar")
        third_party_bak = os.path.join(res_dir, "app.asar.bak")
        with open(third_party_bak, "wb") as f:
            f.write(b"THIRD_PARTY_ORIGINAL_BACKUP_DO_NOT_TOUCH")

        # 构建官方 v2.35.2 app.asar
        hdr, fb = build_mock_asar(asar_path, version="2.35.2")
        mod.write_asar(asar_path, hdr, fb)

        # 1. 验证独立 kiriu 命名空间
        got_res, got_asar, got_bak, got_staged, _ = mod.get_paths(res_dir)
        assert got_res == res_dir
        assert os.path.basename(got_bak) == "app.asar.kiriu.bak", got_bak
        assert os.path.basename(got_staged) == "app.asar.kiriu.staged", got_staged

        # 执行首次 install
        mod.cmd_install(stage_only=False, explicit_dir=res_dir, do_sync=False)

        assert os.path.exists(got_bak), "app.asar.kiriu.bak must be created"
        with open(third_party_bak, "rb") as f:
            assert f.read() == b"THIRD_PARTY_ORIGINAL_BACKUP_DO_NOT_TOUCH", "third-party app.asar.bak must remain untouched"
        assert mod.has_plugin_loader(asar_path), "loader must be installed"

        # 2. 模拟其他开发者在已安装我们 loader 的 app.asar 上增量写入自己的插件文件与 main.js 代码
        h2, fb2 = mod.load_asar(asar_path)
        fb2[("dist", "otherDevPlugin.js")] = b"exports.hello = 'from-other-dev';\n"
        h2["files"]["dist"]["files"]["otherDevPlugin.js"] = {"size": len(fb2[("dist", "otherDevPlugin.js")]), "offset": "0"}
        fb2[("dist", "main.js")] = fb2[("dist", "main.js")] + b"\n// OTHER_DEV_HOOK\nrequire('./otherDevPlugin');\n"
        # 顺便把 loader 版本降成旧版 2.1.0，模拟我们发新版需要原地升级
        fb2[("dist", "pluginLoader.js")] = fb2[("dist", "pluginLoader.js")].replace(b'"2.3.0"', b'"2.1.0"', 1)
        mod.write_asar(asar_path, h2, fb2)

        assert mod.detect_asar_change_kind(asar_path, "upgrade") == "loader_upgrade"
        mod.cmd_install(stage_only=False, explicit_dir=res_dir, do_sync=False)

        # 验证：升级后，其他开发者的文件与 main.js 代码 100% 完好保留！
        _, fb_after = mod.load_asar(asar_path)
        assert ("dist", "otherDevPlugin.js") in fb_after, "third-party plugin file must be preserved after incremental upgrade"
        assert fb_after[("dist", "otherDevPlugin.js")] == b"exports.hello = 'from-other-dev';\n"
        assert b"OTHER_DEV_HOOK" in fb_after[("dist", "main.js")], "third-party main.js hook must be preserved"
        assert mod.get_installed_loader_version(asar_path) >= (2, 3, 0), "loader must be upgraded"

        # 3. 模拟同版本下被第三方工具整体改写 app.asar（导致我们的 loader 消失）
        hdr_ext, fb_ext = build_mock_asar(
            asar_path,
            version="2.35.2",
            extra_files={("dist", "competitor.js"): b"exports.x = 1;"},
            main_extra="\n// COMPETITOR_PATCH\n",
        )
        mod.write_asar(asar_path, hdr_ext, fb_ext)
        assert not mod.has_plugin_loader(asar_path)
        assert mod.detect_asar_change_kind(asar_path, "missing") == "external_rewrite"

        # 模拟 SessionStart hook：不得静默生成 staged，不得拉起 exit-watcher，只返回提醒
        orig_get_paths = mod.get_paths
        orig_is_enabled = mod.is_plugin_enabled
        orig_spawn = mod.spawn_exit_watcher
        orig_stdin = sys.stdin
        spawn_called = []
        try:
            mod.get_paths = lambda explicit_dir=None: orig_get_paths(res_dir)
            mod.is_plugin_enabled = lambda: True
            mod.spawn_exit_watcher = lambda rd: spawn_called.append(rd)
            sys.stdin = io.StringIO("{}")

            notice = mod.run_session_hook()
            assert "injectSteps" in notice, "external rewrite must emit a user notice"
            assert not os.path.exists(got_staged), "external rewrite must NOT auto-stage and overwrite"
            assert len(spawn_called) == 0, "external rewrite must NOT spawn exit watcher"

            # 4. 模拟 Antigravity 官方更新到新版本 v2.36.0 -> 必须识别为 official_update 并正常增量 pre-stage
            hdr_new, fb_new = build_mock_asar(asar_path, version="2.36.0")
            mod.write_asar(asar_path, hdr_new, fb_new)
            assert mod.detect_asar_change_kind(asar_path, "missing") == "official_update"
            sys.stdin = io.StringIO("{}")
            notice2 = mod.run_session_hook()
            assert "injectSteps" in notice2, "official update must emit update notice"
            assert os.path.exists(got_staged), "official update must create app.asar.kiriu.staged"
            assert mod.has_plugin_loader(got_staged), "staged asar must contain pluginLoader"
            assert len(spawn_called) == 1, "official update must spawn exit watcher"
        finally:
            mod.get_paths = orig_get_paths
            mod.is_plugin_enabled = orig_is_enabled
            mod.spawn_exit_watcher = orig_spawn
            sys.stdin = orig_stdin

        # 5. 验证 cmd_restore 使用 app.asar.kiriu.bak 且不碰第三方 app.asar.bak
        mod.cmd_restore(res_dir)
        assert not mod.has_plugin_loader(asar_path)
        assert mod.get_asar_version(asar_path) == "2.36.0"
        with open(third_party_bak, "rb") as f:
            assert f.read() == b"THIRD_PARTY_ORIGINAL_BACKUP_DO_NOT_TOUCH"

    print("All plugin_host.py kiriu namespace & coexistence tests passed!")


if __name__ == "__main__":
    main()
