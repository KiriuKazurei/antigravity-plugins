"""
Antigravity 轻量化 Markdown 知识库 MCP Server (stdio JSON-RPC 2.0)
零第三方依赖（纯 Python 标准库），与 antigravity-kb UI 共享 runtime/kb-config.json 与 ~/.gemini/kb。

提供工具：
- kb_list   : 列出知识库中的 Markdown 笔记与可用 Vault
- kb_search : 按关键词与 #标签 检索知识库笔记
- kb_read   : 读取指定笔记（支持相对路径或 [[笔记名]] / 标题匹配）及反向链接
- kb_write  : 创建或覆盖写入知识库 .md 笔记（自动处理父目录与 Frontmatter）
- kb_append : 向已有笔记追加内容（或自动创建新笔记）
"""

import json
import os
import re
import sys
import tempfile
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_CONFIG_PATH = os.path.join(PLUGIN_DIR, "runtime", "kb-config.json")
FALLBACK_CONFIG_PATH = os.path.join(
    os.path.expanduser("~"), ".gemini", "config", "plugins", "antigravity-kb", "runtime", "kb-config.json"
)
DEFAULT_VAULT_PATH = os.environ.get("AGY_KB_DEFAULT_VAULT") or os.path.join(
    os.path.expanduser("~"), ".gemini", "kb"
)

SKIP_DIRS = {
    ".git",
    "node_modules",
    ".obsidian",
    ".trash",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
}

MAX_SCAN_FILES = 2000
MAX_FILE_BYTES = 2 * 1024 * 1024
MD_EXTS = (".md", ".markdown")


def get_config_path():
    if os.path.exists(DEFAULT_CONFIG_PATH):
        return DEFAULT_CONFIG_PATH
    if os.path.exists(FALLBACK_CONFIG_PATH):
        return FALLBACK_CONFIG_PATH
    return DEFAULT_CONFIG_PATH


def load_kb_config():
    cfg_path = get_config_path()
    data = {}
    try:
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
    except Exception:
        data = {}

    vaults = data.get("vaults")
    if not isinstance(vaults, list) or not vaults:
        vaults = [
            {
                "id": "personal",
                "label": "个人知识库",
                "path": DEFAULT_VAULT_PATH,
                "kind": "personal",
            }
        ]
    active_id = data.get("activeVaultId") or vaults[0].get("id") or "personal"
    return {
        "activeVaultId": str(active_id),
        "vaults": vaults,
        "prefs": data.get("prefs") if isinstance(data.get("prefs"), dict) else {},
    }


def ensure_default_vault():
    try:
        os.makedirs(DEFAULT_VAULT_PATH, exist_ok=True)
    except OSError:
        pass
    return DEFAULT_VAULT_PATH


def resolve_vaults(vault_arg=None):
    cfg = load_kb_config()
    vaults = cfg["vaults"]
    ensure_default_vault()

    if not vault_arg:
        for v in vaults:
            if v.get("id") == cfg["activeVaultId"] and v.get("path"):
                return [v]
        return [vaults[0]]

    key = str(vault_arg).strip()
    if key.lower() == "all":
        return [v for v in vaults if isinstance(v, dict) and v.get("path")]

    for v in vaults:
        if key == v.get("id") or key == v.get("label") or key == v.get("kind"):
            return [v]

    expanded = os.path.abspath(os.path.expanduser(key))
    for v in vaults:
        vpath = v.get("path")
        if vpath and os.path.abspath(os.path.expanduser(vpath)) == expanded:
            return [v]

    # Allow referencing an existing registered workspace vault or explicit existing directory
    if os.path.isdir(expanded):
        return [{"id": "custom", "label": os.path.basename(expanded) or expanded, "path": expanded, "kind": "custom"}]

    raise ValueError(f"未找到知识库目录: {vault_arg}")


