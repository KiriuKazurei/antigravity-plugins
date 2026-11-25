/**
 * Antigravity 轻量化 Markdown 知识库 (antigravity-kb) 运行时
 * - 右侧边栏原生 Tab (`+ > 插件 > 知识库` / `Alt+K`)，Shadow DOM 样式隔离
 * - 本地真实 .md 文件夹读写（通过 pluginLoader.js 本地 Loopback Bridge），兼容 Obsidian / Git / MCP
 * - 多 Vault 切换（个人知识库 ~/.gemini/kb + 自动探测当前工作区 + 自定义目录）
 * - Preview / Edit / Split 三态阅读编辑、[[双向链接]] 与反向链接、#标签筛选、任务复选框点击写回
 * - 对话输入框 `[[` 实时检索并插入知识库笔记、选中文本一键收藏为笔记
 */
(function () {
  'use strict';

  const hasWindow = typeof window !== 'undefined';
  const hasDocument = typeof document !== 'undefined';
  const meta = hasWindow && window.__AGY_PLUGIN_META__ ? window.__AGY_PLUGIN_META__ : {};
  const bridgeInfo = hasWindow && window.__AGY_KB_BRIDGE__ ? window.__AGY_KB_BRIDGE__ : null;
  if (hasWindow) {
    try {
      delete window.__AGY_PLUGIN_META__;
    } catch (_) {}
  }

  const HOST_ID = 'agy-kb-host';
  const PREFS_FALLBACK_KEY = 'agy_kb_prefs_fallback_v1';
  const MAX_POPUP_ITEMS = 12;

  // ==================== 纯函数工具（供 UI 与单元测试复用） ====================

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeRelPath(input) {
    const cleaned = String(input || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/');
    if (!cleaned) return '';
    const parts = cleaned.split('/').filter((seg) => seg && seg !== '.' && seg !== '..');
    if (parts.length === 0) return '';
    let joined = parts.join('/');
    if (!/\.(md|markdown)$/i.test(joined)) {
      joined += '.md';
    }
    return joined;
  }

  function stripExtension(relPath) {
    return String(relPath || '').replace(/\.(md|markdown)$/i, '');
  }

  function baseStem(relPath) {
    const clean = String(relPath || '').replace(/\\/g, '/');
    const name = clean.split('/').pop() || clean;
    return stripExtension(name);
  }

  function parseFrontmatterAndBody(rawText) {
    const text = String(rawText || '');
    const lines = text.split(/\r?\n/);
    const metaOut = { title: '', tags: [], aliases: [], updated: '', rawYaml: '' };
    let bodyStart = 0;

    if (lines.length > 0 && lines[0].trim() === '---') {
      let endIdx = -1;
      for (let i = 1; i < Math.min(lines.length, 80); i++) {
        const s = lines[i].trim();
        if (s === '---' || s === '...') {
          endIdx = i;
          break;
        }
      }
      if (endIdx > 0) {
        bodyStart = endIdx + 1;
        metaOut.rawYaml = lines.slice(1, endIdx).join('\n');
        let inTags = false;
        let inAliases = false;
        for (let i = 1; i < endIdx; i++) {
          const line = lines[i];
          const stripped = line.trim();
          if (!stripped || stripped.startsWith('#')) continue;
          if (/^[ \t]+-\s+/.test(line)) {
            const item = stripped.slice(2).trim().replace(/^['"]|['"]$/g, '');
            if (inTags && item) metaOut.tags.push(item.replace(/^#+/, ''));
            else if (inAliases && item) metaOut.aliases.push(item);
            continue;
          }
          inTags = false;
          inAliases = false;
          const idx = stripped.indexOf(':');
          if (idx > 0) {
            const k = stripped.slice(0, idx).trim().toLowerCase();
            const v = stripped.slice(idx + 1).trim();
            if (k === 'title' && v) {
              metaOut.title = v.replace(/^['"]|['"]$/g, '');
            } else if (k === 'updated' && v) {
              metaOut.updated = v.replace(/^['"]|['"]$/g, '');
            } else if (k === 'tags') {
              if (v.startsWith('[') && v.endsWith(']')) {
                v.slice(1, -1)
                  .split(',')
                  .forEach((p) => {
                    const t = p.trim().replace(/^['"]|['"]$/g, '').replace(/^#+/, '');
                    if (t) metaOut.tags.push(t);
                  });
              } else if (v) {
                v.split(/[,，\s]+/).forEach((p) => {
                  const t = p.trim().replace(/^['"]|['"]$/g, '').replace(/^#+/, '');
                  if (t) metaOut.tags.push(t);
                });
              } else {
                inTags = true;
              }
            } else if (k === 'aliases') {
              if (v.startsWith('[') && v.endsWith(']')) {
                v.slice(1, -1)
                  .split(',')
                  .forEach((p) => {
                    const a = p.trim().replace(/^['"]|['"]$/g, '');
                    if (a) metaOut.aliases.push(a);
                  });
              } else if (v) {
                metaOut.aliases.push(v.replace(/^['"]|['"]$/g, ''));
              } else {
                inAliases = true;
              }
            }
          }
        }
      }
    }

    const body = lines.slice(bodyStart).join('\n');
    return { meta: metaOut, body, bodyStartLine: bodyStart };
  }

  function extractWikilinks(text) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    const links = [];
    const seen = new Set();
    let inFence = false;
    for (const ln of lines) {
      const s = ln.trim();
      if (s.startsWith('```') || s.startsWith('~~~')) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const re = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
      let m;
      while ((m = re.exec(ln)) !== null) {
        const target = m[1].trim();
        if (target && !seen.has(target.toLowerCase())) {
          seen.add(target.toLowerCase());
          links.push(target);
        }
      }
    }
    return links;
  }

  function computeBacklinks(targetNote, allNotes) {
    if (!targetNote || !Array.isArray(allNotes)) return [];
    const stem = baseStem(targetNote.relPath).toLowerCase();
    const titleLow = String(targetNote.title || '').trim().toLowerCase();
    const relLow = String(targetNote.relPath || '').toLowerCase();
    const relNoExt = stripExtension(relLow);
    const matches = [];
    for (const n of allNotes) {
      if (!n || n.relPath === targetNote.relPath) continue;
      const links = Array.isArray(n.links) ? n.links : [];
      const hit = links.some((lnk) => {
        const low = stripExtension(String(lnk || '').trim().toLowerCase());
        return low === stem || (titleLow && low === titleLow) || low === relNoExt;
      });
      if (hit) matches.push(n);
    }
    return matches;
  }

  function toggleCheckboxAtLine(markdownText, lineIndex) {
    const lines = String(markdownText || '').split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return markdownText;
    const line = lines[lineIndex];
    const m = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s*.*)$/.exec(line);
    if (!m) return markdownText;
    const nextChar = m[2] === ' ' ? 'x' : ' ';
    lines[lineIndex] = `${m[1]}${nextChar}${m[3]}`;
    return lines.join('\n');
  }

  function buildFrontmatterNote({ title, tags, body, source }) {
    const cleanTitle = String(title || '').trim() || '未命名笔记';
    const cleanTags = Array.isArray(tags)
      ? tags.map((t) => String(t).trim().replace(/^#+/, '')).filter(Boolean)
      : [];
    const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const fm = [
      '---',
      `title: "${cleanTitle.replace(/"/g, '\\"')}"`,
    ];
    if (cleanTags.length > 0) {
      fm.push(`tags: [${cleanTags.join(', ')}]`);
    }
    fm.push(`updated: ${nowStr}`);
    if (source) {
      fm.push(`source: "${String(source).replace(/"/g, '\\"')}"`);
    }
    fm.push('---', '');
    const cleanBody = String(body || '').trim();
    const hasHeading = /^#\s+/m.test(cleanBody);
    const bodyPart = hasHeading ? cleanBody : `# ${cleanTitle}\n\n${cleanBody}`;
    return fm.join('\n') + '\n' + bodyPart + '\n';
  }

  function renderInlineMarkdown(rawLine) {
    let text = escapeHtml(rawLine);
    const codeTokens = [];
    text = text.replace(/`([^`]+)`/g, (_, code) => {
      const idx = codeTokens.length;
      codeTokens.push(`<code class="kb-inline-code">${code}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    // Wikilinks [[target|alias]]
    text = text.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_, tgt, anchor, alias) => {
      const cleanTgt = tgt.trim();
      const label = (alias || (anchor ? `${cleanTgt}#${anchor}` : cleanTgt)).trim();
      return `<a href="#" class="kb-wikilink" data-wikilink="${escapeHtml(cleanTgt)}">${escapeHtml(label)}</a>`;
    });

    // Standard markdown links [label](url)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      return `<a href="${url}" class="kb-ext-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // Bold, italic, strikethrough, highlight
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/==([^=]+)==/g, '<mark class="kb-mark">$1</mark>');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');

    // Inline #tag chips
    text = text.replace(/(^|[\s(])#([A-Za-z0-9_\-\u4e00-\u9fff/]+)/g, (m, pre, tag) => {
      if (/^[0-9a-fA-F]{3,8}$/.test(tag)) return m;
      return `${pre}<button type="button" class="kb-inline-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`;
    });

    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || '');
    return text;
  }

  function renderMarkdownToHtml(rawMarkdown) {
    const raw = String(rawMarkdown || '');
    const allLines = raw.split('\n');
    let startIdx = 0;

    // Skip YAML frontmatter in rendered preview
    if (allLines.length > 0 && allLines[0].trim() === '---') {
      for (let i = 1; i < Math.min(allLines.length, 80); i++) {
        if (allLines[i].trim() === '---' || allLines[i].trim() === '...') {
          startIdx = i + 1;
          break;
        }
      }
    }

    const html = [];
    let i = startIdx;
    while (i < allLines.length) {
      const rawLine = allLines[i].replace(/\r$/, '');
      const trimmed = rawLine.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // Fenced code block
      const fenceMatch = /^(```|~~~)\s*([^\s`]*)/.exec(trimmed);
      if (fenceMatch) {
        const fence = fenceMatch[1];
        const lang = fenceMatch[2] || 'text';
        const codeLines = [];
        i++;
        while (i < allLines.length) {
          const cur = allLines[i].replace(/\r$/, '');
          if (cur.trim().startsWith(fence)) {
            i++;
            break;
          }
          codeLines.push(cur);
          i++;
        }
        const codeRaw = codeLines.join('\n');
        const codeIdx = html.length;
        html.push(
          `<div class="kb-code-wrap" data-code-block="1">` +
            `<div class="kb-code-head">` +
              `<span class="kb-code-lang">${escapeHtml(lang)}</span>` +
              `<span class="kb-code-actions">` +
                `<button type="button" class="kb-mini-btn" data-copy-code="${codeIdx}">复制</button>` +
                `<button type="button" class="kb-mini-btn" data-insert-code="${codeIdx}">插入对话</button>` +
              `</span>` +
            `</div>` +
            `<pre class="kb-pre"><code>${escapeHtml(codeRaw)}</code></pre>` +
          `</div>`
        );
        continue;
      }

      // Horizontal rule
      if (/^([-*_])\1{2,}\s*$/.test(trimmed)) {
        html.push('<hr class="kb-hr" />');
        i++;
        continue;
      }

      // Heading
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        const lvl = headingMatch[1].length;
        html.push(`<h${lvl} class="kb-h kb-h${lvl}">${renderInlineMarkdown(headingMatch[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // Blockquote
      if (trimmed.startsWith('>')) {
        const quoteLines = [];
        while (i < allLines.length && allLines[i].trim().startsWith('>')) {
          quoteLines.push(allLines[i].replace(/\r$/, '').replace(/^\s*>\s?/, ''));
          i++;
        }
        html.push(`<blockquote class="kb-quote">${quoteLines.map(renderInlineMarkdown).join('<br />')}</blockquote>`);
        continue;
      }

      // Markdown table
      if (
        trimmed.includes('|') &&
        i + 1 < allLines.length &&
        /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(allLines[i + 1].trim())
      ) {
        const parseCells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        const headers = parseCells(rawLine);
        i += 2;
        const rows = [];
        while (i < allLines.length && allLines[i].trim().includes('|')) {
          rows.push(parseCells(allLines[i].replace(/\r$/, '')));
          i++;
        }
        const ths = headers.map((h) => `<th>${renderInlineMarkdown(h)}</th>`).join('');
        const trs = rows
          .map((r) => `<tr>${headers.map((_, ci) => `<td>${renderInlineMarkdown(r[ci] || '')}</td>`).join('')}</tr>`)
          .join('');
        html.push(`<div class="kb-table-wrap"><table class="kb-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
        continue;
      }

      // Task / bullet / ordered lists
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(rawLine)) {
        const isOrdered = /^\s*\d+\.\s+/.test(rawLine);
        const tag = isOrdered ? 'ol' : 'ul';
        const items = [];
        while (i < allLines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(allLines[i])) {
          const cur = allLines[i].replace(/\r$/, '');
          const taskMatch = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s*(.*)$/.exec(cur);
          if (taskMatch) {
            const checked = taskMatch[1] !== ' ';
            items.push(
              `<li class="kb-task-item${checked ? ' is-done' : ''}">` +
                `<label class="kb-task-label">` +
                  `<input type="checkbox" class="kb-task-cb" data-line-index="${i}" ${checked ? 'checked' : ''} />` +
                  `<span>${renderInlineMarkdown(taskMatch[2])}</span>` +
                `</label>` +
              `</li>`
            );
          } else {
            const liText = cur.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
            items.push(`<li>${renderInlineMarkdown(liText)}</li>`);
          }
          i++;
        }
        html.push(`<${tag} class="kb-list">${items.join('')}</${tag}>`);
        continue;
      }

      // Paragraph
      const paraLines = [];
      while (i < allLines.length) {
        const cur = allLines[i].replace(/\r$/, '');
        const cs = cur.trim();
        if (
          !cs ||
          /^(```|~~~|#{1,6}\s|>|[-*_]{3,}\s*$)/.test(cs) ||
          /^\s*(?:[-*+]|\d+\.)\s+/.test(cur)
        ) {
          break;
        }
        paraLines.push(cur);
        i++;
      }
      if (paraLines.length > 0) {
        html.push(`<p class="kb-p">${paraLines.map(renderInlineMarkdown).join('<br />')}</p>`);
      } else {
        i++;
      }
    }

    return html.join('\n');
  }

  function detectWikiTrigger(text, cursorPos) {
    const raw = String(text || '');
    const pos = Math.max(0, Math.min(Number(cursorPos) || 0, raw.length));
    const before = raw.slice(0, pos);
    const openIdx = before.lastIndexOf('[[');
    if (openIdx < 0) return null;
    const afterOpen = before.slice(openIdx + 2);
    if (afterOpen.includes(']]') || afterOpen.includes('\n') || afterOpen.length > 48) {
      return null;
    }
    return {
      start: openIdx,
      end: pos,
      query: afterOpen,
    };
  }

  function applyWikiTriggerReplacement(text, trigger, replacement) {
    const raw = String(text || '');
    const before = raw.slice(0, trigger.start);
    const after = raw.slice(trigger.end);
    const nextText = before + replacement + after;
    const nextCursor = before.length + replacement.length;
    return { text: nextText, cursor: nextCursor };
  }

  function scoreNoteForPopup(note, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 10;
    const titleLow = String(note.title || '').toLowerCase();
    const stemLow = baseStem(note.relPath).toLowerCase();
    const relLow = String(note.relPath || '').toLowerCase();
    const tagsLow = Array.isArray(note.tags) ? note.tags.join(' ').toLowerCase() : '';
    const excerptLow = String(note.excerpt || '').toLowerCase();

    if (titleLow === q || stemLow === q) return 200;
    if (titleLow.startsWith(q) || stemLow.startsWith(q)) return 140;
    if (titleLow.includes(q) || stemLow.includes(q)) return 100;
    if (tagsLow.includes(q)) return 70;
    if (relLow.includes(q)) return 50;
    if (excerptLow.includes(q)) return 25;
    return 0;
  }

  function formatNoteForComposer(note, fullContent, mode, fullPath) {
    const title = note && note.title ? note.title : baseStem(note && note.relPath);
    if (mode === 'path' && fullPath) {
      return fullPath;
    }
    const parsed = parseFrontmatterAndBody(fullContent || '');
    const cleanBody = parsed.body.trim();
    if (mode === 'quote') {
      const quoted = cleanBody
        .split(/\r?\n/)
        .map((ln) => `> ${ln}`)
        .join('\n');
      return `> **知识库参考：${title}**\n${quoted}\n`;
    }
    return cleanBody || title;
  }

  if (typeof module !== 'undefined' && module.exports && !hasWindow) {
    module.exports = {
      escapeHtml,
      sanitizeRelPath,
      stripExtension,
      baseStem,
      parseFrontmatterAndBody,
      extractWikilinks,
      computeBacklinks,
      toggleCheckboxAtLine,
      buildFrontmatterNote,
      renderMarkdownToHtml,
      detectWikiTrigger,
      applyWikiTriggerReplacement,
      scoreNoteForPopup,
      formatNoteForComposer,
    };
    return;
  }

  if (!hasWindow || !hasDocument) return;
  if (window.__AGY_KB_LOADED__) return;
  window.__AGY_KB_LOADED__ = true;

  // ==================== 状态管理 & Bridge 通信 ====================

  function detectIsZh() {
    const lang = (document.documentElement?.lang || navigator.language || '').toLowerCase();
    if (lang.startsWith('zh')) return true;
    const bodyText = (document.body?.innerText || '').slice(0, 1200);
    return /设置|新建对话|审查确认|知识库|上下文洞察/.test(bodyText);
  }

  const DEFAULT_PREFS = {
    open: false,
    lang: 'auto', // auto | zh | en
    viewMode: 'preview', // preview | edit | split
    listMode: 'flat', // flat | tree
    autoSave: true,
    enterConfirmsPopup: false,
    insertMode: 'body', // body | quote | path
  };

  const state = {
    isZh: detectIsZh(),
    tabOpen: false,
    openedInNativePane: false,
    lastAuxRect: null,
    bridgeReady: Boolean(bridgeInfo && bridgeInfo.url && bridgeInfo.token),
    config: {
      version: 1,
      activeVaultId: 'personal',
      vaults: bridgeInfo?.defaultVault
        ? [{ id: 'personal', label: '个人知识库', path: bridgeInfo.defaultVault, kind: 'personal' }]
        : [],
      pinnedNotes: [],
      prefs: { ...DEFAULT_PREFS },
    },
    workspaceVaults: [],
    notes: [],
    folders: [],
    selectedTag: '',
    searchQuery: '',
    searchResults: null, // null when browsing, array when content searching
    activeNote: null, // { relPath, fullPath, content, meta, mtimeMs }
    draftContent: '',
    dirty: false,
    saveStatus: '',
    showSettings: false,
    showNewModal: false,
    modalMode: 'new', // new | capture | rename
    modalTitle: '',
    modalPath: '',
    modalTags: '',
    modalAppendTarget: '',
    modalBody: '',
    toast: null,
    popup: {
      visible: false,
      items: [],
      selectedIndex: 0,
      trigger: null,
      composer: null,
      rect: null,
    },
    selectionText: '',
    selectionRect: null,
  };

  let saveTimer = null;
  let searchTimer = null;
  let toastTimer = null;
  let isComposing = false;

  function getActiveLangZh() {
    const p = state.config.prefs || DEFAULT_PREFS;
    if (p.lang === 'zh') return true;
    if (p.lang === 'en') return false;
    return state.isZh;
  }

  function showToast(msg, durationMs = 2400) {
    state.toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = null;
      renderAll();
    }, durationMs);
    renderAll();
  }

  async function callBridge(route, body, method = 'POST') {
    if (!bridgeInfo || !bridgeInfo.url || !bridgeInfo.token) {
      return { ok: false, error: 'KB Bridge 未就绪，请更新并重启 Antigravity 宿主。' };
    }
    try {
      const opts = {
        method,
        headers: {
          'x-agy-kb-token': bridgeInfo.token,
        },
      };
      if (method !== 'GET') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body || {});
      }
      const resp = await fetch(`${bridgeInfo.url}${route}`, opts);
      return await resp.json();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  function getAllVaults() {
    const map = new Map();
    for (const v of state.config.vaults || []) {
      if (v && v.path) map.set(v.path.toLowerCase(), v);
    }
    for (const wv of state.workspaceVaults || []) {
      if (wv && wv.path && !map.has(wv.path.toLowerCase())) {
        map.set(wv.path.toLowerCase(), wv);
      }
    }
    return Array.from(map.values());
  }

  function getActiveVault() {
    const all = getAllVaults();
    const hit = all.find((v) => v.id === state.config.activeVaultId);
    return hit || all[0] || null;
  }

  async function saveConfigRemote() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(PREFS_FALLBACK_KEY, JSON.stringify(state.config.prefs || DEFAULT_PREFS));
      }
    } catch (_) {}
    if (state.bridgeReady) {
      await callBridge('/config/save', { config: state.config });
    }
  }

  // 从 Antigravity RPC 缓存中自动探测当前工作区路径
  async function detectWorkspaceVaults() {
    const candidates = new Set();
    try {
      const cache = window.__AGY_CAPTURED_LS_CACHE__ || {};
      const traj = cache.GetAllCascadeTrajectories;
      const summaries = traj && (traj.trajectorySummaries || traj.trajectory_summaries);
      if (summaries && typeof summaries === 'object') {
        const list = Object.values(summaries).sort(
          (a, b) => new Date(b?.lastModifiedTime || 0).getTime() - new Date(a?.lastModifiedTime || 0).getTime()
        );
        for (const item of list.slice(0, 6)) {
          const wsList = Array.isArray(item?.workspaces) ? item.workspaces : [];
          for (const ws of wsList) {
            const uri = ws?.workspaceFolderAbsoluteUri || ws?.workspaceUri || '';
            if (typeof uri === 'string' && uri.startsWith('file:///')) {
              let decoded = decodeURIComponent(uri.slice(7));
              if (/^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1);
              decoded = decoded.replace(/\//g, navigator.platform.includes('Win') ? '\\' : '/');
              if (decoded) candidates.add(decoded);
            }
          }
        }
      }
    } catch (_) {}

    const discovered = [];
    for (const wsPath of candidates) {
      const check = await callBridge('/kb/exists', { rootPath: wsPath });
      if (check && check.ok && check.exists) {
        const sep = wsPath.includes('\\') ? '\\' : '/';
        const folderName = wsPath.split(/[\\/]/).filter(Boolean).pop() || wsPath;
        discovered.push({
          id: `ws:${wsPath}`,
          label: `工作区: ${folderName}`,
          path: check.rootPath,
          kind: 'workspace',
        });
        // 如果工作区下存在 docs 目录，也提供快捷入口
        const docsPath = `${check.rootPath}${sep}docs`;
        const docsCheck = await callBridge('/kb/exists', { rootPath: docsPath });
        if (docsCheck && docsCheck.ok && docsCheck.exists) {
          discovered.push({
            id: `ws-docs:${docsPath}`,
            label: `${folderName}/docs`,
            path: docsCheck.rootPath,
            kind: 'workspace-docs',
          });
        }
      }
    }
    state.workspaceVaults = discovered;
  }

  async function refreshVaultTree(keepSelection = true) {
    const vault = getActiveVault();
    if (!vault || !vault.path) return;
    const res = await callBridge('/kb/tree', { rootPath: vault.path });
    if (!res || !res.ok) {
      state.notes = [];
      state.folders = [];
      renderAll();
      return;
    }
    state.notes = Array.isArray(res.notes) ? res.notes : [];
    state.folders = Array.isArray(res.folders) ? res.folders : [];

    if (keepSelection && state.activeNote) {
      const stillThere = state.notes.find((n) => n.relPath === state.activeNote.relPath);
      if (!stillThere) {
        state.activeNote = null;
        state.draftContent = '';
        state.dirty = false;
      }
    }
    if (!state.activeNote && state.notes.length > 0) {
      await openNoteByRelPath(state.notes[0].relPath);
    } else {
      renderAll();
    }
  }

  async function openNoteByRelPath(relPath) {
    if (state.dirty && state.activeNote) {
      await persistCurrentDraft();
    }
    const vault = getActiveVault();
    if (!vault) return;
    const res = await callBridge('/kb/read', { rootPath: vault.path, relPath });
    if (!res || !res.ok) {
      showToast(res?.error || '读取笔记失败');
      return;
    }
    state.activeNote = {
      relPath: res.relPath,
      fullPath: res.fullPath,
      content: res.content,
      meta: res.meta || parseFrontmatterAndBody(res.content).meta,
      mtimeMs: res.mtimeMs,
    };
    state.draftContent = res.content;
    state.dirty = false;
    state.saveStatus = '';
    renderAll();
  }

  async function persistCurrentDraft() {
    if (!state.activeNote) return false;
    const vault = getActiveVault();
    if (!vault) return false;
    state.saveStatus = '保存中...';
    renderSaveBadgeOnly();
    const res = await callBridge('/kb/write', {
      rootPath: vault.path,
      relPath: state.activeNote.relPath,
      content: state.draftContent,
    });
    if (res && res.ok) {
      state.activeNote.content = state.draftContent;
      state.activeNote.meta = res.meta;
      state.activeNote.mtimeMs = res.mtimeMs;
      state.dirty = false;
      state.saveStatus = '已保存';
      // 同步列表里的摘要与标签
      const idx = state.notes.findIndex((n) => n.relPath === res.relPath);
      if (idx >= 0) {
        state.notes[idx] = {
          ...state.notes[idx],
          title: res.meta.title,
          tags: res.meta.tags,
          links: res.meta.links,
          excerpt: res.meta.excerpt,
          mtimeMs: res.mtimeMs,
        };
      }
      // 若用户正在编辑器内输入，不重建 DOM，以免打断输入法或清空 Ctrl+Z 撤销栈
      const ae = shadowRootRef && shadowRootRef.activeElement;
      const isEditingNow = Boolean(ae && ae.getAttribute && ae.getAttribute('data-kb-editor') === '1');
      if (isEditingNow) {
        renderSaveBadgeOnly();
        syncActiveListItemOnly(res.relPath, res.meta);
      } else {
        renderAll();
      }
      return true;
    }
    state.saveStatus = '保存失败';
    renderSaveBadgeOnly();
    return false;
  }

  function scheduleAutoSave() {
    if (!(state.config.prefs?.autoSave ?? true)) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (state.dirty) {
        void persistCurrentDraft();
      }
    }, 800);
  }

  async function runSearchQuery(q) {
    const vault = getActiveVault();
    if (!vault) return;
    const trimmed = String(q || '').trim();
    if (!trimmed) {
      state.searchResults = null;
      renderAll();
      return;
    }
    const res = await callBridge('/kb/search', {
      rootPath: vault.path,
      query: trimmed,
      tag: state.selectedTag || '',
      limit: 60,
    });
    if (res && res.ok) {
      state.searchResults = res.matches || [];
    } else {
      state.searchResults = null;
    }
    renderAll();
  }

  async function initKbState() {
    if (!state.bridgeReady) {
      renderAll();
      return;
    }
    const cfgRes = await callBridge('/config/get', {});
    if (cfgRes && cfgRes.ok && cfgRes.config) {
      state.config = {
        ...state.config,
        ...cfgRes.config,
        prefs: { ...DEFAULT_PREFS, ...(cfgRes.config.prefs || {}) },
      };
    }
    await detectWorkspaceVaults();
    await refreshVaultTree(false);
    if (state.config.prefs?.open) {
      state.tabOpen = true;
    }
    renderAll();
  }

  // ==================== 原生右侧边栏 & 插件菜单集成 ====================

  function isOutsidePluginHosts(el) {
    if (!el || !el.closest) return true;
    return !el.closest(`#${HOST_ID}, #agy-context-doctor-host, #agy-usage-dashboard-host, #agy-snippets-host, #agy-notifier-host`);
  }

  function hasLeftSidebarAnchor(container) {
    if (!container || !container.querySelectorAll) return false;
    const btns = container.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!b || typeof b.getBoundingClientRect !== 'function') continue;
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')) || '';
      if (/^(Settings|设置)$/i.test(txt || aria.trim())) {
        const r = b.getBoundingClientRect();
        if (r.left >= 0 && r.left < 240 && r.bottom > (window.innerHeight || 800) - 140) {
          return true;
        }
      }
    }
    return false;
  }

  function locateNativeAuxTabStrip() {
    if (!document.querySelectorAll) return { found: false };
    const innerW = window.innerWidth || 1280;
    const btns = document.querySelectorAll('button, [role="tab"], [role="button"]');
    let plusBtn = null;
    let tabAnchor = null;

    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isOutsidePluginHosts(b) || typeof b.getBoundingClientRect !== 'function') continue;
      if (b.getAttribute && (b.getAttribute('data-agy-kb-tab') === '1' || b.getAttribute('data-agy-cd-tab') === '1')) {
        continue;
      }
      const r = b.getBoundingClientRect();
      if (r.top < 0 || r.top > 48 || r.height < 16 || r.height > 44 || r.left < 28 || r.right > innerW - 60) {
        continue;
      }
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
      const role = (b.getAttribute('role') || '').trim();

      if (txt === '+' || /new\s*tab|add\s*tab|新建标签|添加标签|打开新标签/i.test(aria)) {
        if (!plusBtn || r.left < plusBtn.getBoundingClientRect().left) {
          plusBtn = b;
        }
      } else if (
        role === 'tab' ||
        /^(审查确认|Review Changes?|Open File|终端|Terminal|浏览器|Browser|Swarm|Side Question|New Tab|新建标签页)$/i.test(txt)
      ) {
        if (!tabAnchor) tabAnchor = b;
      }
    }

    if (!plusBtn && tabAnchor && tabAnchor.parentElement) {
      const tr = tabAnchor.getBoundingClientRect();
      const pBtns = tabAnchor.parentElement.querySelectorAll('button, [role="button"]');
      for (let i = 0; i < pBtns.length; i++) {
        const pb = pBtns[i];
        if (pb === tabAnchor || (pb.getAttribute && (pb.getAttribute('data-agy-kb-tab') === '1' || pb.getAttribute('data-agy-cd-tab') === '1'))) {
          continue;
        }
        const pr = pb.getBoundingClientRect();
        if (
          pr.left >= tr.right - 2 &&
          pr.right <= innerW - 60 &&
          pr.width >= 16 &&
          pr.width <= 38 &&
          Math.abs(pr.top - tr.top) <= 10
        ) {
          plusBtn = pb;
          break;
        }
      }
    }

    const refEl = plusBtn || tabAnchor;
    if (!refEl || !refEl.parentElement) return { found: false };
    let stripEl = refEl.parentElement;
    if (
      stripEl.children &&
      stripEl.children.length === 1 &&
      stripEl.parentElement &&
      stripEl.parentElement !== document.body
    ) {
      stripEl = stripEl.parentElement;
    }
    const rect = stripEl.getBoundingClientRect();
    return {
      found: true,
      stripEl,
      plusBtn,
      tabAnchor,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function findChatComposer() {
    const selectors = [
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
    ];
    let best = null;
    let bestBottom = -1;
    const innerH = window.innerHeight || 800;
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!isOutsidePluginHosts(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 140 || r.height < 18 || r.bottom <= innerH * 0.35) continue;
        if (r.bottom >= bestBottom) {
          bestBottom = r.bottom;
          best = el;
        }
      }
    }
    return best;
  }

  function locateNativeAuxPane() {
    if (!document.querySelectorAll) return { found: false };
    const innerW = window.innerWidth || 1280;
    const innerH = window.innerHeight || 800;
    const composer = findChatComposer();
    const strip = locateNativeAuxTabStrip();

    let anchor = null;
    const inputs = document.querySelectorAll('input[placeholder]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (!isOutsidePluginHosts(inp)) continue;
      const ph = (inp.getAttribute('placeholder') || '').trim();
      if (/Search or enter a URL|搜索或输入网址|Enter URL/i.test(ph)) {
        const r = inp.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 20 && r.right > innerW * 0.4) {
          anchor = inp;
          break;
        }
      }
    }

    if (!anchor) {
      const candidates = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (!isOutsidePluginHosts(el) || typeof el.getBoundingClientRect !== 'function') continue;
        const txt = (el.textContent || '').trim();
        if (/^(Side Question|Open File|审查确认|Review Changes?|终端|Terminal|浏览器|Browser)$/i.test(txt)) {
          const r = el.getBoundingClientRect();
          if (r.width >= 80 && r.height >= 20 && r.right > innerW * 0.35 && r.top > 36 && r.top < innerH - 60) {
            anchor = el;
            break;
          }
        }
      }
    }

    if (!anchor) {
      const frames = document.querySelectorAll('iframe, webview, .xterm, .monaco-diff-editor, .monaco-editor');
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!isOutsidePluginHosts(f) || typeof f.getBoundingClientRect !== 'function') continue;
        if (composer && (f === composer || (f.contains && f.contains(composer)))) continue;
        const r = f.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 200 && r.right >= innerW - 40 && r.left >= 20) {
          anchor = f;
          break;
        }
      }
    }

    if (!anchor && strip.found) anchor = strip.stripEl;
    if (anchor) {
      let cur = anchor.parentElement || anchor;
      let best = null;
      for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 14; depth++) {
        if (typeof cur.getBoundingClientRect === 'function') {
          const r = cur.getBoundingClientRect();
          const containsComposer = composer && cur.contains && cur.contains(composer);
          const containsLeftSettings = hasLeftSidebarAnchor(cur);
          if (containsComposer || containsLeftSettings) break;
          if (
            r.width >= 240 &&
            r.height >= innerH * 0.55 &&
            r.top >= 0 &&
            r.top <= 100 &&
            r.right >= innerW - 36
          ) {
            best = cur;
          }
        }
        cur = cur.parentElement;
      }
      if (best) {
        const r = best.getBoundingClientRect();
        let radius = 10;
        try {
          const br = parseFloat(window.getComputedStyle(best).borderRadius);
          if (Number.isFinite(br) && br >= 0 && br <= 20) radius = br;
        } catch (_) {}
        const stripBottom = strip.found ? strip.rect.bottom : 0;
        const contentTop = strip.found ? Math.max(Math.round(r.top), Math.round(stripBottom + 2)) : Math.max(Math.round(r.top), 38);
        let bgColor = '';
        try {
          const bg = window.getComputedStyle(best).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') bgColor = bg;
        } catch (_) {}
        return {
          found: true,
          hasNativeTabStrip: strip.found,
          left: Math.round(r.left),
          top: contentTop,
          width: Math.round(r.width),
          height: Math.max(200, Math.round(r.bottom - contentTop)),
          radius,
          bgColor,
        };
      }
    }
    return { found: false, hasNativeTabStrip: false };
  }

  function findRightPaneToggleButton() {
    const innerW = window.innerWidth || 1280;
    const btns = document.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isOutsidePluginHosts(b) || typeof b.getBoundingClientRect !== 'function') continue;
      const r = b.getBoundingClientRect();
      if (r.top >= 0 && r.top <= 42 && r.right >= innerW - 70 && r.width >= 18 && r.width <= 44 && r.height <= 40) {
        const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        if (/side|pane|panel|aux|侧边|面板|right/i.test(lbl)) {
          return b;
        }
      }
    }
    return null;
  }

  function dismissOpenMenus() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch (_) {}
  }

  function openKbInPane(tryOpenNativePane) {
    const aux = locateNativeAuxPane();
    if (!aux.found && tryOpenNativePane) {
      const toggleBtn = findRightPaneToggleButton();
      if (toggleBtn && typeof toggleBtn.click === 'function') {
        try {
          toggleBtn.click();
        } catch (_) {}
        setTimeout(() => {
          const nextAux = locateNativeAuxPane();
          activateKbState(nextAux);
        }, 90);
        return;
      }
    }
    activateKbState(aux);
  }

  function activateKbState(aux) {
    state.openedInNativePane = aux.found;
    state.lastAuxRect = aux.found ? aux : null;
    state.tabOpen = true;
    state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), open: true };
    try {
      window.dispatchEvent(new CustomEvent('agy-aux-plugin-activated', { detail: { id: 'antigravity-kb' } }));
    } catch (_) {}
    void saveConfigRemote();
    renderAll();
    void detectWorkspaceVaults().then(() => refreshVaultTree(true));
  }

  function switchAwayFromKb() {
    if (!state.config.prefs?.open) return;
    state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), open: false };
    void saveConfigRemote();
    renderAll();
  }

  function closeKbTab() {
    state.tabOpen = false;
    state.openedInNativePane = false;
    state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), open: false };
    void saveConfigRemote();
    renderAll();
  }

  function buildBookIconSvg(size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size || 14));
    svg.setAttribute('height', String(size || 14));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.45');
    svg.style.flexShrink = '0';
    svg.style.opacity = '0.88';
    const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p1.setAttribute('d', 'M2.5 3.2A1.7 1.7 0 0 1 4.2 1.5h8.3v11.3H4.2a1.7 1.7 0 0 0-1.7 1.7V3.2Z');
    p1.setAttribute('stroke-linejoin', 'round');
    const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p2.setAttribute('d', 'M2.5 13.5A1.5 1.5 0 0 1 4 12h8.5v2.5H4A1.5 1.5 0 0 1 2.5 13.5Z');
    const p3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p3.setAttribute('d', 'M5.5 5h4.5M5.5 7.5h3.2');
    p3.setAttribute('stroke-linecap', 'round');
    svg.appendChild(p1);
    svg.appendChild(p2);
    svg.appendChild(p3);
    return svg;
  }

  function ensureMenuInjectStyles() {
    if (!document.head || document.getElementById('agy-kb-menu-style')) return;
    const st = document.createElement('style');
    st.id = 'agy-kb-menu-style';
    st.textContent = `
      .agy-kb-menu-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.35;
        text-align: left;
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .agy-kb-menu-btn:hover { background: rgba(127, 127, 127, 0.16); }
      .agy-kb-menu-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .agy-kb-menu-badge {
        font-size: 11px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(127, 127, 127, 0.16);
        color: inherit;
        opacity: 0.78;
        font-variant-numeric: tabular-nums;
      }
      .agy-kb-aux-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 7px 0 10px;
        margin: 0 2px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: transparent;
        color: inherit;
        opacity: 0.68;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        user-select: none;
        transition: background 0.12s ease, opacity 0.12s ease, border-color 0.12s ease;
      }
      .agy-kb-aux-tab:hover { opacity: 0.95; background: rgba(127, 127, 127, 0.12); }
      .agy-kb-aux-tab[data-active="true"] {
        opacity: 1;
        background: rgba(127, 127, 127, 0.18);
        border-color: rgba(127, 127, 127, 0.22);
      }
      .agy-kb-aux-tab-count { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
      .agy-kb-aux-tab-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        font-size: 11px;
        opacity: 0.6;
      }
      .agy-kb-aux-tab-close:hover { opacity: 1; background: rgba(127, 127, 127, 0.24); }
      *:has(> [data-agy-kb-tab="1"][data-active="true"]) > button:not([data-agy-kb-tab="1"]),
      *:has(> [data-agy-kb-tab="1"][data-active="true"]) > [role="tab"]:not([data-agy-kb-tab="1"]) {
        opacity: 0.58 !important;
        background: transparent !important;
        border-color: transparent !important;
      }
    `;
    document.head.appendChild(st);
  }

  function syncPluginsMenuInjection() {
    if (!document.querySelectorAll) return;
    const innerH = window.innerHeight || 800;
    const isZh = getActiveLangZh();
    const countText = String(state.notes.length || 0);

    const existing = document.querySelectorAll('[data-agy-kb-menu-item="1"]');
    existing.forEach((item) => {
      const b = item.querySelector('.agy-kb-menu-badge');
      if (b) b.textContent = countText;
    });

    const candidateSet = new Set();
    if (document.body && document.body.children) {
      const topEls = document.body.children;
      for (let i = 0; i < topEls.length; i++) {
        const top = topEls[i];
        if (!isOutsidePluginHosts(top)) continue;
        candidateSet.add(top);
        const lvl1 = top.children || [];
        for (let j = 0; j < lvl1.length && j < 12; j++) {
          candidateSet.add(lvl1[j]);
          const lvl2 = lvl1[j].children || [];
          for (let k = 0; k < lvl2.length && k < 12; k++) {
            candidateSet.add(lvl2[k]);
          }
        }
      }
    }
    document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]').forEach((el) => {
      candidateSet.add(el);
    });

    for (const c of candidateSet) {
      if (!isOutsidePluginHosts(c) || typeof c.getBoundingClientRect !== 'function') continue;
      if (c.querySelector && c.querySelector('[data-agy-kb-menu-item="1"]')) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 110 || r.width > 380 || r.height < 40 || r.height > 420 || r.top < 20 || r.bottom > innerH) {
        continue;
      }
      let swarmBtn = null;
      let hasPluginHeader = false;
      const children = c.children || [];
      for (let j = 0; j < children.length; j++) {
        const ch = children[j];
        const txt = (ch.textContent || '').trim();
        if (/^(插件|Plugins)$/i.test(txt)) hasPluginHeader = true;
        if (/^Swarm$/i.test(txt)) swarmBtn = ch;
      }
      if (!swarmBtn && c.querySelectorAll) {
        const btns = c.querySelectorAll('button, [role="menuitem"], [role="button"]');
        for (let k = 0; k < btns.length; k++) {
          if (/^Swarm$/i.test((btns[k].textContent || '').trim())) {
            swarmBtn = btns[k];
            break;
          }
        }
      }
      if (swarmBtn || (hasPluginHeader && children.length <= 8)) {
        const targetParent = swarmBtn ? swarmBtn.parentElement : c;
        if (!targetParent || targetParent.querySelector('[data-agy-kb-menu-item="1"]')) continue;
        ensureMenuInjectStyles();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-agy-kb-menu-item', '1');
        btn.setAttribute('role', 'menuitem');
        btn.className = swarmBtn && typeof swarmBtn.className === 'string'
          ? `${swarmBtn.className} agy-kb-menu-btn`.trim()
          : 'agy-kb-menu-btn';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'space-between';
        btn.style.width = '100%';

        const left = document.createElement('span');
        left.className = 'agy-kb-menu-left';
        left.appendChild(buildBookIconSvg(15));
        const lbl = document.createElement('span');
        lbl.textContent = isZh ? '知识库' : 'Knowledge Base';
        left.appendChild(lbl);

        const badge = document.createElement('span');
        badge.className = 'agy-kb-menu-badge';
        badge.textContent = countText;
        btn.appendChild(left);
        btn.appendChild(badge);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          dismissOpenMenus();
          openKbInPane(false);
        });
        if (swarmBtn && swarmBtn.nextSibling) targetParent.insertBefore(btn, swarmBtn.nextSibling);
        else targetParent.appendChild(btn);
      }
    }
  }

  function removeAuxTabFromStrip() {
    document.querySelectorAll('[data-agy-kb-tab="1"]').forEach((node) => {
      node.parentNode?.removeChild(node);
    });
  }

  function syncAuxTabInStrip() {
    if (!state.tabOpen) {
      removeAuxTabFromStrip();
      return;
    }
    ensureMenuInjectStyles();
    const strip = locateNativeAuxTabStrip();
    if (!strip.found || !strip.stripEl) return;

    const isZh = getActiveLangZh();
    let tabEl = strip.stripEl.querySelector('[data-agy-kb-tab="1"]');
    document.querySelectorAll('[data-agy-kb-tab="1"]').forEach((node) => {
      if (node !== tabEl) node.parentNode?.removeChild(node);
    });

    if (!tabEl) {
      tabEl = document.createElement('button');
      tabEl.type = 'button';
      tabEl.setAttribute('data-agy-kb-tab', '1');
      tabEl.setAttribute('role', 'tab');
      tabEl.className = 'agy-kb-aux-tab';

      const icon = buildBookIconSvg(14);
      const lbl = document.createElement('span');
      lbl.className = 'agy-kb-aux-tab-lbl';
      const cnt = document.createElement('span');
      cnt.className = 'agy-kb-aux-tab-count';
      const closeX = document.createElement('span');
      closeX.className = 'agy-kb-aux-tab-close';
      closeX.textContent = '✕';
      closeX.title = isZh ? '关闭标签页' : 'Close tab';
      closeX.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeKbTab();
      });
      tabEl.appendChild(icon);
      tabEl.appendChild(lbl);
      tabEl.appendChild(cnt);
      tabEl.appendChild(closeX);
      tabEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openKbInPane(false);
      });
      const insertRef = strip.plusBtn && strip.plusBtn.parentElement === strip.stripEl ? strip.plusBtn : null;
      if (insertRef) strip.stripEl.insertBefore(tabEl, insertRef);
      else strip.stripEl.appendChild(tabEl);
    }

    const active = Boolean(state.config.prefs?.open);
    tabEl.setAttribute('data-active', active ? 'true' : 'false');
    tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
    const lblNode = tabEl.querySelector('.agy-kb-aux-tab-lbl');
    if (lblNode) lblNode.textContent = isZh ? '知识库' : 'Wiki KB';
    const cntNode = tabEl.querySelector('.agy-kb-aux-tab-count');
    if (cntNode) cntNode.textContent = state.notes.length > 0 ? String(state.notes.length) : '';
  }

  let auxSyncScheduled = false;
  function flushAuxSync() {
    auxSyncScheduled = false;
    syncPluginsMenuInjection();
    if (state.tabOpen) syncAuxTabInStrip();
    if (state.config.prefs?.open) {
      const aux = locateNativeAuxPane();
      if (state.openedInNativePane && !aux.found) {
        switchAwayFromKb();
        return;
      }
      if (aux.found) {
        state.lastAuxRect = aux;
        applyDrawerGeometry();
      }
    }
  }

  function scheduleAuxSync() {
    if (auxSyncScheduled) return;
    auxSyncScheduled = true;
    const raf = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(flushAuxSync);
  }

  // ==================== 输入框 [[ 快捷引用 & 文本选区收藏 ====================

  function isSkippedEditableSubtree(root, node) {
    if (!node || node === root || node.nodeType !== 1) return false;
    try {
      if (node.getAttribute('contenteditable') === 'false') return true;
      if (node.getAttribute('aria-hidden') === 'true') return true;
    } catch (_) {}
    return false;
  }

  function walkContentEditableText(root, stopNode, stopOffset) {
    let out = '';
    let stopped = false;
    function visit(node) {
      if (stopped || !node || isSkippedEditableSubtree(root, node)) return;
      if (node === stopNode && node.nodeType !== 3) {
        const children = node.childNodes;
        const limit = Math.min(stopOffset, children.length);
        for (let i = 0; i < limit; i++) {
          visit(children[i]);
          if (stopped) return;
        }
        stopped = true;
        return;
      }
      if (node.nodeType === 3) {
        const val = node.nodeValue || '';
        if (node === stopNode) {
          out += val.slice(0, stopOffset);
          stopped = true;
          return;
        }
        out += val;
        return;
      }
      if (node.nodeType === 1) {
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          out += '\n';
          return;
        }
        const isBlock = tag === 'div' || tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre';
        if (isBlock && out.length > 0 && !out.endsWith('\n')) {
          out += '\n';
        }
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) {
          visit(children[i]);
          if (stopped) return;
        }
      }
    }
    visit(root);
    return out;
  }

  function resolveContentEditableDomPoint(root, targetCharOffset) {
    let acc = 0;
    let lastWasNewline = false;
    let found = null;
    function visit(node) {
      if (found || !node || isSkippedEditableSubtree(root, node)) return;
      if (node.nodeType === 3) {
        const val = node.nodeValue || '';
        const len = val.length;
        if (acc + len >= targetCharOffset) {
          found = { node, offset: Math.max(0, targetCharOffset - acc) };
          return;
        }
        acc += len;
        if (len > 0) lastWasNewline = val.endsWith('\n');
        return;
      }
      if (node.nodeType === 1) {
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          const parent = node.parentNode;
          const idx = Array.prototype.indexOf.call(parent.childNodes, node);
          if (acc + 1 > targetCharOffset) {
            found = { node: parent, offset: idx };
            return;
          }
          acc += 1;
          lastWasNewline = true;
          return;
        }
        const isBlock = tag === 'div' || tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre';
        if (isBlock && acc > 0 && !lastWasNewline) {
          if (acc + 1 > targetCharOffset) {
            found = { node, offset: 0 };
            return;
          }
          acc += 1;
          lastWasNewline = true;
        }
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) {
          visit(children[i]);
          if (found) return;
        }
      }
    }
    visit(root);
    if (found) return found;
    return { node: root, offset: root.childNodes ? root.childNodes.length : 0 };
  }

  function dispatchComposerPaste(el, insertText) {
    if (typeof ClipboardEvent !== 'function' || typeof DataTransfer !== 'function') {
      return { dispatched: false, defaultPrevented: false };
    }
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', insertText);
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      if (!pasteEv.clipboardData) {
        try {
          Object.defineProperty(pasteEv, 'clipboardData', { value: dt });
        } catch (_) {}
      }
      const notCancelled = el.dispatchEvent(pasteEv);
      return { dispatched: true, defaultPrevented: !notCancelled || Boolean(pasteEv.defaultPrevented) };
    } catch (_) {
      return { dispatched: false, defaultPrevented: false };
    }
  }

  function readComposerTextAndCursor(el) {
    if (!el) return { text: '', cursor: 0 };
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return { text: el.value || '', cursor: el.selectionStart || 0 };
    }
    const sel = window.getSelection();
    const text = el.innerText || el.textContent || '';
    if (!sel || sel.rangeCount === 0) return { text, cursor: text.length };
    const range = sel.getRangeAt(0);
    if (!el.contains(range.endContainer)) return { text, cursor: text.length };
    const before = walkContentEditableText(el, range.endContainer, range.endOffset);
    return { text, cursor: before.length, beforeText: before };
  }

  function replaceRangeInComposer(el, start, end, insertText) {
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const prev = el.value || '';
      const s = Math.max(0, Math.min(start, prev.length));
      const e = Math.max(s, Math.min(end, prev.length));
      const nextText = prev.slice(0, s) + insertText + prev.slice(e);
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (proto && proto.set) proto.set.call(el, nextText);
      else el.value = nextText;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const nextCursor = s + insertText.length;
      try {
        el.setSelectionRange(nextCursor, nextCursor);
      } catch (_) {}
      return true;
    }

    const sel = window.getSelection();
    if (!sel) return false;
    let range = null;
    try {
      const startPt = resolveContentEditableDomPoint(el, start);
      const endPt = resolveContentEditableDomPoint(el, end);
      range = document.createRange();
      range.setStart(startPt.node, startPt.offset);
      range.setEnd(endPt.node, endPt.offset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    } catch (_) {
      return false;
    }

    const beforeFull = el.innerText || el.textContent || '';
    const pasteRes = dispatchComposerPaste(el, insertText);
    if ((el.innerText || el.textContent || '') !== beforeFull || pasteRes.defaultPrevented) {
      return true;
    }
    try {
      if (document.execCommand('insertText', false, insertText)) {
        return true;
      }
    } catch (_) {}

    range.deleteContents();
    const frag = document.createDocumentFragment();
    const lines = insertText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) frag.appendChild(document.createElement('br'));
      frag.appendChild(document.createTextNode(lines[i]));
    }
    range.insertNode(frag);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: insertText }));
    return true;
  }

  function insertTextIntoComposer(textToInsert) {
    const composer = findChatComposer();
    if (!composer) {
      showToast('未检测到当前对话输入框');
      return false;
    }
    const { text, cursor } = readComposerTextAndCursor(composer);
    const before = text.slice(0, cursor);
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    return replaceRangeInComposer(composer, cursor, cursor, sep + textToInsert);
  }

  function updatePopupFromComposer(el) {
    if (!el || isComposing || !isOutsidePluginHosts(el)) return;
    const info = readComposerTextAndCursor(el);
    const trig =
      typeof info.beforeText === 'string'
        ? detectWikiTrigger(info.beforeText, info.beforeText.length)
        : detectWikiTrigger(info.text, info.cursor);
    if (!trig) {
      if (state.popup.visible) {
        state.popup.visible = false;
        renderPopupOnly();
      }
      return;
    }
    const scored = state.notes
      .map((n) => ({ note: n, score: scoreNoteForPopup(n, trig.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.note.mtimeMs - a.note.mtimeMs)
      .slice(0, MAX_POPUP_ITEMS)
      .map((x) => x.note);

    state.popup.visible = true;
    state.popup.items = scored;
    state.popup.selectedIndex = 0;
    state.popup.trigger = trig;
    state.popup.composer = el;
    state.popup.rect = el.getBoundingClientRect();
    renderPopupOnly();
  }

  async function confirmPopupSelection(idx) {
    const note = state.popup.items[idx];
    const composer = state.popup.composer;
    const trig = state.popup.trigger;
    state.popup.visible = false;
    renderPopupOnly();
    if (!note || !composer || !trig) return;

    const vault = getActiveVault();
    let fullContent = '';
    let fullPath = '';
    if (vault) {
      const res = await callBridge('/kb/read', { rootPath: vault.path, relPath: note.relPath });
      if (res && res.ok) {
        fullContent = res.content;
        fullPath = res.fullPath;
      }
    }
    const mode = state.config.prefs?.insertMode || 'body';
    const insertion = formatNoteForComposer(note, fullContent, mode, fullPath);
    replaceRangeInComposer(composer, trig.start, trig.end, insertion);
  }

  function handleSelectionCaptureCheck() {
    setTimeout(() => {
      try {
        const sel = window.getSelection();
        const txt = sel ? sel.toString().trim() : '';
        if (!txt || txt.length < 8) {
          if (state.selectionText) {
            state.selectionText = '';
            state.selectionRect = null;
            renderSelectionPillOnly();
          }
          return;
        }
        const anchorNode = sel.anchorNode;
        const el = anchorNode && anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
        if (!el || !isOutsidePluginHosts(el)) return;
        const composer = findChatComposer();
        if (composer && (composer === el || composer.contains(el))) return;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || rect.width < 4 || rect.height < 4) return;
        state.selectionText = txt;
        state.selectionRect = {
          left: Math.min((window.innerWidth || 1280) - 160, Math.max(16, rect.right - 120)),
          top: Math.max(48, rect.top - 36),
        };
        renderSelectionPillOnly();
      } catch (_) {}
    }, 30);
  }

  // ==================== Shadow DOM UI 渲染 & 宿主主题同步 ====================

  const SVG_ICON_PATHS = {
    pin: '<path d="M9.5 2.5L13.5 6.5L11.2 8.8L11.8 11.5L9.2 8.9L5.5 12.5L3.5 10.5L7.1 6.8L4.5 4.2L7.2 4.8L9.5 2.5Z"/><path d="M5.5 10.5L2.5 13.5"/>',
    pinFilled: '<path d="M9.5 2.5L13.5 6.5L11.2 8.8L11.8 11.5L9.2 8.9L5.5 12.5L3.5 10.5L7.1 6.8L4.5 4.2L7.2 4.8L9.5 2.5Z" fill="currentColor"/><path d="M5.5 10.5L2.5 13.5"/>',
    insert: '<path d="M3 4.5h10v6.5H7.2L4.5 13.2V11H3V4.5Z"/><path d="M6 7.8h4M8 5.8v4"/>',
    rename: '<path d="M11.2 2.8l2 2-7.4 7.4-2.6.6.6-2.6 7.4-7.4Z"/><path d="M9.6 4.4l2 2"/>',
    folder: '<path d="M2.2 4.2h4.2l1.3 1.5h6.1v6.8a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V4.2Z"/>',
    trash: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M4.8 4.5l.6 8.2a1 1 0 0 0 1 .9h3.2a1 1 0 0 0 1-.9l.6-8.2"/>',
    clip: '<rect x="4" y="3.2" width="8" height="10.3" rx="1.2"/><path d="M6.2 3.2V2.2h3.6v1M6.2 6.8h3.6M6.2 9.4h2.5"/>',
    refresh: '<path d="M13 7.5a5 5 0 1 1-1.3-3.3L13 5.5"/><path d="M13 2.5v3h-3"/>',
    settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.2v1.3M8 12.5v1.3M3.9 3.9l.9.9M11.2 11.2l.9.9M2.2 8h1.3M12.5 8h1.3M3.9 12.1l.9-.9M11.2 4.8l.9-.9"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    bookmark: '<path d="M4 2.5h8v11l-4-2.6-4 2.6v-11Z"/>',
  };

  function svgIcon(name, size = 14) {
    const body = SVG_ICON_PATHS[name] || '';
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0">${body}</svg>`;
  }

  let hostEl = null;
  let shadowRootRef = null;
  let drawerEl = null;
  let popupEl = null;
  let pillEl = null;

  function ensureShadowHost() {
    if (hostEl && shadowRootRef) return shadowRootRef;
    hostEl = document.getElementById(HOST_ID);
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = HOST_ID;
      hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
      document.body.appendChild(hostEl);
    }
    shadowRootRef = hostEl.shadowRoot || hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        --bg: var(--host-bg, #141416);
        --bg-elev: var(--host-card, var(--bg));
        --bg-card: color-mix(in srgb, var(--fg) 4.5%, transparent);
        --bg-hover: color-mix(in srgb, var(--fg) 7.5%, transparent);
        --border: color-mix(in srgb, var(--fg) 9%, transparent);
        --border-strong: color-mix(in srgb, var(--fg) 15%, transparent);
        --fg: var(--host-fg, #e8e8ec);
        --fg-muted: var(--host-muted-fg, #8e8e98);
        --fg-dim: color-mix(in srgb, var(--fg-muted) 72%, transparent);
        --accent: var(--host-primary, #4d7cfe);
        --accent-fg: var(--host-primary-fg, #ffffff);
        --accent-soft: color-mix(in srgb, var(--accent) 15%, transparent);
        --green: #7aae66;
        --amber: #cab43e;
        --red: #d95c5c;
        --font: var(--font-family, "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
        --mono: var(--editor-font-family, "Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
        --r-sm: 4px;
        --r-md: 6px;
        --r-lg: 8px;
        --shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
        font-family: var(--font);
        -webkit-font-smoothing: antialiased;
      }
      :host(.is-light) {
        --bg: var(--host-bg, #f7f7f8);
        --bg-elev: var(--host-card, #ffffff);
        --bg-card: color-mix(in srgb, var(--fg) 4%, transparent);
        --bg-hover: color-mix(in srgb, var(--fg) 7%, transparent);
        --border: color-mix(in srgb, var(--fg) 9%, transparent);
        --border-strong: color-mix(in srgb, var(--fg) 15%, transparent);
        --fg: var(--host-fg, #1d1f21);
        --fg-muted: var(--host-muted-fg, #5d676f);
        --fg-dim: #9da5ab;
        --accent: var(--host-primary, #007acc);
        --accent-fg: var(--host-primary-fg, #ffffff);
        --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
        --green: #63984f;
        --amber: #bca136;
        --red: #cb3d3d;
        --shadow: -6px 0 24px rgba(15, 23, 42, 0.12);
      }
      *, *::before, *::after { box-sizing: border-box; }
      .kb-drawer {
        position: fixed;
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--fg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        box-shadow: var(--shadow);
        pointer-events: auto;
        overflow: hidden;
        font-family: var(--font);
        font-size: 13px;
        line-height: 1.5;
      }
      .kb-drawer.docked-aux {
        box-shadow: none;
        border-color: transparent;
      }
      .kb-drawer.is-hidden { display: none; }
      .kb-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px 8px;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
        flex-shrink: 0;
      }
      .kb-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
      .kb-vault-select {
        max-width: 210px;
        height: 26px;
        background: var(--bg-card);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: var(--r-md);
        padding: 0 8px;
        font-family: var(--font);
        font-size: 12px;
        font-weight: 500;
        outline: none;
        cursor: pointer;
        transition: border-color 0.12s ease, background 0.12s ease;
      }
      .kb-vault-select:hover, .kb-vault-select:focus {
        border-color: var(--border-strong);
        background: var(--bg-hover);
      }
      .kb-vault-select option {
        background: var(--bg-elev);
        color: var(--fg);
      }
      .kb-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        height: 26px;
        padding: 0 10px;
        border-radius: var(--r-md);
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--fg);
        font-family: var(--font);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.12s ease, border-color 0.12s ease, filter 0.12s ease;
      }
      .kb-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
      .kb-btn.is-primary {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: var(--accent);
      }
      .kb-btn.is-primary:hover { filter: brightness(1.08); }
      .kb-btn.is-danger:hover { border-color: var(--red); color: var(--red); }
      .kb-icon-btn {
        width: 26px;
        height: 26px;
        padding: 0;
        border-radius: var(--r-md);
        border: 1px solid transparent;
        background: transparent;
        color: var(--fg-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .kb-icon-btn:hover { background: var(--bg-hover); color: var(--fg); }
      .kb-icon-btn.is-active { color: var(--accent); background: var(--accent-soft); }
      .kb-icon-btn.is-danger:hover { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
      .kb-search-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 14px;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
        flex-shrink: 0;
      }
      .kb-search-icon {
        color: var(--fg-dim);
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }
      .kb-input {
        flex: 1;
        min-width: 0;
        height: 28px;
        padding: 0 9px;
        border-radius: var(--r-md);
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--fg);
        font-family: var(--font);
        font-size: 12.5px;
        outline: none;
        transition: border-color 0.12s ease, background 0.12s ease;
      }
      .kb-input::placeholder { color: var(--fg-dim); }
      .kb-input:focus { border-color: var(--accent); background: var(--bg-elev); }
      .kb-tag-strip {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 6px 14px;
        overflow-x: auto;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
        flex-shrink: 0;
        scrollbar-width: none;
      }
      .kb-tag-strip::-webkit-scrollbar { display: none; }
      .kb-tag-chip {
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--fg-muted);
        font-family: var(--font);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
      }
      .kb-tag-chip:hover { background: var(--bg-hover); color: var(--fg); }
      .kb-tag-chip.is-active {
        background: var(--accent-soft);
        color: var(--accent);
        border-color: color-mix(in srgb, var(--accent) 45%, transparent);
      }
      .kb-body {
        display: grid;
        grid-template-columns: 192px minmax(0, 1fr);
        flex: 1;
        min-height: 0;
      }
      .kb-body.is-narrow {
        grid-template-columns: 1fr;
        grid-template-rows: 172px minmax(0, 1fr);
      }
      .kb-list-pane, .kb-preview, .kb-editor, .kb-popup {
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--fg) 20%, transparent) transparent;
      }
      .kb-list-pane::-webkit-scrollbar,
      .kb-preview::-webkit-scrollbar,
      .kb-editor::-webkit-scrollbar,
      .kb-popup::-webkit-scrollbar { width: 8px; height: 8px; }
      .kb-list-pane::-webkit-scrollbar-thumb,
      .kb-preview::-webkit-scrollbar-thumb,
      .kb-editor::-webkit-scrollbar-thumb,
      .kb-popup::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--fg) 18%, transparent);
        border: 2px solid transparent;
        background-clip: padding-box;
        border-radius: 8px;
      }
      .kb-list-pane::-webkit-scrollbar-track,
      .kb-preview::-webkit-scrollbar-track,
      .kb-editor::-webkit-scrollbar-track,
      .kb-popup::-webkit-scrollbar-track { background: transparent; }
      .kb-list-pane {
        border-right: 1px solid var(--border);
        overflow-y: auto;
        padding: 6px;
        background: var(--bg);
      }
      .kb-body.is-narrow .kb-list-pane {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
      .kb-note-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 7px 9px;
        border-radius: var(--r-md);
        cursor: pointer;
        margin-bottom: 3px;
        border: 1px solid transparent;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .kb-note-item:hover { background: var(--bg-card); }
      .kb-note-item.is-active {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 36%, transparent);
      }
      .kb-note-title-row {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
      }
      .kb-note-pin {
        color: var(--accent);
        display: inline-flex;
        flex-shrink: 0;
      }
      .kb-note-title {
        font-weight: 600;
        font-size: 12.5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kb-note-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--fg-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kb-note-excerpt {
        font-size: 11px;
        color: var(--fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kb-main-pane {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        background: var(--bg);
      }
      .kb-doc-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 12px;
        min-height: 36px;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
        flex-shrink: 0;
      }
      .kb-save-badge {
        font-size: 11px;
        color: var(--fg-dim);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .kb-seg {
        display: inline-flex;
        align-items: center;
        gap: 12px;
        margin-right: 4px;
      }
      .kb-seg button {
        position: relative;
        height: 34px;
        padding: 0 2px;
        border: none;
        background: transparent;
        color: var(--fg-muted);
        font-family: var(--font);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: color 0.12s ease;
      }
      .kb-seg button::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 2px;
        border-radius: 2px 2px 0 0;
        background: transparent;
      }
      .kb-seg button:hover { color: var(--fg); }
      .kb-seg button.is-active { color: var(--fg); }
      .kb-seg button.is-active::after { background: var(--fg); }
      .kb-doc-content {
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: hidden;
      }
      .kb-preview {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px 24px;
        line-height: 1.65;
        font-size: 13px;
        min-width: 0;
      }
      .kb-editor-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        border-right: 1px solid var(--border);
      }
      .kb-editor {
        flex: 1;
        width: 100%;
        border: none;
        outline: none;
        resize: none;
        padding: 14px 16px;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--mono);
        font-size: 12.5px;
        line-height: 1.6;
      }
      .kb-h { margin: 16px 0 6px; font-weight: 600; line-height: 1.35; letter-spacing: -0.01em; }
      .kb-h1 { font-size: 17px; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-top: 2px; }
      .kb-h2 { font-size: 14.5px; }
      .kb-h3 { font-size: 13.5px; }
      .kb-p { margin: 6px 0; }
      .kb-list { margin: 6px 0; padding-left: 20px; }
      .kb-task-item { list-style: none; margin-left: -16px; margin-bottom: 3px; }
      .kb-task-label { display: inline-flex; align-items: flex-start; gap: 7px; cursor: pointer; }
      .kb-task-cb { accent-color: var(--accent); margin-top: 4px; cursor: pointer; }
      .kb-task-item.is-done span { text-decoration: line-through; color: var(--fg-dim); }
      .kb-quote {
        margin: 8px 0;
        padding: 7px 11px;
        border-left: 2.5px solid var(--accent);
        background: var(--bg-card);
        border-radius: 0 var(--r-md) var(--r-md) 0;
        color: var(--fg-muted);
      }
      .kb-inline-code {
        padding: 1px 5px;
        border-radius: var(--r-sm);
        background: var(--bg-card);
        border: 1px solid var(--border);
        font-family: var(--mono);
        font-size: 11.5px;
      }
      .kb-code-wrap {
        margin: 8px 0;
        border: 1px solid var(--border);
        border-radius: var(--r-lg);
        overflow: hidden;
        background: var(--bg-card);
      }
      .kb-code-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        border-bottom: 1px solid var(--border);
        font-family: var(--mono);
        font-size: 11px;
        color: var(--fg-muted);
      }
      .kb-code-actions { display: flex; gap: 6px; }
      .kb-mini-btn {
        padding: 1px 7px;
        border-radius: var(--r-sm);
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--fg-muted);
        font-family: var(--font);
        font-size: 11px;
        cursor: pointer;
        transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
      }
      .kb-mini-btn:hover { background: var(--bg-hover); color: var(--fg); border-color: var(--border-strong); }
      .kb-pre {
        margin: 0;
        padding: 10px 12px;
        overflow-x: auto;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.52;
      }
      .kb-table-wrap { overflow-x: auto; margin: 8px 0; }
      .kb-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .kb-table th, .kb-table td { border: 1px solid var(--border); padding: 5px 8px; text-align: left; }
      .kb-table th { background: var(--bg-card); font-weight: 600; color: var(--fg-muted); }
      .kb-wikilink {
        color: var(--accent);
        text-decoration: none;
        border-bottom: 1px dashed color-mix(in srgb, var(--accent) 65%, transparent);
        cursor: pointer;
      }
      .kb-wikilink:hover { border-bottom-style: solid; }
      .kb-ext-link { color: var(--accent); }
      .kb-inline-tag {
        border: none;
        background: var(--accent-soft);
        color: var(--accent);
        border-radius: var(--r-sm);
        padding: 0 5px;
        font-family: var(--font);
        font-size: 11.5px;
        cursor: pointer;
      }
      .kb-mark { background: color-mix(in srgb, var(--amber) 30%, transparent); color: inherit; padding: 0 2px; border-radius: 2px; }
      .kb-hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
      .kb-backlinks {
        margin-top: 18px;
        padding-top: 10px;
        border-top: 1px dashed var(--border);
        font-size: 12px;
      }
      .kb-backlinks-title { color: var(--fg-muted); font-weight: 600; margin-bottom: 6px; font-size: 11.5px; }
      .kb-backlink-chip {
        display: inline-block;
        margin: 0 6px 6px 0;
        padding: 3px 8px;
        border-radius: var(--r-md);
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--accent);
        font-family: var(--font);
        cursor: pointer;
        font-size: 11.5px;
      }
      .kb-backlink-chip:hover { background: var(--bg-hover); border-color: var(--border-strong); }
      .kb-modal-mask {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        z-index: 20;
      }
      .kb-modal {
        width: 100%;
        max-width: 390px;
        background: var(--bg-elev);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: var(--shadow);
      }
      .kb-modal-title { font-weight: 600; font-size: 14px; }
      .kb-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
      .kb-field label { color: var(--fg-muted); font-size: 11.5px; }
      .kb-textarea {
        min-height: 96px;
        padding: 7px 9px;
        border-radius: var(--r-md);
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--fg);
        font-family: var(--mono);
        font-size: 12px;
        resize: vertical;
        outline: none;
      }
      .kb-textarea:focus { border-color: var(--accent); }
      .kb-toast {
        position: absolute;
        bottom: 12px;
        right: 12px;
        background: var(--bg-elev);
        border: 1px solid var(--border-strong);
        color: var(--fg);
        padding: 6px 12px;
        border-radius: var(--r-lg);
        font-size: 12px;
        box-shadow: var(--shadow);
        z-index: 30;
      }
      .kb-popup {
        position: fixed;
        width: 380px;
        max-width: calc(100vw - 24px);
        max-height: 290px;
        overflow-y: auto;
        background: var(--bg-elev);
        color: var(--fg);
        border: 1px solid var(--border-strong);
        border-radius: 10px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        padding: 5px;
        pointer-events: auto;
        z-index: 50;
      }
      .kb-popup.is-hidden { display: none; }
      .kb-popup-head {
        font-size: 11px;
        color: var(--fg-muted);
        padding: 4px 8px 6px;
        border-bottom: 1px solid var(--border);
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .kb-popup-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: var(--r-sm);
        background: var(--accent-soft);
        color: var(--accent);
        font-family: var(--mono);
        font-weight: 600;
        margin-right: 6px;
      }
      .kb-popup-item {
        padding: 6px 8px;
        border-radius: var(--r-md);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        border: 1px solid transparent;
      }
      .kb-popup-item.is-selected, .kb-popup-item:hover {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 32%, transparent);
      }
      .kb-pill {
        position: fixed;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        border-radius: 999px;
        background: var(--bg-elev);
        color: var(--fg);
        border: 1px solid var(--border-strong);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
        font-family: var(--font);
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        z-index: 45;
        transition: border-color 0.12s ease, transform 0.12s ease;
      }
      .kb-pill:hover { border-color: var(--accent); transform: translateY(-1px); }
      .kb-pill.is-hidden { display: none; }
      .kb-empty {
        padding: 24px 14px;
        text-align: center;
        color: var(--fg-muted);
        font-size: 12.5px;
      }
    `;
    shadowRootRef.appendChild(style);

    drawerEl = document.createElement('div');
    drawerEl.className = 'kb-drawer is-hidden';
    shadowRootRef.appendChild(drawerEl);

    popupEl = document.createElement('div');
    popupEl.className = 'kb-popup is-hidden';
    shadowRootRef.appendChild(popupEl);

    pillEl = document.createElement('button');
    pillEl.type = 'button';
    pillEl.className = 'kb-pill is-hidden';
    pillEl.innerHTML = `${svgIcon('bookmark', 12)}<span>存到知识库</span>`;
    pillEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    pillEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCaptureModal(state.selectionText);
    });
    shadowRootRef.appendChild(pillEl);

    return shadowRootRef;
  }

  function isValidCssColor(val) {
    if (typeof val !== 'string') return false;
    const v = val.trim();
    if (!v) return false;
    if (/^(#|rgb\(|rgba\(|hsl\(|hsla\(|oklch\(|lab\(|lch\(|color\()/i.test(v)) return true;
    try {
      return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', v);
    } catch (_) {
      return false;
    }
  }

  function applyThemeClass() {
    if (!hostEl) return;
    let isLight = false;
    try {
      const rootEl = document.documentElement || document.body;
      const rootCs = window.getComputedStyle(rootEl);
      const bodyCs = window.getComputedStyle(document.body || rootEl);
      const bg =
        (bodyCs && bodyCs.backgroundColor && bodyCs.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? bodyCs.backgroundColor
          : rootCs && rootCs.backgroundColor) || '';
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
      if (m) {
        const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
        isLight = lum > 140;
      }
      if (rootCs && typeof rootCs.getPropertyValue === 'function') {
        const colorMap = [
          ['--host-bg', ['--background', '--vscode-sideBar-background']],
          ['--host-card', ['--card', '--vscode-editor-background']],
          ['--host-fg', ['--foreground', '--vscode-foreground']],
          ['--host-muted-fg', ['--muted-foreground']],
          ['--host-primary', ['--primary']],
          ['--host-primary-fg', ['--primary-foreground']],
        ];
        for (const [targetVar, sources] of colorMap) {
          for (const src of sources) {
            const val = rootCs.getPropertyValue(src).trim();
            if (isValidCssColor(val)) {
              hostEl.style.setProperty(targetVar, val);
              break;
            }
          }
        }
        for (const fontKey of ['--font-family', '--editor-font-family']) {
          const fv = rootCs.getPropertyValue(fontKey).trim();
          if (fv) hostEl.style.setProperty(fontKey, fv);
        }
      }
    } catch (_) {}
    hostEl.classList.toggle('is-light', isLight);
    if (drawerEl && state.lastAuxRect && state.lastAuxRect.bgColor) {
      drawerEl.style.setProperty('--bg', state.lastAuxRect.bgColor);
    } else if (drawerEl) {
      drawerEl.style.removeProperty('--bg');
    }
  }

  function applyDrawerGeometry() {
    ensureShadowHost();
    if (!drawerEl) return;
    const isOpen = Boolean(state.config.prefs?.open);
    drawerEl.classList.toggle('is-hidden', !isOpen);
    drawerEl.classList.toggle('docked-aux', Boolean(state.openedInNativePane));
    if (!isOpen) return;

    const aux = state.lastAuxRect;
    if (aux && aux.found) {
      drawerEl.style.left = `${aux.left}px`;
      drawerEl.style.top = `${aux.top}px`;
      drawerEl.style.width = `${aux.width}px`;
      drawerEl.style.height = `${aux.height}px`;
      drawerEl.style.borderRadius = `${aux.radius || 10}px`;
    } else {
      const w = Math.min(520, Math.max(360, Math.round((window.innerWidth || 1280) * 0.36)));
      drawerEl.style.left = `${(window.innerWidth || 1280) - w - 14}px`;
      drawerEl.style.top = '48px';
      drawerEl.style.width = `${w}px`;
      drawerEl.style.height = `${Math.max(320, (window.innerHeight || 800) - 64)}px`;
    }
  }

  function renderSaveBadgeOnly() {
    if (!drawerEl) return;
    const el = drawerEl.querySelector('[data-kb-save-status="1"]');
    if (el) el.textContent = state.saveStatus || (state.dirty ? '未保存' : '');
  }

  function syncActiveListItemOnly(relPath, metaObj) {
    if (!drawerEl || !relPath) return;
    const items = drawerEl.querySelectorAll('[data-open-note]');
    for (const item of items) {
      if (item.getAttribute('data-open-note') === relPath) {
        const titleEl = item.querySelector('.kb-note-title');
        if (titleEl && metaObj && metaObj.title) titleEl.textContent = metaObj.title;
        const excEl = item.querySelector('.kb-note-excerpt');
        if (excEl && metaObj && typeof metaObj.excerpt === 'string') excEl.textContent = metaObj.excerpt;
        break;
      }
    }
  }

  function renderPopupOnly() {
    ensureShadowHost();
    if (!popupEl) return;
    if (!state.popup.visible || !state.popup.rect) {
      popupEl.classList.add('is-hidden');
      return;
    }
    const r = state.popup.rect;
    const innerH = window.innerHeight || 800;
    popupEl.classList.remove('is-hidden');
    popupEl.style.left = `${Math.max(12, Math.min((window.innerWidth || 1280) - 392, r.left))}px`;
    popupEl.style.bottom = `${Math.min(Math.max(24, innerH - 310), Math.max(24, innerH - r.top + 8))}px`;

    const items = state.popup.items;
    if (items.length === 0) {
      popupEl.innerHTML = `<div class="kb-popup-head"><span><span class="kb-popup-badge">[[</span>知识库引用</span><span>Esc 关闭</span></div><div class="kb-empty" style="padding:12px">没有匹配的笔记</div>`;
      return;
    }
    const rowsHtml = items
      .map((n, idx) => {
        const sel = idx === state.popup.selectedIndex ? ' is-selected' : '';
        const tags = (n.tags || []).slice(0, 3).map((t) => `#${escapeHtml(t)}`).join(' ');
        return (
          `<div class="kb-popup-item${sel}" data-popup-idx="${idx}">` +
            `<div class="kb-note-title">${escapeHtml(n.title || baseStem(n.relPath))}</div>` +
            `<div class="kb-note-meta"><span>${escapeHtml(n.relPath)}</span><span>${tags}</span></div>` +
          `</div>`
        );
      })
      .join('');
    popupEl.innerHTML = `<div class="kb-popup-head"><span><span class="kb-popup-badge">[[</span>知识库引用 · Tab 插入</span><span>${items.length} 篇</span></div>${rowsHtml}`;
    popupEl.querySelectorAll('[data-popup-idx]').forEach((node) => {
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        void confirmPopupSelection(Number(node.getAttribute('data-popup-idx')));
      });
    });
  }

  function renderSelectionPillOnly() {
    ensureShadowHost();
    if (!pillEl) return;
    if (!state.selectionText || !state.selectionRect || state.showNewModal) {
      pillEl.classList.add('is-hidden');
      return;
    }
    pillEl.classList.remove('is-hidden');
    pillEl.style.left = `${state.selectionRect.left}px`;
    pillEl.style.top = `${state.selectionRect.top}px`;
  }

  function openNewModal(defaultTitle = '') {
    state.showNewModal = true;
    state.modalMode = 'new';
    state.modalTitle = defaultTitle;
    state.modalPath = defaultTitle ? sanitizeRelPath(defaultTitle) : '';
    state.modalTags = '';
    state.modalBody = '';
    renderAll();
  }

  function openCaptureModal(capturedText) {
    state.selectionText = '';
    state.selectionRect = null;
    renderSelectionPillOnly();
    const firstLine = String(capturedText || '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*\s`-]+/, '').trim())
      .find(Boolean) || '对话收藏笔记';
    const shortTitle = firstLine.slice(0, 36).replace(/[\\/:*?"<>|]/g, '-');
    state.showNewModal = true;
    state.modalMode = 'capture';
    state.modalTitle = shortTitle;
    state.modalPath = sanitizeRelPath(`clips/${new Date().toISOString().slice(0, 10)}-${shortTitle}`);
    state.modalTags = '对话收藏';
    state.modalAppendTarget = '';
    state.modalBody = capturedText || '';
    if (!state.config.prefs?.open) {
      openKbInPane(true);
    } else {
      renderAll();
    }
  }

  async function submitModal() {
    const vault = getActiveVault();
    if (!vault) return;
    if (state.modalMode === 'rename' && state.activeNote) {
      const nextRel = sanitizeRelPath(state.modalPath);
      if (!nextRel) return;
      const res = await callBridge('/kb/rename', {
        rootPath: vault.path,
        oldRelPath: state.activeNote.relPath,
        newRelPath: nextRel,
      });
      if (res && res.ok) {
        state.showNewModal = false;
        state.activeNote.relPath = res.relPath;
        await refreshVaultTree(false);
        await openNoteByRelPath(res.relPath);
        showToast('已重命名笔记');
      } else {
        showToast(res?.error || '重命名失败');
      }
      return;
    }

    if (state.modalMode === 'capture' && state.modalAppendTarget) {
      const readRes = await callBridge('/kb/read', { rootPath: vault.path, relPath: state.modalAppendTarget });
      if (!readRes || !readRes.ok) {
        showToast('读取目标笔记失败');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const appended = `${readRes.content.trimEnd()}\n\n## ${stamp} 对话摘录\n\n${state.modalBody.trim()}\n`;
      const wr = await callBridge('/kb/write', {
        rootPath: vault.path,
        relPath: state.modalAppendTarget,
        content: appended,
      });
      if (wr && wr.ok) {
        state.showNewModal = false;
        await refreshVaultTree(false);
        await openNoteByRelPath(wr.relPath);
        showToast('已追加到笔记');
      }
      return;
    }

    const title = state.modalTitle.trim() || baseStem(state.modalPath) || '未命名笔记';
    const relPath = sanitizeRelPath(state.modalPath || title);
    const tags = state.modalTags
      .split(/[,，\s]+/)
      .map((t) => t.trim().replace(/^#+/, ''))
      .filter(Boolean);
    const content = buildFrontmatterNote({
      title,
      tags,
      body: state.modalBody || '',
    });
    const res = await callBridge('/kb/write', {
      rootPath: vault.path,
      relPath,
      content,
      overwrite: false,
    });
    if (res && res.ok) {
      state.showNewModal = false;
      await refreshVaultTree(false);
      await openNoteByRelPath(res.relPath);
      showToast(`已创建 ${res.relPath}`);
    } else {
      showToast(res?.error || '创建失败');
    }
  }

  function renderAll() {
    ensureShadowHost();
    applyThemeClass();
    applyDrawerGeometry();
    renderPopupOnly();
    renderSelectionPillOnly();
    if (!drawerEl || !state.config.prefs?.open) return;

    // 保留搜索框或编辑器的焦点与光标位置
    let focusRestore = null;
    try {
      const ae = shadowRootRef && shadowRootRef.activeElement;
      if (ae && ae.getAttribute) {
        if (ae.getAttribute('data-kb-search') === '1') {
          focusRestore = { sel: '[data-kb-search="1"]', start: ae.selectionStart, end: ae.selectionEnd };
        } else if (ae.getAttribute('data-kb-editor') === '1') {
          focusRestore = { sel: '[data-kb-editor="1"]', start: ae.selectionStart, end: ae.selectionEnd, scrollTop: ae.scrollTop };
        }
      }
    } catch (_) {}

    const activeVault = getActiveVault();
    const allVaults = getAllVaults();
    const prefs = state.config.prefs || DEFAULT_PREFS;
    const drawerWidth =
      (state.lastAuxRect && state.lastAuxRect.found && state.lastAuxRect.width) ||
      Math.min(520, Math.max(360, Math.round((window.innerWidth || 1280) * 0.36)));
    const isNarrow = drawerWidth < 480;

    // 汇总全部标签
    const tagCounts = new Map();
    for (const n of state.notes) {
      for (const t of n.tags || []) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18);

    // 过滤展示列表
    let displayedNotes = state.searchResults !== null ? state.searchResults : state.notes;
    if (state.selectedTag && state.searchResults === null) {
      const selLow = state.selectedTag.toLowerCase();
      displayedNotes = displayedNotes.filter((n) => (n.tags || []).some((t) => t.toLowerCase() === selLow));
    }
    const pinnedSet = new Set(state.config.pinnedNotes || []);
    displayedNotes = [...displayedNotes].sort((a, b) => {
      const pa = pinnedSet.has(a.relPath) ? 1 : 0;
      const pb = pinnedSet.has(b.relPath) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return 0;
    });

    const vaultOptions = allVaults
      .map((v) => `<option value="${escapeHtml(v.id)}" ${activeVault && v.id === activeVault.id ? 'selected' : ''}>${escapeHtml(v.label)}</option>`)
      .join('');

    const tagStripHtml =
      `<button type="button" class="kb-tag-chip${!state.selectedTag ? ' is-active' : ''}" data-filter-tag="">全部 (${state.notes.length})</button>` +
      topTags
        .map(
          ([t, cnt]) =>
            `<button type="button" class="kb-tag-chip${state.selectedTag === t ? ' is-active' : ''}" data-filter-tag="${escapeHtml(t)}">#${escapeHtml(t)} (${cnt})</button>`
        )
        .join('');

    const listHtml = !state.bridgeReady
      ? `<div class="kb-empty">KB Bridge 尚未就绪。<br/>请运行 <code>python scripts/manage_plugins.py install</code> 并重启 Antigravity。</div>`
      : displayedNotes.length === 0
        ? `<div class="kb-empty">当前筛选下没有 Markdown 笔记<br/><br/><button type="button" class="kb-btn is-primary" data-act="new-note">+ 新建第一篇笔记</button></div>`
        : displayedNotes
            .map((n) => {
              const isActive = state.activeNote && state.activeNote.relPath === n.relPath;
              const isPin = pinnedSet.has(n.relPath);
              const snippetLine = n.snippets && n.snippets[0] ? `L${n.snippets[0].line}: ${n.snippets[0].text}` : n.excerpt;
              return (
                `<div class="kb-note-item${isActive ? ' is-active' : ''}" data-open-note="${escapeHtml(n.relPath)}">` +
                  `<div class="kb-note-title-row">` +
                    (isPin ? `<span class="kb-note-pin" title="已置顶">${svgIcon('pinFilled', 12)}</span>` : '') +
                    `<span class="kb-note-title">${escapeHtml(n.title || baseStem(n.relPath))}</span>` +
                  `</div>` +
                  `<div class="kb-note-meta"><span>${escapeHtml(n.relPath)}</span></div>` +
                  (snippetLine ? `<div class="kb-note-excerpt">${escapeHtml(snippetLine)}</div>` : '') +
                `</div>`
              );
            })
            .join('');

    // 主区域内容
    let mainHtml = `<div class="kb-empty">从左侧选择一篇笔记，或点击上方「+ 新建」开始记录。</div>`;
    if (state.activeNote) {
      const note = state.activeNote;
      const isPin = pinnedSet.has(note.relPath);
      const backlinks = computeBacklinks(
        { relPath: note.relPath, title: note.meta?.title || baseStem(note.relPath) },
        state.notes
      );
      const backlinksHtml =
        backlinks.length > 0
          ? `<div class="kb-backlinks"><div class="kb-backlinks-title">反向链接 (${backlinks.length})</div>` +
            backlinks
              .map(
                (bl) =>
                  `<button type="button" class="kb-backlink-chip" data-open-note="${escapeHtml(bl.relPath)}">[[${escapeHtml(bl.title || baseStem(bl.relPath))}]]</button>`
              )
              .join('') +
            `</div>`
          : '';

      const viewMode = prefs.viewMode || 'preview';
      const editorPane =
        viewMode === 'edit' || viewMode === 'split'
          ? `<div class="kb-editor-wrap"><textarea class="kb-editor" data-kb-editor="1" spellcheck="false">${escapeHtml(state.draftContent)}</textarea></div>`
          : '';
      const previewPane =
        viewMode === 'preview' || viewMode === 'split'
          ? `<div class="kb-preview" data-kb-preview="1">${renderMarkdownToHtml(state.draftContent)}${backlinksHtml}</div>`
          : '';

      mainHtml =
        `<div class="kb-doc-toolbar">` +
          `<div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">` +
            `<span class="kb-note-title" title="${escapeHtml(note.relPath)}">${escapeHtml(note.meta?.title || baseStem(note.relPath))}</span>` +
            `<span class="kb-save-badge" data-kb-save-status="1">${escapeHtml(state.saveStatus || (state.dirty ? '未保存' : ''))}</span>` +
          `</div>` +
          `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">` +
            `<div class="kb-seg">` +
              `<button type="button" class="${viewMode === 'preview' ? 'is-active' : ''}" data-view="preview">预览</button>` +
              `<button type="button" class="${viewMode === 'edit' ? 'is-active' : ''}" data-view="edit">编辑</button>` +
              `<button type="button" class="${viewMode === 'split' ? 'is-active' : ''}" data-view="split">分栏</button>` +
            `</div>` +
            `<button type="button" class="kb-icon-btn${isPin ? ' is-active' : ''}" title="置顶/取消置顶" data-act="toggle-pin">${svgIcon(isPin ? 'pinFilled' : 'pin', 14)}</button>` +
            `<button type="button" class="kb-icon-btn" title="插入到当前对话输入框" data-act="insert-note">${svgIcon('insert', 14)}</button>` +
            `<button type="button" class="kb-icon-btn" title="重命名/移动" data-act="rename-note">${svgIcon('rename', 14)}</button>` +
            `<button type="button" class="kb-icon-btn" title="在资源管理器中显示" data-act="reveal-note">${svgIcon('folder', 14)}</button>` +
            `<button type="button" class="kb-icon-btn is-danger" title="移入回收站 (.trash)" data-act="delete-note">${svgIcon('trash', 14)}</button>` +
          `</div>` +
        `</div>` +
        `<div class="kb-doc-content">${editorPane}${previewPane}</div>`;
    }

    const modalHtml = state.showNewModal
      ? `<div class="kb-modal-mask">` +
          `<div class="kb-modal">` +
            `<div class="kb-modal-title">${state.modalMode === 'rename' ? '重命名 / 移动笔记' : state.modalMode === 'capture' ? '收藏到知识库' : '新建 Markdown 笔记'}</div>` +
            (state.modalMode !== 'rename'
              ? `<div class="kb-field"><label>标题</label><input class="kb-input" data-modal-field="title" value="${escapeHtml(state.modalTitle)}" placeholder="例如：Electron 打包排查" /></div>`
              : '') +
            `<div class="kb-field"><label>相对路径 (.md)</label><input class="kb-input" data-modal-field="path" value="${escapeHtml(state.modalPath)}" placeholder="notes/example.md" /></div>` +
            (state.modalMode !== 'rename'
              ? `<div class="kb-field"><label>标签（空格或逗号分隔）</label><input class="kb-input" data-modal-field="tags" value="${escapeHtml(state.modalTags)}" placeholder="调试 Antigravity" /></div>`
              : '') +
            (state.modalMode === 'capture'
              ? `<div class="kb-field"><label>或者追加到已有笔记（留空则新建）</label>` +
                  `<select class="kb-vault-select" style="max-width:none" data-modal-field="appendTarget">` +
                    `<option value="">-- 新建独立笔记 --</option>` +
                    state.notes.slice(0, 40).map((n) => `<option value="${escapeHtml(n.relPath)}" ${state.modalAppendTarget === n.relPath ? 'selected' : ''}>${escapeHtml(n.title || n.relPath)}</option>`).join('') +
                  `</select></div>` +
                `<div class="kb-field"><label>内容</label><textarea class="kb-textarea" data-modal-field="body">${escapeHtml(state.modalBody)}</textarea></div>`
              : '') +
            `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">` +
              `<button type="button" class="kb-btn" data-act="close-modal">取消</button>` +
              `<button type="button" class="kb-btn is-primary" data-act="submit-modal">确定</button>` +
            `</div>` +
          `</div>` +
        `</div>`
      : '';

    const settingsHtml = state.showSettings
      ? `<div class="kb-modal-mask">` +
          `<div class="kb-modal">` +
            `<div class="kb-modal-title">知识库设置</div>` +
            `<div class="kb-field"><label>当前 Vault 路径</label><div style="font-size:11.5px;color:var(--fg-muted);word-break:break-all">${escapeHtml(activeVault?.path || '')}</div></div>` +
            `<div class="kb-field"><label>[[ 快捷插入默认格式</label>` +
              `<select class="kb-vault-select" style="max-width:none" data-pref="insertMode">` +
                `<option value="body" ${prefs.insertMode === 'body' ? 'selected' : ''}>插入笔记正文（去掉 Frontmatter）</option>` +
                `<option value="quote" ${prefs.insertMode === 'quote' ? 'selected' : ''}>插入引用块（带笔记标题）</option>` +
                `<option value="path" ${prefs.insertMode === 'path' ? 'selected' : ''}>仅插入本地 .md 文件路径</option>` +
              `</select></div>` +
            `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">` +
              `<input type="checkbox" data-pref-cb="autoSave" ${prefs.autoSave !== false ? 'checked' : ''} /> 编辑停止 0.8s 后自动保存</label>` +
            `<div style="display:flex;justify-content:space-between;gap:8px;margin-top:4px">` +
              `<button type="button" class="kb-btn" data-act="add-vault">+ 挂载本地目录</button>` +
              `<button type="button" class="kb-btn is-primary" data-act="close-settings">完成</button>` +
            `</div>` +
          `</div>` +
        `</div>`
      : '';

    const toastHtml = state.toast ? `<div class="kb-toast">${escapeHtml(state.toast)}</div>` : '';

    drawerEl.innerHTML =
      `<div class="kb-header">` +
        `<div class="kb-header-left">` +
          `<select class="kb-vault-select" data-act="switch-vault">${vaultOptions}</select>` +
          `<button type="button" class="kb-btn is-primary" data-act="new-note">${svgIcon('plus', 12)}<span>新建</span></button>` +
        `</div>` +
        `<div style="display:flex;align-items:center;gap:2px">` +
          `<button type="button" class="kb-icon-btn" title="从剪贴板新建笔记" data-act="clip-paste">${svgIcon('clip', 14)}</button>` +
          `<button type="button" class="kb-icon-btn" title="刷新目录" data-act="refresh">${svgIcon('refresh', 14)}</button>` +
          `<button type="button" class="kb-icon-btn" title="设置" data-act="open-settings">${svgIcon('settings', 14)}</button>` +
          `<button type="button" class="kb-icon-btn" title="关闭" data-act="close-tab">${svgIcon('close', 14)}</button>` +
        `</div>` +
      `</div>` +
      `<div class="kb-search-bar">` +
        `<span class="kb-search-icon">${svgIcon('search', 13)}</span>` +
        `<input class="kb-input" data-kb-search="1" value="${escapeHtml(state.searchQuery)}" placeholder="搜索标题、#标签 或全文内容..." />` +
        (state.searchQuery ? `<button type="button" class="kb-icon-btn" title="清空搜索" data-act="clear-search">${svgIcon('close', 12)}</button>` : '') +
      `</div>` +
      `<div class="kb-tag-strip">${tagStripHtml}</div>` +
      `<div class="kb-body${isNarrow ? ' is-narrow' : ''}">` +
        `<div class="kb-list-pane">${listHtml}</div>` +
        `<div class="kb-main-pane">${mainHtml}</div>` +
      `</div>` +
      modalHtml +
      settingsHtml +
      toastHtml;

    bindDrawerEvents();

    if (focusRestore) {
      try {
        const target = drawerEl.querySelector(focusRestore.sel);
        if (target && typeof target.focus === 'function') {
          target.focus();
          if (typeof focusRestore.start === 'number' && typeof target.setSelectionRange === 'function') {
            target.setSelectionRange(focusRestore.start, focusRestore.end ?? focusRestore.start);
          }
          if (typeof focusRestore.scrollTop === 'number') {
            target.scrollTop = focusRestore.scrollTop;
          }
        }
      } catch (_) {}
    }
  }

  function bindDrawerEvents() {
    if (!drawerEl) return;

    const vaultSel = drawerEl.querySelector('[data-act="switch-vault"]');
    if (vaultSel) {
      vaultSel.addEventListener('change', async () => {
        state.config.activeVaultId = vaultSel.value;
        state.activeNote = null;
        state.selectedTag = '';
        state.searchQuery = '';
        state.searchResults = null;
        await saveConfigRemote();
        await refreshVaultTree(false);
      });
    }

    const searchInput = drawerEl.querySelector('[data-kb-search="1"]');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.searchQuery = searchInput.value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          void runSearchQuery(state.searchQuery);
        }, 180);
      });
    }

    drawerEl.querySelectorAll('[data-filter-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedTag = btn.getAttribute('data-filter-tag') || '';
        if (state.searchQuery) void runSearchQuery(state.searchQuery);
        else renderAll();
      });
    });

    drawerEl.querySelectorAll('[data-open-note]').forEach((node) => {
      node.addEventListener('click', () => {
        const rel = node.getAttribute('data-open-note');
        if (rel) void openNoteByRelPath(rel);
      });
    });

    drawerEl.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), viewMode: btn.getAttribute('data-view') };
        void saveConfigRemote();
        renderAll();
      });
    });

    const editor = drawerEl.querySelector('[data-kb-editor="1"]');
    let splitPreviewTimer = null;
    if (editor) {
      editor.addEventListener('input', () => {
        state.draftContent = editor.value;
        state.dirty = true;
        state.saveStatus = '未保存';
        renderSaveBadgeOnly();
        scheduleAutoSave();
        // 分栏模式下局部刷新右侧预览，不重建编辑器 DOM
        if ((state.config.prefs?.viewMode || 'preview') === 'split') {
          if (splitPreviewTimer) clearTimeout(splitPreviewTimer);
          splitPreviewTimer = setTimeout(() => {
            const pv = drawerEl && drawerEl.querySelector('[data-kb-preview="1"]');
            if (pv && state.activeNote) {
              const backlinks = computeBacklinks(
                { relPath: state.activeNote.relPath, title: state.activeNote.meta?.title || baseStem(state.activeNote.relPath) },
                state.notes
              );
              const blHtml =
                backlinks.length > 0
                  ? `<div class="kb-backlinks"><div class="kb-backlinks-title">反向链接 (${backlinks.length})</div>` +
                    backlinks
                      .map(
                        (bl) =>
                          `<button type="button" class="kb-backlink-chip" data-open-note="${escapeHtml(bl.relPath)}">[[${escapeHtml(bl.title || baseStem(bl.relPath))}]]</button>`
                      )
                      .join('') +
                    `</div>`
                  : '';
              pv.innerHTML = `${renderMarkdownToHtml(state.draftContent)}${blHtml}`;
              bindPreviewEvents(pv);
              pv.querySelectorAll('.kb-backlink-chip[data-open-note]').forEach((node) => {
                node.addEventListener('click', () => {
                  const rel = node.getAttribute('data-open-note');
                  if (rel) void openNoteByRelPath(rel);
                });
              });
            }
          }, 120);
        }
      });
      editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void persistCurrentDraft();
        }
      });
    }

    const preview = drawerEl.querySelector('[data-kb-preview="1"]');
    if (preview) {
      bindPreviewEvents(preview);
    }

    // 模态框表单绑定
    drawerEl.querySelectorAll('[data-modal-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.getAttribute('data-modal-field');
        if (k === 'title') {
          state.modalTitle = el.value;
          if (state.modalMode === 'new') {
            state.modalPath = sanitizeRelPath(el.value);
            const pathInp = drawerEl.querySelector('[data-modal-field="path"]');
            if (pathInp) pathInp.value = state.modalPath;
          }
        } else if (k === 'path') state.modalPath = el.value;
        else if (k === 'tags') state.modalTags = el.value;
        else if (k === 'body') state.modalBody = el.value;
        else if (k === 'appendTarget') state.modalAppendTarget = el.value;
      });
      if (el.tagName === 'INPUT') {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submitModal();
          }
        });
      }
    });

    const insertPrefSel = drawerEl.querySelector('[data-pref="insertMode"]');
    if (insertPrefSel) {
      insertPrefSel.addEventListener('change', () => {
        state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), insertMode: insertPrefSel.value };
        void saveConfigRemote();
      });
    }
    const autoSaveCb = drawerEl.querySelector('[data-pref-cb="autoSave"]');
    if (autoSaveCb) {
      autoSaveCb.addEventListener('change', () => {
        state.config.prefs = { ...(state.config.prefs || DEFAULT_PREFS), autoSave: autoSaveCb.checked };
        void saveConfigRemote();
      });
    }

    const actions = {
      'new-note': () => openNewModal(''),
      'close-modal': () => {
        state.showNewModal = false;
        renderAll();
      },
      'submit-modal': () => void submitModal(),
      'open-settings': () => {
        state.showSettings = true;
        renderAll();
      },
      'close-settings': () => {
        state.showSettings = false;
        renderAll();
      },
      'close-tab': () => closeKbTab(),
      'refresh': () => void detectWorkspaceVaults().then(() => refreshVaultTree(true)),
      'clear-search': () => {
        state.searchQuery = '';
        state.searchResults = null;
        renderAll();
      },
      'clip-paste': async () => {
        try {
          const clip = navigator.clipboard ? await navigator.clipboard.readText() : '';
          openCaptureModal(clip || '');
        } catch (_) {
          openCaptureModal('');
        }
      },
      'add-vault': async () => {
        const res = await callBridge('/kb/pick-folder', {});
        if (res && res.ok && !res.canceled && res.path) {
          const label = res.path.split(/[\\/]/).filter(Boolean).pop() || res.path;
          const id = `custom:${res.path}`;
          const existing = (state.config.vaults || []).find((v) => v.path === res.path);
          if (!existing) {
            state.config.vaults = [...(state.config.vaults || []), { id, label, path: res.path, kind: 'custom' }];
          }
          state.config.activeVaultId = existing ? existing.id : id;
          state.showSettings = false;
          state.activeNote = null;
          await saveConfigRemote();
          await refreshVaultTree(false);
          showToast(`已挂载目录: ${label}`);
        }
      },
      'toggle-pin': async () => {
        if (!state.activeNote) return;
        const cur = new Set(state.config.pinnedNotes || []);
        if (cur.has(state.activeNote.relPath)) cur.delete(state.activeNote.relPath);
        else cur.add(state.activeNote.relPath);
        state.config.pinnedNotes = Array.from(cur);
        await saveConfigRemote();
        renderAll();
      },
      'insert-note': () => {
        if (!state.activeNote) return;
        const mode = state.config.prefs?.insertMode || 'body';
        const txt = formatNoteForComposer(
          { relPath: state.activeNote.relPath, title: state.activeNote.meta?.title },
          state.draftContent,
          mode,
          state.activeNote.fullPath
        );
        if (insertTextIntoComposer(txt)) showToast('已插入笔记到对话输入框');
      },
      'rename-note': () => {
        if (!state.activeNote) return;
        state.showNewModal = true;
        state.modalMode = 'rename';
        state.modalPath = state.activeNote.relPath;
        renderAll();
      },
      'reveal-note': async () => {
        const vault = getActiveVault();
        if (!vault) return;
        await callBridge('/kb/open-external', {
          rootPath: vault.path,
          relPath: state.activeNote ? state.activeNote.relPath : '',
        });
      },
      'delete-note': async () => {
        const vault = getActiveVault();
        if (!vault || !state.activeNote) return;
        const rel = state.activeNote.relPath;
        const res = await callBridge('/kb/delete', { rootPath: vault.path, relPath: rel });
        if (res && res.ok) {
          state.activeNote = null;
          state.draftContent = '';
          state.dirty = false;
          await refreshVaultTree(false);
          showToast(`已移入 .trash: ${rel}`);
        }
      },
    };

    drawerEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fn = actions[btn.getAttribute('data-act')];
        if (fn) void fn();
      });
    });
  }

  function bindPreviewEvents(preview) {
    if (!preview) return;
    // 点击任务复选框直接写回 .md
    preview.querySelectorAll('.kb-task-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const lineIdx = Number(cb.getAttribute('data-line-index'));
        state.draftContent = toggleCheckboxAtLine(state.draftContent, lineIdx);
        state.dirty = true;
        void persistCurrentDraft();
      });
    });
    // 点击 [[双向链接]] 跳转到目标笔记（不存在时快速创建）
    preview.querySelectorAll('.kb-wikilink').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const tgt = a.getAttribute('data-wikilink') || '';
        const tgtLow = tgt.toLowerCase();
        const hit = state.notes.find(
          (n) =>
            baseStem(n.relPath).toLowerCase() === tgtLow ||
            (n.title || '').toLowerCase() === tgtLow ||
            stripExtension(n.relPath).toLowerCase() === tgtLow
        );
        if (hit) {
          void openNoteByRelPath(hit.relPath);
        } else {
          openNewModal(tgt);
        }
      });
    });
    // 点击内联 #标签 过滤
    preview.querySelectorAll('.kb-inline-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedTag = btn.getAttribute('data-tag') || '';
        renderAll();
      });
    });
    // 代码块复制 / 插入对话
    preview.querySelectorAll('[data-copy-code]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const codeEl = btn.closest('.kb-code-wrap')?.querySelector('pre code');
        if (codeEl && navigator.clipboard) {
          await navigator.clipboard.writeText(codeEl.textContent || '');
          showToast('代码已复制');
        }
      });
    });
    preview.querySelectorAll('[data-insert-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wrap = btn.closest('.kb-code-wrap');
        const lang = wrap?.querySelector('.kb-code-lang')?.textContent || '';
        const code = wrap?.querySelector('pre code')?.textContent || '';
        if (insertTextIntoComposer(`\`\`\`${lang === 'text' ? '' : lang}\n${code}\n\`\`\``)) {
          showToast('已插入到对话输入框');
        }
      });
    });
  }

  // ==================== 全局事件挂载 & 启动 ====================

  function installGlobalListeners() {
    window.addEventListener(
      'keydown',
      (e) => {
        // Alt+K 开关知识库面板
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          if (state.config.prefs?.open) {
            if (locateNativeAuxTabStrip().found) switchAwayFromKb();
            else closeKbTab();
          } else {
            openKbInPane(true);
          }
          return;
        }

        // Esc 关闭模态框或 [[ 浮层
        if (e.key === 'Escape') {
          if (state.popup.visible) {
            e.preventDefault();
            state.popup.visible = false;
            renderPopupOnly();
            return;
          }
          if (state.showNewModal || state.showSettings) {
            e.preventDefault();
            state.showNewModal = false;
            state.showSettings = false;
            renderAll();
            return;
          }
        }

        // [[ 浮层键盘导航
        if (state.popup.visible && state.popup.items.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            state.popup.selectedIndex = (state.popup.selectedIndex + 1) % state.popup.items.length;
            renderPopupOnly();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            state.popup.selectedIndex =
              (state.popup.selectedIndex - 1 + state.popup.items.length) % state.popup.items.length;
            renderPopupOnly();
          } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            void confirmPopupSelection(state.popup.selectedIndex);
          }
        }
      },
      true
    );

    document.addEventListener('compositionstart', () => {
      isComposing = true;
    }, true);
    document.addEventListener('compositionend', (e) => {
      isComposing = false;
      updatePopupFromComposer(e.target);
    }, true);
    document.addEventListener('input', (e) => {
      const composer = findChatComposer();
      if (composer && (e.target === composer || composer.contains(e.target))) {
        updatePopupFromComposer(composer);
      }
    }, true);
    document.addEventListener('mouseup', handleSelectionCaptureCheck, true);
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey) handleSelectionCaptureCheck();
    }, true);

    // 与 context-doctor 等同侧边栏插件互斥协同
    window.addEventListener('agy-aux-plugin-activated', (ev) => {
      const activeId = ev && ev.detail ? ev.detail.id : '';
      if (activeId && activeId !== 'antigravity-kb') {
        switchAwayFromKb();
      }
    });

    document.addEventListener(
      'click',
      (e) => {
        if (!state.config.prefs?.open || !e.target) return;
        const t = e.target;
        if (!isOutsidePluginHosts(t)) return;
        if (t.closest && t.closest('[data-agy-kb-tab="1"], [data-agy-kb-menu-item="1"]')) return;

        const strip = locateNativeAuxTabStrip();
        if (strip.found && strip.stripEl && strip.stripEl.contains(t)) {
          const stripBtn = t.closest('button, [role="tab"], [role="button"], a');
          if (stripBtn && strip.stripEl.contains(stripBtn)) {
            switchAwayFromKb();
          }
          return;
        }
        const btn = t.closest('button, [role="tab"], [role="menuitem"], [role="button"]');
        if (!btn) return;
        const txt = (btn.textContent || '').trim();
        if (
          txt === '+' ||
          btn.getAttribute('role') === 'tab' ||
          /^(审查确认|Review Changes?|Open File|终端|Terminal|浏览器|Browser|Side Question|Swarm)$/i.test(txt)
        ) {
          switchAwayFromKb();
        }
      },
      true
    );

    if (typeof MutationObserver === 'function' && document.body) {
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.target && !isOutsidePluginHosts(m.target)) continue;
          scheduleAuxSync();
          break;
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('resize', scheduleAuxSync);
  }

  function boot() {
    ensureShadowHost();
    installGlobalListeners();
    void initKbState();
    scheduleAuxSync();
    setTimeout(scheduleAuxSync, 400);
    setTimeout(scheduleAuxSync, 1600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
