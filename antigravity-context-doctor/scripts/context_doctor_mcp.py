"""
Antigravity 上下文洞察与诊断面板 MCP App Server (stdio JSON-RPC 2.0)
零第三方依赖（纯 Python 标准库）：
- 通过本机 Antigravity Language Server RPC 获取会话列表、Generator token 用量与轨迹步骤
- 若轨迹步骤 RPC 不可用，自动回退解析 ~/.gemini/antigravity/brain/<cid>/.system_generated/logs/transcript.jsonl
- 向 Antigravity 原生右侧边栏 (aux_pane) 与全局侧栏 (global) 注册 MCP App (`ui://context-doctor/app.html`)
"""

import json
import os
import pathlib
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone

SUPPORTED_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_CONFIG_PATH = os.path.join(PLUGIN_DIR, "runtime", "context-doctor-config.json")
FALLBACK_CONFIG_PATH = os.path.join(
    os.path.expanduser("~"),
    ".gemini",
    "config",
    "plugins",
    "antigravity-context-doctor",
    "runtime",
    "context-doctor-config.json",
)
BRAIN_ROOT = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity", "brain")

CD_APP_URI = "ui://context-doctor/app.html"
CD_APP_MIME = "text/html;profile=mcp-app"
CD_APP_HTML_PATH = os.path.join(PLUGIN_DIR, "app", "dist", "app.html")
FALLBACK_APP_HTML_PATH = os.path.join(
    os.path.expanduser("~"),
    ".gemini",
    "config",
    "plugins",
    "antigravity-context-doctor",
    "app",
    "dist",
    "app.html",
)

LS_SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService/"
_LS_SCHEME_CACHE = {}
_LS_UNREACHABLE_UNTIL = 0.0
_LS_COOLDOWN_SEC = 20.0

DEFAULT_PREFS = {
    "warnThresholdPct": 75,
    "criticalThresholdPct": 90,
    "langMode": "auto",
    "customModelLimits": {},
}

MODEL_LIMIT_RULES = [
    (r"gemini.*(2\.5|3|4|pro|flash|neon)", 1000000),
    (r"claude.*(3\.5|3\.7|4|sonnet|opus|haiku)", 200000),
    (r"gpt-5|gpt-6|o3|o4", 400000),
    (r"gpt-4o|gpt-4\.1", 128000),
]


def get_config_path():
    plugin_data = os.environ.get("PLUGIN_DATA")
    if plugin_data:
        return os.path.join(plugin_data, "context-doctor-config.json")
    if os.path.exists(DEFAULT_CONFIG_PATH):
        return DEFAULT_CONFIG_PATH
    if os.path.exists(FALLBACK_CONFIG_PATH):
        return FALLBACK_CONFIG_PATH
    return DEFAULT_CONFIG_PATH


def atomic_write_text(path, text):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".cd-tmp-", dir=parent or None)
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


def load_prefs():
    prefs = dict(DEFAULT_PREFS)
    prefs["customModelLimits"] = {}
    for cfg_path in (get_config_path(), DEFAULT_CONFIG_PATH, FALLBACK_CONFIG_PATH):
        if cfg_path and os.path.exists(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        for k in ("warnThresholdPct", "criticalThresholdPct", "langMode"):
                            if k in data:
                                prefs[k] = data[k]
                        if isinstance(data.get("customModelLimits"), dict):
                            prefs["customModelLimits"] = dict(data["customModelLimits"])
                        break
            except Exception:
                continue
    return prefs


def save_prefs(updates):
    prefs = load_prefs()
    if isinstance(updates, dict):
        if "warnThresholdPct" in updates:
            try:
                prefs["warnThresholdPct"] = max(40, min(95, int(updates["warnThresholdPct"])))
            except (TypeError, ValueError):
                pass
        if "criticalThresholdPct" in updates:
            try:
                prefs["criticalThresholdPct"] = max(50, min(99, int(updates["criticalThresholdPct"])))
            except (TypeError, ValueError):
                pass
        if updates.get("langMode") in ("auto", "zh", "en"):
            prefs["langMode"] = updates["langMode"]
        if isinstance(updates.get("customModelLimits"), dict):
            cleaned = {}
            for k, v in updates["customModelLimits"].items():
                try:
                    n = int(v)
                    if n >= 16000:
                        cleaned[str(k)] = n
                except (TypeError, ValueError):
                    pass
            prefs["customModelLimits"] = cleaned
    atomic_write_text(get_config_path(), json.dumps(prefs, ensure_ascii=False, indent=2) + "\n")
    return prefs


def load_cd_app_html():
    for path in (os.environ.get("AGY_CD_APP_HTML") or "", CD_APP_HTML_PATH, FALLBACK_APP_HTML_PATH):
        if path and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
    raise FileNotFoundError(f"未找到上下文洞察 MCP App HTML 资源: {CD_APP_HTML_PATH}")


def parse_num(val):
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str) and val.strip():
        try:
            return float(val)
        except ValueError:
            return 0.0
    return 0.0