def resolve_safe_md_path(root_path, rel_path, allow_missing=True):
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError("笔记路径不能为空")
    if "\x00" in rel_path:
        raise ValueError("笔记路径包含非法字符")
    cleaned = rel_path.strip().replace("\\", "/").lstrip("/")
    if re.match(r"^[A-Za-z]:", cleaned):
        raise ValueError("路径越界：不允许使用盘符绝对路径")
    if not cleaned.lower().endswith(MD_EXTS):
        cleaned += ".md"
    base = os.path.abspath(os.path.expanduser(root_path))
    target = os.path.abspath(os.path.join(base, cleaned))
    base_nc = os.path.normcase(base)
    target_nc = os.path.normcase(target)
    if target_nc != base_nc and not target_nc.startswith(base_nc + os.sep):
        raise ValueError("路径越界：不允许访问知识库目录之外的文件")
    if not allow_missing and not os.path.isfile(target):
        raise FileNotFoundError(f"笔记不存在: {cleaned}")
    rel_norm = os.path.relpath(target, base).replace("\\", "/")
    return target, rel_norm


def parse_markdown_meta(text, rel_path=""):
    lines = text.splitlines()
    title = ""
    tags = []
    aliases = []
    body_start = 0

    if lines and lines[0].strip() == "---":
        end_idx = -1
        for i in range(1, min(len(lines), 80)):
            if lines[i].strip() in ("---", "..."):
                end_idx = i
                break
        if end_idx > 0:
            body_start = end_idx + 1
            in_tags = False
            in_aliases = False
            for raw in lines[1:end_idx]:
                stripped = raw.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if raw.startswith((" ", "\t")) and stripped.startswith("- "):
                    item = stripped[2:].strip().strip("'\"")
                    if in_tags and item:
                        tags.append(item.lstrip("#"))
                    elif in_aliases and item:
                        aliases.append(item)
                    continue
                in_tags = False
                in_aliases = False
                if ":" in stripped:
                    k, v = stripped.split(":", 1)
                    k = k.strip().lower()
                    v = v.strip()
                    if k == "title" and v:
                        title = v.strip("'\"")
                    elif k == "tags":
                        if v.startswith("[") and v.endswith("]"):
                            for part in v[1:-1].split(","):
                                t = part.strip().strip("'\"").lstrip("#")
                                if t:
                                    tags.append(t)
                        elif v:
                            for part in re.split(r"[,，\s]+", v):
                                t = part.strip().strip("'\"").lstrip("#")
                                if t:
                                    tags.append(t)
                        else:
                            in_tags = True
                    elif k == "aliases":
                        if v.startswith("[") and v.endswith("]"):
                            for part in v[1:-1].split(","):
                                a = part.strip().strip("'\"")
                                if a:
                                    aliases.append(a)
                        elif v:
                            aliases.append(v.strip("'\""))
                        else:
                            in_aliases = True

    body_lines = lines[body_start:]
    in_fence = False
    excerpt_parts = []
    inline_tags = []
    wikilinks = []

    for ln in body_lines:
        s = ln.strip()
        if s.startswith("```") or s.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if not title and s.startswith("# "):
            title = s[2:].strip()
        for m in re.finditer(r"(?:^|[\s(])#([A-Za-z0-9_\-\u4e00-\u9fff/]+)", ln):
            t = m.group(1).strip("/")
            if t and not re.fullmatch(r"[0-9a-fA-F]{3,8}", t):
                inline_tags.append(t)
        for m in re.finditer(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]", ln):
            target = m.group(1).strip()
            if target:
                wikilinks.append(target)
        if len(excerpt_parts) < 3 and s and not s.startswith("#") and not s.startswith("---"):
            clean = re.sub(r"[`*_>\[\]]", "", s)
            if clean:
                excerpt_parts.append(clean)

    if not title and rel_path:
        title = os.path.splitext(os.path.basename(rel_path))[0]

    seen_tags = []
    seen_set = set()
    for t in tags + inline_tags:
        low = t.lower()
        if low not in seen_set:
            seen_set.add(low)
            seen_tags.append(t)

    excerpt = " ".join(excerpt_parts)[:160]
    return {
        "title": title,
        "tags": seen_tags,
        "aliases": aliases,
        "links": list(dict.fromkeys(wikilinks)),
        "excerpt": excerpt,
        "body_start": body_start,
    }


