"""
Antigravity Prompt 模板库 MCP App Server (stdio JSON-RPC 2.0)
零第三方依赖（纯 Python 标准库）：
- 向 Antigravity 左侧栏原生「插件」分组注册 `模板库`（global 入口）
- 与 runtime/snippets.json 共享模板数据，支持搜索、分类/置顶、新建/编辑/删除与一键复制
"""

import json
import os
import sys
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_STORE_PATH = os.path.join(PLUGIN_DIR, "runtime", "snippets.json")
FALLBACK_STORE_PATH = os.path.join(
    os.path.expanduser("~"), ".gemini", "config", "plugins", "antigravity-snippets", "runtime", "snippets.json"
)
SNIPPETS_APP_URI = "ui://snippets/app.html"
SNIPPETS_APP_MIME = "text/html;profile=mcp-app"
SNIPPETS_APP_HTML_PATH = os.path.join(PLUGIN_DIR, "app", "dist", "app.html")
FALLBACK_APP_HTML_PATH = os.path.join(
    os.path.expanduser("~"), ".gemini", "config", "plugins", "antigravity-snippets", "app", "dist", "app.html"
)
SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

DEFAULT_SNIPPETS = [
    {
        "id": "builtin-cr",
        "title": "代码审查 (Code Review)",
        "alias": "cr",
        "category": "研发工程",
        "tags": ["review", "质量", "diff"],
        "content": "请对当前改动进行严格的代码审查（Code Review），重点关注正确性、边界条件、复杂度与最小安全修复。",
        "pinned": True,
        "useCount": 0,
        "builtin": True,
        "updatedAt": 1700000008000,
    },
    {
        "id": "builtin-ask",
        "title": "先对齐方案再动手",
        "alias": "ask",
        "category": "架构设计",
        "tags": ["plan", "方案", "对比"],
        "content": "先不要直接修改代码。请基于当前上下文给出 2 套可行实现方案，对比改动范围、风险与推荐选择，待确认后再实施。",
        "pinned": True,
        "useCount": 0,
        "builtin": True,
        "updatedAt": 1700000007000,
    },
    {
        "id": "builtin-bug",
        "title": "Bug 根因排查",
        "alias": "bug",
        "category": "调试排错",
        "tags": ["debug", "报错", "排查"],
        "content": "请协助定位以下问题的根本原因（不要只做表面规避），依次给出根因定位、最小修复方案及回归验证方法：{{$cursor}}",
        "pinned": True,
        "useCount": 0,
        "builtin": True,
        "updatedAt": 1700000006000,
    },
    {
        "id": "builtin-ut",
        "title": "单元测试生成",
        "alias": "ut",
        "category": "研发工程",
        "tags": ["test", "测试"],
        "content": "请为以下目标编写高信号单元测试，覆盖正常路径、边界条件与异常分支，并运行验证：{{$cursor}}",
        "pinned": False,
        "useCount": 0,
        "builtin": True,
        "updatedAt": 1700000005000,
    },
]


def get_store_path():
    plugin_data = os.environ.get("PLUGIN_DATA")
    if plugin_data:
        return os.path.join(plugin_data, "snippets.json")
    if os.path.exists(DEFAULT_STORE_PATH):
        return DEFAULT_STORE_PATH
    if os.path.exists(FALLBACK_STORE_PATH):
        return FALLBACK_STORE_PATH
    return DEFAULT_STORE_PATH


def atomic_write_text(path, text):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".snip-tmp-", dir=parent or None)
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


def load_store():
    for path in (get_store_path(), DEFAULT_STORE_PATH, FALLBACK_STORE_PATH):
        if path and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("snippets"), list):
                    return data
            except Exception:
                continue
    return {"version": 1, "snippets": [dict(s) for s in DEFAULT_SNIPPETS], "prefs": {"showFloatingBtn": False}}


def save_store(store):
    payload = json.dumps(store, ensure_ascii=False, indent=2) + "\n"
    atomic_write_text(get_store_path(), payload)
    # 若存在 runtime/snippets.json（供 # 快捷输入共享），同步写入一份
    if os.path.isdir(os.path.dirname(DEFAULT_STORE_PATH)) and os.path.abspath(get_store_path()) != os.path.abspath(DEFAULT_STORE_PATH):
        try:
            atomic_write_text(DEFAULT_STORE_PATH, payload)
        except OSError:
            pass


def load_app_html():
    for path in (os.environ.get("AGY_SNIPPETS_APP_HTML") or "", SNIPPETS_APP_HTML_PATH, FALLBACK_APP_HTML_PATH):
        if path and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
    raise FileNotFoundError(f"未找到模板库 MCP App HTML 资源: {SNIPPETS_APP_HTML_PATH}")


def _filter_snippets(snippets, query="", category=""):
    q = str(query or "").strip().lower()
    cat = str(category or "").strip()
    out = []
    for s in snippets:
        if not isinstance(s, dict):
            continue
        if cat and s.get("category") != cat:
            continue
        if q:
            hay = " ".join([
                str(s.get("title") or ""),
                str(s.get("alias") or ""),
                str(s.get("category") or ""),
                " ".join(s.get("tags") or []),
                str(s.get("content") or ""),
            ]).lower()
            if not all(term in hay for term in q.split() if term):
                continue
        out.append(s)
    out.sort(key=lambda x: (1 if x.get("pinned") else 0, int(x.get("updatedAt") or 0)), reverse=True)
    return out


