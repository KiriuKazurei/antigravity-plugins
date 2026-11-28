"""
Antigravity 任务通知与远程推送 MCP App Server (stdio JSON-RPC 2.0)
零第三方依赖（纯 Python 标准库）：
- 向 Antigravity 左侧栏原生「插件」分组注册 `远程推送`（global 入口）
- 直接读写 runtime/notifier-config.json（与 Stop Hook notify_hook.py 共享配置）并支持一键发送真实测试推送
"""

import json
import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_CONFIG_PATH = os.path.join(PLUGIN_DIR, "runtime", "notifier-config.json")
FALLBACK_CONFIG_PATH = os.path.join(
    os.path.expanduser("~"), ".gemini", "config", "plugins", "antigravity-notifier", "runtime", "notifier-config.json"
)
LOG_PATH = os.path.join(PLUGIN_DIR, "runtime", "notify.log")
NOTIFIER_APP_URI = "ui://notifier/app.html"
NOTIFIER_APP_MIME = "text/html;profile=mcp-app"
NOTIFIER_APP_HTML_PATH = os.path.join(PLUGIN_DIR, "app", "dist", "app.html")
FALLBACK_APP_HTML_PATH = os.path.join(
    os.path.expanduser("~"), ".gemini", "config", "plugins", "antigravity-notifier", "app", "dist", "app.html"
)
SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

DEFAULT_CONFIG = {
    "enabled": False,
    "provider": "feishu",
    "webhookUrl": "",
    "secret": "",
    "telegramBotToken": "",
    "telegramChatId": "",
    "customHeaders": {},
    "notifyOnComplete": True,
    "notifyOnError": True,
    "notifyOnMaxLimit": True,
    "notifyOnCancel": False,
    "titlePrefix": "Antigravity",
}


def get_config_path():
    plugin_data = os.environ.get("PLUGIN_DATA")
    if plugin_data:
        return os.path.join(plugin_data, "notifier-config.json")
    if os.path.exists(DEFAULT_CONFIG_PATH):
        return DEFAULT_CONFIG_PATH
    if os.path.exists(FALLBACK_CONFIG_PATH):
        return FALLBACK_CONFIG_PATH
    return DEFAULT_CONFIG_PATH


def atomic_write_text(path, text):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".noti-tmp-", dir=parent or None)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    for path in (DEFAULT_CONFIG_PATH, get_config_path(), FALLBACK_CONFIG_PATH):
        if path and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    cfg.update(data)
                    break
            except Exception:
                continue
    return cfg


def save_config(updates):
    cfg = load_config()
    if isinstance(updates, dict):
        for key in (
            "enabled",
            "provider",
            "webhookUrl",
            "secret",
            "telegramBotToken",
            "telegramChatId",
            "notifyOnComplete",
            "notifyOnError",
            "notifyOnMaxLimit",
            "notifyOnCancel",
            "titlePrefix",
        ):
            if key in updates:
                cfg[key] = updates[key]
    payload = json.dumps(cfg, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(get_config_path(), payload)
    # 同步写入 runtime/notifier-config.json 供 Stop Hook notify_hook.py 直接读取
    try:
        if os.path.abspath(get_config_path()) != os.path.abspath(DEFAULT_CONFIG_PATH):
            atomic_write_text(DEFAULT_CONFIG_PATH, payload)
    except OSError:
        pass
    return cfg


def read_recent_logs(max_lines=30):
    if not os.path.isfile(LOG_PATH):
        return []
    try:
        with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = [ln.strip() for ln in f.readlines() if ln.strip()]
        return lines[-max_lines:][::-1]
    except Exception:
        return []


def load_app_html():
    for path in (os.environ.get("AGY_NOTIFIER_APP_HTML") or "", NOTIFIER_APP_HTML_PATH, FALLBACK_APP_HTML_PATH):
        if path and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
    raise FileNotFoundError(f"未找到远程推送 MCP App HTML 资源: {NOTIFIER_APP_HTML_PATH}")


def _build_state():
    return {
        "ok": True,
        "config": load_config(),
        "logs": read_recent_logs(30),
        "configPath": DEFAULT_CONFIG_PATH,
    }


def tool_open_panel(_args):
    return _build_state()


def tool_app_save_config(args):
    args = args if isinstance(args, dict) else {}
    save_config(args.get("config") or args)
    return _build_state()


def tool_app_test_push(_args):
    hook_script = os.path.join(SCRIPT_DIR, "notify_hook.py")
    if not os.path.isfile(hook_script):
        raise FileNotFoundError(f"未找到推送脚本: {hook_script}")
    proc = subprocess.run(
        [sys.executable, hook_script, "--test"],
        capture_output=True,
        text=True,
        timeout=12,
        cwd=PLUGIN_DIR,
    )
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    state = _build_state()
    state["testResult"] = {
        "ok": proc.returncode == 0,
        "exitCode": proc.returncode,
        "message": out or err or ("测试推送已发送" if proc.returncode == 0 else "测试推送失败"),
    }
    return state


TOOLS = [
    {
        "name": "open_panel",
        "title": "远程推送",
        "description": "在 Antigravity 左侧栏原生打开任务通知与 Webhook 远程推送配置面板。",
        "inputSchema": {"type": "object", "properties": {}},
        "_meta": {
            "ui": {"resourceUri": NOTIFIER_APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "global", "title": "远程推送"},
                ]
            },
        },
    },
    {
        "name": "app_get_state",
        "description": "App-only: 获取当前远程推送配置与最近推送日志。",
        "inputSchema": {"type": "object", "properties": {}},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_save_config",
        "description": "App-only: 保存远程推送 Webhook 配置。",
        "inputSchema": {
            "type": "object",
            "properties": {"config": {"type": "object"}},
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_test_push",
        "description": "App-only: 发送一条测试远程推送消息并返回结果。",
        "inputSchema": {"type": "object", "properties": {}},
        "_meta": {"ui": {"visibility": ["app"]}},
    },
]