def parse_ts_ms(ts):
    if not ts:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e12 else ts * 1000)
    if isinstance(ts, str):
        try:
            s = ts.strip().replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            return 0
    if isinstance(ts, dict) and "seconds" in ts:
        sec = parse_num(ts.get("seconds"))
        nanos = parse_num(ts.get("nanos"))
        return int(sec * 1000 + nanos / 1e6)
    return 0


def parse_duration_sec(dur):
    if not dur:
        return 0.0
    if isinstance(dur, (int, float)):
        return max(0.0, float(dur))
    if isinstance(dur, str):
        m = re.match(r"^(-?\d+(?:\.\d+)?)s$", dur.strip(), re.I)
        return max(0.0, float(m.group(1))) if m else 0.0
    if isinstance(dur, dict):
        return max(0.0, parse_num(dur.get("seconds")) + parse_num(dur.get("nanos")) / 1e9)
    return 0.0


def estimate_tokens(text):
    if not text:
        return 0
    s = str(text)
    cjk = len(re.findall(r"[\u3400-\u9fff\uf900-\ufaff]", s))
    other = max(0, len(s) - cjk)
    return max(1, int(cjk * 1.45 + other / 3.8))


def resolve_model_limit(model_name, custom_limits=None):
    key = str(model_name or "").strip()
    if isinstance(custom_limits, dict) and key in custom_limits:
        return int(custom_limits[key])
    low = key.lower()
    for pat, limit in MODEL_LIMIT_RULES:
        if re.search(pat, low):
            return limit
    return 1000000 if "gemini" in low else 200000


def _is_loopback_url(url):
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        return host in ("localhost", "127.0.0.1", "::1")
    except Exception:
        return False


def _normalize_file_path_and_uri(raw_path):
    if not raw_path:
        return "", ""
    s = str(raw_path).strip()
    if s.lower().startswith("file://"):
        parsed = urllib.parse.urlparse(s)
        local = urllib.parse.unquote(parsed.path or "")
        if re.match(r"^/[A-Za-z]:", local):
            local = local[1:]
        try:
            return local, pathlib.Path(local).as_uri()
        except Exception:
            return local, s
    try:
        return s, pathlib.Path(os.path.abspath(s)).as_uri()
    except Exception:
        return s, ""


def _normalize_ls_addr(addr):
    s = str(addr or "").strip()
    if not s:
        return "127.0.0.1:5387"
    # Windows 下 localhost 会先解析 IPv6 ::1 触发 ~2s 超时；归一化为 127.0.0.1 可将本地 RPC 从 2.1s 降至 ~3ms
    return re.sub(r"(^|://)localhost(?=(?::\d+)?(?:/|$))", r"\g<1>127.0.0.1", s, flags=re.I)


