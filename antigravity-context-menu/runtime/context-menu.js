/**
 * Antigravity 右键菜单增强框架 (antigravity-context-menu)
 *
 * 定位：可拓展的右键菜单框架，允许内置模块、外部插件与用户自定义动作无缝接入。
 * 首发核心能力：智能识别 Antigravity 输出（链接、行内代码、代码块、正文与选区）中的本地路径，
 * 一键在资源管理器中定位/打开文件夹、用默认应用打开文件、在终端打开目录及多格式复制路径。
 *
 * 架构：
 * - 纯浏览器 DOM 环境执行（Shadow DOM 样式隔离）
 * - 双通道系统桥接：优先使用 pluginLoader v2.4.0+ 的 System Bridge（支持 stat/reveal/open/open-terminal），
 *   在未升级宿主时自动降级为 window.electronNative.revealInFilePicker(fileUrl)，零重启可用。
 * - 全局扩展注册 API：window.__AGY_CONTEXT_MENU__
 * - 按住 Shift + 右键 可随时直达原生右键菜单。
 */
(function (root) {
  'use strict';

  const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
  const PLUGIN_VERSION = '1.0.0';
  const STORE_KEY = 'agy_context_menu_config_v1';
  const HOST_ID = 'agy-context-menu-host';

  // ==================== 路径识别与标准化纯逻辑（可独立单元测试） ====================

  const FILE_EXT_RE = /\.[A-Za-z0-9]{1,10}$/;
  const TRAILING_PUNCT_RE = /[.,;:!?，。；：！？、》」』】）)\]]+$/;
  const LEADING_WRAP_RE = /^[\s"'`“”‘’<(\[（【《「『]+/;
  const TRAILING_WRAP_RE = /[\s"'`“”‘’>)\]）】》」』]+$/;

  const SAFE_POSIX_ROOTS = new Set([
    'users', 'home', 'etc', 'var', 'opt', 'tmp', 'usr', 'bin', 'sbin', 'lib',
    'mnt', 'media', 'srv', 'root', 'volumes', 'applications', 'library', 'system',
    'private', 'proc', 'sys', 'dev', 'workspace', 'workspaces', 'data', 'app',
  ]);

  function detectPlatform(hint) {
    if (hint) return hint;
    if (typeof process !== 'undefined' && process && process.platform) {
      return process.platform;
    }
    if (IS_BROWSER && navigator && typeof navigator.platform === 'string') {
      const p = navigator.platform.toLowerCase();
      if (p.includes('win')) return 'win32';
      if (p.includes('mac')) return 'darwin';
    }
    return 'win32';
  }

  function decodeFileUrlToPath(fileUrl) {
    if (typeof fileUrl !== 'string' || !/^file:\/\//i.test(fileUrl.trim())) {
      return null;
    }
    let raw = fileUrl.trim();
    let line = null;
    let endLine = null;
    const hashIdx = raw.indexOf('#');
    if (hashIdx !== -1) {
      const hash = raw.slice(hashIdx + 1);
      const lm = hash.match(/^L(\d+)(?:-L?(\d+))?$/i);
      if (lm) {
        line = Number(lm[1]);
        endLine = lm[2] ? Number(lm[2]) : null;
      }
      raw = raw.slice(0, hashIdx);
    }
    const qIdx = raw.indexOf('?');
    if (qIdx !== -1) {
      raw = raw.slice(0, qIdx);
    }

    let body = raw.replace(/^file:\/\//i, '');
    try {
      body = decodeURIComponent(body);
    } catch (_) {
      // Keep original if percent-encoding is malformed
    }

    let normalized = '';
    if (/^\/[A-Za-z]:/.test(body)) {
      // file:///C:/Users/... -> C:\Users\...
      normalized = body.slice(1).replace(/\//g, '\\');
    } else if (/^[A-Za-z]:/.test(body)) {
      normalized = body.replace(/\//g, '\\');
    } else if (/^[^/]+\//.test(body) && !body.startsWith('/')) {
      // file://server/share/path -> \\server\share\path
      normalized = '\\\\' + body.replace(/\//g, '\\');
    } else {
      normalized = body;
    }

    return {
      raw: fileUrl.trim(),
      path: normalized,
      line,
      endLine,
      column: null,
      kind: 'file-url',
    };
  }

  function stripLocationSuffix(rawStr) {
    let s = String(rawStr || '').trim();
    let line = null;
    let endLine = null;
    let column = null;

    // #L10-L20 or #L10
    const hashMatch = s.match(/#L(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      line = Number(hashMatch[1]);
      endLine = hashMatch[2] ? Number(hashMatch[2]) : null;
      s = s.slice(0, hashMatch.index);
    }

    // path.cs(12,4) or path.cs(12)
    const parenMatch = s.match(/\((\d+)(?:,\s*(\d+))?\)$/);
    if (parenMatch && s.length > parenMatch[0].length + 2) {
      line = Number(parenMatch[1]);
      column = parenMatch[2] ? Number(parenMatch[2]) : null;
      s = s.slice(0, parenMatch.index);
    }

    // path.ts:42:10 or path.ts:42 (skip drive letter C:)
    const colonMatch = s.match(/^(.+?):(\d+)(?::(\d+))?$/);
    if (colonMatch && colonMatch[1] && !/^[A-Za-z]$/.test(colonMatch[1])) {
      s = colonMatch[1];
      line = Number(colonMatch[2]);
      column = colonMatch[3] ? Number(colonMatch[3]) : null;
    }

    return { path: s, line, endLine, column };
  }

  function trimPathWrappers(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    // Strip symmetric quotes/backticks/angle brackets
    let changed = true;
    while (changed && s.length >= 2) {
      changed = false;
      const first = s[0];
      const last = s[s.length - 1];
      const pairs = { '"': '"', "'": "'", '`': '`', '<': '>', '(': ')', '[': ']', '“': '”', '‘': '’', '《': '》', '（': '）', '【': '】' };
      if (pairs[first] && pairs[first] === last) {
        s = s.slice(1, -1).trim();
        changed = true;
      }
    }
    s = s.replace(LEADING_WRAP_RE, '');
    // Keep trailing ')' if there is a matching '(' inside (e.g., Program Files (x86))
    while (s.length > 0 && TRAILING_PUNCT_RE.test(s)) {
      const lastChar = s[s.length - 1];
      if (lastChar === ')') {
        const opens = (s.match(/\(/g) || []).length;
        const closes = (s.match(/\)/g) || []).length;
        if (opens >= closes) break;
      }
      if (lastChar === ']') {
        const opens = (s.match(/\[/g) || []).length;
        const closes = (s.match(/\]/g) || []).length;
        if (opens >= closes) break;
      }
      s = s.slice(0, -1);
    }
    s = s.replace(TRAILING_WRAP_RE, '');
    return s.trim();
  }

  function classifyPathString(cleanPath) {
    if (!cleanPath || cleanPath.length < 2 || cleanPath.length > 520) return null;
    if (/[\r\n\t\0]/.test(cleanPath)) return null;
    if (/^https?:\/\//i.test(cleanPath) || /^mailto:/i.test(cleanPath) || /^data:/i.test(cleanPath)) {
      return null;
    }
    if (/^file:\/\//i.test(cleanPath)) return 'file-url';
    if (/^[A-Za-z]:[\\/]/.test(cleanPath)) return 'win-abs';
    if (/^\\\\[^\\\s/:*?"<>|]+\\[^\\\s/:*?"<>|]+/.test(cleanPath)) return 'unc';
    if (/^~[\\/]/.test(cleanPath) || cleanPath === '~') return 'home';
    if (/^%[A-Za-z_][A-Za-z0-9_]*%[\\/]/.test(cleanPath)) return 'env';
    if (cleanPath.startsWith('/') && !cleanPath.startsWith('//')) {
      const segs = cleanPath.split('/').filter(Boolean);
      if (segs.length >= 2) {
        const firstLow = segs[0].toLowerCase();
        if (SAFE_POSIX_ROOTS.has(firstLow) || FILE_EXT_RE.test(segs[segs.length - 1])) {
          return 'posix-abs';
        }
      }
    }
    return null;
  }

  function guessIsLikelyFile(pathStr) {
    if (!pathStr) return false;
    if (/[\\/]$/.test(pathStr)) return false;
    const base = pathStr.replace(/\\/g, '/').split('/').pop() || '';
    if (!base || base === '.' || base === '..') return false;
    if (/^\.[A-Za-z0-9_-]+$/.test(base)) return true; // .gitignore, .env
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx <= 0) return false;
    const ext = base.slice(dotIdx);
    return FILE_EXT_RE.test(ext);
  }

  function getParentDirString(pathStr) {
    if (!pathStr) return '';
    const trimmed = pathStr.replace(/[\\/]+$/, '');
    const sep = trimmed.includes('\\') ? '\\' : '/';
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx <= 0) return trimmed;
    const parent = trimmed.slice(0, idx);
    if (/^[A-Za-z]:$/.test(parent)) return parent + sep;
    return parent;
  }

  function getBaseNameString(pathStr) {
    if (!pathStr) return '';
    const trimmed = pathStr.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }

  function toPosixPath(pathStr) {
    return String(pathStr || '').replace(/\\/g, '/');
  }

  function toPlatformPath(pathStr, platformHint) {
    const plat = detectPlatform(platformHint);
    if (plat === 'win32' && (/^[A-Za-z]:[\\/]/.test(pathStr) || /^\\\\/.test(pathStr) || /^%[A-Za-z_]+%/.test(pathStr))) {
      return String(pathStr).replace(/\//g, '\\');
    }
    return String(pathStr || '');
  }

  function toFileUrl(pathStr) {
    if (!pathStr || typeof pathStr !== 'string') return null;
    const s = pathStr.trim();
    if (/^file:\/\//i.test(s)) return s.split('#')[0].split('?')[0];
    // UNC: \\server\share\dir\file
    if (/^\\\\[^\\]+\\[^\\]+/.test(s)) {
      const rest = s.slice(2).replace(/\\/g, '/');
      const parts = rest.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)));
      return 'file://' + parts.join('/');
    }
    // Windows drive: C:\Users\a b\c.md
    if (/^[A-Za-z]:[\\/]/.test(s)) {
      const drive = s.slice(0, 2);
      const rest = s.slice(2).replace(/\\/g, '/').replace(/^\/+/, '');
      const encoded = rest
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      return `file:///${drive}/${encoded}`;
    }
    // POSIX absolute: /Users/a b/c.md
    if (s.startsWith('/')) {
      const encoded = s
        .split('/')
        .map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg)))
        .join('/');
      return `file://${encoded}`;
    }
    return null;
  }

  function buildPathInfo(rawInput, source, platformHint) {
    if (!rawInput || typeof rawInput !== 'string') return null;
    const trimmed = trimPathWrappers(rawInput);
    if (!trimmed) return null;

    if (/^file:\/\//i.test(trimmed)) {
      const decoded = decodeFileUrlToPath(trimmed);
      if (!decoded || !decoded.path) return null;
      const platPath = toPlatformPath(decoded.path, platformHint);
      return {
        raw: decoded.raw,
        path: platPath,
        posixPath: toPosixPath(platPath),
        fileUrl: toFileUrl(platPath),
        parentDir: getParentDirString(platPath),
        filename: getBaseNameString(platPath),
        line: decoded.line,
        endLine: decoded.endLine,
        column: decoded.column,
        kind: decoded.kind,
        isLikelyFile: guessIsLikelyFile(platPath),
        source: source || 'text',
      };
    }

    const stripped = stripLocationSuffix(trimmed);
    const clean = stripped.path.replace(/[\\/]+$/, (m) => (stripped.path.length <= 3 ? m : ''));
    const kind = classifyPathString(clean);
    if (!kind) return null;

    const platPath = toPlatformPath(clean, platformHint);
    return {
      raw: trimmed,
      path: platPath,
      posixPath: toPosixPath(platPath),
      fileUrl: toFileUrl(platPath),
      parentDir: getParentDirString(platPath),
      filename: getBaseNameString(platPath),
      line: stripped.line,
      endLine: stripped.endLine,
      column: stripped.column,
      kind,
      isLikelyFile: guessIsLikelyFile(platPath),
      source: source || 'text',
    };
  }

  // 在任意一段文本中扫描所有候选本地路径（支持带位置偏移以精准定位光标所在路径）
  const PATH_SCAN_PATTERNS = [
    // file:// URL
    /file:\/\/\/?[^\s"'`<>()[\]{}，。；：！？、]+/gi,
    // UNC path: \\wsl$\... or \\server\share\...
    /\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>|*?，。；：！？、]+/g,
    // Windows drive path (conservative, no whitespace; full whitespace handled by whole-text/code check)
    /(?<![A-Za-z0-9_])([A-Za-z]:[\\/][^\s"'`<>|*?，。；：！？、]+)/g,
    // Home path: ~/.gemini/... or ~\Desktop\...
    /(?<![A-Za-z0-9_])(~[\\/][^\s"'`<>|*?，。；：！？、]+)/g,
    // Env path: %USERPROFILE%\...
    /(%[A-Za-z_][A-Za-z0-9_]*%[\\/][^\s"'`<>|*?，。；：！？、]+)/g,
    // POSIX absolute path: /Users/... /home/... /etc/... (exclude :// URL paths)
    /(?<![A-Za-z0-9_:/])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._~+@%-]+)+)/g,
  ];

  function extractPathsFromText(text, options = {}) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const offset = typeof options.offset === 'number' ? options.offset : -1;
    const platformHint = options.platform;
    const source = options.source || 'text';

    // 1. 优先尝试整段文本本身就是一条完整路径（完美支持含空格的路径，如 C:\Program Files\Git\bin\git.exe）
    const trimmed = text.trim();
    if (trimmed.length <= 400 && !trimmed.includes('\n')) {
      const direct = buildPathInfo(trimmed, source, platformHint);
      if (direct) {
        return [{ ...direct, start: 0, end: text.length, hitOffset: true }];
      }
    }

    // 2. 用正则扫描文本中的所有路径
    const found = [];
    const seen = new Set();
    for (const re of PATH_SCAN_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const rawMatch = m[0];
        const start = m.index;
        const end = start + rawMatch.length;
        // 避免把 URL 中的 /path 当作 POSIX 路径
        if (start >= 2 && text.slice(Math.max(0, start - 10), start).includes('://')) {
          continue;
        }
        const info = buildPathInfo(rawMatch, source, platformHint);
        if (!info) continue;
        const key = `${info.path.toLowerCase()}@${start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hitOffset = offset >= 0 && offset >= start - 1 && offset <= end + 1;
        found.push({ ...info, start, end, hitOffset });
      }
    }

    if (offset >= 0 && found.length > 1) {
      found.sort((a, b) => {
        if (a.hitOffset !== b.hitOffset) return a.hitOffset ? -1 : 1;
        const distA = Math.min(Math.abs(offset - a.start), Math.abs(offset - a.end));
        const distB = Math.min(Math.abs(offset - b.start), Math.abs(offset - b.end));
        return distA - distB;
      });
    }
    return found;
  }

  function extractBestPathFromText(text, options = {}) {
    const list = extractPathsFromText(text, options);
    return list.length > 0 ? list[0] : null;
  }

  // ==================== 终端命令识别纯逻辑 ====================

  const NO_ARG_COMMANDS = new Set([
    'ls', 'dir', 'pwd', 'clear', 'cls', 'whoami', 'hostname', 'date', 'uptime',
    'top', 'htop', 'ps', 'env', 'printenv', 'id', 'uname', 'df', 'free', 'ifconfig', 'ipconfig',
  ]);

  const KNOWN_CLI_BINARIES = new Set([
    // Python & AI
    'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry', 'pdm', 'conda', 'mamba', 'pytest', 'ruff', 'mypy', 'black', 'uvicorn', 'gunicorn', 'flask', 'django-admin',
    // JS / TS
    'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'tsc', 'tsx', 'vitest', 'jest', 'eslint', 'prettier', 'vite', 'next', 'nuxt', 'astro',
    // Rust / Go / JVM / C / .NET
    'cargo', 'rustc', 'rustup', 'go', 'java', 'javac', 'mvn', 'gradle', 'gradlew', 'dotnet', 'gcc', 'g++', 'clang', 'clang++', 'cmake', 'make', 'ninja', 'msbuild', 'bazel', 'blaze',
    // Ruby / PHP / Swift / Mobile
    'ruby', 'gem', 'bundle', 'rails', 'php', 'composer', 'artisan', 'swift', 'xcodebuild', 'pod', 'flutter', 'dart', 'adb', 'fastboot',
    // VCS / Containers / Cloud / DevOps
    'git', 'gh', 'glab', 'svn', 'hg', 'docker', 'docker-compose', 'podman', 'kubectl', 'k9s', 'helm', 'minikube', 'kind', 'terraform', 'tofu', 'ansible', 'ansible-playbook', 'vagrant',
    'aws', 'gcloud', 'gsutil', 'az', 'firebase', 'wrangler', 'vercel', 'netlify', 'fly', 'flyctl', 'railway', 'supabase', 'prisma',
    // Shell / OS / Network / Package Managers
    'cd', 'ls', 'dir', 'pwd', 'mkdir', 'md', 'rmdir', 'rd', 'rm', 'del', 'cp', 'copy', 'xcopy', 'robocopy', 'mv', 'move', 'ren', 'cat', 'type', 'head', 'tail', 'less', 'more',
    'grep', 'rg', 'egrep', 'fgrep', 'find', 'fd', 'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'xargs', 'tee', 'echo', 'printf', 'export', 'set', 'unset', 'alias', 'source', 'which', 'where', 'whereis',
    'curl', 'wget', 'http', 'ssh', 'scp', 'sftp', 'rsync', 'ping', 'tracert', 'traceroute', 'nslookup', 'dig', 'netstat', 'ss', 'lsof', 'nc', 'telnet',
    'kill', 'pkill', 'killall', 'tasklist', 'taskkill', 'net', 'sc', 'reg', 'icacls', 'takeown', 'certutil', 'wmic', 'systemctl', 'service', 'journalctl', 'chmod', 'chown', 'ln', 'tar', 'zip', 'unzip', '7z',
    'winget', 'choco', 'scoop', 'brew', 'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'pacman', 'apk', 'snap', 'flatpak', 'nix',
    'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'wsl',
    // Editors / Agents / DB / Media
    'code', 'agy', 'cursor', 'claude', 'codex', 'gemini', 'ollama', 'ffmpeg', 'ffprobe', 'magick', 'convert', 'sqlite3', 'psql', 'mysql', 'mongosh', 'redis-cli', 'jq', 'yq',
  ]);

  const SHORTCUT_RE = /^(?:(?:Ctrl|Cmd|Command|Alt|Opt|Option|Shift|Meta|Win)\s*\+\s*)+(?:[A-Za-z0-9]|F\d{1,2}|Enter|Esc|Escape|Tab|Space|Backspace|Delete|Up|Down|Left|Right|右键|左键)$/i;

  function stripShellPrompt(line) {
    let s = String(line || '').trim();
    // PS C:\Users\...> cmd  or  PS> cmd
    s = s.replace(/^PS(?:\s+[^>\r\n]+)?>\s+/, '');
    // C:\Users\...> cmd
    s = s.replace(/^[A-Za-z]:\\[^>\r\n]*>\s+/, '');
    // user@host:~/dir$ cmd  or  $ cmd
    s = s.replace(/^(?:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^$#\r\n]*)?[$#]\s+/, '');
    // > cmd
    s = s.replace(/^>\s+/, '');
    return s.trim();
  }

  function extractCommandFromText(rawText) {
    if (typeof rawText !== 'string') return null;
    const trimmed = rawText.trim();
    if (!trimmed || trimmed.length > 2000) return null;
    if (SHORTCUT_RE.test(trimmed)) return null;
    if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) return null;

    const rawLines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
    if (rawLines.length === 0 || rawLines.length > 25) return null;

    const cleanedLines = rawLines.map(stripShellPrompt).filter(Boolean);
    if (cleanedLines.length === 0) return null;

    const firstLine = cleanedLines[0];
    // 跳过前置环境变量赋值：FOO=bar BAZ="1" npm test
    let expr = firstLine.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, '');
    // PowerShell $env:FOO="bar"; cmd
    expr = expr.replace(/^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^;\s]+)\s*;\s*/i, '');
    if (!expr) return null;

    // 剥离包裹反引号或引号
    const firstTokenMatch = expr.match(/^("[^"]+"|'[^']+'|[^\s|&;]+)/);
    if (!firstTokenMatch) return null;
    const rawBin = firstTokenMatch[1].replace(/^['"]|['"]$/g, '');
    const rest = expr.slice(firstTokenMatch[0].length).trim();

    // 1. 显式相对/脚本执行：./script.sh、.\run.ps1、.\build.bat
    const isScriptExec = /^(?:\.[\\/])[^\s]+\.(?:sh|ps1|bat|cmd|py|js|mjs|cjs|exe)$/i.test(rawBin)
      || /^(?:\.[\\/])[A-Za-z0-9._-]+$/.test(rawBin);
    // 2. PowerShell Cmdlet：Get-ChildItem、Set-Location、Invoke-RestMethod、Start-Process 等
    const isPsCmdlet = /^(?:Get|Set|New|Remove|Start|Stop|Restart|Invoke|Test|Copy|Move|Rename|Clear|Select|Where|ForEach|Export|Import|Install|Uninstall|Update|Enable|Disable|Add|Out|Write|Read|Format|Measure|Sort|Group|Resolve|Split|Join)-[A-Z][A-Za-z0-9]+$/.test(rawBin);
    // 3. 已知 CLI 二进制名（支持带 .exe / 路径前缀）
    const baseBin = rawBin.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
    const isKnownBin = KNOWN_CLI_BINARIES.has(baseBin);

    if (!isScriptExec && !isPsCmdlet && !isKnownBin) {
      return null;
    }

    // 防止普通行内名词误判（例如单独出现 `python`、`node`、`git` 而无参数）
    if (isKnownBin && !rest && cleanedLines.length === 1 && !NO_ARG_COMMANDS.has(baseBin)) {
      return null;
    }

    // 防止像 `app.asar.staged`、`v2.4.0` 或普通路径被误判
    if (/^[A-Za-z]:[\\/]/.test(firstLine) && !rest && !/\.(?:exe|bat|cmd|ps1|sh)$/i.test(rawBin)) {
      return null;
    }

    const command = cleanedLines.join('\n');
    return {
      raw: trimmed,
      command,
      binary: baseBin || rawBin,
      multiline: cleanedLines.length > 1,
    };
  }

  function renderActionTemplate(template, ctx) {
    if (typeof template !== 'string') return '';
    const sel = ctx.selectionText || '';
    const p = ctx.pathInfo ? ctx.pathInfo.path : '';
    const dir = ctx.pathInfo ? ctx.pathInfo.parentDir : '';
    const fn = ctx.pathInfo ? ctx.pathInfo.filename : '';
    const url = ctx.linkUrl || '';
    const vars = {
      selection: sel,
      selection_encoded: encodeURIComponent(sel),
      path: p,
      path_posix: ctx.pathInfo ? ctx.pathInfo.posixPath : '',
      dir,
      filename: fn,
      url,
      url_encoded: encodeURIComponent(url),
    };
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
    });
  }

  // ==================== 可拓展菜单注册中心 (Registry) ====================

  function createMenuRegistry(initialConfig) {
    const modules = new Map();
    const externalActions = [];
    const config = {
      version: 1,
      disabledModules: Array.isArray(initialConfig?.disabledModules) ? [...initialConfig.disabledModules] : [],
      customActions: Array.isArray(initialConfig?.customActions) ? [...initialConfig.customActions] : [],
      prefs: {
        openFolderDirectly: true,
        showPathPreview: false,
        enableOnInputs: true,
        ...(initialConfig?.prefs && typeof initialConfig.prefs === 'object' ? initialConfig.prefs : {}),
      },
    };

    function isModuleEnabled(id) {
      return !config.disabledModules.includes(id);
    }

    function setModuleEnabled(id, enabled) {
      const idx = config.disabledModules.indexOf(id);
      if (enabled && idx !== -1) {
        config.disabledModules.splice(idx, 1);
      } else if (!enabled && idx === -1) {
        config.disabledModules.push(id);
      }
      return config;
    }

    function registerModule(def) {
      if (!def || typeof def.id !== 'string' || !def.id.trim() || typeof def.getItems !== 'function') {
        throw new Error('Invalid context menu module definition: requires id and getItems(ctx, helpers)');
      }
      const normalized = {
        id: def.id.trim(),
        name: String(def.name || def.id),
        description: String(def.description || ''),
        priority: typeof def.priority === 'number' ? def.priority : 100,
        builtin: Boolean(def.builtin),
        alwaysOn: Boolean(def.alwaysOn),
        getItems: def.getItems,
      };
      modules.set(normalized.id, normalized);
      return normalized.id;
    }

    function unregisterModule(id) {
      return modules.delete(id);
    }

    function registerAction(actionDef) {
      if (!actionDef || typeof actionDef.id !== 'string' || typeof actionDef.label !== 'string') {
        throw new Error('Invalid action definition: requires id and label');
      }
      const idx = externalActions.findIndex((a) => a.id === actionDef.id);
      if (idx !== -1) {
        externalActions[idx] = actionDef;
      } else {
        externalActions.push(actionDef);
      }
      return actionDef.id;
    }

    function listModules() {
      return Array.from(modules.values())
        .sort((a, b) => a.priority - b.priority)
        .map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          priority: m.priority,
          builtin: m.builtin,
          alwaysOn: m.alwaysOn,
          enabled: m.alwaysOn ? true : isModuleEnabled(m.id),
        }));
    }

    function cleanSeparators(items) {
      const out = [];
      for (const item of items) {
        if (!item) continue;
        if (item.type === 'separator') {
          if (out.length === 0 || out[out.length - 1].type === 'separator') {
            continue;
          }
          out.push(item);
        } else {
          out.push(item);
        }
      }
      while (out.length > 0 && out[out.length - 1].type === 'separator') {
        out.pop();
      }
      return out;
    }

    function buildMenuItems(ctx, helpers) {
      const sorted = Array.from(modules.values()).sort((a, b) => a.priority - b.priority);
      const result = [];
      for (const mod of sorted) {
        if (!mod.alwaysOn && !isModuleEnabled(mod.id)) {
          continue;
        }
        try {
          const produced = mod.getItems(ctx, helpers);
          if (Array.isArray(produced) && produced.length > 0) {
            if (result.length > 0 && result[result.length - 1].type !== 'separator' && produced[0].type !== 'separator') {
              result.push({ type: 'separator' });
            }
            for (const it of produced) {
              if (it) result.push(it);
            }
          }
        } catch (err) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn(`[AgyContextMenu] module "${mod.id}" failed:`, err);
          }
        }
      }

      // 挂载通过 registerAction 注册的外部快捷动作
      if (externalActions.length > 0) {
        const matched = [];
        for (const act of externalActions) {
          try {
            if (typeof act.when === 'function' && !act.when(ctx)) continue;
            matched.push({
              id: act.id,
              label: act.label,
              icon: act.icon || 'spark',
              shortcut: act.shortcut || '',
              badge: act.badge || '',
              onClick: () => act.run && act.run(ctx, helpers),
            });
          } catch (_) {}
        }
        if (matched.length > 0) {
          if (result.length > 0 && result[result.length - 1].type !== 'separator') {
            result.push({ type: 'separator' });
          }
          result.push(...matched);
        }
      }

      return cleanSeparators(result);
    }

    return {
      config,
      isModuleEnabled,
      setModuleEnabled,
      registerModule,
      unregisterModule,
      registerAction,
      listModules,
      buildMenuItems,
    };
  }

  // Node.js 单元测试导出
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PLUGIN_VERSION,
      decodeFileUrlToPath,
      stripLocationSuffix,
      trimPathWrappers,
      classifyPathString,
      guessIsLikelyFile,
      toFileUrl,
      buildPathInfo,
      extractPathsFromText,
      extractBestPathFromText,
      stripShellPrompt,
      extractCommandFromText,
      renderActionTemplate,
      createMenuRegistry,
    };
  }

  if (!IS_BROWSER) {
    return;
  }

  // ==================== 浏览器运行时初始化 ====================

  if (window.__AGY_CONTEXT_MENU_INITIALIZED__) {
    return;
  }
  window.__AGY_CONTEXT_MENU_INITIALIZED__ = true;

  const pluginMeta = window.__AGY_PLUGIN_META__ || {};
  const sysBridge = window.__AGY_SYSTEM_BRIDGE__ || null;
  try {
    delete window.__AGY_PLUGIN_META__;
  } catch (_) {}

  const DEFAULT_CUSTOM_ACTIONS = [
    {
      id: 'custom-explain-path',
      label: '让 AI 解释此文件',
      type: 'insert-prompt',
      when: 'hasPath',
      template: '请帮我阅读并解释 `{{path}}` 的核心逻辑与作用：',
    },
  ];

  function loadLocalConfig() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_) {}
    return {
      version: 1,
      disabledModules: [],
      customActions: DEFAULT_CUSTOM_ACTIONS,
      prefs: {
        openFolderDirectly: true,
        showPathPreview: false,
        enableOnInputs: true,
      },
    };
  }

  function saveLocalConfig(cfg) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch (_) {}
    if (sysBridge && sysBridge.url && sysBridge.token) {
      fetch(`${sysBridge.url}/sys/config/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agy-sys-token': sysBridge.token,
        },
        body: JSON.stringify({ config: cfg }),
      }).catch(() => {});
    }
  }

  const registry = createMenuRegistry(loadLocalConfig());

  // 如果系统桥接可用，异步拉取持久化配置
  if (sysBridge && sysBridge.url && sysBridge.token) {
    fetch(`${sysBridge.url}/sys/config/get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agy-sys-token': sysBridge.token,
      },
      body: '{}',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.ok && data.config && typeof data.config === 'object') {
          if (Array.isArray(data.config.disabledModules)) {
            registry.config.disabledModules = [...data.config.disabledModules];
          }
          if (Array.isArray(data.config.customActions) && data.config.customActions.length > 0) {
            registry.config.customActions = [...data.config.customActions];
          }
          if (data.config.prefs && typeof data.config.prefs === 'object') {
            registry.config.prefs = { ...registry.config.prefs, ...data.config.prefs };
          }
          try {
            localStorage.setItem(STORE_KEY, JSON.stringify(registry.config));
          } catch (_) {}
        }
      })
      .catch(() => {});
  }

  // ==================== 系统桥接调用封装（含降级兜底） ====================

  async function callSysBridge(route, payload) {
    if (!sysBridge || !sysBridge.url || !sysBridge.token) {
      return null;
    }
    try {
      const resp = await fetch(`${sysBridge.url}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agy-sys-token': sysBridge.token,
        },
        body: JSON.stringify(payload || {}),
      });
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function revealPathInExplorer(pathInfo, options = {}) {
    if (!pathInfo || !pathInfo.path) return;
    const openFolderDirectly = registry.config.prefs.openFolderDirectly !== false;
    const mode = options.forceSelect ? 'select' : (openFolderDirectly ? 'open-folder' : 'select');

    // 通道 1: pluginLoader v2.4.0+ System Bridge
    if (sysBridge) {
      const res = await callSysBridge('/sys/reveal', {
        path: pathInfo.path,
        mode,
        fallbackToParent: true,
      });
      if (res && res.ok) {
        if (res.fallback) {
          showToast(`目标不存在，已打开上级目录：${getBaseNameString(res.resolvedPath)}`, 'warn');
        } else if (res.action === 'openDirectory') {
          showToast(`已在资源管理器打开目录`, 'ok');
        } else {
          showToast(`已在资源管理器定位：${pathInfo.filename || pathInfo.path}`, 'ok');
        }
        return;
      }
      if (res && res.error) {
        showToast(`无法打开路径：${res.error}`, 'error');
        return;
      }
    }

    // 通道 2: 降级使用 Antigravity 原生 revealInFilePicker(fileUrl)（零重启可用）
    const fileUrl = pathInfo.fileUrl || toFileUrl(pathInfo.path);
    if (fileUrl && window.electronNative && typeof window.electronNative.revealInFilePicker === 'function') {
      try {
        await window.electronNative.revealInFilePicker(fileUrl);
        showToast(`已在资源管理器定位：${pathInfo.filename || pathInfo.path}`, 'ok');
        return;
      } catch (err) {
        showToast(`打开失败：${err && err.message ? err.message : '路径格式不受原生接口支持'}`, 'error');
        return;
      }
    }

    showToast('当前环境不支持直接打开资源管理器，请升级宿主加载器', 'error');
  }

  async function openPathWithDefaultApp(pathInfo) {
    if (!pathInfo || !pathInfo.path) return;
    if (sysBridge) {
      const res = await callSysBridge('/sys/open', { path: pathInfo.path });
      if (res && res.ok) {
        showToast(`已打开：${pathInfo.filename || pathInfo.path}`, 'ok');
        return;
      }
      if (res && res.error) {
        showToast(`打开失败：${res.error}`, 'error');
        return;
      }
    }
    // 未升级宿主时降级到资源管理器定位
    await revealPathInExplorer(pathInfo, { forceSelect: true });
  }

  async function openTerminalAtPath(pathInfo) {
    if (!pathInfo || !pathInfo.path) return;
    if (!sysBridge) {
      showToast('重启 Antigravity 接入最新宿主后即可在终端打开目录', 'warn');
      return;
    }
    const res = await callSysBridge('/sys/open-terminal', { path: pathInfo.path });
    if (res && res.ok) {
      showToast(`已在终端打开：${getBaseNameString(res.dir || pathInfo.parentDir)}`, 'ok');
    } else {
      showToast(`打开终端失败：${(res && res.error) || '未知错误'}`, 'error');
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisibleRect(r, minW = 1, minH = 1) {
    return Boolean(r && r.width >= minW && r.height >= minH && r.bottom > 0 && r.right > 0);
  }

  function findAllXtermTextareas() {
    return Array.from(document.querySelectorAll('textarea.xterm-helper-textarea')).filter(
      (el) => el && !el.closest(`#${HOST_ID}`)
    );
  }

  function findVisibleXtermTextarea(excludeSet) {
    const list = findAllXtermTextareas();
    const visible = list.filter((el) => {
      if (excludeSet && excludeSet.has(el)) return false;
      const box = el.closest('.xterm') || el.parentElement;
      if (!box) return false;
      return isVisibleRect(box.getBoundingClientRect(), 40, 20);
    });
    if (visible.length > 0) return visible[visible.length - 1];
    if (!excludeSet && list.length > 0) return list[list.length - 1];
    return null;
  }

  function isXtermPromptReady(ta) {
    if (!ta) return false;
    const xtermRoot = ta.closest('.xterm') || ta.parentElement;
    if (!xtermRoot) return true;
    const text = (xtermRoot.textContent || '').trim();
    if (!text) return false;
    // PowerShell (PS ...>), cmd (C:\...>), bash/zsh ($ / # / %), or any non-empty prompt line
    return /[>$#%❯➜]\s*$/m.test(text) || text.length >= 6;
  }

  async function waitForXtermReady(options = {}) {
    const excludeSet = options.excludeSet || null;
    const waitForPrompt = Boolean(options.waitForPrompt);
    const timeoutMs = options.timeoutMs || 2600;
    const deadline = Date.now() + timeoutMs;

    let found = null;
    while (Date.now() < deadline) {
      found = findVisibleXtermTextarea(excludeSet);
      if (found) break;
      await sleep(75);
    }
    if (!found) return null;

    if (waitForPrompt) {
      const promptDeadline = Date.now() + 2600;
      while (Date.now() < promptDeadline) {
        if (isXtermPromptReady(found)) {
          await sleep(160);
          break;
        }
        await sleep(90);
      }
    } else {
      await sleep(80);
    }
    return found;
  }

  function findExistingTerminalTabButton() {
    const innerH = window.innerHeight || 800;
    const candidates = Array.from(
      document.querySelectorAll('[role="tab"], button, [role="button"]')
    );
    for (const el of candidates) {
      if (!el || el.closest(`#${HOST_ID}`)) continue;
      if (el.getAttribute('data-agy-kb-tab') === '1' || el.getAttribute('data-agy-cd-tab') === '1') continue;
      const r = el.getBoundingClientRect();
      if (!isVisibleRect(r, 20, 14) || r.top > Math.min(90, innerH * 0.2)) continue;
      const txt = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (
        /^(终端|Terminal|PowerShell|pwsh|cmd|bash|zsh|sh)(\s*#?\d+)?$/i.test(txt) ||
        /^(终端|Terminal)(\s*#?\d+)?$/i.test(aria)
      ) {
        return el;
      }
    }
    return null;
  }

  function findRightPaneToggleButton() {
    const innerW = window.innerWidth || 1280;
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of btns) {
      if (!b || b.closest(`#${HOST_ID}`)) continue;
      const r = b.getBoundingClientRect();
      if (r.top >= 0 && r.top <= 48 && r.right >= innerW - 90 && r.width >= 16 && r.width <= 44 && r.height <= 42) {
        const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        if (/side|pane|panel|aux|侧边|面板|right|toggle.*terminal|切换终端/i.test(lbl)) {
          return b;
        }
      }
    }
    return null;
  }

  function findAuxPlusTabButton() {
    const innerW = window.innerWidth || 1280;
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    let best = null;
    for (const b of btns) {
      if (!b || b.closest(`#${HOST_ID}`)) continue;
      if (b.getAttribute('data-agy-kb-tab') === '1' || b.getAttribute('data-agy-cd-tab') === '1') continue;
      const r = b.getBoundingClientRect();
      if (r.top < 0 || r.top > 64 || r.left < innerW * 0.25 || r.width < 16 || r.width > 42 || r.height < 16 || r.height > 42) {
        continue;
      }
      const txt = (b.textContent || '').trim();
      const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
      const isNamedPlus = /new tab|新建标签|add tab|新建终端|new terminal/i.test(lbl);
      const isSvgPlus = !txt && Boolean(b.querySelector('svg')) && (
        /plus|add|new/i.test(lbl) ||
        Boolean(b.querySelector('path[d*="M12 5"], path[d*="M5 12"], path[d*="M8 3"], path[d*="M3 8"], line'))
      );
      if (txt === '+' || isNamedPlus || isSvgPlus) {
        if (!best || (isNamedPlus && !/new tab|新建/i.test(best.getAttribute('aria-label') || ''))) {
          best = b;
        }
      }
    }
    return best;
  }

  function findNewTerminalDirectButton() {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of btns) {
      if (!b || b.closest(`#${HOST_ID}`)) continue;
      const r = b.getBoundingClientRect();
      if (!isVisibleRect(r, 14, 14)) continue;
      const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
      if (/^(新建终端标签页|新建终端|New Terminal Tab|New Terminal)$/i.test(lbl)) {
        return b;
      }
    }
    return null;
  }

  function findTerminalMenuItemInOpenPopups() {
    const items = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], button')
    );
    for (const el of items) {
      if (!el || el.closest(`#${HOST_ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (!isVisibleRect(r, 40, 18)) continue;
      // 排除顶部 tab 本身，菜单项通常在 top > 36
      if (r.top < 36) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(终端|Terminal|新建终端标签页|新建终端|New Terminal Tab|New Terminal)$/i.test(txt)) {
        return el;
      }
    }
    return null;
  }

  async function createNewBuiltinTerminal() {
    const existingSet = new Set(findAllXtermTextareas());

    // 1. 若页面直接有“新建终端”按钮，优先点击
    const directBtn = findNewTerminalDirectButton();
    if (directBtn) {
      directBtn.click();
      const created = await waitForXtermReady({ excludeSet: existingSet, waitForPrompt: true, timeoutMs: 2800 });
      if (created) return created;
    }

    // 2. 通过右侧边栏的 `+` 新建标签页 -> 选择「终端 / Terminal」
    let plusBtn = findAuxPlusTabButton();
    if (!plusBtn) {
      const toggleBtn = findRightPaneToggleButton();
      if (toggleBtn) {
        toggleBtn.click();
        await sleep(220);
        plusBtn = findAuxPlusTabButton();
      }
    }

    if (plusBtn) {
      plusBtn.click();
      let termMenuItem = null;
      const menuDeadline = Date.now() + 900;
      while (Date.now() < menuDeadline) {
        termMenuItem = findTerminalMenuItemInOpenPopups();
        if (termMenuItem) break;
        await sleep(60);
      }
      if (termMenuItem) {
        termMenuItem.click();
        const created = await waitForXtermReady({ excludeSet: existingSet, waitForPrompt: true, timeoutMs: 3000 });
        if (created) return created;
      } else {
        // 未弹出菜单时关闭可能残留的焦点
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        } catch (_) {}
      }
    }

    // 3. 兜底：尝试触发原生切换终端快捷键 (Ctrl+`)
    try {
      const target = document.activeElement || document.body;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: '`', code: 'Backquote', keyCode: 192, ctrlKey: true, bubbles: true, cancelable: true })
      );
      const created = await waitForXtermReady({ excludeSet: existingSet, waitForPrompt: true, timeoutMs: 1800 });
      if (created) return created;
    } catch (_) {}

    return null;
  }

  async function ensureExistingOrCreateBuiltinTerminal() {
    // 1. 已有可见内置终端 -> 直接使用
    const visible = findVisibleXtermTextarea();
    if (visible) return { ta: visible, created: false };

    // 2. 顶部标签栏有已打开但未激活的终端标签 -> 切换过去
    const tabBtn = findExistingTerminalTabButton();
    if (tabBtn) {
      tabBtn.click();
      const activated = await waitForXtermReady({ waitForPrompt: false, timeoutMs: 1400 });
      if (activated) return { ta: activated, created: false };
    }

    // 3. 如果右侧边栏被折叠了，先展开看看里面是否已有终端
    const toggleBtn = findRightPaneToggleButton();
    if (toggleBtn && !findAuxPlusTabButton()) {
      toggleBtn.click();
      await sleep(220);
      const afterOpen = findVisibleXtermTextarea();
      if (afterOpen) return { ta: afterOpen, created: false };
      const tabAfterOpen = findExistingTerminalTabButton();
      if (tabAfterOpen) {
        tabAfterOpen.click();
        const activated = await waitForXtermReady({ waitForPrompt: false, timeoutMs: 1400 });
        if (activated) return { ta: activated, created: false };
      }
    }

    // 4. 确实没有已打开的终端 -> 自动创建一个新的内置终端
    const created = await createNewBuiltinTerminal();
    if (created) return { ta: created, created: true };

    return { ta: null, created: false };
  }

  function dispatchTextToXterm(ta, text, autoExecute) {
    if (!ta) return false;
    const payload = autoExecute ? `${text}\r` : text;
    try {
      ta.focus();
      const dt = typeof DataTransfer === 'function' ? new DataTransfer() : null;
      if (dt) {
        dt.setData('text/plain', payload);
        const pasteEvt = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        ta.dispatchEvent(pasteEvt);
        return true;
      }
    } catch (_) {}
    try {
      ta.focus();
      ta.value = payload;
      ta.dispatchEvent(new InputEvent('input', { data: payload, inputType: 'insertFromPaste', bubbles: true }));
      if (autoExecute) {
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function sendCommandToTerminal(cmdInfo, options = {}) {
    const command = typeof cmdInfo === 'string' ? cmdInfo : (cmdInfo && cmdInfo.command) || '';
    if (!command) return;
    const autoExecute = Boolean(options.autoExecute);
    const preferNew = Boolean(options.preferNew);

    if (options.external) {
      if (!sysBridge) {
        await copyText(command);
        showToast('已复制命令（重启接入新宿主后可直接唤起外部终端）', 'warn');
        return;
      }
      const res = await callSysBridge('/sys/open-terminal', {
        path: options.cwd || '',
        command,
      });
      if (res && res.ok) {
        showToast('已在外部终端中运行命令', 'ok');
      } else {
        await copyText(command);
        showToast(`外部终端启动失败，已复制命令：${(res && res.error) || ''}`, 'warn');
      }
      return;
    }

    let ta = null;
    let createdNew = false;

    if (preferNew) {
      // 「输入并在终端运行」：优先创建一个新终端并运行
      ta = await createNewBuiltinTerminal();
      if (ta) {
        createdNew = true;
      } else {
        const fallback = await ensureExistingOrCreateBuiltinTerminal();
        ta = fallback.ta;
        createdNew = fallback.created;
      }
    } else {
      // 「快捷输入到终端」：优先输入到已打开的终端，没有时自动打开新终端
      const res = await ensureExistingOrCreateBuiltinTerminal();
      ta = res.ta;
      createdNew = res.created;
    }

    if (ta && dispatchTextToXterm(ta, command, autoExecute)) {
      if (autoExecute) {
        showToast(createdNew ? '已新建终端并运行命令' : '已在终端中运行命令', 'ok');
      } else {
        showToast(createdNew ? '已自动打开终端并输入（按 Enter 执行）' : '已输入到终端（按 Enter 执行）', 'ok');
      }
      return;
    }

    // 兜底：若页面实在无法唤起内置终端且用户选择了运行，尝试外部终端或复制剪贴板
    if (autoExecute && sysBridge) {
      const extRes = await callSysBridge('/sys/open-terminal', { path: options.cwd || '', command });
      if (extRes && extRes.ok) {
        showToast('已在外部终端中运行命令', 'ok');
        return;
      }
    }
    await copyText(command);
    showToast('未能自动打开内置终端，已复制命令，打开终端按 Ctrl+V 即可输入', 'warn');
  }

  // ==================== 剪贴板与输入框交互工具 ====================

  async function copyText(text, label) {
    if (typeof text !== 'string') return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        if (label) showToast(`已复制${label}`, 'ok');
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (label) showToast(`已复制${label}`, 'ok');
      return true;
    } catch (_) {
      showToast('复制失败', 'error');
      return false;
    }
  }

  function findChatInputElement() {
    const candidates = Array.from(
      document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
    ).filter((el) => {
      if (!el || el.closest(`#${HOST_ID}`)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 120 && rect.height >= 20 && rect.bottom > 0;
    });
    if (candidates.length === 0) return null;
    // 优先选择靠近页面底部的对话输入框
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0];
  }

  function insertTextIntoChatInput(text) {
    const target = findChatInputElement();
    if (!target) {
      void copyText(text, '内容（未找到输入框，已复制到剪贴板）');
      return false;
    }
    target.focus();
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
      const next = target.value.slice(0, start) + text + target.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(target, next);
      else target.value = next;
      target.selectionStart = target.selectionEnd = start + text.length;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch (_) {
        target.textContent = (target.textContent || '') + text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    showToast('已填入对话输入框', 'ok');
    return true;
  }

  function openExternalUrl(url) {
    if (!url) return;
    if (window.electronNative && typeof window.electronNative.openExternal === 'function') {
      window.electronNative.openExternal(url).catch(() => window.open(url, '_blank', 'noopener'));
      return;
    }
    window.open(url, '_blank', 'noopener');
  }

  // ==================== DOM 右键上下文采集 ====================

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'password', 'tel', 'number'].includes(t) && !el.readOnly && !el.disabled;
    }
    return Boolean(el.isContentEditable || el.closest('[contenteditable="true"]'));
  }

  function getCaretTextAndOffset(clientX, clientY) {
    try {
      if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(clientX, clientY);
        if (range && range.startContainer && range.startContainer.nodeType === 3) {
          return { text: range.startContainer.textContent || '', offset: range.startOffset };
        }
      } else if (typeof document.caretPositionFromPoint === 'function') {
        const pos = document.caretPositionFromPoint(clientX, clientY);
        if (pos && pos.offsetNode && pos.offsetNode.nodeType === 3) {
          return { text: pos.offsetNode.textContent || '', offset: pos.offset };
        }
      }
    } catch (_) {}
    return null;
  }

  function extractContextFromEvent(event) {
    const target = event.target && event.target.nodeType === 1 ? event.target : event.target?.parentElement || null;
    const selObj = window.getSelection ? window.getSelection() : null;
    const selectionText = selObj ? String(selObj.toString() || '').trim() : '';
    const editable = isEditableElement(target);

    // 1. 链接探测
    const anchor = target ? target.closest('a[href]') : null;
    const rawHref = anchor ? (anchor.getAttribute('href') || anchor.href || '').trim() : '';
    const linkUrl = /^https?:\/\//i.test(rawHref) ? rawHref : '';
    const linkText = anchor ? (anchor.textContent || '').trim() : '';

    // 2. 代码块与标蓝行内代码探测
    const preEl = target ? target.closest('pre') : null;
    const codeBlockText = preEl ? (preEl.textContent || '').trim() : '';
    const inlineCodeEl = target && !preEl ? target.closest('code, kbd') : null;
    const inlineCodeText = inlineCodeEl ? (inlineCodeEl.textContent || '').trim() : '';

    // 3. 路径多级探测（优先级：file:// 链接 > data-path > 选中文本 > 行内 code > 光标精确文本节点 > 元素文本）
    let pathInfo = null;
    const plat = sysBridge?.platform || detectPlatform();

    if (rawHref && /^file:\/\//i.test(rawHref)) {
      pathInfo = buildPathInfo(rawHref, 'file-link', plat);
    }
    if (!pathInfo && target) {
      const dataHost = target.closest('[data-path], [data-filepath], [data-file-path], [title]');
      if (dataHost) {
        const attrVal =
          dataHost.getAttribute('data-path') ||
          dataHost.getAttribute('data-filepath') ||
          dataHost.getAttribute('data-file-path') ||
          dataHost.getAttribute('title') ||
          '';
        if (attrVal && attrVal.length < 400) {
          pathInfo = extractBestPathFromText(attrVal, { source: 'attr', platform: plat });
        }
      }
    }
    if (!pathInfo && selectionText) {
      pathInfo = extractBestPathFromText(selectionText, { source: 'selection', platform: plat });
    }
    if (!pathInfo && inlineCodeText && inlineCodeText.length <= 420) {
      pathInfo = extractBestPathFromText(inlineCodeText, { source: 'inline-code', platform: plat });
    }
    if (!pathInfo) {
      const caret = getCaretTextAndOffset(event.clientX, event.clientY);
      if (caret && caret.text) {
        pathInfo = extractBestPathFromText(caret.text, {
          offset: caret.offset,
          source: 'caret',
          platform: plat,
        });
      }
    }
    if (!pathInfo && target && target.textContent && target.textContent.length <= 360) {
      pathInfo = extractBestPathFromText(target.textContent, { source: 'element', platform: plat });
    }

    // 4. 终端可执行命令探测（优先级：选中文本 > 标蓝行内 code > 代码块）
    let commandInfo = null;
    if (selectionText) {
      commandInfo = extractCommandFromText(selectionText);
    }
    if (!commandInfo && inlineCodeText) {
      commandInfo = extractCommandFromText(inlineCodeText);
    }
    if (!commandInfo && codeBlockText) {
      commandInfo = extractCommandFromText(codeBlockText);
    }

    // 5. 统一可复制目标（继承原版右键菜单「复制」能力）
    const copyableText =
      selectionText ||
      inlineCodeText ||
      (pathInfo ? pathInfo.path : '') ||
      linkUrl ||
      linkText ||
      '';

    // 6. 精准识别左侧边栏、顶栏、终端与原生交互控件区（保护左侧栏原生菜单，不误伤主工作区）
    const inLeftSidebar = isInLeftSidebar(target);
    const inTopChrome = event.clientY < 42;
    const inXterm = Boolean(target && target.closest('.xterm'));
    const inInteractiveChrome = Boolean(
      inLeftSidebar ||
      inTopChrome ||
      inXterm ||
      (target && target.closest('[role="tablist"], [role="tab"], [role="treeitem"], [role="menuitem"], header'))
    );

    return {
      event,
      clientX: event.clientX,
      clientY: event.clientY,
      target,
      editable,
      selectionText,
      linkUrl,
      linkText,
      codeBlockText,
      inlineCodeText,
      commandInfo,
      copyableText,
      pathInfo,
      inLeftSidebar,
      inInteractiveChrome,
      platform: plat,
      hasSysBridge: Boolean(sysBridge),
    };
  }

  function locateLeftSidebarContainer() {
    const innerH = window.innerHeight || 800;
    const composer = findChatInputElement();
    const btns = document.querySelectorAll('button, a, [role="button"]');
    let anchorBtn = null;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!b || b.closest(`#${HOST_ID}`)) continue;
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
      const label = txt || aria;
      if (/^(Settings|设置)$/i.test(label)) {
        const r = b.getBoundingClientRect();
        if (r.left >= 0 && r.left < 280 && r.bottom > innerH - 180 && r.width > 0) {
          anchorBtn = b;
          break;
        }
      }
      if (!anchorBtn && /^(New Conversation|新建对话|Customizations|自定义|Inbox|收件箱)$/i.test(label)) {
        const r = b.getBoundingClientRect();
        if (r.left >= 0 && r.left < 260 && r.width > 0 && r.width < 320) {
          anchorBtn = b;
        }
      }
    }
    if (anchorBtn) {
      let cur = anchorBtn.parentElement;
      let best = null;
      for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 14; depth++) {
        if (composer && cur.contains(composer)) break;
        const r = cur.getBoundingClientRect();
        if (r.left <= 16 && r.width >= 120 && r.width <= 420 && r.height >= innerH * 0.55) {
          best = cur;
        }
        cur = cur.parentElement;
      }
      if (best) return best;
    }
    return null;
  }

  function isInLeftSidebar(target) {
    if (!target) return false;
    const semantic = target.closest('aside, nav');
    if (semantic) {
      const r = semantic.getBoundingClientRect();
      if (r.left <= 20 && r.width <= 420 && r.height >= (window.innerHeight || 800) * 0.4) {
        return true;
      }
    }
    const sidebar = locateLeftSidebarContainer();
    if (sidebar && sidebar.contains(target)) {
      return true;
    }
    return false;
  }

  function shouldTakeOverContextMenu(ctx) {
    // 按住 Shift 始终放行原生菜单
    if (ctx.event.shiftKey) return false;
    // 左侧边栏（会话列表/工作区/导航等）始终保留 Antigravity 原生右键菜单，绝不覆盖！
    if (ctx.inLeftSidebar) return false;
    // 顶栏/标签页头/内置终端等原生功能区放行原生菜单
    if (ctx.inInteractiveChrome && !ctx.pathInfo && !ctx.commandInfo && !ctx.inlineCodeText && !ctx.selectionText) {
      return false;
    }
    // 命中路径或 file:// 链接
    if (ctx.pathInfo) return true;
    // 命中标蓝行内代码或终端命令
    if (ctx.inlineCodeText || ctx.commandInfo) return true;
    // 命中 http/https 链接
    if (ctx.linkUrl) return true;
    // 选中了文本
    if (ctx.selectionText) return true;
    // 命中代码块
    if (ctx.codeBlockText) return true;
    // 输入框（根据偏好）
    if (ctx.editable && registry.config.prefs.enableOnInputs !== false) return true;
    // 其他正文区域接管
    return true;
  }

  // ==================== 注册内置扩展模块 ====================

  // 模块 1：路径与资源管理器（位于原版基础编辑项之后）
  registry.registerModule({
    id: 'path-explorer',
    name: '路径识别与资源管理器直达',
    description: '自动识别对话与代码中的本地路径或 file:// 链接，一键在资源管理器中定位、直接打开文件、终端打开及多格式复制。',
    priority: 20,
    builtin: true,
    getItems(ctx) {
      if (!ctx.pathInfo) return [];
      const p = ctx.pathInfo;
      const isMac = ctx.platform === 'darwin';
      const explorerName = isMac ? 'Finder' : '资源管理器';
      const items = [];

      if (registry.config.prefs.showPathPreview === true) {
        const lineTag = p.line ? `:${p.line}${p.endLine ? '-' + p.endLine : ''}` : '';
        items.push({
          type: 'header',
          id: 'path-preview-header',
          label: `${p.filename || p.path}${lineTag}`,
          sublabel: p.path,
          badge: p.isLikelyFile ? '文件' : '路径',
          badgeTone: 'info',
        });
      }

      items.push({
        id: 'path-reveal-explorer',
        label: `在${explorerName}中打开`,
        icon: 'folder-open',
        shortcut: p.isLikelyFile ? '定位文件' : '打开目录',
        onClick: () => void revealPathInExplorer(p),
      });

      if (ctx.hasSysBridge) {
        items.push({
          id: 'path-open-default',
          label: p.isLikelyFile ? '使用默认应用打开文件' : '直接进入文件夹',
          icon: 'external',
          onClick: () => void openPathWithDefaultApp(p),
        });

        items.push({
          id: 'path-open-terminal',
          label: '在终端中打开所在目录',
          icon: 'terminal',
          onClick: () => void openTerminalAtPath(p),
        });
      }

      items.push({
        id: 'path-copy-submenu',
        label: '复制路径',
        icon: 'copy',
        submenu: [
          {
            id: 'path-copy-native',
            label: '复制完整路径',
            shortcut: p.platform === 'win32' ? '\\' : '',
            onClick: () => void copyText(p.path, '路径'),
          },
          {
            id: 'path-copy-posix',
            label: '复制 POSIX 路径 (/)',
            onClick: () => void copyText(p.posixPath, ' POSIX 路径'),
          },
          {
            id: 'path-copy-dir',
            label: '复制所在目录路径',
            onClick: () => void copyText(p.parentDir || p.path, '所在目录路径'),
          },
          {
            id: 'path-copy-name',
            label: '仅复制文件名',
            onClick: () => void copyText(p.filename || p.path, '文件名'),
          },
          ...(p.fileUrl
            ? [
                {
                  id: 'path-copy-fileurl',
                  label: '复制 file:// 链接',
                  onClick: () => void copyText(p.fileUrl, ' file:// 链接'),
                },
              ]
            : []),
        ],
      });

      return items;
    },
  });

  // 模块 2：标蓝行内代码与终端命令直输
  registry.registerModule({
    id: 'terminal-command',
    name: '终端命令识别与快捷输入',
    description: '识别标蓝行内代码、代码块与选区中的可执行命令，一键快捷输入到内置终端或外部终端运行。',
    priority: 25,
    builtin: true,
    getItems(ctx) {
      const items = [];
      if (ctx.commandInfo) {
        const cmd = ctx.commandInfo;
        if (!ctx.pathInfo && registry.config.prefs.showPathPreview === true) {
          const preview = cmd.command.replace(/\s+/g, ' ');
          items.push({
            type: 'header',
            id: 'cmd-preview-header',
            label: cmd.binary,
            sublabel: preview,
            badge: '终端命令',
          });
        }
        items.push({
          id: 'cmd-send-terminal',
          label: '快捷输入到终端',
          icon: 'terminal',
          shortcut: '当前终端',
          onClick: () => void sendCommandToTerminal(cmd, { autoExecute: false, preferNew: false }),
        });
        items.push({
          id: 'cmd-run-terminal',
          label: '输入并在终端运行',
          icon: 'external',
          shortcut: '新建终端',
          onClick: () => void sendCommandToTerminal(cmd, { autoExecute: true, preferNew: true }),
        });
        if (ctx.hasSysBridge) {
          items.push({
            id: 'cmd-run-external',
            label: '在外部终端中运行',
            icon: 'terminal',
            onClick: () => void sendCommandToTerminal(cmd, { external: true }),
          });
        }
        return items;
      }

      // 非路径、非命令的标蓝行内代码（如 app.asar.staged、v2.4.0）
      if (ctx.inlineCodeText && !ctx.pathInfo) {
        if (registry.config.prefs.showPathPreview === true) {
          items.push({
            type: 'header',
            id: 'inline-code-header',
            label: ctx.inlineCodeText,
            sublabel: '行内代码片段',
            badge: '代码',
          });
        }
        items.push({
          id: 'inline-code-quote',
          label: '引用到对话输入框',
          icon: 'quote',
          onClick: () => insertTextIntoChatInput(`\`${ctx.inlineCodeText}\` `),
        });
      }
      return items;
    },
  });

  // 模块 3：网页链接增强
  registry.registerModule({
    id: 'link-actions',
    name: '网页链接操作',
    description: '右键 http/https 链接时支持在浏览器打开、复制地址及复制 Markdown 链接。',
    priority: 30,
    builtin: true,
    getItems(ctx) {
      if (!ctx.linkUrl) return [];
      return [
        {
          id: 'link-open-browser',
          label: '在浏览器中打开链接',
          icon: 'globe',
          onClick: () => openExternalUrl(ctx.linkUrl),
        },
        {
          id: 'link-copy-url',
          label: '复制链接地址',
          icon: 'link',
          onClick: () => void copyText(ctx.linkUrl, '链接地址'),
        },
        {
          id: 'link-copy-md',
          label: '复制为 Markdown 链接',
          icon: 'code',
          onClick: () => {
            const label = ctx.linkText || ctx.linkUrl;
            void copyText(`[${label}](${ctx.linkUrl})`, ' Markdown 链接');
          },
        },
      ];
    },
  });

  // 模块 0：原版基础编辑与代码块（置顶优先展示，复刻 Agy 原生菜单顺序）
  registry.registerModule({
    id: 'edit-basics',
    name: '基础编辑与代码块',
    description: '置顶保留原版复制、剪切、粘贴、全选及一键复制整个代码块。',
    priority: 10,
    builtin: true,
    getItems(ctx) {
      const items = [];
      if (ctx.copyableText) {
        const copyLabel = ctx.selectionText
          ? '复制'
          : ctx.commandInfo
            ? '复制命令'
            : ctx.inlineCodeText
              ? '复制代码片段'
              : '复制';
        items.push({
          id: 'edit-copy',
          label: copyLabel,
          icon: 'copy',
          shortcut: 'Ctrl+C',
          onClick: () => void copyText(ctx.copyableText, ctx.commandInfo ? '命令' : ctx.inlineCodeText ? '代码片段' : '内容'),
        });
      }
      if (ctx.editable) {
        if (ctx.selectionText) {
          items.push({
            id: 'edit-cut',
            label: '剪切',
            icon: 'scissors',
            shortcut: 'Ctrl+X',
            onClick: () => {
              ctx.target?.focus?.();
              try {
                document.execCommand('cut');
              } catch (_) {
                void copyText(ctx.selectionText, '选中文本');
              }
            },
          });
        }
        items.push({
          id: 'edit-paste',
          label: '粘贴',
          icon: 'clipboard',
          shortcut: 'Ctrl+V',
          onClick: async () => {
            try {
              const txt = await navigator.clipboard.readText();
              if (txt && ctx.target) {
                ctx.target.focus();
                document.execCommand('insertText', false, txt);
              }
            } catch (_) {
              showToast('请使用 Ctrl+V 粘贴', 'warn');
            }
          },
        });
      }
      if (ctx.codeBlockText) {
        items.push({
          id: 'edit-copy-codeblock',
          label: '复制完整代码块',
          icon: 'code',
          onClick: () => void copyText(ctx.codeBlockText, '代码块'),
        });
      }
      if (ctx.editable || !ctx.selectionText) {
        items.push({
          id: 'edit-select-all',
          label: '全选',
          icon: 'select-all',
          shortcut: 'Ctrl+A',
          onClick: () => {
            if (ctx.editable && ctx.target) {
              ctx.target.focus();
              if (typeof ctx.target.select === 'function') {
                ctx.target.select();
                return;
              }
            }
            document.execCommand('selectAll');
          },
        });
      }
      return items;
    },
  });

  // 模块 4：选中文本实用工具
  registry.registerModule({
    id: 'selection-tools',
    name: '选中文本工具箱',
    description: '支持一键引用到对话框，以及 JSON 格式化、URL/Base64 编解码与字数统计。',
    priority: 40,
    builtin: true,
    getItems(ctx) {
      if (!ctx.selectionText) return [];
      const text = ctx.selectionText;
      return [
        {
          id: 'sel-quote-to-chat',
          label: '引用到对话输入框',
          icon: 'quote',
          onClick: () => {
            const quoted = text
              .split(/\r?\n/)
              .map((line) => `> ${line}`)
              .join('\n');
            insertTextIntoChatInput(`${quoted}\n\n`);
          },
        },
        {
          id: 'sel-transform-submenu',
          label: '文本转换与工具',
          icon: 'wand',
          submenu: [
            {
              id: 'sel-json-pretty',
              label: 'JSON 格式化并复制',
              onClick: () => {
                try {
                  const formatted = JSON.stringify(JSON.parse(text), null, 2);
                  void copyText(formatted, '格式化后的 JSON');
                } catch (_) {
                  showToast('选中内容不是有效的 JSON', 'error');
                }
              },
            },
            {
              id: 'sel-url-encode',
              label: 'URL 编码并复制',
              onClick: () => void copyText(encodeURIComponent(text), ' URL 编码结果'),
            },
            {
              id: 'sel-url-decode',
              label: 'URL 解码并复制',
              onClick: () => {
                try {
                  void copyText(decodeURIComponent(text), ' URL 解码结果');
                } catch (_) {
                  showToast('URL 解码失败', 'error');
                }
              },
            },
            {
              id: 'sel-b64-encode',
              label: 'Base64 编码并复制',
              onClick: () => {
                try {
                  const bytes = new TextEncoder().encode(text);
                  let bin = '';
                  bytes.forEach((b) => (bin += String.fromCharCode(b)));
                  void copyText(btoa(bin), ' Base64 编码');
                } catch (_) {
                  showToast('Base64 编码失败', 'error');
                }
              },
            },
            {
              id: 'sel-b64-decode',
              label: 'Base64 解码并复制',
              onClick: () => {
                try {
                  const bin = atob(text.trim());
                  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                  void copyText(new TextDecoder().decode(bytes), ' Base64 解码结果');
                } catch (_) {
                  showToast('不是有效的 Base64 字符串', 'error');
                }
              },
            },
            {
              id: 'sel-stats',
              label: '统计字数与行数',
              onClick: () => {
                const lines = text.split(/\r?\n/).length;
                const chars = text.length;
                const nonSpace = text.replace(/\s/g, '').length;
                showToast(`共 ${chars} 字符（非空 ${nonSpace}），${lines} 行`, 'ok');
              },
            },
          ],
        },
      ];
    },
  });

  // 模块 5：用户自定义动作
  registry.registerModule({
    id: 'custom-actions',
    name: '自定义扩展动作',
    description: '运行你在设置面板中自定义的 Prompt 模板、复制模板或快捷搜索动作。',
    priority: 50,
    builtin: true,
    getItems(ctx) {
      const list = Array.isArray(registry.config.customActions) ? registry.config.customActions : [];
      const items = [];
      for (const act of list) {
        if (!act || !act.label || !act.template) continue;
        const when = act.when || 'always';
        if (when === 'hasPath' && !ctx.pathInfo) continue;
        if (when === 'hasSelection' && !ctx.selectionText) continue;
        if (when === 'hasLink' && !ctx.linkUrl) continue;
        items.push({
          id: `custom-${act.id}`,
          label: act.label,
          icon: 'spark',
          onClick: () => {
            const rendered = renderActionTemplate(act.template, ctx);
            if (act.type === 'copy-template') {
              void copyText(rendered, '模板结果');
            } else if (act.type === 'open-url') {
              openExternalUrl(rendered);
            } else {
              insertTextIntoChatInput(rendered);
            }
          },
        });
      }
      return items;
    },
  });

  // 模块 6：底部框架管理入口（始终可用）
  registry.registerModule({
    id: 'framework-footer',
    name: '框架设置入口',
    description: '右键菜单底部的扩展管理与设置入口。',
    priority: 999,
    builtin: true,
    alwaysOn: true,
    getItems() {
      return [
        {
          id: 'ctx-open-settings',
          label: '管理右键菜单与扩展…',
          icon: 'settings',
          shortcut: 'Alt+M',
          onClick: () => openSettingsModal(),
        },
      ];
    },
  });

  // ==================== Shadow DOM 渲染层 ====================

  const ICONS = {
    'folder-open': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.4 1.5H13A1.25 1.25 0 0 1 14.25 5.75V7H3.4l-1.65 5.25V4.25Z"/><path d="M2.2 12.75 3.8 7.5h10.7l-1.55 5.25H2.2Z"/></svg>',
    external: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 7 9"/><path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3"/></svg>',
    terminal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="2.5" width="12.5" height="11" rx="1.75"/><path d="m4.75 6.25 2.25 2-2.25 2"/><path d="M8.5 10.25h2.75"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.25"/><path d="M3.5 10.5H3a1.25 1.25 0 0 1-1.25-1.25V3A1.25 1.25 0 0 1 3 1.75h6.25A1.25 1.25 0 0 1 10.5 3v.5"/></svg>',
    scissors: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.25" cy="4.25" r="1.75"/><circle cx="4.25" cy="11.75" r="1.75"/><path d="M13.25 3.25 5.7 10.45"/><path d="M9.4 9.4 13.25 12.75"/><path d="M5.7 5.55 8 7.8"/></svg>',
    clipboard: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.75" width="10" height="11.5" rx="1.5"/><path d="M5.75 2.75v-.5A1 1 0 0 1 6.75 1.25h2.5a1 1 0 0 1 1 1v.5"/></svg>',
    code: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5.25 4.75-3.25 3.25 3.25 3.25"/><path d="m10.75 4.75 3.25 3.25-3.25 3.25"/><path d="m9.25 2.75-2.5 10.5"/></svg>',
    'select-all': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" stroke-dasharray="2.5 2"/><path d="M5.25 5.75h5.5M5.25 8h5.5M5.25 10.25h3.5"/></svg>',
    globe: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2.2 8h11.6"/><path d="M8 2a9.5 9.5 0 0 1 0 12A9.5 9.5 0 0 1 8 2Z"/></svg>',
    link: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.75 9.25a3 3 0 0 0 4.24 0l2-2a3 3 0 1 0-4.24-4.24l-1 1"/><path d="M9.25 6.75a3 3 0 0 0-4.24 0l-2 2a3 3 0 1 0 4.24 4.24l1-1"/></svg>',
    quote: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 8h7M3 12h8"/></svg>',
    wand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 13.5 7-7"/><path d="m9.5 6.5 2-2 2 2-2 2-2-2Z"/><path d="M5 3v1.5M3.5 4.5H5M12 10.5V12M10.5 12H12"/></svg>',
    spark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v12M2 8h12M4 4l8 8M12 4 4 12"/></svg>',
    settings: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.25"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3.75 4.25 4.25L6 12.25"/></svg>',
  };

  let shadowHost = null;
  let shadowRoot = null;
  let menuContainer = null;
  let toastContainer = null;
  let modalContainer = null;
  let activeMenuCloseFn = null;

  function detectDarkTheme() {
    try {
      const rootEl = document.documentElement;
      if (rootEl && (rootEl.classList.contains('dark') || rootEl.getAttribute('data-theme') === 'dark')) {
        return true;
      }
      if (rootEl && (rootEl.classList.contains('light') || rootEl.getAttribute('data-theme') === 'light')) {
        return false;
      }
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 128;
      }
    } catch (_) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function isValidCssColor(val) {
    if (!val || typeof val !== 'string') return false;
    const s = val.trim();
    if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return false;
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
      return CSS.supports('color', s);
    }
    return /^(#|rgb|hsl|oklch|lab|lch|color)/i.test(s);
  }

  function syncHostTheme(hostEl) {
    if (!hostEl) return;
    const isDark = detectDarkTheme();
    hostEl.setAttribute('data-theme', isDark ? 'dark' : 'light');
    try {
      const rootCs = getComputedStyle(document.documentElement);
      const colorMap = [
        ['--host-popover', ['--popover', '--card', '--background', '--vscode-menu-background', '--vscode-sideBar-background']],
        ['--host-bg', ['--background', '--vscode-sideBar-background']],
        ['--host-fg', ['--popover-foreground', '--foreground', '--vscode-foreground']],
        ['--host-muted-fg', ['--muted-foreground', '--vscode-descriptionForeground']],
        ['--host-border', ['--border', '--vscode-menu-border']],
        ['--host-primary', ['--primary', '--vscode-focusBorder']],
        ['--host-primary-fg', ['--primary-foreground']],
      ];
      for (const [targetVar, sources] of colorMap) {
        let applied = false;
        for (const src of sources) {
          const val = rootCs.getPropertyValue(src).trim();
          if (isValidCssColor(val)) {
            hostEl.style.setProperty(targetVar, val);
            applied = true;
            break;
          }
        }
        if (!applied) {
          hostEl.style.removeProperty(targetVar);
        }
      }
      const hostFont = rootCs.getPropertyValue('--font-family').trim() || getComputedStyle(document.body).fontFamily;
      if (hostFont) {
        hostEl.style.setProperty('--host-font', hostFont);
      }
      const hostMono = rootCs.getPropertyValue('--editor-font-family').trim();
      if (hostMono) {
        hostEl.style.setProperty('--host-mono', hostMono);
      }
    } catch (_) {}
  }

  function ensureShadowRoot() {
    if (shadowRoot && shadowHost && document.documentElement.contains(shadowHost)) {
      syncHostTheme(shadowHost);
      return shadowRoot;
    }
    shadowHost = document.getElementById(HOST_ID) || document.createElement('div');
    shadowHost.id = HOST_ID;
    shadowHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    syncHostTheme(shadowHost);
    if (!shadowHost.parentNode) {
      document.documentElement.appendChild(shadowHost);
    }
    shadowRoot = shadowHost.shadowRoot || shadowHost.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          --bg: var(--host-popover, #ffffff);
          --bg-subtle: color-mix(in srgb, var(--fg) 4%, transparent);
          --bg-hover: color-mix(in srgb, var(--fg) 7%, transparent);
          --border: var(--host-border, color-mix(in srgb, var(--fg) 10%, transparent));
          --sep: color-mix(in srgb, var(--fg) 7.5%, transparent);
          --fg: var(--host-fg, #1d1f21);
          --fg-muted: var(--host-muted-fg, #636b73);
          --fg-dim: color-mix(in srgb, var(--fg-muted) 75%, transparent);
          --accent: var(--host-primary, #007acc);
          --accent-fg: var(--host-primary-fg, #ffffff);
          --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
          --ok: #5c9a55;
          --warn: #b8982e;
          --err: #cb4848;
          --font: var(--host-font, "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
          --mono: var(--host-mono, "Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
          --shadow: 0 8px 24px rgba(0, 0, 0, 0.14), 0 1px 3px rgba(0, 0, 0, 0.08);
          font-family: var(--font);
          font-size: 12.5px;
          color: var(--fg);
          -webkit-font-smoothing: antialiased;
        }
        :host([data-theme="dark"]) {
          --bg: var(--host-popover, #141416);
          --bg-subtle: color-mix(in srgb, var(--fg) 4%, transparent);
          --bg-hover: color-mix(in srgb, var(--fg) 7.5%, transparent);
          --border: var(--host-border, color-mix(in srgb, var(--fg) 10%, transparent));
          --sep: color-mix(in srgb, var(--fg) 7%, transparent);
          --fg: var(--host-fg, #e6e6ea);
          --fg-muted: var(--host-muted-fg, #8d8d96);
          --fg-dim: color-mix(in srgb, var(--fg-muted) 72%, transparent);
          --accent: var(--host-primary, #5b8af5);
          --accent-fg: var(--host-primary-fg, #ffffff);
          --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
          --ok: #7aae66;
          --warn: #cab43e;
          --err: #d95c5c;
          --shadow: 0 10px 28px rgba(0, 0, 0, 0.56), 0 1px 4px rgba(0, 0, 0, 0.36);
        }
        *, *::before, *::after { box-sizing: border-box; }
        .menu-layer { position: fixed; inset: 0; pointer-events: none; }
        .menu {
          position: fixed;
          min-width: 192px;
          max-width: 268px;
          padding: 4px;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: var(--shadow);
          pointer-events: auto;
          user-select: none;
          animation: agyCtxFade 0.08s ease-out;
        }
        @keyframes agyCtxFade {
          from { opacity: 0; transform: translateY(-2px) scale(0.99); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .menu-header {
          padding: 5px 8px 6px;
          margin-bottom: 2px;
          border-radius: 5px;
          background: var(--bg-subtle);
          border: 1px solid var(--sep);
        }
        .menu-header-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .menu-header-title {
          font-weight: 500;
          font-size: 12px;
          color: var(--fg);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .menu-header-sub {
          margin-top: 2px;
          font-size: 11px;
          color: var(--fg-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--mono);
        }
        .badge {
          flex-shrink: 0;
          font-size: 10px;
          font-weight: 500;
          padding: 1px 6px;
          border-radius: 4px;
          background: var(--bg-subtle);
          border: 1px solid var(--border);
          color: var(--fg-muted);
        }
        .badge.ok {
          background: color-mix(in srgb, var(--ok) 12%, transparent);
          border-color: color-mix(in srgb, var(--ok) 26%, transparent);
          color: var(--ok);
        }
        .badge.warn {
          background: color-mix(in srgb, var(--warn) 12%, transparent);
          border-color: color-mix(in srgb, var(--warn) 26%, transparent);
          color: var(--warn);
        }
        .sep {
          height: 1px;
          background: var(--sep);
          margin: 3px 4px;
        }
        .item {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 5.5px 8px;
          border: none;
          border-radius: 5px;
          background: transparent;
          color: var(--fg);
          font-family: var(--font);
          font-size: 12.5px;
          line-height: 1.35;
          text-align: left;
          cursor: pointer;
          transition: background 0.08s ease, color 0.08s ease;
        }
        .item:hover, .item.active { background: var(--bg-hover); }
        .item.disabled { opacity: 0.42; cursor: not-allowed; }
        .item-icon {
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--fg-muted);
          transition: color 0.08s ease;
        }
        .item:hover .item-icon, .item.active .item-icon { color: var(--fg); }
        .item-icon svg { width: 14px; height: 14px; }
        .item-label {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .item-shortcut {
          font-size: 11px;
          color: var(--fg-dim);
          margin-left: 10px;
          flex-shrink: 0;
        }
        .item-arrow {
          width: 12px;
          height: 12px;
          color: var(--fg-dim);
          flex-shrink: 0;
          display: inline-flex;
        }
        .submenu {
          position: fixed;
          min-width: 184px;
          max-width: 268px;
          padding: 4px;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: var(--shadow);
          pointer-events: auto;
          z-index: 2;
        }
        .toast-wrap {
          position: fixed;
          right: 16px;
          bottom: 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          pointer-events: none;
          z-index: 5;
        }
        .toast {
          padding: 7px 12px;
          border-radius: 7px;
          background: var(--bg);
          border: 1px solid var(--border);
          box-shadow: var(--shadow);
          color: var(--fg);
          font-size: 12px;
          max-width: 330px;
          display: flex;
          align-items: center;
          gap: 8px;
          animation: agyCtxFade 0.1s ease-out;
        }
        .toast-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--accent); }
        .toast.ok .toast-dot { background: var(--ok); }
        .toast.warn .toast-dot { background: var(--warn); }
        .toast.error .toast-dot { background: var(--err); }
        /* Settings Modal */
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(2px);
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          z-index: 10;
        }
        .modal {
          width: min(560px, 92vw);
          max-height: 82vh;
          display: flex;
          flex-direction: column;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: var(--shadow);
          overflow: hidden;
        }
        .modal-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 14px;
          border-bottom: 1px solid var(--sep);
        }
        .modal-title { font-weight: 600; font-size: 13px; color: var(--fg); }
        .modal-close {
          border: none;
          background: transparent;
          color: var(--fg-muted);
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          padding: 4px 6px;
          border-radius: 5px;
        }
        .modal-close:hover { background: var(--bg-hover); color: var(--fg); }
        .modal-body {
          padding: 13px 14px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .sec-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--fg-muted);
          margin-bottom: 6px;
          letter-spacing: 0.02em;
        }
        .card-list { display: flex; flex-direction: column; gap: 5px; }
        .mod-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 10px;
          border: 1px solid var(--sep);
          border-radius: 6px;
          background: var(--bg-subtle);
        }
        .mod-info { min-width: 0; }
        .mod-name { font-weight: 500; font-size: 12.5px; color: var(--fg); }
        .mod-desc { font-size: 11.5px; color: var(--fg-muted); margin-top: 2px; line-height: 1.4; }
        .btn {
          border: 1px solid var(--border);
          background: var(--bg-subtle);
          color: var(--fg);
          padding: 5px 10px;
          border-radius: 5px;
          font-family: var(--font);
          font-size: 12px;
          cursor: pointer;
        }
        .btn:hover { background: var(--bg-hover); }
        .btn-primary {
          background: var(--accent);
          border-color: var(--accent);
          color: var(--accent-fg);
        }
        .btn-primary:hover { opacity: 0.9; }
        .btn-danger { color: var(--err); }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 7px;
          padding: 9px;
          border: 1px dashed var(--border);
          border-radius: 6px;
        }
        .input, .select {
          width: 100%;
          padding: 5.5px 8px;
          border: 1px solid var(--border);
          border-radius: 5px;
          background: var(--bg);
          color: var(--fg);
          font-family: var(--font);
          font-size: 12px;
          outline: none;
        }
        .input:focus, .select:focus { border-color: var(--accent); }
        .full-col { grid-column: 1 / -1; }
        .hint { font-size: 11.5px; color: var(--fg-muted); line-height: 1.5; }
        code {
          font-family: var(--mono);
          font-size: 11px;
          padding: 1px 4px;
          border-radius: 4px;
          background: var(--bg-subtle);
          border: 1px solid var(--sep);
        }
      </style>
      <div class="menu-layer" id="menu-layer"></div>
      <div class="toast-wrap" id="toast-wrap"></div>
      <div id="modal-layer"></div>
    `;
    menuContainer = shadowRoot.getElementById('menu-layer');
    toastContainer = shadowRoot.getElementById('toast-wrap');
    modalContainer = shadowRoot.getElementById('modal-layer');
    return shadowRoot;
  }

  function showToast(message, type = 'ok') {
    ensureShadowRoot();
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-dot"></span><span></span>`;
    el.lastChild.textContent = String(message || '');
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 2800);
  }

  function closeMenu() {
    if (activeMenuCloseFn) {
      const fn = activeMenuCloseFn;
      activeMenuCloseFn = null;
      fn();
    }
    if (menuContainer) {
      menuContainer.innerHTML = '';
    }
  }

  function positionPopup(el, x, y) {
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > vw - pad) {
      left = Math.max(pad, vw - rect.width - pad);
    }
    if (top + rect.height > vh - pad) {
      top = Math.max(pad, vh - rect.height - pad);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function renderContextMenu(ctx) {
    closeMenu();
    ensureShadowRoot();

    const items = registry.buildMenuItems(ctx, { showToast, copyText, revealPathInExplorer, openPathWithDefaultApp });
    if (!items || items.length === 0) return false;

    const menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.setAttribute('role', 'menu');

    let openSubEl = null;
    const closeSubmenu = () => {
      if (openSubEl) {
        openSubEl.remove();
        openSubEl = null;
      }
    };

    const actionButtons = [];
    let headerBadgeEl = null;

    for (const item of items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'sep';
        menuEl.appendChild(sep);
        continue;
      }
      if (item.type === 'header') {
        const hdr = document.createElement('div');
        hdr.className = 'menu-header';
        hdr.innerHTML = `
          <div class="menu-header-top">
            <span class="menu-header-title"></span>
            <span class="badge"></span>
          </div>
          <div class="menu-header-sub"></div>
        `;
        hdr.querySelector('.menu-header-title').textContent = item.label || '';
        const b = hdr.querySelector('.badge');
        b.textContent = item.badge || '';
        if (!item.badge) b.style.display = 'none';
        headerBadgeEl = b;
        hdr.querySelector('.menu-header-sub').textContent = item.sublabel || '';
        hdr.title = item.sublabel || '';
        menuEl.appendChild(hdr);
        continue;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `item${item.disabled ? ' disabled' : ''}`;
      btn.setAttribute('role', 'menuitem');

      const iconSpan = document.createElement('span');
      iconSpan.className = 'item-icon';
      iconSpan.innerHTML = ICONS[item.icon] || ICONS.spark;
      btn.appendChild(iconSpan);

      const labelSpan = document.createElement('span');
      labelSpan.className = 'item-label';
      labelSpan.textContent = item.label || '';
      btn.appendChild(labelSpan);

      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'item-shortcut';
        sc.textContent = item.shortcut;
        btn.appendChild(sc);
      }

      const hasSub = Array.isArray(item.submenu) && item.submenu.length > 0;
      if (hasSub) {
        const arrow = document.createElement('span');
        arrow.className = 'item-arrow';
        arrow.innerHTML = ICONS.chevron;
        btn.appendChild(arrow);

        const openSub = () => {
          closeSubmenu();
          const sub = document.createElement('div');
          sub.className = 'submenu';
          for (const subItem of item.submenu) {
            if (!subItem) continue;
            if (subItem.type === 'separator') {
              const s = document.createElement('div');
              s.className = 'sep';
              sub.appendChild(s);
              continue;
            }
            const sbtn = document.createElement('button');
            sbtn.type = 'button';
            sbtn.className = 'item';
            const sl = document.createElement('span');
            sl.className = 'item-label';
            sl.textContent = subItem.label || '';
            sbtn.appendChild(sl);
            if (subItem.shortcut) {
              const ssc = document.createElement('span');
              ssc.className = 'item-shortcut';
              ssc.textContent = subItem.shortcut;
              sbtn.appendChild(ssc);
            }
            sbtn.addEventListener('click', (e) => {
              e.stopPropagation();
              closeMenu();
              try {
                subItem.onClick && subItem.onClick();
              } catch (_) {}
            });
            sub.appendChild(sbtn);
          }
          menuContainer.appendChild(sub);
          const btnRect = btn.getBoundingClientRect();
          const subRect = sub.getBoundingClientRect();
          let sx = btnRect.right + 4;
          if (sx + subRect.width > window.innerWidth - 8) {
            sx = Math.max(8, btnRect.left - subRect.width - 4);
          }
          let sy = btnRect.top - 4;
          if (sy + subRect.height > window.innerHeight - 8) {
            sy = Math.max(8, window.innerHeight - subRect.height - 8);
          }
          sub.style.left = `${sx}px`;
          sub.style.top = `${sy}px`;
          openSubEl = sub;
        };

        btn.addEventListener('mouseenter', openSub);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openSub();
        });
      } else {
        btn.addEventListener('mouseenter', closeSubmenu);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.disabled) return;
          closeMenu();
          try {
            item.onClick && item.onClick();
          } catch (_) {}
        });
      }

      menuEl.appendChild(btn);
      if (!item.disabled) {
        actionButtons.push(btn);
      }
    }

    menuContainer.appendChild(menuEl);
    positionPopup(menuEl, ctx.clientX, ctx.clientY);

    // 异步校验本地路径存在性（不阻塞菜单弹出）
    if (ctx.pathInfo && ctx.hasSysBridge && headerBadgeEl) {
      callSysBridge('/sys/stat', { path: ctx.pathInfo.path }).then((info) => {
        if (!info || !headerBadgeEl || !headerBadgeEl.isConnected) return;
        if (info.exists) {
          headerBadgeEl.textContent = info.isDirectory ? '文件夹' : '文件';
          headerBadgeEl.className = 'badge ok';
        } else if (info.nearestExistingParent) {
          headerBadgeEl.textContent = '不存在 · 可开上级';
          headerBadgeEl.className = 'badge warn';
        } else {
          headerBadgeEl.textContent = '路径不存在';
          headerBadgeEl.className = 'badge warn';
        }
      });
    }

    // 键盘与外部点击关闭
    let focusIdx = -1;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
      } else if (e.key === 'ArrowDown' && actionButtons.length > 0) {
        e.preventDefault();
        focusIdx = (focusIdx + 1) % actionButtons.length;
        actionButtons.forEach((b, i) => b.classList.toggle('active', i === focusIdx));
      } else if (e.key === 'ArrowUp' && actionButtons.length > 0) {
        e.preventDefault();
        focusIdx = (focusIdx - 1 + actionButtons.length) % actionButtons.length;
        actionButtons.forEach((b, i) => b.classList.toggle('active', i === focusIdx));
      } else if (e.key === 'Enter' && focusIdx >= 0 && actionButtons[focusIdx]) {
        e.preventDefault();
        actionButtons[focusIdx].click();
      }
    };
    const onOutsidePointer = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.includes(menuEl) || (openSubEl && path.includes(openSubEl))) return;
      closeMenu();
    };
    const onBlur = () => closeMenu();

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onOutsidePointer, true);
    window.addEventListener('scroll', onBlur, true);
    window.addEventListener('blur', onBlur);

    activeMenuCloseFn = () => {
      closeSubmenu();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onOutsidePointer, true);
      window.removeEventListener('scroll', onBlur, true);
      window.removeEventListener('blur', onBlur);
    };

    return true;
  }

  // ==================== 设置与扩展管理面板 (Alt+M) ====================

  function closeSettingsModal() {
    if (modalContainer) modalContainer.innerHTML = '';
  }

  function openSettingsModal() {
    closeMenu();
    ensureShadowRoot();
    if (!modalContainer) return;

    const render = () => {
      const mods = registry.listModules().filter((m) => !m.alwaysOn);
      const customActs = registry.config.customActions || [];
      const bridgeStatus = sysBridge
        ? `已连接本地系统桥接 (v${pluginMeta.appVersion || 'host'})`
        : '降级兼容模式（支持资源管理器定位；重启接入 v2.4.0 宿主可解锁直接打开文件与终端）';

      modalContainer.innerHTML = `
        <div class="modal-backdrop" id="backdrop">
          <div class="modal" role="dialog" aria-modal="true">
            <div class="modal-head">
              <div class="modal-title">右键菜单增强框架 · 扩展与设置</div>
              <button class="modal-close" id="btn-close" title="关闭">×</button>
            </div>
            <div class="modal-body">
              <div class="hint">
                运行状态：<strong>${bridgeStatus}</strong><br/>
                提示：按住 <strong>Shift + 右键</strong> 可随时直达原生右键菜单；外部插件可通过 <code>window.__AGY_CONTEXT_MENU__</code> 注册新模块。
              </div>

              <div>
                <div class="sec-title">界面与行为偏好</div>
                <div class="card-list">
                  <div class="mod-row">
                    <div class="mod-info">
                      <div class="mod-name">显示顶部路径/命令预览头</div>
                      <div class="mod-desc">默认关闭以保持 Antigravity 原生极简菜单布局；开启后在菜单顶部显示路径与实时状态徽章。</div>
                    </div>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;">
                      <input type="checkbox" id="pref-show-header" ${registry.config.prefs.showPathPreview === true ? 'checked' : ''} />
                      <span style="font-size:12px;">${registry.config.prefs.showPathPreview === true ? '开启' : '关闭'}</span>
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <div class="sec-title">已注册扩展模块 (${mods.length})</div>
                <div class="card-list" id="mod-list"></div>
              </div>

              <div>
                <div class="sec-title">自定义右键动作 (${customActs.length})</div>
                <div class="card-list" id="custom-list"></div>
                <div class="form-grid" style="margin-top:8px;">
                  <input class="input" id="act-label" placeholder="菜单项名称（如：用 Google 搜索）" />
                  <select class="select" id="act-when">
                    <option value="hasSelection">触发条件：选中文本时</option>
                    <option value="hasPath">触发条件：右键路径时</option>
                    <option value="hasLink">触发条件：右键链接时</option>
                    <option value="always">触发条件：始终显示</option>
                  </select>
                  <select class="select" id="act-type">
                    <option value="insert-prompt">动作：填入对话输入框</option>
                    <option value="copy-template">动作：渲染模板并复制</option>
                    <option value="open-url">动作：在浏览器打开 URL</option>
                  </select>
                  <button class="btn btn-primary" id="btn-add-act">+ 添加自定义动作</button>
                  <input class="input full-col" id="act-tpl" placeholder="模板（支持 {{selection}} {{selection_encoded}} {{path}} {{dir}} {{filename}} {{url}}）" />
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      const prefHeaderEl = modalContainer.querySelector('#pref-show-header');
      if (prefHeaderEl) {
        prefHeaderEl.addEventListener('change', (e) => {
          registry.config.prefs.showPathPreview = Boolean(e.target.checked);
          saveLocalConfig(registry.config);
          render();
        });
      }

      const modList = modalContainer.querySelector('#mod-list');
      for (const m of mods) {
        const row = document.createElement('div');
        row.className = 'mod-row';
        row.innerHTML = `
          <div class="mod-info">
            <div class="mod-name"></div>
            <div class="mod-desc"></div>
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;">
            <input type="checkbox" ${m.enabled ? 'checked' : ''} />
            <span style="font-size:12px;">${m.enabled ? '已启用' : '已停用'}</span>
          </label>
        `;
        row.querySelector('.mod-name').textContent = m.name;
        row.querySelector('.mod-desc').textContent = m.description;
        row.querySelector('input').addEventListener('change', (e) => {
          registry.setModuleEnabled(m.id, e.target.checked);
          saveLocalConfig(registry.config);
          render();
        });
        modList.appendChild(row);
      }

      const customList = modalContainer.querySelector('#custom-list');
      if (customActs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '暂无自定义动作，可在下方快速添加。';
        customList.appendChild(empty);
      } else {
        for (const act of customActs) {
          const row = document.createElement('div');
          row.className = 'mod-row';
          row.innerHTML = `
            <div class="mod-info">
              <div class="mod-name"></div>
              <div class="mod-desc"></div>
            </div>
            <button class="btn btn-danger">删除</button>
          `;
          row.querySelector('.mod-name').textContent = act.label;
          row.querySelector('.mod-desc').textContent = `[${act.type} / ${act.when}] ${act.template}`;
          row.querySelector('button').addEventListener('click', () => {
            registry.config.customActions = registry.config.customActions.filter((a) => a.id !== act.id);
            saveLocalConfig(registry.config);
            render();
          });
          customList.appendChild(row);
        }
      }

      modalContainer.querySelector('#btn-add-act').addEventListener('click', () => {
        const label = modalContainer.querySelector('#act-label').value.trim();
        const when = modalContainer.querySelector('#act-when').value;
        const type = modalContainer.querySelector('#act-type').value;
        const template = modalContainer.querySelector('#act-tpl').value.trim();
        if (!label || !template) {
          showToast('请填写菜单名称与模板内容', 'warn');
          return;
        }
        registry.config.customActions.push({
          id: `u-${Date.now().toString(36)}`,
          label,
          when,
          type,
          template,
        });
        saveLocalConfig(registry.config);
        showToast(`已添加自定义动作：${label}`, 'ok');
        render();
      });

      modalContainer.querySelector('#btn-close').addEventListener('click', closeSettingsModal);
      modalContainer.querySelector('#backdrop').addEventListener('click', (e) => {
        if (e.target && e.target.id === 'backdrop') closeSettingsModal();
      });
    };

    render();
  }

  // ==================== 全局事件绑定与公开 API ====================

  window.addEventListener(
    'contextmenu',
    (event) => {
      try {
        if (event.target && event.target.closest && event.target.closest(`#${HOST_ID}`)) {
          return;
        }
        const ctx = extractContextFromEvent(event);
        if (!shouldTakeOverContextMenu(ctx)) {
          return;
        }
        const shown = renderContextMenu(ctx);
        if (shown) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      } catch (err) {
        console.warn('[AgyContextMenu] contextmenu error:', err);
      }
    },
    true
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        if (modalContainer && modalContainer.innerHTML) {
          closeSettingsModal();
        } else {
          openSettingsModal();
        }
      }
    },
    true
  );

  // 暴露全局扩展 API，供其它 Antigravity 插件或自定义脚本随时扩展右键菜单
  window.__AGY_CONTEXT_MENU__ = {
    version: PLUGIN_VERSION,
    registerModule: (def) => registry.registerModule(def),
    unregisterModule: (id) => registry.unregisterModule(id),
    setModuleEnabled: (id, enabled) => {
      registry.setModuleEnabled(id, enabled);
      saveLocalConfig(registry.config);
    },
    listModules: () => registry.listModules(),
    registerAction: (actionDef) => registry.registerAction(actionDef),
    extractPath: (text, offset) => extractBestPathFromText(text, { offset }),
    toFileUrl,
    renderTemplate: renderActionTemplate,
    openSettings: openSettingsModal,
    closeMenu,
    showToast,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