def _build_state(query="", category=""):
    store = load_store()
    all_items = store.get("snippets") or []
    cats = sorted({str(s.get("category") or "未分类") for s in all_items if isinstance(s, dict)})
    filtered = _filter_snippets(all_items, query=query, category=category)
    return {
        "ok": True,
        "totalCount": len(all_items),
        "categories": cats,
        "query": str(query or ""),
        "activeCategory": str(category or ""),
        "snippets": filtered[:200],
    }


def tool_open_panel(args):
    args = args if isinstance(args, dict) else {}
    return _build_state(query=args.get("query") or "", category=args.get("category") or "")


def tool_list(args):
    args = args if isinstance(args, dict) else {}
    return _build_state(query=args.get("query") or "", category=args.get("category") or "")


def tool_app_save(args):
    args = args if isinstance(args, dict) else {}
    title = str(args.get("title") or "").strip()
    content = args.get("content")
    if not title:
        raise ValueError("模板标题不能为空")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("模板内容不能为空")
    store = load_store()
    items = list(store.get("snippets") or [])
    sid = str(args.get("id") or "").strip() or f"custom-{int(time.time() * 1000)}"
    alias = str(args.get("alias") or "").strip()
    category = str(args.get("category") or "自定义").strip() or "自定义"
    raw_tags = args.get("tags") or []
    if isinstance(raw_tags, str):
        tags = [t.strip().lstrip("#") for t in raw_tags.replace("，", ",").split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t).strip().lstrip("#") for t in raw_tags if str(t).strip()]
    else:
        tags = []
    pinned = bool(args.get("pinned", False))
    now_ms = int(time.time() * 1000)

    updated = False
    for idx, it in enumerate(items):
        if isinstance(it, dict) and it.get("id") == sid:
            items[idx] = {
                **it,
                "title": title,
                "alias": alias,
                "category": category,
                "tags": tags,
                "content": content,
                "pinned": pinned,
                "updatedAt": now_ms,
            }
            updated = True
            break
    if not updated:
        items.insert(0, {
            "id": sid,
            "title": title,
            "alias": alias,
            "category": category,
            "tags": tags,
            "content": content,
            "pinned": pinned,
            "useCount": 0,
            "builtin": False,
            "updatedAt": now_ms,
        })
    store["snippets"] = items
    save_store(store)
    state = _build_state()
    state["savedId"] = sid
    return state


def tool_app_delete(args):
    args = args if isinstance(args, dict) else {}
    sid = str(args.get("id") or "").strip()
    if not sid:
        raise ValueError("缺少模板 id")
    store = load_store()
    items = [s for s in (store.get("snippets") or []) if not (isinstance(s, dict) and s.get("id") == sid)]
    store["snippets"] = items
    save_store(store)
    return _build_state()


TOOLS = [
    {
        "name": "open_panel",
        "title": "模板库",
        "description": "在 Antigravity 左侧栏原生打开 Prompt 模板库管理面板。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "可选：初始搜索关键词"},
                "category": {"type": "string", "description": "可选：初始分类过滤"},
            },
        },
        "_meta": {
            "ui": {"resourceUri": SNIPPETS_APP_URI},
            "com.google.antigravity/ui": {
                "entrypoints": [
                    {"type": "global", "title": "模板库"},
                ]
            },
        },
    },
    {
        "name": "list",
        "description": "列出或检索当前 Prompt 模板库中的所有模板。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "category": {"type": "string"},
            },
        },
    },
    {
        "name": "app_get_state",
        "description": "App-only: 获取模板库列表与分类。",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "category": {"type": "string"}},
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_save",
        "description": "App-only: 创建或更新 Prompt 模板。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "title": {"type": "string"},
                "alias": {"type": "string"},
                "category": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "content": {"type": "string"},
                "pinned": {"type": "boolean"},
            },
            "required": ["title", "content"],
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_delete",
        "description": "App-only: 删除指定 Prompt 模板。",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
]

TOOL_HANDLERS = {
    "open_panel": tool_open_panel,
    "list": tool_list,
    "app_get_state": tool_open_panel,
    "app_save": tool_app_save,
    "app_delete": tool_app_delete,
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
                "serverInfo": {"name": "snippets", "version": "2.0.0"},
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
                        "uri": SNIPPETS_APP_URI,
                        "name": "Antigravity 模板库",
                        "description": "Antigravity 原生左侧栏 Prompt 模板库管理界面",
                        "mimeType": SNIPPETS_APP_MIME,
                        "_meta": {"ui": {"prefersBorder": False, "permissions": {"clipboardWrite": {}}}},
                    }
                ]
            },
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri != SNIPPETS_APP_URI:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32002, "message": f"Resource not found: {uri}"}}
        try:
            html = load_app_html()
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "contents": [
                        {
                            "uri": SNIPPETS_APP_URI,
                            "mimeType": SNIPPETS_APP_MIME,
                            "text": html,
                            "_meta": {"ui": {"prefersBorder": False, "permissions": {"clipboardWrite": {}}}},
                        }
                    ]
                },
            }
        except Exception as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": f"读取模板库 UI 失败: {exc}"}}
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
            text_out = (
                f"已打开 Prompt 模板库，共 {payload.get('totalCount', 0)} 个模板。"
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