def call_ls_rpc(method, payload=None, timeout=1.2):
    global _LS_UNREACHABLE_UNTIL
    raw_addr = (os.environ.get("ANTIGRAVITY_LS_ADDRESS") or "").strip()
    if not raw_addr:
        raise RuntimeError("ANTIGRAVITY_LS_ADDRESS 未注入，直接回退本地数据")
    addr = _normalize_ls_addr(raw_addr)
    csrf = os.environ.get("ANTIGRAVITY_CSRF_TOKEN") or ""
    body = json.dumps(payload or {}).encode("utf-8")

    if addr.startswith(("http://", "https://")):
        schemes = [""]
    else:
        cached = _LS_SCHEME_CACHE.get(addr)
        schemes = [cached, "https" if cached == "http" else "http"] if cached else ["http", "https"]

    last_err = None
    for scheme in schemes:
        base = f"{scheme}://{addr}" if scheme else addr.rstrip("/")
        url = f"{base}{LS_SERVICE_PREFIX}{method}"
        loopback = _is_loopback_url(url)
        headers = {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
        }
        if csrf and loopback:
            headers["x-codeium-csrf-token"] = csrf
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        ctx = ssl._create_unverified_context() if (url.startswith("https://") and loopback) else None
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                if scheme:
                    _LS_SCHEME_CACHE[addr] = scheme
                _LS_UNREACHABLE_UNTIL = 0.0
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")[:180]
            except Exception:
                pass
            last_err = RuntimeError(f"HTTP {exc.code}: {err_body}")
            # HTTP 400 可能是纯 HTTP 打到 HTTPS-only 端口所致，允许继续尝试 HTTPS
            if exc.code in (401, 403, 404):
                break
        except urllib.error.URLError as exc:
            last_err = exc
            # 端口明确拒绝连接（WinError 10061 / ECONNREFUSED）时无需再尝试另一协议
            reason = getattr(exc, "reason", None)
            if isinstance(reason, ConnectionRefusedError) or getattr(reason, "winerror", None) in (10061, 10013):
                break
        except Exception as exc:
            last_err = exc
    raise last_err or RuntimeError("Language Server 不可用")


def extract_steps_from_ls(resp):
    if not isinstance(resp, dict):
        return []
    for key in ("steps", "trajectorySteps", "trajectory_steps", "items"):
        if isinstance(resp.get(key), list):
            return resp[key]
    traj = resp.get("trajectory")
    if isinstance(traj, dict):
        for key in ("steps", "trajectorySteps", "trajectory_steps", "items"):
            if isinstance(traj.get(key), list):
                return traj[key]
    return []


def discover_local_brain_sessions(limit=20):
    if not os.path.isdir(BRAIN_ROOT):
        return []
    found = []
    try:
        for name in os.listdir(BRAIN_ROOT):
            if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", name):
                continue
            tpath = os.path.join(BRAIN_ROOT, name, ".system_generated", "logs", "transcript.jsonl")
            if os.path.isfile(tpath):
                try:
                    mtime_ms = int(os.path.getmtime(tpath) * 1000)
                except OSError:
                    mtime_ms = 0
                found.append({
                    "cascadeId": name,
                    "title": f"Local {name[:8]}",
                    "status": "LOCAL",
                    "isRunning": False,
                    "stepCount": 0,
                    "lastModifiedMs": mtime_ms,
                    "parentCascadeId": "",
                    "isSubtrajectory": False,
                })
    except OSError:
        return []
    found.sort(key=lambda s: s["lastModifiedMs"], reverse=True)
    return found[:limit]


def read_local_transcript_steps(cascade_id, tail_limit=400):
    if not cascade_id or not re.fullmatch(r"[0-9a-fA-F-]{8,64}", str(cascade_id)):
        return []
    path = os.path.join(BRAIN_ROOT, str(cascade_id), ".system_generated", "logs", "transcript.jsonl")
    if not os.path.isfile(path):
        return []
    steps = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            tail_lines = deque(f, maxlen=tail_limit)
        for line in tail_lines:
            raw = line.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except Exception:
                continue
            if isinstance(entry, dict):
                steps.append({"_transcriptEntry": entry})
    except Exception:
        return []
    return steps


