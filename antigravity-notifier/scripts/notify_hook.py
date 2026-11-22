"""
Stop hook & Webhook dispatcher for antigravity-notifier.
- Runs quickly on Stop hook: reads config, spawns detached background sender if enabled, prints {}.
- Supports Feishu, WeCom, Discord, Telegram, and Custom JSON Webhooks.
- Supports `python scripts/notify_hook.py --test` for direct CLI verification.
"""

import base64
import hashlib
import hmac
import html
import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
RUNTIME_DIR = os.path.join(PLUGIN_DIR, "runtime")
CONFIG_PATH = os.path.join(RUNTIME_DIR, "notifier-config.json")
LOG_PATH = os.path.join(RUNTIME_DIR, "notify.log")


def write_notify_log(message):
    try:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 65536:
            with open(LOG_PATH, "w", encoding="utf-8") as f:
                f.write("")
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {message}\n")
    except Exception:
        pass


def load_config():
    try:
        if not os.path.exists(CONFIG_PATH):
            return None
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as exc:
        write_notify_log(f"Failed to read notifier-config.json: {exc}")
        return None


def is_plugin_enabled():
    try:
        if SCRIPT_DIR not in sys.path:
            sys.path.insert(0, SCRIPT_DIR)
        import plugin_host  # noqa: E402

        return plugin_host.is_plugin_enabled()
    except Exception:
        return True


def classify_stop_event(payload, cfg):
    reason = str(payload.get("terminationReason") or "NO_TOOL_CALL").upper()
    error_text = str(payload.get("error") or "").strip()

    if reason == "USER_CANCELED" and not cfg.get("notifyOnCancel", False):
        return None

    if error_text or reason == "ERROR":
        if not cfg.get("notifyOnError", True):
            return None
        kind = "error"
        title = f"❌ {cfg.get('titlePrefix') or 'Antigravity'} 任务异常中断"
        color = "red"
        hex_color = 0xEF4444
    elif reason in (
        "MAX_INVOCATIONS",
        "MAX_FORCED_INVOCATIONS",
        "MAX_TOKEN_BUDGET_EXCEEDED",
    ):
        if not cfg.get("notifyOnMaxLimit", True):
            return None
        kind = "warn"
        title = f"⚠️ {cfg.get('titlePrefix') or 'Antigravity'} 任务达到上限暂停"
        color = "orange"
        hex_color = 0xF59E0B
    else:
        if not cfg.get("notifyOnComplete", True):
            return None
        kind = "complete"
        title = f"✅ {cfg.get('titlePrefix') or 'Antigravity'} 任务已完成"
        color = "green"
        hex_color = 0x10B981

    workspaces = payload.get("workspacePaths") or []
    workspace = os.path.basename(str(workspaces[0])) if workspaces else ""
    last_input = str(payload.get("lastUserInput") or "").strip().replace("\n", " ")
    if len(last_input) > 120:
        last_input = last_input[:117] + "..."

    return {
        "kind": kind,
        "title": title,
        "color": color,
        "hex_color": hex_color,
        "reason": reason,
        "error": error_text[:240] if error_text else "",
        "model": str(payload.get("modelName") or ""),
        "workspace": workspace,
        "lastUserInput": last_input,
        "conversationId": str(payload.get("conversationId") or ""),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
    }


def compute_feishu_sign(secret, timestamp_str):
    string_to_sign = f"{timestamp_str}\n{secret}"
    hmac_code = hmac.new(
        string_to_sign.encode("utf-8"), digestmod=hashlib.sha256
    ).digest()
    return base64.b64encode(hmac_code).decode("utf-8")