def scan_vault_notes(root_path):
    base = os.path.abspath(os.path.expanduser(root_path))
    if not os.path.isdir(base):
        return []
    notes = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(files):
            if not fn.lower().endswith(MD_EXTS):
                continue
            full = os.path.join(root, fn)
            try:
                st = os.stat(full)
                if st.st_size > MAX_FILE_BYTES:
                    continue
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception:
                continue
            rel = os.path.relpath(full, base).replace("\\", "/")
            meta = parse_markdown_meta(text, rel)
            notes.append(
                {
                    "rel_path": rel,
                    "full_path": full,
                    "title": meta["title"],
                    "tags": meta["tags"],
                    "aliases": meta["aliases"],
                    "links": meta["links"],
                    "excerpt": meta["excerpt"],
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                    "content": text,
                }
            )
            if len(notes) >= MAX_SCAN_FILES:
                return notes
    notes.sort(key=lambda n: n["mtime"], reverse=True)
    return notes


def tool_kb_list(args):
    vault_arg = args.get("vault")
    folder = str(args.get("folder") or "").strip().replace("\\", "/").strip("/")
    tag_filter = str(args.get("tag") or "").strip().lstrip("#").lower()
    limit = max(1, min(int(args.get("limit") or 100), 500))

    vaults = resolve_vaults(vault_arg)
    cfg = load_kb_config()
    items = []
    for v in vaults:
        vpath = v["path"]
        for n in scan_vault_notes(vpath):
            if folder and not (n["rel_path"] == folder or n["rel_path"].startswith(folder + "/")):
                continue
            if tag_filter and not any(t.lower() == tag_filter for t in n["tags"]):
                continue
            items.append(
                {
                    "vault": v.get("id"),
                    "vault_label": v.get("label"),
                    "rel_path": n["rel_path"],
                    "title": n["title"],
                    "tags": n["tags"],
                    "excerpt": n["excerpt"],
                    "updated_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(n["mtime"])),
                }
            )
            if len(items) >= limit:
                break

    return {
        "active_vault": cfg["activeVaultId"],
        "vaults": [{"id": v.get("id"), "label": v.get("label"), "path": v.get("path")} for v in cfg["vaults"]],
        "count": len(items),
        "notes": items,
    }


def tool_kb_search(args):
    query = str(args.get("query") or "").strip()
    tag_filter = str(args.get("tag") or "").strip().lstrip("#").lower()
    if not query and not tag_filter:
        raise ValueError("请提供 query 或 tag 参数")
    limit = max(1, min(int(args.get("limit") or 20), 100))
    vaults = resolve_vaults(args.get("vault"))
    q_low = query.lower()
    terms = [t for t in re.split(r"\s+", q_low) if t]

    results = []
    for v in vaults:
        for n in scan_vault_notes(v["path"]):
            if tag_filter and not any(t.lower() == tag_filter for t in n["tags"]):
                continue
            score = 0
            title_low = n["title"].lower()
            path_low = n["rel_path"].lower()
            tags_low = " ".join(n["tags"]).lower()
            content_low = n["content"].lower()

            if q_low:
                if title_low == q_low or os.path.splitext(os.path.basename(path_low))[0] == q_low:
                    score += 120
                elif q_low in title_low:
                    score += 80
                if q_low in tags_low:
                    score += 50
                if q_low in path_low:
                    score += 40
                all_terms_hit = all(
                    (term in title_low or term in tags_low or term in path_low or term in content_low)
                    for term in terms
                )
                if not all_terms_hit:
                    continue
                score += sum(content_low.count(term) for term in terms) * 4
            else:
                score = 10

            snippets = []
            if terms:
                for idx, line in enumerate(n["content"].splitlines(), start=1):
                    l_low = line.lower()
                    if any(term in l_low for term in terms):
                        snippets.append({"line": idx, "text": line.strip()[:220]})
                        if len(snippets) >= 4:
                            break
            elif n["excerpt"]:
                snippets.append({"line": 1, "text": n["excerpt"]})

            results.append(
                {
                    "score": score,
                    "vault": v.get("id"),
                    "vault_label": v.get("label"),
                    "rel_path": n["rel_path"],
                    "title": n["title"],
                    "tags": n["tags"],
                    "snippets": snippets,
                }
            )

    results.sort(key=lambda x: (x["score"]), reverse=True)
    return {"query": query, "tag": tag_filter, "count": min(len(results), limit), "matches": results[:limit]}