def classify_step(step, idx):
    if not isinstance(step, dict):
        return None

    # Local transcript.jsonl fallback entry
    if "_transcriptEntry" in step:
        entry = step["_transcriptEntry"]
        role = str(entry.get("role") or entry.get("type") or "").lower()
        text = json.dumps(entry, ensure_ascii=False)
        est = estimate_tokens(text)
        cat = "assistant"
        badge = "AI"
        title = f"Step #{idx + 1}"
        file_path = ""
        if "user" in role:
            cat, badge = "user", "user"
            title = str(entry.get("text") or entry.get("content") or title)[:72]
        elif "tool" in role or "function" in role:
            name = str(entry.get("name") or entry.get("tool") or "tool")
            low_name = name.lower()
            if any(k in low_name for k in ("read", "view", "grep", "find", "list", "search")):
                cat, badge = "file_read", "read"
            elif any(k in low_name for k in ("edit", "write", "replace", "patch")):
                cat, badge = "file_edit", "edit"
            elif any(k in low_name for k in ("command", "run", "shell", "terminal")):
                cat, badge = "command", "cmd"
            else:
                cat, badge = "agent_tool", "agent"
            title = name
        return {
            "index": idx + 1,
            "category": cat,
            "badge": badge,
            "title": title.strip() or f"Step #{idx + 1}",
            "estTokens": est,
            "filePath": file_path,
            "preview": text[:800],
        }

    stype = str(step.get("type") or "").upper()
    text = json.dumps(step, ensure_ascii=False)
    est = estimate_tokens(text)
    cat = "assistant"
    badge = "AI"
    title = stype.replace("CORTEX_STEP_TYPE_", "").lower() or f"step-{idx + 1}"
    file_path = ""

    if "USER_INPUT" in stype:
        cat, badge = "user", "user"
        ui = step.get("userInput") or {}
        title = str(ui.get("userResponse") or ui.get("query") or "用户输入")[:72]
    elif any(k in stype for k in ("VIEW_FILE", "READ", "GREP", "FIND", "LIST_DIR", "SEARCH")):
        cat, badge = "file_read", "read"
        for k in ("viewFile", "grepSearch", "findByName", "listDirectory"):
            sub = step.get(k)
            if isinstance(sub, dict):
                file_path = str(
                    sub.get("absolutePathUri")
                    or sub.get("absolutePath")
                    or sub.get("path")
                    or sub.get("searchPath")
                    or ""
                )
                if file_path:
                    norm_fp, _ = _normalize_file_path_and_uri(file_path)
                    title = os.path.basename(norm_fp) or norm_fp
                    break
    elif any(k in stype for k in ("WRITE_TO_FILE", "REPLACE_FILE", "MULTI_REPLACE", "EDIT", "CODE_ACTION")):
        cat, badge = "file_edit", "edit"
        for k in ("writeToFile", "replaceFileContent", "multiReplaceFileContent", "codeAction"):
            sub = step.get(k)
            if isinstance(sub, dict):
                file_path = str(
                    sub.get("targetFile")
                    or sub.get("absolutePathUri")
                    or sub.get("absolutePath")
                    or sub.get("path")
                    or ""
                )
                if file_path:
                    norm_fp, _ = _normalize_file_path_and_uri(file_path)
                    title = os.path.basename(norm_fp) or norm_fp
                    break
    elif any(k in stype for k in ("RUN_COMMAND", "COMMAND_STATUS", "SHELL")):
        cat, badge = "command", "cmd"
        rc = step.get("runCommand") or {}
        title = str(rc.get("commandLine") or rc.get("command") or "终端命令")[:72]
    elif any(k in stype for k in ("MCP", "SUBAGENT", "BROWSER", "TASK")):
        cat, badge = "agent_tool", "agent"
        title = stype.replace("CORTEX_STEP_TYPE_", "").lower()
    elif "PLANNER_RESPONSE" in stype:
        cat, badge = "assistant", "AI"
        pr = step.get("plannerResponse") or {}
        title = str(pr.get("response") or pr.get("thinking") or "AI 回复")[:72]

    return {
        "index": idx + 1,
        "category": cat,
        "badge": badge,
        "title": title.strip() or f"Step #{idx + 1}",
        "estTokens": est,
        "filePath": file_path,
        "preview": text[:240],
    }