def build_webhook_request(cfg, event_info):
    provider = str(cfg.get("provider") or "custom").strip().lower()
    url = str(cfg.get("webhookUrl") or "").strip()
    headers = {"Content-Type": "application/json; charset=utf-8"}

    custom_headers = cfg.get("customHeaders")
    if isinstance(custom_headers, dict):
        for k, v in custom_headers.items():
            if isinstance(k, str) and v is not None:
                headers[k] = str(v)

    lines = []
    if event_info.get("workspace"):
        lines.append(f"工作区: {event_info['workspace']}")
    if event_info.get("model"):
        lines.append(f"模型: {event_info['model']}")
    if event_info.get("lastUserInput"):
        lines.append(f"任务: {event_info['lastUserInput']}")
    if event_info.get("error"):
        lines.append(f"错误: {event_info['error']}")
    lines.append(f"状态: {event_info['reason']} · {event_info['timestamp']}")
    summary_text = "\n".join(lines)

    if provider == "feishu":
        md_lines = [f"**{line.split(':', 1)[0]}**: {line.split(':', 1)[1].strip()}" if ":" in line else line for line in lines]
        body = {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {"tag": "plain_text", "content": event_info["title"]},
                    "template": event_info["color"],
                },
                "elements": [
                    {"tag": "markdown", "content": "\n".join(md_lines)}
                ],
            },
        }
        secret = str(cfg.get("secret") or "").strip()
        if secret:
            ts = str(int(time.time()))
            body["timestamp"] = ts
            body["sign"] = compute_feishu_sign(secret, ts)
        return url, headers, body

    if provider == "wecom":
        md_lines = [f"### {event_info['title']}"] + [f"> {line}" for line in lines]
        body = {
            "msgtype": "markdown",
            "markdown": {"content": "\n".join(md_lines)},
        }
        return url, headers, body

    if provider == "discord":
        body = {
            "embeds": [
                {
                    "title": event_info["title"],
                    "description": summary_text,
                    "color": event_info["hex_color"],
                }
            ]
        }
        return url, headers, body

    if provider == "telegram":
        bot_token = str(cfg.get("telegramBotToken") or "").strip()
        chat_id = str(cfg.get("telegramChatId") or "").strip()
        if not url and bot_token:
            url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        safe_title = html.escape(event_info["title"])
        safe_summary = html.escape(summary_text)
        body = {
            "chat_id": chat_id,
            "text": f"<b>{safe_title}</b>\n{safe_summary}",
            "parse_mode": "HTML",
        }
        return url, headers, body

    # custom / generic JSON webhook
    body = {
        "event": event_info["kind"],
        "title": event_info["title"],
        "summary": summary_text,
        "terminationReason": event_info["reason"],
        "error": event_info["error"],
        "model": event_info["model"],
        "workspace": event_info["workspace"],
        "lastUserInput": event_info["lastUserInput"],
        "conversationId": event_info["conversationId"],
        "timestamp": event_info["timestamp"],
    }
    return url, headers, body


def deliver_webhook(cfg, event_info):
    url, headers, body = build_webhook_request(cfg, event_info)
    if not url:
        return False, "webhookUrl 未配置"
    if not (url.startswith("https://") or url.startswith("http://")):
        return False, "webhookUrl 必须以 http:// 或 https:// 开头"

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            status = getattr(resp, "status", 200)
            resp_text = resp.read().decode("utf-8", errors="ignore")[:200]
            write_notify_log(
                f"Webhook sent ({cfg.get('provider')}) status={status} kind={event_info['kind']}"
            )
            return True, f"HTTP {status}: {resp_text or 'ok'}"
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="ignore")[:200]
        except Exception:
            pass
        write_notify_log(f"Webhook HTTPError ({cfg.get('provider')}): {exc.code} {detail}")
        return False, f"HTTP {exc.code}: {detail}"
    except Exception as exc:
        write_notify_log(f"Webhook error ({cfg.get('provider')}): {exc}")
        return False, str(exc)


def spawn_background_delivery(event_info):
    encoded = base64.urlsafe_b64encode(
        json.dumps(event_info, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    cmd = [sys.executable, os.path.abspath(__file__), "--deliver", encoded]
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, **kwargs)


def run_stop_hook():
    payload = {}
    try:
        if not sys.stdin.isatty():
            raw = sys.stdin.read()
            if raw and raw.strip():
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    payload = parsed
    except Exception:
        pass

    if not is_plugin_enabled():
        return {}

    cfg = load_config()
    if not cfg or not cfg.get("enabled"):
        return {}

    event_info = classify_stop_event(payload, cfg)
    if not event_info:
        return {}

    try:
        spawn_background_delivery(event_info)
    except Exception as exc:
        write_notify_log(f"Failed to spawn webhook delivery: {exc}")

    return {}


def main():
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "--deliver":
        cfg = load_config()
        if not cfg or not cfg.get("enabled"):
            return
        try:
            raw = base64.urlsafe_b64decode(args[1].encode("ascii")).decode("utf-8")
            event_info = json.loads(raw)
            if isinstance(event_info, dict):
                deliver_webhook(cfg, event_info)
        except Exception as exc:
            write_notify_log(f"Deliver decode error: {exc}")
        return

    if args and args[0] == "--test":
        cfg = load_config()
        if not cfg:
            print(f"未找到配置文件: {CONFIG_PATH}")
            print("请先复制 runtime/notifier-config.example.json 为 runtime/notifier-config.json 并填写 Webhook。")
            sys.exit(1)
        test_event = {
            "kind": "complete",
            "title": f"✅ {cfg.get('titlePrefix') or 'Antigravity'} 测试推送",
            "color": "green",
            "hex_color": 0x10B981,
            "reason": "MANUAL_TEST",
            "error": "",
            "model": "Test Model",
            "workspace": os.path.basename(PLUGIN_DIR),
            "lastUserInput": "这是一条来自 antigravity-notifier 的测试通知",
            "conversationId": "test-session",
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        }
        ok, msg = deliver_webhook(cfg, test_event)
        print(("推送成功: " if ok else "推送失败: ") + msg)
        sys.exit(0 if ok else 1)

    print(json.dumps(run_stop_hook(), ensure_ascii=False))


if __name__ == "__main__":
    main()