def find_note_in_vaults(note_ref, vault_arg=None):
    ref = str(note_ref or "").strip()
    if not ref:
        raise ValueError("请指定笔记路径或名称")
    if ref.startswith("[[") and ref.endswith("]]"):
        ref = ref[2:-2].split("|", 1)[0].split("#", 1)[0].strip()

    vaults = resolve_vaults(vault_arg)
    for v in vaults:
        vpath = v["path"]
        # 1. Exact path check
        try:
            target, rel_norm = resolve_safe_md_path(vpath, ref, allow_missing=False)
            return v, target, rel_norm
        except FileNotFoundError:
            pass
        except ValueError:
            pass

        # 2. Title / basename / alias match
        ref_low = ref.lower().removesuffix(".md").removesuffix(".markdown")
        notes = scan_vault_notes(vpath)
        for n in notes:
            stem = os.path.splitext(os.path.basename(n["rel_path"]))[0].lower()
            if (
                stem == ref_low
                or n["title"].lower() == ref_low
                or any(a.lower() == ref_low for a in n["aliases"])
            ):
                return v, n["full_path"], n["rel_path"]
        for n in notes:
            if ref_low in n["title"].lower() or ref_low in n["rel_path"].lower():
                return v, n["full_path"], n["rel_path"]

    raise FileNotFoundError(f"未找到匹配的笔记: {note_ref}")