def analyze_generator_calls(gen_list):
    calls = []
    total_cache_read = 0
    total_input = 0
    compactions = 0
    prev_ctx = 0
    tps_samples = []
    latest_model = ""

    for item in gen_list or []:
        if not isinstance(item, dict):
            continue
        cm = item.get("chatModel") or item.get("chat_model") or {}
        usage = cm.get("usage")
        if not isinstance(usage, dict) or not usage:
            continue
        inp = int(parse_num(usage.get("inputTokens") or usage.get("input_tokens")))
        cache_read = int(parse_num(usage.get("cacheReadTokens") or usage.get("cache_read_tokens")))
        out = int(parse_num(usage.get("outputTokens") or usage.get("output_tokens")))
        if inp <= 0 and cache_read <= 0 and out <= 0:
            continue
        model = str(cm.get("model") or latest_model or "")
        if model:
            latest_model = model
        # 兼容两种口径：Gemini/OpenAI 的 inputTokens 通常已包含 cacheReadTokens；Claude 的 inputTokens 通常不含 cacheReadTokens
        is_claude = "claude" in model.lower()
        ctx = (inp + cache_read) if (is_claude or inp < cache_read) else inp
        dur = parse_duration_sec(cm.get("timeToLastToken") or cm.get("streamingDuration") or cm.get("latency"))
        tps = (out / dur) if dur > 0.05 and out > 0 else 0.0
        if tps > 0:
            tps_samples.append(tps)
        compacted = prev_ctx > 20000 and ctx > 0 and ctx < prev_ctx * 0.72
        spiked = prev_ctx > 0 and (ctx - prev_ctx) >= 25000
        if compacted:
            compactions += 1
        if ctx > 0:
            prev_ctx = ctx
        total_cache_read += min(cache_read, ctx)
        total_input += ctx
        calls.append({
            "turn": len(calls) + 1,
            "contextTokens": ctx,
            "inputTokens": inp,
            "cacheReadTokens": cache_read,
            "outputTokens": out,
            "compacted": compacted,
            "spiked": spiked,
            "tps": round(tps, 1),
        })

    latest_ctx = calls[-1]["contextTokens"] if calls else 0
    peak_ctx = max((c["contextTokens"] for c in calls), default=0)
    cache_hit_pct = (total_cache_read / total_input * 100.0) if total_input > 0 else 0.0
    avg_tps = (sum(tps_samples) / len(tps_samples)) if tps_samples else 0.0
    return {
        "calls": calls,
        "latestContextTokens": latest_ctx,
        "peakContextTokens": peak_ctx,
        "totalCacheRead": total_cache_read,
        "cacheHitPct": round(cache_hit_pct, 2),
        "callCount": len(calls),
        "compactions": compactions,
        "avgTps": round(avg_tps, 1),
        "model": latest_model,
    }