TOOL_HANDLERS = {
    "open_panel": tool_open_panel,
    "app_get_state": tool_open_panel,
    "app_save_config": tool_app_save_config,
    "app_test_push": tool_app_test_push,
}


def handle_rpc_request(msg):
    if not isinstance(msg, dict):
        return None
    msg_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    if msg_id is None:
        return None

    if method == "initialize":
        req_proto = params.get("protocolVersion")
        proto = req_proto if req_proto in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": proto,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {"subscribe": False, "listChanged": False},
                },
                "serverInfo": {"name": "notifier", "version": "2.0.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "resources/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "resources": [
                    {
                        "uri": NOTIFIER_APP_URI,
                        "name": "Antigravity 远程推送",
                        "description": "Antigravity 原生左侧栏任务通知与 Webhook 远程推送配置面板",
                        "mimeType": NOTIFIER_APP_MIME,
                        "_meta": {"ui": {"prefersBorder": False}},
                    }
                ]
            },
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri != NOTIFIER_APP_URI:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32002, "message": f"Resource not found: {uri}"}}
        try:
            html = load_app_html()
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "contents": [
                        {
                            "uri": NOTIFIER_APP_URI,
                            "mimeType": NOTIFIER_APP_MIME,
                            "text": html,
                            "_meta": {"ui": {"prefersBorder": False}},
                        }
                    ]
                },
            }
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": f"读取远程推送 UI 失败: {exc}"}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        raw_args = params.get("arguments")
        if raw_args is not None and not isinstance(raw_args, dict):
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": "参数错误: arguments 必须是 JSON 对象"}], "isError": True},
            }
        arguments = raw_args if isinstance(raw_args, dict) else {}
        handler = TOOL_HANDLERS.get(name)
        if not handler:
            return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"未知工具: {name}"}], "isError": True}}
        try:
            payload = handler(arguments)
            cfg = payload.get("config", {})
            text_out = (
                f"已打开远程推送设置（渠道: {cfg.get('provider', 'feishu')}，状态: {'已启用' if cfg.get('enabled') else '未启用'}）。"
                if name == "open_panel"
                else json.dumps(payload, ensure_ascii=False, indent=2)
            )
            res_obj = {"content": [{"type": "text", "text": text_out}], "isError": False}
            if isinstance(payload, dict):
                res_obj["structuredContent"] = payload
            return {"jsonrpc": "2.0", "id": msg_id, "result": res_obj}
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": f"执行失败: {exc}"}], "isError": True}}

    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        resp = handle_rpc_request(msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