def tool_kb_read(args):
    vault, target, rel_norm = find_note_in_vaults(args.get("note"), args.get("vault"))
    with open(target, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    meta = parse_markdown_meta(content, rel_norm)

    # Compute backlinks from sibling notes in the same vault
    stem_low = os.path.splitext(os.path.basename(rel_norm))[0].lower()
    title_low = meta["title"].lower()
    backlinks = []
    for n in scan_vault_notes(vault["path"]):
        if n["rel_path"] == rel_norm:
            continue
        if any(lnk.lower() in (stem_low, title_low, rel_norm.lower()) for lnk in n["links"]):
            backlinks.append({"rel_path": n["rel_path"], "title": n["title"]})

    return {
        "vault": vault.get("id"),
        "vault_label": vault.get("label"),
        "rel_path": rel_norm,
        "full_path": target,
        "title": meta["title"],
        "tags": meta["tags"],
        "links": meta["links"],
        "backlinks": backlinks,
        "content": content,
    }


def format_frontmatter_content(content, title=None, tags=None):
    text = content or ""
    if text.startswith("---\n") or text.startswith("---\r\n"):
        return text
    fm_lines = []
    if title:
        safe_title = str(title).replace('"', '\\"')
        fm_lines.append(f'title: "{safe_title}"')
    if tags and isinstance(tags, list):
        clean_tags = [str(t).strip().lstrip("#") for t in tags if str(t).strip()]
        if clean_tags:
            fm_lines.append("tags: [" + ", ".join(clean_tags) + "]")
    if not fm_lines:
        return text
    fm_lines.append(f"updated: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    header = "---\n" + "\n".join(fm_lines) + "\n---\n\n"
    return header + text


def atomic_write_text(target_path, content):
    parent = os.path.dirname(target_path)
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".kb_", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp_path, target_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def tool_kb_write(args):
    vaults = resolve_vaults(args.get("vault"))
    vault = vaults[0]
    overwrite = args.get("overwrite", True)
    target, rel_norm = resolve_safe_md_path(vault["path"], args.get("rel_path"), allow_missing=True)
    if not overwrite and os.path.exists(target):
        raise FileExistsError(f"笔记已存在且 overwrite=false: {rel_norm}")
    final_text = format_frontmatter_content(
        str(args.get("content") or ""),
        title=args.get("title"),
        tags=args.get("tags"),
    )
    atomic_write_text(target, final_text)
    return {
        "ok": True,
        "vault": vault.get("id"),
        "rel_path": rel_norm,
        "full_path": target,
        "bytes": len(final_text.encode("utf-8")),
    }


def tool_kb_append(args):
    note_ref = str(args.get("note") or "").strip()
    append_body = str(args.get("content") or "")
    section = str(args.get("section") or "").strip()
    if not append_body.strip():
        raise ValueError("追加内容不能为空")

    try:
        vault, target, rel_norm = find_note_in_vaults(note_ref, args.get("vault"))
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read()
    except FileNotFoundError:
        vault = resolve_vaults(args.get("vault"))[0]
        target, rel_norm = resolve_safe_md_path(vault["path"], note_ref, allow_missing=True)
        title = os.path.splitext(os.path.basename(rel_norm))[0]
        existing = f"# {title}\n"

    sep = "\n\n" if existing and not existing.endswith("\n\n") else ("\n" if existing and not existing.endswith("\n") else "")
    block = f"## {section}\n\n{append_body}" if section else append_body
    updated = existing + sep + block.rstrip() + "\n"
    atomic_write_text(target, updated)
    return {
        "ok": True,
        "vault": vault.get("id"),
        "rel_path": rel_norm,
        "full_path": target,
        "bytes": len(updated.encode("utf-8")),
    }


TOOLS = [
    {
        "name": "kb_list",
        "description": "列出 Antigravity Markdown 知识库中的笔记文件、标签和可用 Vault 目录。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "vault": {"type": "string", "description": "可选：Vault ID/名称/路径，或 'all' 列出全部已配置库"},
                "folder": {"type": "string", "description": "可选：按子目录过滤，如 'debugging'"},
                "tag": {"type": "string", "description": "可选：按标签过滤（不含 # 亦可）"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 100"},
            },
        },
    },
    {
        "name": "kb_search",
        "description": "按关键词或 #标签 全文检索知识库中的 Markdown 笔记。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词（支持多词空格分词）"},
                "tag": {"type": "string", "description": "可选：按标签过滤"},
                "vault": {"type": "string", "description": "可选：指定 Vault 或 'all' 跨库搜索"},
                "limit": {"type": "integer", "description": "最多返回条数，默认 20"},
            },
        },
    },
    {
        "name": "kb_read",
        "description": "读取知识库中的某篇笔记正文、元数据与反向链接，支持相对路径或 [[笔记标题]]。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": {"type": "string", "description": "笔记相对路径（如 'git/rebase.md'）或笔记标题/文件名"},
                "vault": {"type": "string", "description": "可选：Vault ID 或 'all'"},
            },
            "required": ["note"],
        },
    },
    {
        "name": "kb_write",
        "description": "创建或更新知识库中的 Markdown (.md) 笔记，支持自动生成 Frontmatter 标题与标签。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "rel_path": {"type": "string", "description": "相对路径，如 'notes/antigravity-tips.md'"},
                "content": {"type": "string", "description": "Markdown 正文内容"},
                "title": {"type": "string", "description": "可选：笔记标题（若正文无 Frontmatter 将自动写入）"},
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "可选：标签数组",
                },
                "vault": {"type": "string", "description": "可选：目标 Vault ID"},
                "overwrite": {"type": "boolean", "description": "是否允许覆盖已有笔记，默认 true"},
            },
            "required": ["rel_path", "content"],
        },
    },
    {
        "name": "kb_append",
        "description": "向已有知识库笔记末尾追加一段记录（若笔记不存在则自动新建）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": {"type": "string", "description": "目标笔记相对路径或标题"},
                "content": {"type": "string", "description": "要追加的 Markdown 内容"},
                "section": {"type": "string", "description": "可选：自动添加的二级标题（如 '2026-11-23 排查记录'）"},
                "vault": {"type": "string", "description": "可选：目标 Vault ID"},
            },
            "required": ["note", "content"],
        },
    },
]

TOOL_HANDLERS = {
    "kb_list": tool_kb_list,
    "kb_search": tool_kb_search,
    "kb_read": tool_kb_read,
    "kb_write": tool_kb_write,
    "kb_append": tool_kb_append,
}


def handle_rpc_request(msg):
    if not isinstance(msg, dict):
        return None
    msg_id = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

    # Notifications have no id
    if msg_id is None:
        return None

    if method == "initialize":
        proto = params.get("protocolVersion") or "2024-11-05"
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": proto,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "antigravity-kb", "version": "1.0.0"},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        handler = TOOL_HANDLERS.get(name)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"未知工具: {name}"}],
                    "isError": True,
                },
            }
        try:
            payload = handler(arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
                    "isError": False,
                },
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"执行失败: {exc}"}],
                    "isError": True,
                },
            }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    ensure_default_vault()
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