def build_snapshot(cascade_id=None, prefs=None):
    global _LS_UNREACHABLE_UNTIL
    prefs = prefs or load_prefs()
    rpc_diag = {"traj": "", "gen": "", "steps": ""}
    summaries = {}
    ls_available = False
    now_mono = time.monotonic()
    if now_mono < _LS_UNREACHABLE_UNTIL:
        rpc_diag["traj"] = "cooldown(offline)"
    else:
        try:
            traj_resp = call_ls_rpc("GetAllCascadeTrajectories", {})
            summaries = traj_resp.get("trajectorySummaries") or {}
            rpc_diag["traj"] = f"OK({len(summaries)})"
            ls_available = True
        except Exception as exc:
            rpc_diag["traj"] = str(exc)[:100]
            _LS_UNREACHABLE_UNTIL = time.monotonic() + _LS_COOLDOWN_SEC

    sessions = []
    now_ms = int(time.time() * 1000)
    for cid, info in summaries.items():
        if not isinstance(info, dict):
            continue
        mod_ms = parse_ts_ms(info.get("lastModifiedTime"))
        status = str(info.get("status") or "")
        sessions.append({
            "cascadeId": cid,
            "title": str(info.get("summary") or f"Session {cid[:8]}"),
            "status": status,
            "isRunning": "RUNNING" in status.upper(),
            "stepCount": int(parse_num(info.get("stepCount"))),
            "lastModifiedMs": mod_ms,
            "parentCascadeId": str(info.get("parentCascadeId") or ""),
            "isSubtrajectory": bool(info.get("isSubtrajectory")),
        })

    sessions.sort(key=lambda s: (1 if s["isRunning"] else 0, s["lastModifiedMs"]), reverse=True)
    if not sessions:
        sessions = discover_local_brain_sessions(limit=20)
    main_sessions = [s for s in sessions if not s["isSubtrajectory"] and not s["parentCascadeId"]]

    target_cid = str(cascade_id or "").strip()
    if not target_cid and main_sessions:
        target_cid = main_sessions[0]["cascadeId"]
    elif not target_cid and sessions:
        target_cid = sessions[0]["cascadeId"]

    gen_list = []
    if target_cid and ls_available:
        try:
            gen_resp = call_ls_rpc(
                "GetCascadeTrajectoryGeneratorMetadata",
                {"cascadeId": target_cid, "generatorMetadataOffset": 0, "includeMessages": False},
            )
            gen_list = gen_resp.get("generatorMetadata") or gen_resp.get("generator_metadata") or []
            rpc_diag["gen"] = f"OK({len(gen_list)})"
        except Exception as exc:
            rpc_diag["gen"] = str(exc)[:100]
    elif target_cid:
        rpc_diag["gen"] = "skipped(offline)"

    raw_steps = []
    if target_cid:
        if ls_available:
            try:
                s_resp = call_ls_rpc("GetCascadeTrajectory", {"cascadeId": target_cid})
                raw_steps = extract_steps_from_ls(s_resp)
            except Exception as exc:
                rpc_diag["steps"] = str(exc)[:80]
            if not raw_steps:
                try:
                    s_resp2 = call_ls_rpc("GetCascadeTrajectorySteps", {"cascadeId": target_cid, "stepOffset": 0})
                    raw_steps = extract_steps_from_ls(s_resp2)
                except Exception as exc2:
                    if not rpc_diag["steps"]:
                        rpc_diag["steps"] = str(exc2)[:80]
        if raw_steps:
            rpc_diag["steps"] = f"OK({len(raw_steps)})"
        else:
            local_steps = read_local_transcript_steps(target_cid)
            if local_steps:
                raw_steps = local_steps
                rpc_diag["steps"] = f"transcript({len(local_steps)})"

    gen_stats = analyze_generator_calls(gen_list)
    classified = [c for c in (classify_step(s, i) for i, s in enumerate(raw_steps)) if c]

    categories = {
        "user": 0,
        "assistant": 0,
        "file_read": 0,
        "command": 0,
        "file_edit": 0,
        "agent_tool": 0,
    }
    file_map = {}
    for item in classified:
        cat = item["category"]
        if cat in categories:
            categories[cat] += item["estTokens"]
        fp = item.get("filePath")
        if fp:
            clean_fp, file_uri = _normalize_file_path_and_uri(fp)
            rec = file_map.setdefault(clean_fp, {"path": clean_fp, "fileUri": file_uri, "reads": 0, "edits": 0, "estTokens": 0})
            if cat == "file_edit":
                rec["edits"] += 1
            else:
                rec["reads"] += 1
            rec["estTokens"] += item["estTokens"]

    step_est_total = sum(categories.values())
    latest_ctx = gen_stats["latestContextTokens"] or step_est_total
    model_name = gen_stats["model"] or "Gemini"
    window_limit = resolve_model_limit(model_name, prefs.get("customModelLimits"))
    occupancy_pct = round(min(100.0, (latest_ctx / window_limit * 100.0)) if window_limit > 0 else 0.0, 2)

    # 若步骤估算总和超过实测窗口（如发生过上下文压缩），按比例归一化到实测窗口，确保 Treemap 图块之和严格等于当前窗口用量
    if gen_stats["latestContextTokens"] > 0 and step_est_total > gen_stats["latestContextTokens"]:
        scale = gen_stats["latestContextTokens"] / step_est_total
        for k in list(categories.keys()):
            categories[k] = int(round(categories[k] * scale))
        system_overhead = 0
    else:
        system_overhead = max(0, latest_ctx - step_est_total) if latest_ctx > 0 else 0
    categories["system_overhead"] = system_overhead

    total_for_share = max(1, step_est_total or latest_ctx)
    heavy_hitters = sorted(classified, key=lambda x: x["estTokens"], reverse=True)[:25]
    for h in heavy_hitters:
        h["sharePct"] = round(h["estTokens"] / total_for_share * 100.0, 1)

    file_activities = sorted(file_map.values(), key=lambda x: x["estTokens"], reverse=True)[:20]
    fleet = [s for s in sessions if s["parentCascadeId"] == target_cid][:20]

    warn_pct = prefs.get("warnThresholdPct", 75)
    crit_pct = prefs.get("criticalThresholdPct", 90)
    if latest_ctx <= 0 and gen_stats["callCount"] == 0 and not classified:
        health = {"level": "unknown", "title": "暂无上下文数据", "desc": "未获取到本机 Language Server 或本地轨迹数据，请确认会话已开始运行后点击刷新。"}
    elif occupancy_pct >= crit_pct:
        health = {"level": "critical", "title": "上下文接近上限", "desc": "建议立即生成交接 Prompt 开启新会话，避免上下文被强制压缩丢失细节。"}
    elif occupancy_pct >= warn_pct:
        health = {"level": "warn", "title": "上下文水位偏高", "desc": "可先梳理大户步骤并准备交接摘要，保持较高缓存命中率。"}
    else:
        health = {"level": "ok", "title": "上下文健康度良好", "desc": "当前窗口水位可控，结构分布均衡，暂无清理压力。"}

    active_meta = next((s for s in sessions if s["cascadeId"] == target_cid), None)
    session_title = active_meta["title"] if active_meta else (f"Session {target_cid[:8]}" if target_cid else "当前会话")

    # Build handoff prompt draft
    handoff_lines = [
        f"# 会话交接摘要：{session_title}",
        f"- 原会话 ID：`{target_cid or 'N/A'}`",
        f"- 当前模型：`{model_name}`（上下文占用 {occupancy_pct}%）",
    ]
    if file_activities:
        handoff_lines.append("\n## 涉及的关键文件")
        for fitem in file_activities[:10]:
            handoff_lines.append(f"- `{fitem['path']}` (读 {fitem['reads']} / 改 {fitem['edits']})")
    cmd_steps = [x for x in classified if x["category"] == "command"][-6:]
    if cmd_steps:
        handoff_lines.append("\n## 最近执行的关键命令")
        for citem in cmd_steps:
            handoff_lines.append(f"- `{citem['title']}`")
    handoff_lines.append("\n## 下一步")
    handoff_lines.append("- 请基于以上上下文继续推进当前任务。")

    seven_days_ago = now_ms - 7 * 86400 * 1000
    recent_7d = [s for s in main_sessions if s["lastModifiedMs"] >= seven_days_ago]

    return {
        "ok": True,
        "updatedAtMs": now_ms,
        "prefs": prefs,
        "active": {
            "cascadeId": target_cid,
            "title": session_title,
            "model": model_name,
            "windowLimit": window_limit,
            "latestContextTokens": latest_ctx,
            "peakContextTokens": gen_stats["peakContextTokens"],
            "occupancyPct": occupancy_pct,
            "cacheHitPct": gen_stats["cacheHitPct"],
            "totalCacheRead": gen_stats["totalCacheRead"],
            "callCount": gen_stats["callCount"],
            "compactions": gen_stats["compactions"],
            "avgTps": gen_stats["avgTps"],
            "categories": categories,
            "trend": gen_stats["calls"][-24:],
            "heavyHitters": heavy_hitters,
            "fileActivities": file_activities,
            "fleet": fleet,
            "health": health,
            "handoffPrompt": "\n".join(handoff_lines),
            "rpcDiag": rpc_diag,
        },
        "sessions": main_sessions[:30],
        "globalStats": {
            "sessions7d": len(recent_7d),
            "totalSessions": len(main_sessions),
            "totalSteps7d": sum(s["stepCount"] for s in recent_7d),
            "runningCount": sum(1 for s in sessions if s["isRunning"]),
        },
    }


