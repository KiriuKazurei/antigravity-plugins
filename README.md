# Antigravity Plugins Suite

**English** | [简体中文](./README_zh.md)

A curated suite of self-contained productivity and observability plugins for the **Google `Antigravity` 2.0** desktop application. All plugins share a byte-identical host loader (`scripts/pluginLoader.js`), isolate their UI inside `Shadow DOM`, and ship with `SessionStart` self-healing hooks (`hooks.json`) so they survive app updates and coexist seamlessly.

> [!NOTE]
> The Simplified Chinese UI localization plugin is maintained in a dedicated repository: [KiriuKazurei/antigravity-zh-cn-plugin](https://github.com/KiriuKazurei/antigravity-zh-cn-plugin). It uses the exact same host loader and coexists cleanly with all plugins in this repository.

---

## Included Plugins

| Directory | Plugin | Version | Summary | Entry / Shortcut |
| :--- | :--- | :--- | :--- | :--- |
| [`antigravity-context-doctor/`](./antigravity-context-doctor/README.md) | **Context Doctor** | `v1.0.0` | Native right-pane tab for live context window gauge, composition breakdown, heavy-hitter step ranking, file activity, multi-agent fleet view, 7-day insights, and one-click session handoff prompt generation | Right Pane `+ > Plugins > Context Doctor` / `Alt+C` |
| [`antigravity-kb/`](./antigravity-kb/README.md) | **Markdown Knowledge Base** | `v1.0.0` | Local `.md` knowledge base in a native right-pane tab with live preview, `[[` quick note citation, one-click AI reply/code clipping, `[[backlinks]]` & `#tag` search, plus a built-in MCP server for AI retrieval and capture | Right Pane `+ > Plugins > Knowledge Base` / `[[` |
| [`antigravity-usage-dashboard/`](./antigravity-usage-dashboard/README.md) | **Usage Dashboard** | `v1.0.1` | Floating card docked at the bottom of the left sidebar showing model quota pools, reset countdowns, Credits balance, per-turn/session token consumption, TPS, and persistent per-model history | Bottom of Left Sidebar (above `Settings`) |
| [`antigravity-snippets/`](./antigravity-snippets/README.md) | **Prompt Snippets** | `v1.0.0` | Type `#` in the chat composer for instant template search with `title`/`alias` priority ranking, dynamic variables (`{{date}}`, `{{clipboard}}`, `{{selection}}`), `{{$cursor}}` placement, and a visual library manager | Type `#` / `Alt+P` / Bottom-right capsule |
| [`antigravity-notifier/`](./antigravity-notifier/README.md) | **Task Notifier** | `v1.0.0` | Detects task completion, approval prompts, and errors; delivers desktop notifications, synthesized Web Audio chimes, background title flashing, and `Stop`-hook Webhook push (Feishu, WeCom, Discord, Telegram, Custom) | Left Sidebar `Remote Push` / `Alt+N` |

### What Each Plugin Does

- **[`antigravity-context-doctor`](./antigravity-context-doctor/README.md)** — Inspired by `dsh-context`, opens as a native tab right alongside `Review` and `Browser` in the right side pane. Helps you diagnose what is filling up your context window (`Cache Read` vs `New Input` vs `Output/Thinking`), spot oversized terminal logs or repeated file reads, browse 7-day cross-session token usage, and generate a structured handoff prompt straight into the chat input.
- **[`antigravity-kb`](./antigravity-kb/README.md)** — Local-first Markdown knowledge base embedded as a native right-pane tab with split edit/preview, `[[` inline citation autocomplete in the composer, one-click clipping of AI responses/code blocks, and a lightweight `MCP` server so the Agent can search and save notes directly.
- **[`antigravity-usage-dashboard`](./antigravity-usage-dashboard/README.md)** — Monitors `RetrieveUserQuotaSummary`, `GetUserStatus`, and `GetCascadeTrajectoryGeneratorMetadata` to display live shared quota pools, reset timers, and token/TPS metrics without leaving the main workspace, persisting history across restarts.
- **[`antigravity-snippets`](./antigravity-snippets/README.md)** — Speeds up repetitive prompting with 8 built-in engineering templates, IME-friendly `#` inline autocomplete, `Tab` insertion without accidentally submitting, and import/export backups.
- **[`antigravity-notifier`](./antigravity-notifier/README.md)** — Prevents missed approvals or silent stalls during long agent runs using dual RPC + DOM approval detection and background `Stop` hooks for CORS-free Webhook alerts.

---

## Quick Install via Agent (Copy & Paste)

Copy the prompt below and send it directly to your `Antigravity` Agent to download, verify, and install the plugins automatically:

```text
Please download and install the plugins from https://github.com/KiriuKazurei/antigravity-plugins.git into my Antigravity environment:
1. Clone https://github.com/KiriuKazurei/antigravity-plugins.git to a temporary working directory.
2. Run `python scripts/manage_plugins.py test` to verify loader consistency, Python syntax, and all unit tests.
3. Run `python scripts/manage_plugins.py status` to check if `app.asar` already has the latest host loader.
   - If the host loader is already up to date, run `python scripts/manage_plugins.py sync` and tell me to press Ctrl+R in Antigravity.
   - If the host loader is missing or outdated, run `python scripts/manage_plugins.py stage` (or `install` if Antigravity is closed) and tell me what to restart to finish activation.
4. Run `python scripts/manage_plugins.py status` again and summarize the installed plugins.
5. Monitor the entire process end-to-end and directly troubleshoot/fix any installation, environment, or compatibility issues you encounter. If you run into a plugin bug or a new Antigravity version compatibility issue, please also open a GitHub Issue on https://github.com/KiriuKazurei/antigravity-plugins/issues (with OS, Antigravity version, reproduction steps, and sanitized error logs) to help the maintainer improve compatibility.
```

> [!TIP]
> Want only specific plugins? Replace `sync` / `install` in the prompt with `--only antigravity-context-doctor,antigravity-usage-dashboard` (any comma-separated subset).

---

## Manual Installation & Management

### Prerequisites

- `Python 3`
- `Git` (optional; you can also download a release archive)
- `Node.js` (only needed to run unit tests)

### Install All or Selected Plugins

```powershell
git clone https://github.com/KiriuKazurei/antigravity-plugins.git
cd antigravity-plugins

# Close Antigravity completely before first-time host installation:
python scripts/manage_plugins.py install

# Or install only selected plugins:
python scripts/manage_plugins.py install --only antigravity-context-doctor,antigravity-snippets
```

### Common Commands

```powershell
# Sync plugin script updates only (if host loader is already active, press Ctrl+R in Antigravity to hot-reload)
python scripts/manage_plugins.py sync

# Check host loader status, plugin versions, and sync state
python scripts/manage_plugins.py status

# Run full checks (pluginLoader.js hash consistency + py_compile + Node.js unit tests)
python scripts/manage_plugins.py test

# Restore original unpatched app.asar (close Antigravity first)
python scripts/manage_plugins.py restore
```

---

## Repository Structure

```text
antigravity-plugins/
├── LICENSE
├── README.md                         # English overview & quick-install guide
├── README_zh.md                      # 简体中文总览与快速安装指南
├── scripts/
│   └── manage_plugins.py             # Multi-plugin manager (status/sync/install/stage/test/restore)
├── antigravity-context-doctor/       # Context insights & handoff diagnostics
├── antigravity-kb/                   # Local Markdown knowledge base & MCP server
├── antigravity-usage-dashboard/      # Sidebar model quota & token dashboard
├── antigravity-snippets/             # #-triggered prompt template library
└── antigravity-notifier/             # Task alerts & Webhook remote push
```

---

## License

This project is licensed under the [MIT License](./LICENSE).