def tool_context_doctor_open(args):
    args = args if isinstance(args, dict) else {}
    return build_snapshot(cascade_id=args.get("cascade_id"))


def tool_context_doctor_summary(args):
    args = args if isinstance(args, dict) else {}
    snap = build_snapshot(cascade_id=args.get("cascade_id"))
    a = snap["active"]
    return {
        "cascadeId": a["cascadeId"],
        "title": a["title"],
        "model": a["model"],
        "latestContextTokens": a["latestContextTokens"],
        "windowLimit": a["windowLimit"],
        "occupancyPct": a["occupancyPct"],
        "cacheHitPct": a["cacheHitPct"],
        "callCount": a["callCount"],
        "compactions": a["compactions"],
        "health": a["health"],
        "topHeavyHitters": a["heavyHitters"][:5],
        "topFiles": a["fileActivities"][:8],
    }


def tool_cd_app_snapshot(args):
    args = args if isinstance(args, dict) else {}
    return build_snapshot(cascade_id=args.get("cascade_id"))


def tool_cd_app_save_prefs(args):
    args = args if isinstance(args, dict) else {}
    prefs = save_prefs(args.get("prefs") or args)
    return build_snapshot(cascade_id=args.get("cascade_id"), prefs=prefs)


TOOLS = [
    {
        "name": "open_panel",
        "title": "上下文交接沙箱",
        "description": "按需异步打开上下文交接 MCP App 沙箱面板（仅用于交接 Prompt 附加/发送；日常上下文洞察由本地侧栏 0ms 秒开承载）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cascade_id": {"type": "string", "description": "可选：指定查看的会话 ID"},
            },
        },
        "_meta": {
            "ui": {"resourceUri": CD_APP_URI},
        },
    },
    {
        "name": "summary",
        "description": "获取当前或指定会话的上下文窗口占用率、缓存命中率、大户步骤和健康诊断摘要。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cascade_id": {"type": "string", "description": "可选：指定分析的会话 ID"},
            },
        },
    },
    {
        "name": "app_snapshot",
        "description": "App-only: 获取上下文洞察面板的完整实时快照。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cascade_id": {"type": "string"},
            },
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
    {
        "name": "app_save_prefs",
        "description": "App-only: 保存上下文洞察预警阈值、自定义模型窗口上限等偏好设置。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cascade_id": {"type": "string"},
                "prefs": {"type": "object"},
            },
        },
        "_meta": {"ui": {"visibility": ["app"]}},
    },
]

TOOL_HANDLERS = {
    "open_panel": tool_context_doctor_open,
    "summary": tool_context_doctor_summary,
    "app_snapshot": tool_cd_app_snapshot,
    "app_save_prefs": tool_cd_app_save_prefs,
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
                "serverInfo": {"name": "antigravity-context-doctor", "version": "2.0.0"},
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
                        "uri": CD_APP_URI,
                        "name": "Antigravity 上下文洞察",
                        "description": "Antigravity 原生右侧边栏上下文窗口与诊断 UI",
                        "mimeType": CD_APP_MIME,
                        "_meta": {"ui": {"prefersBorder": False, "permissions": {"clipboardWrite": {}}}},
                    }
                ]
            },
        }
    if method == "resources/read":
        uri = params.get("uri")
        if uri != CD_APP_URI:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32002, "message": f"Resource not found: {uri}"},
            }
        try:
            html = load_cd_app_html()
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "contents": [
                        {
                            "uri": CD_APP_URI,
                            "mimeType": CD_APP_MIME,
                            "text": html,
                            "_meta": {"ui": {"prefersBorder": False, "permissions": {"clipboardWrite": {}}}},
                        }
                    ]
                },
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32603, "message": f"读取上下文洞察 UI 失败: {exc}"},
            }
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        raw_args = params.get("arguments")
        if raw_args is not None and not isinstance(raw_args, dict):
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": "参数错误: arguments 必须是 JSON 对象"}],
                    "isError": True,
                },
            }
        arguments = raw_args if isinstance(raw_args, dict) else {}
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
            if name == "open_panel":
                a = payload.get("active", {})
                text_out = f"已打开上下文洞察面板：{a.get('title', '当前会话')}，窗口占用 {a.get('occupancyPct', 0)}%，缓存命中率 {a.get('cacheHitPct', 0)}%。"
            else:
                text_out = json.dumps(payload, ensure_ascii=False, indent=2)
            result_obj = {
                "content": [{"type": "text", "text": text_out}],
                "isError": False,
            }
            if isinstance(payload, dict):
                result_obj["structuredContent"] = payload
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": result_obj,
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
