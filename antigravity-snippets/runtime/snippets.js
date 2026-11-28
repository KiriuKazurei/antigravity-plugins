/**
 * Antigravity Prompt 模板库 (antigravity-snippets) 运行时
 * 纯浏览器 DOM 环境执行（Shadow DOM 隔离），无任何 Node.js 内置模块依赖。
 *
 * 核心特性：
 * - 在对话输入框中输入 `#` 触发实时检索，优先匹配 title / alias，其次标签与 Prompt 正文
 * - `↑` / `↓` 切换，`Tab` 快捷插入（不误触发送），`Esc` 关闭
 * - 支持 `{{变量}}`、`{{变量:默认值}}`、`{{$cursor}}` 光标锚点及 `{{date}}` / `{{clipboard}}` / `{{selection}}` 自动变量
 * - 支持模板管理面板（`Alt+P`）、一键收藏当前输入、JSON 导入导出与深浅色/中英文自适应
 */
(function () {
  'use strict';

  const meta = window.__AGY_PLUGIN_META__ || {};
  try {
    delete window.__AGY_PLUGIN_META__;
  } catch (_) {}

  const STORE_KEY = 'agy_snippets_store_v1';
  const HOST_ID = 'agy-snippets-host';
  const MAX_QUERY_LEN = 48;
  const MAX_POPUP_ITEMS = 12;

  // ==================== 默认预置模板 ====================

  const DEFAULT_SNIPPETS = [
    {
      id: 'builtin-cr',
      title: '代码审查 (Code Review)',
      alias: 'cr',
      category: '研发工程',
      tags: ['review', '质量', 'diff'],
      content:
        '请对当前改动进行严格的代码审查（Code Review），重点关注：\n' +
        '1. **正确性与边界条件**：空值、异常路径、状态不一致、并发竞态。\n' +
        '2. **复杂度与可维护性**：是否存在重复逻辑、过深嵌套或职责过重。\n' +
        '3. **最小安全修复**：直接指出具体文件与行号并给出修改建议，避免无意义的风格挑刺。\n\n' +
        '重点关注：全部',
      pinned: true,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000008000,
    },
    {
      id: 'builtin-ask',
      title: '先对齐方案再动手',
      alias: 'ask',
      category: '架构设计',
      tags: ['plan', '方案', '对比'],
      content:
        '先不要直接修改代码。请基于当前上下文给出 2 套可行实现方案，并简明对比：\n' +
        '- 改动范围与影响面\n' +
        '- 潜在风险与边界情况\n' +
        '- 你的推荐选择及理由\n\n' +
        '待我确认后再开始实施。需求补充：{{$cursor}}',
      pinned: true,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000007000,
    },
    {
      id: 'builtin-bug',
      title: 'Bug 根因排查',
      alias: 'bug',
      category: '调试排错',
      tags: ['debug', '报错', '排查'],
      content:
        '请协助定位以下问题的根本原因（不要只做表面规避）：\n' +
        '- **现象 / 报错**：{{$cursor}}\n' +
        '- **预期行为**：\n\n' +
        '请按以下顺序输出：\n' +
        '1. 根因定位（指出具体触发链路与代码位置）\n' +
        '2. 最小修复方案及原因说明\n' +
        '3. 如何验证修复有效（含需要补充的回归测试）',
      pinned: true,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000006000,
    },
    {
      id: 'builtin-ut',
      title: '单元测试生成',
      alias: 'ut',
      category: '研发工程',
      tags: ['test', '测试', '覆盖率'],
      content:
        '请为以下目标编写高信号单元测试：\n' +
        '{{$cursor}}\n\n' +
        '要求：\n' +
        '- 自动匹配项目现有测试框架\n' +
        '- 覆盖正常路径、关键边界条件与异常分支\n' +
        '- 仅做必要的最小 Mock，避免为测而测的脆弱断言\n' +
        '- 完成后运行测试并汇报真实结果',
      pinned: false,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000005000,
    },
    {
      id: 'builtin-refactor',
      title: '安全重构计划',
      alias: 'rf',
      category: '研发工程',
      tags: ['refactor', '解耦', '清晰度'],
      content:
        '请对以下模块制定安全重构计划（保持外部行为 100% 等价）：\n' +
        '{{$cursor}}\n\n' +
        '要求：\n' +
        '1. 先指出当前最影响可读性或扩展性的 2~3 个坏味道\n' +
        '2. 拆分为小步可验证的重构步骤\n' +
        '3. 保留无关注释与对外接口兼容性',
      pinned: false,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000004000,
    },
    {
      id: 'builtin-explain',
      title: '模块架构与调用链速览',
      alias: 'exp',
      category: '架构设计',
      tags: ['架构', '阅读', '调用链'],
      content:
        '请帮我快速梳理目标模块的核心架构：\n' +
        '1. 核心职责与入口位置\n' +
        '2. 关键数据流 / 调用链路（简明步骤）\n' +
        '3. 状态管理与容易踩坑的隐含约定\n\n' +
        '目标模块：{{$cursor}}',
      pinned: false,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000003000,
    },
    {
      id: 'builtin-commit',
      title: 'Git Commit 规范总结',
      alias: 'gcm',
      category: '日常效率',
      tags: ['git', 'commit', '总结'],
      content:
        '请检查当前 Git 工作区改动（`git status` / `git diff`），总结改动要点并给出 1 条符合 Conventional Commits 规范的 Commit Message（含简短标题与分点正文）。',
      pinned: false,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000002000,
    },
    {
      id: 'builtin-perf',
      title: '性能瓶颈与复杂度分析',
      alias: 'perf',
      category: '调试排错',
      tags: ['性能', '复杂度', '优化'],
      content:
        '请分析以下实现的时间/空间复杂度与潜在性能瓶颈（I/O、渲染、内存分配、锁竞争等），并给出量化收益明显的优化建议：\n{{$cursor}}',
      pinned: false,
      useCount: 0,
      builtin: true,
      updatedAt: 1700000001000,
    },
  ];

  const DEFAULT_PREFS = {
    showFloatingBtn: true,
    enterConfirms: false,
  };

  // ==================== 纯函数：触发提取 / 优先级匹配 / 变量渲染 ====================

  /**
   * 从光标前文本提取 `#` 触发片段。
   * 仅检查当前行最后一个 `#`，规避 `##`、`# 标题`、URL `#hash`、字母数字粘连 `C#`/`PR#12`。
   */
  function extractHashTrigger(textBeforeCaret) {
    if (typeof textBeforeCaret !== 'string' || !textBeforeCaret) {
      return null;
    }
    const lastNl = textBeforeCaret.lastIndexOf('\n');
    const lineStart = lastNl + 1;
    const lineBefore = textBeforeCaret.slice(lineStart);
    const hashPos = lineBefore.lastIndexOf('#');
    if (hashPos === -1) {
      return null;
    }

    const prevChar = hashPos > 0 ? lineBefore[hashPos - 1] : '';
    if (prevChar && /[a-zA-Z0-9_/:.#]/.test(prevChar)) {
      return null;
    }

    const query = lineBefore.slice(hashPos + 1);
    if (query.length > 0 && /^\s/.test(query)) {
      return null;
    }
    if (query.length > MAX_QUERY_LEN) {
      return null;
    }

    return {
      query,
      hashStart: lineStart + hashPos,
      caretOffset: textBeforeCaret.length,
    };
  }

  /**
   * 在 target 中按顺序查找 query 字符，返回命中下标数组或 null。
   */
  function findSubsequenceIndices(query, target) {
    if (!query || !target || query.length > target.length) {
      return null;
    }
    const indices = [];
    let qi = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) {
        indices.push(ti);
        qi++;
      }
    }
    return qi === query.length ? indices : null;
  }

  /**
   * 围绕关键词提取正文预览片段。
   */
  function buildBodyExcerpt(content, query) {
    const clean = String(content || '').replace(/\s+/g, ' ').trim();
    if (!clean) {
      return '';
    }
    if (!query) {
      return clean.length > 72 ? clean.slice(0, 72) + '…' : clean;
    }
    const lower = clean.toLowerCase();
    const q = query.toLowerCase().trim();
    let idx = lower.indexOf(q);
    if (idx === -1) {
      const tokens = q.split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        const ti = lower.indexOf(t);
        if (ti !== -1) {
          idx = ti;
          break;
        }
      }
    }
    if (idx === -1) {
      return clean.length > 72 ? clean.slice(0, 72) + '…' : clean;
    }
    const start = Math.max(0, idx - 18);
    const end = Math.min(clean.length, start + 72);
    return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
  }

  /**
   * 匹配与排序：严格优先 title（及 alias 缩写），其次标签/分类，最后 Prompt 正文。
   */
  function matchSnippets(snippets, query) {
    const list = Array.isArray(snippets) ? snippets : [];
    const rawQ = typeof query === 'string' ? query : '';
    const q = rawQ.trim().toLowerCase();

    if (!q) {
      return list
        .map((snippet) => ({
          snippet,
          score: (snippet.pinned ? 1000 : 0) + Math.min(snippet.useCount || 0, 500),
          matchType: 'all',
          titleRanges: [],
          bodyExcerpt: buildBodyExcerpt(snippet.content, ''),
        }))
        .sort((a, b) => {
          if (Boolean(b.snippet.pinned) !== Boolean(a.snippet.pinned)) {
            return b.snippet.pinned ? 1 : -1;
          }
          const useDiff = (b.snippet.useCount || 0) - (a.snippet.useCount || 0);
          if (useDiff !== 0) {
            return useDiff;
          }
          return (b.snippet.updatedAt || 0) - (a.snippet.updatedAt || 0);
        });
    }

    const tokens = q.split(/\s+/).filter(Boolean);
    const matched = [];

    for (const snippet of list) {
      if (!snippet || typeof snippet !== 'object') {
        continue;
      }
      const title = String(snippet.title || '');
      const titleLower = title.toLowerCase();
      const aliasLower = String(snippet.alias || '').trim().toLowerCase();
      const tagsLower = Array.isArray(snippet.tags)
        ? snippet.tags.join(' ').toLowerCase()
        : '';
      const catLower = String(snippet.category || '').toLowerCase();
      const metaLower = `${tagsLower} ${catLower}`.trim();
      const content = String(snippet.content || '');
      const bodyLower = content.toLowerCase();

      let baseScore = 0;
      let matchType = '';
      let titleRanges = [];

      if (titleLower === q) {
        baseScore = 1000;
        matchType = 'title-exact';
        titleRanges = [[0, title.length]];
      } else if (aliasLower && aliasLower === q) {
        baseScore = 960;
        matchType = 'alias-exact';
      } else if (titleLower.startsWith(q)) {
        baseScore = 860;
        matchType = 'title-prefix';
        titleRanges = [[0, q.length]];
      } else if (aliasLower && aliasLower.startsWith(q)) {
        baseScore = 820;
        matchType = 'alias-prefix';
      } else {
        const titleIdx = titleLower.indexOf(q);
        if (titleIdx !== -1) {
          baseScore = 700 - Math.min(titleIdx, 50);
          matchType = 'title-contains';
          titleRanges = [[titleIdx, titleIdx + q.length]];
        } else if (tokens.length > 1 && tokens.every((t) => titleLower.includes(t))) {
          baseScore = 620;
          matchType = 'title-tokens';
          for (const t of tokens) {
            const ti = titleLower.indexOf(t);
            if (ti !== -1) {
              titleRanges.push([ti, ti + t.length]);
            }
          }
        } else {
          const subIdx =
            q.length >= 2 && !/\s/.test(q) ? findSubsequenceIndices(q, titleLower) : null;
          if (subIdx) {
            const spread = subIdx[subIdx.length - 1] - subIdx[0];
            baseScore = 480 - Math.min(spread * 2, 100);
            matchType = 'title-fuzzy';
            titleRanges = subIdx.map((i) => [i, i + 1]);
          } else if (
            metaLower &&
            (metaLower.includes(q) ||
              (tokens.length > 1 && tokens.every((t) => metaLower.includes(t))))
          ) {
            baseScore = 360;
            matchType = 'tag';
          } else {
            const bodyIdx = bodyLower.indexOf(q);
            if (bodyIdx !== -1) {
              baseScore = 220 - Math.min(bodyIdx * 0.15, 60);
              matchType = 'body';
            } else if (tokens.length > 1 && tokens.every((t) => bodyLower.includes(t))) {
              baseScore = 180;
              matchType = 'body';
            }
          }
        }
      }

      if (baseScore <= 0) {
        continue;
      }

      const bonus =
        (snippet.pinned ? 25 : 0) + Math.min(Number(snippet.useCount) || 0, 20) * 0.5;
      matched.push({
        snippet,
        score: baseScore + bonus,
        matchType,
        titleRanges,
        bodyExcerpt: buildBodyExcerpt(content, matchType === 'body' ? rawQ : ''),
      });
    }

    matched.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.snippet.updatedAt || 0) - (a.snippet.updatedAt || 0);
    });

    return matched;
  }

  const AUTO_VAR_NAMES = new Set([
    'date',
    'time',
    'datetime',
    'clipboard',
    'selection',
    'workspace',
  ]);

  /**
   * 提取模板中的自定义交互变量（排除 `$cursor` 与内置自动变量）。
   */
  function parseTemplateVariables(content) {
    const text = String(content || '');
    const re = /\{\{\s*([^}]+?)\s*\}\}/g;
    const seen = new Map();
    const vars = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[1].trim();
      if (!inner || inner === '$cursor') {
        continue;
      }
      const colonIdx = inner.indexOf(':');
      const name = (colonIdx === -1 ? inner : inner.slice(0, colonIdx)).trim();
      const defaultVal = colonIdx === -1 ? '' : inner.slice(colonIdx + 1).trim();
      if (!name || name === '$cursor') {
        continue;
      }
      if (AUTO_VAR_NAMES.has(name.toLowerCase()) && colonIdx === -1) {
        continue;
      }
      if (!seen.has(name)) {
        const item = { name, defaultValue: defaultVal };
        seen.set(name, item);
        vars.push(item);
      } else if (defaultVal && !seen.get(name).defaultValue) {
        seen.get(name).defaultValue = defaultVal;
      }
    }
    return vars;
  }

  function templateNeedsClipboard(content) {
    return /\{\{\s*clipboard\s*\}\}/i.test(String(content || ''));
  }

  /**
   * 渲染模板并解析 `{{$cursor}}` 光标落点。
   */
  function renderTemplate(content, customValues = {}, autoVars = {}) {
    const raw = String(content || '');
    const substituted = raw.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full, inner) => {
      const trimmed = inner.trim();
      if (trimmed === '$cursor') {
        return '{{$cursor}}';
      }
      const colonIdx = trimmed.indexOf(':');
      const name = (colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx)).trim();
      const defaultVal = colonIdx === -1 ? '' : trimmed.slice(colonIdx + 1).trim();
      if (!name) {
        return full;
      }
      const lower = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(customValues, name)) {
        const v = customValues[name];
        return v !== undefined && v !== null && String(v) !== '' ? String(v) : defaultVal;
      }
      if (colonIdx === -1 && AUTO_VAR_NAMES.has(lower)) {
        const av = autoVars[lower];
        return av !== undefined && av !== null ? String(av) : '';
      }
      return defaultVal;
    });

    const cursorMarker = '{{$cursor}}';
    const firstCursorIdx = substituted.indexOf(cursorMarker);
    const finalText = substituted.split(cursorMarker).join('');
    const cursorOffset = firstCursorIdx !== -1 ? firstCursorIdx : finalText.length;

    return {
      text: finalText,
      cursorOffset,
    };
  }

  function mergeImportedSnippets(existingList, incomingList, mode = 'merge') {
    const normalize = (s, idx) => {
      if (!s || typeof s !== 'object') {
        return null;
      }
      const title = String(s.title || '').trim();
      const content = String(s.content || '');
      if (!title || !content.trim()) {
        return null;
      }
      return {
        id:
          typeof s.id === 'string' && s.id.trim()
            ? s.id.trim()
            : `custom-${Date.now()}-${idx}`,
        title,
        alias: typeof s.alias === 'string' ? s.alias.trim().slice(0, 24) : '',
        category:
          typeof s.category === 'string' && s.category.trim()
            ? s.category.trim()
            : '自定义',
        tags: Array.isArray(s.tags)
          ? s.tags.map((t) => String(t).trim()).filter(Boolean)
          : [],
        content,
        pinned: Boolean(s.pinned),
        useCount: Math.max(0, Number(s.useCount) || 0),
        builtin: Boolean(s.builtin),
        updatedAt: Number(s.updatedAt) || Date.now(),
      };
    };

    const incoming = (Array.isArray(incomingList) ? incomingList : [])
      .map(normalize)
      .filter(Boolean);

    if (mode === 'replace') {
      return incoming;
    }

    const base = Array.isArray(existingList) ? existingList.map((s) => ({ ...s })) : [];
    const byId = new Map(base.map((s, i) => [s.id, i]));
    const byTitle = new Map(base.map((s, i) => [s.title.toLowerCase(), i]));

    for (const item of incoming) {
      if (byId.has(item.id)) {
        const idx = byId.get(item.id);
        base[idx] = { ...base[idx], ...item };
      } else if (byTitle.has(item.title.toLowerCase())) {
        const idx = byTitle.get(item.title.toLowerCase());
        base[idx] = { ...base[idx], ...item, id: base[idx].id };
      } else {
        byId.set(item.id, base.length);
        byTitle.set(item.title.toLowerCase(), base.length);
        base.push(item);
      }
    }
    return base;
  }

  // 导出纯函数供单元测试（无 require 依赖）
  window.__AGY_SNIPPETS_TEST_API__ = {
    DEFAULT_SNIPPETS,
    extractHashTrigger,
    matchSnippets,
    parseTemplateVariables,
    renderTemplate,
    mergeImportedSnippets,
  };

  // ==================== 环境检查（仅在完整 DOM 中初始化 UI） ====================

  if (typeof document === 'undefined' || !document.body || !document.createElement) {
    return;
  }
  if (window.__AGY_SNIPPETS_ACTIVE__) {
    return;
  }
  window.__AGY_SNIPPETS_ACTIVE__ = true;

  // ==================== 持久化存储 ====================

  function loadStore() {
    let rawObj = null;
    try {
      const raw = window.localStorage ? window.localStorage.getItem(STORE_KEY) : null;
      if (raw) {
        rawObj = JSON.parse(raw);
      }
    } catch (_) {}

    const deletedBuiltinIds = Array.isArray(rawObj?.deletedBuiltinIds)
      ? rawObj.deletedBuiltinIds.filter((x) => typeof x === 'string')
      : [];
    const deletedSet = new Set(deletedBuiltinIds);

    const savedSnippets = Array.isArray(rawObj?.snippets) ? rawObj.snippets : null;
    let snippets;
    if (savedSnippets && savedSnippets.length > 0) {
      const byId = new Map();
      snippets = savedSnippets
        .filter((s) => s && typeof s.title === 'string' && typeof s.content === 'string')
        .map((s) => {
          byId.set(s.id, true);
          return { ...s };
        });
      // 合并后续新增的内置模板（不复活用户主动删除过的）
      for (const b of DEFAULT_SNIPPETS) {
        if (!byId.has(b.id) && !deletedSet.has(b.id)) {
          snippets.push({ ...b });
        }
      }
    } else {
      snippets = DEFAULT_SNIPPETS.filter((b) => !deletedSet.has(b.id)).map((b) => ({
        ...b,
      }));
    }

    const prefs = {
      showFloatingBtn:
        typeof rawObj?.prefs?.showFloatingBtn === 'boolean'
          ? rawObj.prefs.showFloatingBtn
          : DEFAULT_PREFS.showFloatingBtn,
      enterConfirms:
        typeof rawObj?.prefs?.enterConfirms === 'boolean'
          ? rawObj.prefs.enterConfirms
          : DEFAULT_PREFS.enterConfirms,
    };

    return {
      version: 1,
      snippets,
      deletedBuiltinIds,
      prefs,
    };
  }

  function saveStore(store) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            version: 1,
            snippets: store.snippets,
            deletedBuiltinIds: store.deletedBuiltinIds,
            prefs: store.prefs,
          })
        );
      }
    } catch (_) {}
  }

  // ==================== 状态管理 ====================

  const store = loadStore();

  const state = {
    isDark: true,
    isZh: true,
    composing: false,
    insertInFlight: false,
    lastSelectionText: '',
    lastEditableEl: null,
    lastCaretSnapshot: null,
    popup: {
      open: false,
      query: '',
      hashStart: 0,
      caretOffset: 0,
      targetEl: null,
      results: [],
      selectedIndex: 0,
      dismissedKey: '',
      rect: { left: 24, top: 24, bottom: 48 },
    },
    manager: {
      open: false,
      search: '',
      category: '全部',
      selectedId: store.snippets[0]?.id || '',
      editingId: null, // null = 查看, '__new__' = 新建, 或具体 id
      draft: null,
      showSettings: false,
      importText: '',
      toast: '',
      toastTimer: null,
    },
  };

  // ==================== 宿主探测 & 编辑器操作 ====================

  function detectThemeIsDark() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) {
        const lum =
          (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
        return lum < 0.5;
      }
    } catch (_) {}
    return true;
  }

  function detectIsZh() {
    if (window.__AGY_I18N_ACTIVE__) {
      return true;
    }
    try {
      if (document.documentElement && /^zh/i.test(document.documentElement.lang || '')) {
        return true;
      }
    } catch (_) {}
    return true;
  }

  function getDeepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function isInsidePluginHost(node) {
    if (!node) {
      return false;
    }
    const host = document.getElementById(HOST_ID);
    if (!host) {
      return false;
    }
    if (node === host) {
      return true;
    }
    try {
      const root = node.getRootNode && node.getRootNode();
      if (root && root.host === host) {
        return true;
      }
      return host.contains(node);
    } catch (_) {
      return false;
    }
  }

  function isSupportedEditable(el) {
    if (!el || el.nodeType !== 1 || isInsidePluginHost(el)) {
      return false;
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') {
      return !el.disabled && !el.readOnly;
    }
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t !== 'text' && t !== 'search') {
        return false;
      }
      return !el.disabled && !el.readOnly;
    }
    if (el.isContentEditable) {
      return true;
    }
    return false;
  }

  function findEditableFromTarget(target) {
    let cur = target;
    while (cur && cur !== document && cur !== window) {
      if (isSupportedEditable(cur)) {
        if (cur.isContentEditable) {
          let host = cur;
          while (
            host.parentNode &&
            host.parentNode.nodeType === 1 &&
            host.parentNode.isContentEditable
          ) {
            host = host.parentNode;
          }
          return host;
        }
        return cur;
      }
      cur = cur.parentNode || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    const active = getDeepActiveElement();
    return isSupportedEditable(active) ? active : null;
  }

  function getRootSelection(el) {
    try {
      const root = el && el.getRootNode ? el.getRootNode() : null;
      if (root && typeof root.getSelection === 'function') {
        const s = root.getSelection();
        if (s) return s;
      }
    } catch (_) {}
    try {
      return window.getSelection ? window.getSelection() : null;
    } catch (_) {
      return null;
    }
  }

  function isSkippedEditableSubtree(root, node) {
    if (!node || node === root || node.nodeType !== 1) {
      return false;
    }
    try {
      const ce = node.getAttribute && node.getAttribute('contenteditable');
      if (ce === 'false') return true;
      const ariaHidden = node.getAttribute && node.getAttribute('aria-hidden');
      if (ariaHidden === 'true') return true;
    } catch (_) {}
    return false;
  }

  function getContentEditableTextBeforeCaret(el) {
    try {
      const sel = getRootSelection(el);
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
        return null;
      }
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) {
        return null;
      }
      return walkContentEditableText(el, range.startContainer, range.startOffset);
    } catch (_) {
      return null;
    }
  }

  function walkContentEditableText(root, stopNode, stopOffset) {
    let out = '';
    let stopped = false;

    function visit(node) {
      if (stopped || !node || isSkippedEditableSubtree(root, node)) {
        return;
      }
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
        const isBlock =
          tag === 'div' || tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre';
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
      if (found || !node || isSkippedEditableSubtree(root, node)) {
        return;
      }
      if (node.nodeType === 3) {
        const val = node.nodeValue || '';
        const len = val.length;
        if (acc + len >= targetCharOffset) {
          found = { node, offset: Math.max(0, targetCharOffset - acc) };
          return;
        }
        acc += len;
        if (len > 0) {
          lastWasNewline = val.endsWith('\n');
        }
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
        const isBlock =
          tag === 'div' || tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre';
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
    if (found) {
      return found;
    }
    return { node: root, offset: root.childNodes ? root.childNodes.length : 0 };
  }

  function findTokenRangeInContentEditable(root, token) {
    if (!root || !token) {
      return null;
    }
    const textNodes = [];
    let full = '';
    function collect(node) {
      if (!node || isSkippedEditableSubtree(root, node)) return;
      if (node.nodeType === 3) {
        const val = node.nodeValue || '';
        if (val.length > 0) {
          textNodes.push({ node, start: full.length, end: full.length + val.length });
          full += val;
        }
        return;
      }
      if (node.nodeType === 1) {
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          full += '\n';
          return;
        }
        const isBlock =
          tag === 'div' || tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'pre';
        if (isBlock && full.length > 0 && !full.endsWith('\n')) {
          full += '\n';
        }
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) {
          collect(children[i]);
        }
      }
    }
    collect(root);

    const idx = full.lastIndexOf(token);
    if (idx === -1) {
      return null;
    }
    const endIdx = idx + token.length;
    let startPt = null;
    let endPt = null;
    for (const seg of textNodes) {
      if (!startPt && idx >= seg.start && idx <= seg.end) {
        startPt = { node: seg.node, offset: idx - seg.start };
      }
      if (!endPt && endIdx >= seg.start && endIdx <= seg.end) {
        endPt = { node: seg.node, offset: endIdx - seg.start };
      }
    }
    if (!startPt || !endPt) {
      return null;
    }
    try {
      const r = document.createRange();
      r.setStart(startPt.node, startPt.offset);
      r.setEnd(endPt.node, endPt.offset);
      return r;
    } catch (_) {
      return null;
    }
  }

  function getTextBeforeCaret(el) {
    if (!el) {
      return null;
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      if (typeof el.selectionStart !== 'number' || el.selectionStart !== el.selectionEnd) {
        return null;
      }
      return {
        textBefore: el.value.slice(0, el.selectionStart),
        caretOffset: el.selectionStart,
      };
    }
    if (el.isContentEditable) {
      const textBefore = getContentEditableTextBeforeCaret(el);
      if (textBefore === null) {
        return null;
      }
      return {
        textBefore,
        caretOffset: textBefore.length,
      };
    }
    return null;
  }

  function getTextareaCaretRect(el, offset) {
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const mirror = document.createElement('div');
      const props = [
        'boxSizing',
        'width',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'letterSpacing',
        'textTransform',
        'wordSpacing',
        'textIndent',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'borderTopWidth',
        'borderRightWidth',
        'borderBottomWidth',
        'borderLeftWidth',
        'lineHeight',
      ];
      mirror.style.position = 'fixed';
      mirror.style.visibility = 'hidden';
      mirror.style.pointerEvents = 'none';
      mirror.style.whiteSpace = el.tagName.toLowerCase() === 'input' ? 'pre' : 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.overflow = 'hidden';
      mirror.style.left = rect.left + 'px';
      mirror.style.top = rect.top + 'px';
      for (const p of props) {
        mirror.style[p] = style[p];
      }

      const before = el.value.slice(0, offset);
      mirror.textContent = before;
      const span = document.createElement('span');
      span.textContent = el.value.slice(offset, offset + 1) || '\u200b';
      mirror.appendChild(span);
      document.body.appendChild(mirror);

      const sRect = span.getBoundingClientRect();
      const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 20;
      const left = Math.max(rect.left, Math.min(rect.right - 20, sRect.left - el.scrollLeft));
      const top = Math.max(rect.top, Math.min(rect.bottom - lineH, sRect.top - el.scrollTop));
      document.body.removeChild(mirror);
      return { left, top, bottom: top + lineH };
    } catch (_) {
      const r = el.getBoundingClientRect();
      return { left: r.left + 12, top: r.top + 8, bottom: r.top + 28 };
    }
  }

  function getCaretScreenRect(el, hashOffset) {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      return getTextareaCaretRect(el, hashOffset);
    }
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0).cloneRange();
        const rects = range.getClientRects();
        if (rects && rects.length > 0) {
          const r = rects[0];
          if (r.width || r.height) {
            return { left: r.left, top: r.top, bottom: r.bottom };
          }
        }
        const br = range.getBoundingClientRect();
        if (br && (br.left || br.top || br.bottom)) {
          return { left: br.left, top: br.top, bottom: br.bottom || br.top + 20 };
        }
      }
    } catch (_) {}
    const r = el.getBoundingClientRect();
    return { left: r.left + 14, top: r.top + 10, bottom: r.top + 30 };
  }

  function setNativeInputValue(el, value) {
    const tag = (el.tagName || '').toLowerCase();
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchPasteEvent(el, insertText) {
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
      return {
        dispatched: true,
        defaultPrevented: !notCancelled || Boolean(pasteEv.defaultPrevented),
      };
    } catch (_) {
      return { dispatched: false, defaultPrevented: false };
    }
  }

  function applyDomRangeFallback(el, sel, range, insertText) {
    sel.removeAllRanges();
    sel.addRange(range);
    let beforeInputCancelled = false;
    try {
      const bi = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: insertText,
      });
      beforeInputCancelled = !el.dispatchEvent(bi);
    } catch (_) {}

    const prevText = readEditableFullText(el);
    if (!beforeInputCancelled || readEditableFullText(el) === prevText) {
      range.deleteContents();
      const frag = document.createDocumentFragment();
      const lines = insertText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) frag.appendChild(document.createElement('br'));
        frag.appendChild(document.createTextNode(lines[i]));
      }
      range.insertNode(frag);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: insertText,
        })
      );
    }
  }

  function replaceTextInEditable(el, hashStart, caretOffset, insertText, cursorOffset, expectedToken = '') {
    if (!el) {
      return false;
    }
    const finalCursorOffset =
      typeof cursorOffset === 'number' ? cursorOffset : insertText.length;
    const hasCustomCursor = finalCursorOffset < insertText.length;
    const tag = (el.tagName || '').toLowerCase();

    if (tag === 'textarea' || tag === 'input') {
      const prevVal = el.value;
      let safeStart = Math.max(0, Math.min(hashStart, prevVal.length));
      let safeEnd = Math.max(safeStart, Math.min(caretOffset, prevVal.length));
      if (expectedToken && prevVal.slice(safeStart, safeEnd) !== expectedToken) {
        const fallbackIdx = prevVal.lastIndexOf(expectedToken, safeEnd);
        if (fallbackIdx !== -1) {
          safeStart = fallbackIdx;
          safeEnd = fallbackIdx + expectedToken.length;
        }
      }
      const expected = prevVal.slice(0, safeStart) + insertText + prevVal.slice(safeEnd);

      el.focus();
      el.setSelectionRange(safeStart, safeEnd);

      let appliedByExec = false;
      try {
        appliedByExec = document.execCommand('insertText', false, insertText);
      } catch (_) {}

      if (!appliedByExec || el.value !== expected) {
        const isMonacoInput =
          el.classList &&
          typeof el.classList.contains === 'function' &&
          el.classList.contains('inputarea');
        if (isMonacoInput) {
          const pasted = dispatchPasteEvent(el, insertText);
          if (!pasted.defaultPrevented && el.value !== expected) {
            setNativeInputValue(el, expected);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          setNativeInputValue(el, expected);
          try {
            el.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                cancelable: false,
                inputType: 'insertText',
                data: insertText,
              })
            );
          } catch (_) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const nextCaret = safeStart + finalCursorOffset;
      try {
        el.setSelectionRange(nextCaret, nextCaret);
      } catch (_) {}
      window.__AGY_SNIPPETS_LAST_INSERT__ = {
        tag,
        method: appliedByExec ? 'execCommand' : 'nativeSetter',
        ok: true,
      };
      return true;
    }

    if (el.isContentEditable) {
      el.focus();
      const sel = getRootSelection(el);
      if (!sel) {
        return false;
      }

      let range = null;
      try {
        const startPt = resolveContentEditableDomPoint(el, hashStart);
        const endPt = resolveContentEditableDomPoint(el, caretOffset);
        range = document.createRange();
        range.setStart(startPt.node, startPt.offset);
        range.setEnd(endPt.node, endPt.offset);
        if (expectedToken && range.toString() !== expectedToken) {
          const exactRange = findTokenRangeInContentEditable(el, expectedToken);
          if (exactRange) {
            range = exactRange;
          }
        }
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {
        range = expectedToken ? findTokenRangeInContentEditable(el, expectedToken) : null;
        if (!range) return false;
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // 通知 Lexical / ProseMirror / Slate 同步最新的 DOM Selection
      try {
        document.dispatchEvent(new Event('selectionchange'));
      } catch (_) {}

      const beforeText = readEditableFullText(el);
      let usedMethod = '';
      let ok = false;

      // 1. 优先尝试 ClipboardEvent('paste') —— Lexical / ProseMirror / TipTap / Slate 原生多行插入通道
      const pasteRes = dispatchPasteEvent(el, insertText);
      const afterPasteText = readEditableFullText(el);
      if (afterPasteText !== beforeText) {
        usedMethod = 'paste';
        ok = true;
      } else if (pasteRes.defaultPrevented) {
        usedMethod = 'paste';
        ok = true;
        // 某些富文本框架会异步刷新 DOM，30ms 后若仍未变化则自动降级到 execCommand / DOM 兜底
        setTimeout(() => {
          try {
            if (el.isConnected === false || readEditableFullText(el) !== beforeText) {
              return;
            }
            let activeRange = range;
            if (!el.contains(activeRange.startContainer)) {
              const recovered = expectedToken
                ? findTokenRangeInContentEditable(el, expectedToken)
                : null;
              if (!recovered) return;
              activeRange = recovered;
            }
            sel.removeAllRanges();
            sel.addRange(activeRange);
            const execOk = document.execCommand('insertText', false, insertText);
            if (!execOk || readEditableFullText(el) === beforeText) {
              applyDomRangeFallback(el, sel, activeRange, insertText);
            }
          } catch (_) {}
        }, 30);
      }

      // 2. 若宿主未消费 paste，则尝试原生 execCommand('insertText')
      if (!ok) {
        try {
          sel.removeAllRanges();
          sel.addRange(range);
          const execOk = document.execCommand('insertText', false, insertText);
          const afterExecText = readEditableFullText(el);
          if (execOk && afterExecText !== beforeText) {
            usedMethod = 'execCommand';
            ok = true;
          }
        } catch (_) {}
      }

      // 3. 最终兜底：beforeinput + DOM Range 替换 + input
      if (!ok) {
        try {
          applyDomRangeFallback(el, sel, range, insertText);
          usedMethod = 'domFallback';
          ok = true;
        } catch (_) {}
      }

      // 仅当模板显式包含 {{$cursor}} 或使用 DOM 兜底时重新定位光标，避免干扰富文本编辑器 paste 后的自然光标
      if (hasCustomCursor || usedMethod === 'domFallback') {
        const positionCaret = () => {
          try {
            const s = getRootSelection(el);
            if (!s) return;
            const targetPt = resolveContentEditableDomPoint(el, hashStart + finalCursorOffset);
            const caretRange = document.createRange();
            caretRange.setStart(targetPt.node, targetPt.offset);
            caretRange.collapse(true);
            s.removeAllRanges();
            s.addRange(caretRange);
          } catch (_) {}
        };
        if (usedMethod === 'paste') {
          setTimeout(positionCaret, 0);
        } else {
          positionCaret();
        }
      }

      window.__AGY_SNIPPETS_LAST_INSERT__ = {
        tag,
        isContentEditable: true,
        method: usedMethod,
        ok,
      };
      return ok;
    }

    return false;
  }

  function insertTextAtEndOfEditable(el, insertText, cursorOffset) {
    if (!el) {
      return false;
    }
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const start =
        typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end =
        typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      return replaceTextInEditable(el, start, end, insertText, cursorOffset);
    }
    if (el.isContentEditable) {
      el.focus();
      const sel = getRootSelection(el);
      if (!sel) {
        return false;
      }
      let range;
      if (sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const startText = walkContentEditableText(el, range.startContainer, range.startOffset);
      const endText = range.collapsed
        ? startText
        : walkContentEditableText(el, range.endContainer, range.endOffset);
      return replaceTextInEditable(el, startText.length, endText.length, insertText, cursorOffset);
    }
    return false;
  }

  function readEditableFullText(el) {
    if (!el) return '';
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      return el.value || '';
    }
    if (el.isContentEditable) {
      return el.innerText || el.textContent || '';
    }
    return '';
  }

  function collectAutoVarsSync() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const datetime = `${date} ${time}`;

    let workspace = '';
    try {
      const title = (document.title || '').replace(/\s*[-–|]\s*Antigravity.*$/i, '').trim();
      if (title && title.toLowerCase() !== 'antigravity') {
        workspace = title;
      }
    } catch (_) {}

    return {
      date,
      time,
      datetime,
      clipboard: '',
      selection: state.lastSelectionText || '',
      workspace,
    };
  }

  async function collectAutoVars(content) {
    const vars = collectAutoVarsSync();
    if (templateNeedsClipboard(content) && navigator.clipboard && navigator.clipboard.readText) {
      try {
        vars.clipboard = await navigator.clipboard.readText();
      } catch (_) {}
    }
    return vars;
  }

  // ==================== 核心业务操作 ====================

  function closePopup(dismissKey = '') {
    if (dismissKey) {
      state.popup.dismissedKey = dismissKey;
    }
    if (!state.popup.open) {
      return;
    }
    state.popup.open = false;
    state.popup.results = [];
    render();
  }

  function evaluateActiveTrigger() {
    if (state.composing || state.manager.open) {
      return;
    }
    const el = findEditableFromTarget(getDeepActiveElement());
    if (!el) {
      closePopup();
      return;
    }
    state.lastEditableEl = el;
    const caretInfo = getTextBeforeCaret(el);
    if (!caretInfo) {
      closePopup();
      return;
    }
    const trigger = extractHashTrigger(caretInfo.textBefore);
    if (!trigger) {
      state.popup.dismissedKey = '';
      closePopup();
      return;
    }

    const triggerKey = `${trigger.hashStart}:${trigger.query}`;
    if (state.popup.dismissedKey && state.popup.dismissedKey === triggerKey) {
      return;
    }
    state.popup.dismissedKey = '';

    const results = matchSnippets(store.snippets, trigger.query);
    // 若用户输入了空格且无任何匹配（如 "#123 hello" 普通文本），自动收起以免打扰
    if (/\s/.test(trigger.query) && results.length === 0) {
      closePopup();
      return;
    }

    const prevSelectedId =
      state.popup.results[state.popup.selectedIndex]?.snippet?.id || '';
    const trimmed = results.slice(0, MAX_POPUP_ITEMS);
    let nextIdx = 0;
    if (prevSelectedId && trimmed.length > 0) {
      const foundIdx = trimmed.findIndex((r) => r.snippet.id === prevSelectedId);
      if (foundIdx !== -1) {
        nextIdx = foundIdx;
      }
    }

    state.popup.open = true;
    state.popup.query = trigger.query;
    state.popup.hashStart = trigger.hashStart;
    state.popup.caretOffset = trigger.caretOffset;
    state.popup.targetEl = el;
    state.popup.results = trimmed;
    state.popup.selectedIndex = nextIdx;
    state.popup.rect = getCaretScreenRect(el, trigger.hashStart);
    render();
  }

  function recordSnippetUsage(snippetId) {
    const target = store.snippets.find((s) => s.id === snippetId);
    if (target) {
      target.useCount = (target.useCount || 0) + 1;
      target.updatedAt = Date.now();
      saveStore(store);
    }
  }

  function applySnippetSelection(snippet, ctx) {
    if (!snippet) {
      return;
    }
    if (templateNeedsClipboard(snippet.content)) {
      void finalizeSnippetInsertionAsync(snippet, {}, ctx);
    } else {
      finalizeSnippetInsertionSync(snippet, {}, ctx, collectAutoVarsSync());
    }
  }

  function performInsertionWithAutoVars(snippet, customValues, ctx, autoVars) {
    const wasInModal = Boolean(state.manager.open);
    state.popup.open = false;
    state.manager.open = false;
    render();

    const { text, cursorOffset } = renderTemplate(snippet.content, customValues, autoVars);
    const rawTarget = ctx?.targetEl || state.lastEditableEl;
    const targetEl = rawTarget && rawTarget.isConnected !== false ? rawTarget : null;
    if (rawTarget && rawTarget.isConnected === false && state.lastEditableEl === rawTarget) {
      state.lastEditableEl = null;
    }
    const expectedToken =
      ctx && ctx.mode === 'replace-hash' ? `#${ctx.query || ''}` : '';

    const runInsert = () => {
      let inserted = false;
      if (ctx && ctx.mode === 'replace-hash' && targetEl) {
        inserted = replaceTextInEditable(
          targetEl,
          ctx.hashStart,
          ctx.caretOffset,
          text,
          cursorOffset,
          expectedToken
        );
      } else if (targetEl) {
        inserted = insertTextAtEndOfEditable(targetEl, text, cursorOffset);
      }

      if (!inserted && navigator.clipboard && navigator.clipboard.writeText) {
        Promise.resolve(navigator.clipboard.writeText(text))
          .then(() => showToast('未检测到活动输入框，已复制到剪贴板'))
          .catch(() => {});
      }
      recordSnippetUsage(snippet.id);
    };

    // 若刚从变量填空/管理弹窗退回 contenteditable，等一帧让编辑器焦点与选区稳定
    if (wasInModal && targetEl && targetEl.isContentEditable) {
      targetEl.focus();
      setTimeout(runInsert, 16);
    } else {
      runInsert();
    }
  }

  function finalizeSnippetInsertionSync(snippet, customValues, ctx, autoVars) {
    performInsertionWithAutoVars(snippet, customValues, ctx, autoVars);
  }

  async function finalizeSnippetInsertionAsync(snippet, customValues, ctx) {
    if (state.insertInFlight) {
      return;
    }
    state.insertInFlight = true;
    try {
      const autoVars = await collectAutoVars(snippet.content);
      performInsertionWithAutoVars(snippet, customValues, ctx, autoVars);
    } finally {
      state.insertInFlight = false;
    }
  }

  function finalizeSnippetInsertion(snippet, customValues, ctx) {
    if (templateNeedsClipboard(snippet.content)) {
      return finalizeSnippetInsertionAsync(snippet, customValues, ctx);
    }
    finalizeSnippetInsertionSync(snippet, customValues, ctx, collectAutoVarsSync());
    return Promise.resolve();
  }

  function confirmPopupSelection() {
    const item = state.popup.results[state.popup.selectedIndex];
    if (!item || !item.snippet) {
      return false;
    }
    const ctx = {
      mode: 'replace-hash',
      targetEl: state.popup.targetEl,
      hashStart: state.popup.hashStart,
      caretOffset: state.popup.caretOffset,
      query: state.popup.query,
    };
    applySnippetSelection(item.snippet, ctx);
    return true;
  }

  function openManager(initialDraft = null) {
    state.popup.open = false;
    state.manager.open = true;
    state.manager.showSettings = false;
    if (initialDraft) {
      state.manager.editingId = '__new__';
      state.manager.draft = initialDraft;
    } else {
      state.manager.editingId = null;
      state.manager.draft = null;
      if (
        !state.manager.selectedId ||
        !store.snippets.some((s) => s.id === state.manager.selectedId)
      ) {
        state.manager.selectedId = store.snippets[0]?.id || '';
      }
    }
    render();
    setTimeout(() => {
      try {
        const sr = getShadowRoot();
        const el = initialDraft
          ? sr?.getElementById('mgr-draft-title')
          : sr?.getElementById('mgr-search');
        el?.focus();
      } catch (_) {}
    }, 30);
  }

  function openNewSnippetFromContext(prefillTitle = '', prefillContent = '') {
    openManager({
      id: '',
      title: prefillTitle,
      alias: '',
      category: '自定义',
      tagsText: '',
      content: prefillContent,
      pinned: false,
    });
  }

  function renderToastOnly() {
    const root = cardRefs.root;
    if (!root) {
      return;
    }
    const existing = typeof root.querySelector === 'function' ? root.querySelector('.toast') : null;
    if (!state.manager.toast) {
      if (existing && typeof existing.remove === 'function') existing.remove();
      return;
    }
    if (existing) {
      existing.textContent = state.manager.toast;
    } else {
      root.appendChild(el('div', { className: 'toast', textContent: state.manager.toast }));
    }
  }

  function showToast(msg) {
    state.manager.toast = msg;
    if (state.manager.toastTimer) {
      clearTimeout(state.manager.toastTimer);
    }
    renderToastOnly();
    state.manager.toastTimer = setTimeout(() => {
      state.manager.toastTimer = null;
      if (state.manager.toast === msg) {
        state.manager.toast = '';
        renderToastOnly();
      }
    }, 2600);
  }

  // ==================== Shadow DOM 与样式 ====================

  let shadowRootRef = null;
  let cardRefs = {};

  function getShadowRoot() {
    if (shadowRootRef && document.getElementById(HOST_ID)) {
      return shadowRootRef;
    }
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
      document.body.appendChild(host);
    }
    shadowRootRef = host.shadowRoot || host.attachShadow({ mode: 'open' });
    buildShell(shadowRootRef);
    return shadowRootRef;
  }

  function buildShell(sr) {
    sr.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      *, *::before, *::after { box-sizing: border-box; }
      .root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-size: 12px;
        line-height: 1.4;
      }
      .root.dark {
        --bg: rgba(24, 24, 29, 0.96);
        --bg-elev: rgba(34, 34, 42, 0.98);
        --bento: rgba(255, 255, 255, 0.04);
        --fg: #e4e4e7;
        --muted: #8b8b98;
        --border: rgba(255, 255, 255, 0.11);
        --border-soft: rgba(255, 255, 255, 0.06);
        --hover: rgba(255, 255, 255, 0.07);
        --active: rgba(16, 185, 129, 0.16);
        --active-border: rgba(52, 211, 153, 0.45);
        --accent: #34d399;
        --accent-fg: #06281e;
        --pill: rgba(255, 255, 255, 0.08);
        --danger: #f87171;
        --shadow: 0 12px 36px rgba(0, 0, 0, 0.52);
        --backdrop: rgba(0, 0, 0, 0.55);
      }
      .root.light {
        --bg: rgba(252, 252, 254, 0.97);
        --bg-elev: #ffffff;
        --bento: rgba(0, 0, 0, 0.03);
        --fg: #18181b;
        --muted: #71717a;
        --border: rgba(0, 0, 0, 0.11);
        --border-soft: rgba(0, 0, 0, 0.06);
        --hover: rgba(0, 0, 0, 0.05);
        --active: rgba(16, 185, 129, 0.12);
        --active-border: rgba(16, 185, 129, 0.45);
        --accent: #10b981;
        --accent-fg: #ffffff;
        --pill: rgba(0, 0, 0, 0.06);
        --danger: #dc2626;
        --shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
        --backdrop: rgba(15, 23, 42, 0.35);
      }

      /* 悬浮快捷入口胶囊 */
      .fab {
        position: fixed;
        right: 18px;
        bottom: 16px;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--fg);
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
        cursor: pointer;
        opacity: 0.72;
        transition: opacity 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
        user-select: none;
        font-size: 11px;
      }
      .fab:hover {
        opacity: 1;
        transform: translateY(-1px);
        border-color: var(--active-border);
      }
      .fab-hash {
        color: var(--accent);
        font-weight: 700;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .fab-count {
        color: var(--muted);
        font-size: 10px;
      }

      /* # 自动补全浮层 */
      .popup {
        position: fixed;
        width: 400px;
        max-width: calc(100vw - 24px);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--fg);
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        overflow: hidden;
      }
      .popup-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        border-bottom: 1px solid var(--border-soft);
        font-size: 11px;
      }
      .popup-query {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        overflow: hidden;
      }
      .hash-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 6px;
        border-radius: 5px;
        background: var(--active);
        color: var(--accent);
        font-weight: 700;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .query-text {
        color: var(--fg);
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .query-empty {
        color: var(--muted);
        font-weight: 400;
      }
      .head-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .mini-btn {
        border: 1px solid transparent;
        background: var(--pill);
        color: var(--fg);
        border-radius: 6px;
        padding: 2px 7px;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      .mini-btn:hover {
        background: var(--hover);
        border-color: var(--border);
      }
      .mini-btn.accent {
        background: var(--accent);
        color: var(--accent-fg);
        font-weight: 600;
      }
      .popup-list {
        max-height: 280px;
        overflow-y: auto;
        padding: 4px;
      }
      .popup-list::-webkit-scrollbar,
      .scroll-y::-webkit-scrollbar {
        width: 5px;
      }
      .popup-list::-webkit-scrollbar-thumb,
      .scroll-y::-webkit-scrollbar-thumb {
        background: var(--border);
        border-radius: 999px;
      }
      .popup-item {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 7px 9px;
        border-radius: 7px;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.1s ease;
      }
      .popup-item.selected {
        background: var(--active);
        border-color: var(--active-border);
      }
      .popup-row-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .popup-title-wrap {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1;
      }
      .pin-mark {
        color: #fbbf24;
        font-size: 11px;
        flex-shrink: 0;
      }
      .popup-title {
        font-weight: 600;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hl {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--pill);
        color: var(--muted);
        font-size: 10px;
        flex-shrink: 0;
      }
      .pill.alias {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        color: var(--accent);
      }
      .pill.tab-hint {
        background: var(--accent);
        color: var(--accent-fg);
        font-weight: 600;
      }
      .popup-preview {
        color: var(--muted);
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty-box {
        padding: 16px 12px;
        text-align: center;
        color: var(--muted);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }
      .popup-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 5px 10px;
        border-top: 1px solid var(--border-soft);
        color: var(--muted);
        font-size: 10px;
      }

      /* 模态框遮罩 */
      .backdrop {
        position: fixed;
        inset: 0;
        background: var(--backdrop);
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .modal {
        width: 780px;
        max-width: 96vw;
        height: 540px;
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: var(--bg-elev);
        color: var(--fg);
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .var-modal {
        width: 460px;
        max-width: 94vw;
        max-height: 82vh;
        height: auto;
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px;
        border-bottom: 1px solid var(--border-soft);
        gap: 10px;
      }
      .modal-title {
        font-size: 13px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .modal-body {
        flex: 1;
        min-height: 0;
        display: flex;
        overflow: hidden;
      }
      .var-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: 11px;
        color: var(--muted);
        font-weight: 600;
      }
      .input, .textarea, .select {
        width: 100%;
        border: 1px solid var(--border);
        background: var(--bento);
        color: var(--fg);
        border-radius: 7px;
        padding: 6px 9px;
        font-size: 12px;
        font-family: inherit;
        outline: none;
      }
      .input:focus, .textarea:focus {
        border-color: var(--active-border);
      }
      .textarea {
        resize: vertical;
        min-height: 130px;
        line-height: 1.5;
      }
      .preview-box {
        border: 1px solid var(--border-soft);
        background: var(--bento);
        border-radius: 7px;
        padding: 8px 10px;
        font-size: 11px;
        color: var(--muted);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 130px;
        overflow-y: auto;
      }
      .modal-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px;
        border-top: 1px solid var(--border-soft);
      }
      .btn {
        border: 1px solid var(--border);
        background: var(--pill);
        color: var(--fg);
        border-radius: 7px;
        padding: 5px 11px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
      }
      .btn:hover { background: var(--hover); }
      .btn.primary {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: transparent;
        font-weight: 600;
      }
      .btn.danger {
        color: var(--danger);
      }

      /* 管理面板双栏 */
      .mgr-left {
        width: 280px;
        border-right: 1px solid var(--border-soft);
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .mgr-toolbar {
        padding: 9px;
        display: flex;
        flex-direction: column;
        gap: 7px;
        border-bottom: 1px solid var(--border-soft);
      }
      .cat-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .cat-chip {
        border: 1px solid var(--border-soft);
        background: transparent;
        color: var(--muted);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 10px;
        cursor: pointer;
      }
      .cat-chip.active {
        background: var(--active);
        color: var(--accent);
        border-color: var(--active-border);
      }
      .mgr-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .mgr-item {
        padding: 7px 9px;
        border-radius: 7px;
        border: 1px solid transparent;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .mgr-item:hover { background: var(--hover); }
      .mgr-item.active {
        background: var(--active);
        border-color: var(--active-border);
      }
      .mgr-right {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .mgr-detail {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .var-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .toast {
        position: fixed;
        bottom: 54px;
        right: 18px;
        background: var(--bg-elev);
        color: var(--fg);
        border: 1px solid var(--active-border);
        border-radius: 8px;
        padding: 7px 12px;
        font-size: 11px;
        box-shadow: var(--shadow);
        pointer-events: none;
      }
    `;
    sr.appendChild(style);

    const root = document.createElement('div');
    root.className = 'root dark';
    sr.appendChild(root);

    cardRefs = { root };
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') {
        node.className = v;
      } else if (k === 'style' && typeof v === 'string') {
        node.style.cssText = v;
      } else if (k === 'textContent') {
        node.textContent = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== undefined && v !== null && v !== false) {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function renderHighlightedText(text, ranges) {
    if (!ranges || ranges.length === 0) {
      return document.createTextNode(text);
    }
    // 合并重叠区间
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of sorted) {
      if (!merged.length || r[0] > merged[merged.length - 1][1]) {
        merged.push([r[0], r[1]]);
      } else {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
      }
    }
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) {
        frag.appendChild(document.createTextNode(text.slice(pos, s)));
      }
      frag.appendChild(el('span', { className: 'hl', textContent: text.slice(s, e) }));
      pos = e;
    }
    if (pos < text.length) {
      frag.appendChild(document.createTextNode(text.slice(pos)));
    }
    return frag;
  }

  function renderPopup() {
    if (!state.popup.open) {
      return null;
    }
    const items = state.popup.results;
    const matchLabelMap = {
      'title-exact': '标题',
      'title-prefix': '标题',
      'title-contains': '标题',
      'title-tokens': '标题',
      'title-fuzzy': '标题',
      'alias-exact': '缩写',
      'alias-prefix': '缩写',
      tag: '标签',
      body: '正文',
    };

    const listEl = el('div', { className: 'popup-list' });
    if (items.length === 0) {
      listEl.appendChild(
        el('div', { className: 'empty-box' }, [
          el('div', { textContent: `未找到匹配 "#${state.popup.query}" 的模板` }),
          el(
            'button',
            {
              className: 'mini-btn accent',
              onMousedown: (e) => e.preventDefault(),
              onClick: () => openNewSnippetFromContext(state.popup.query, ''),
            },
            ['+ 新建此模板']
          ),
        ])
      );
    } else {
      items.forEach((entry, idx) => {
        const s = entry.snippet;
        const isSelected = idx === state.popup.selectedIndex;
        const row = el(
          'div',
          {
            className: `popup-item${isSelected ? ' selected' : ''}`,
            'data-idx': String(idx),
            onMouseEnter: () => {
              if (state.popup.selectedIndex !== idx) {
                state.popup.selectedIndex = idx;
                updatePopupSelectionVisual();
              }
            },
            onMousedown: (e) => {
              // 在 mousedown 阶段立即确认并阻止失焦，防止重渲染吞掉 click
              e.preventDefault();
              e.stopPropagation();
              if (e.button === 0) {
                state.popup.selectedIndex = idx;
                confirmPopupSelection();
              }
            },
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
            },
          },
          [
            el('div', { className: 'popup-row-top' }, [
              el('div', { className: 'popup-title-wrap' }, [
                s.pinned ? el('span', { className: 'pin-mark', textContent: '★' }) : null,
                el('span', { className: 'popup-title' }, [
                  renderHighlightedText(s.title, entry.titleRanges),
                ]),
                s.alias
                  ? el('span', { className: 'pill alias', textContent: `#${s.alias}` })
                  : null,
              ]),
              el('div', { className: 'row', style: 'gap:4px;flex-wrap:nowrap;' }, [
                matchLabelMap[entry.matchType]
                  ? el('span', {
                      className: 'pill',
                      textContent: matchLabelMap[entry.matchType],
                    })
                  : null,
                isSelected
                  ? el('span', { className: 'pill tab-hint', textContent: 'Tab' })
                  : null,
              ]),
            ]),
            el('div', {
              className: 'popup-preview',
              textContent: entry.bodyExcerpt,
            }),
          ]
        );
        listEl.appendChild(row);
      });
    }

    const popupEl = el(
      'div',
      {
        className: 'popup',
        id: 'agy-snippets-popup',
        onMousedown: (e) => e.preventDefault(),
      },
      [
        el('div', { className: 'popup-head' }, [
          el('div', { className: 'popup-query' }, [
            el('span', { className: 'hash-badge', textContent: '#' }),
            state.popup.query
              ? el('span', { className: 'query-text', textContent: state.popup.query })
              : el('span', {
                  className: 'query-empty',
                  textContent: '输入关键词匹配标题 / 缩写 / 正文…',
                }),
          ]),
          el('div', { className: 'head-actions' }, [
            el('span', { className: 'pill', textContent: `${items.length} 条` }),
            el(
              'button',
              {
                className: 'mini-btn',
                title: '新建模板',
                onMousedown: (e) => e.preventDefault(),
                onClick: () => openNewSnippetFromContext(state.popup.query, ''),
              },
              ['+ 新建']
            ),
            el(
              'button',
              {
                className: 'mini-btn',
                title: '管理模板库 (Alt+P)',
                onMousedown: (e) => e.preventDefault(),
                onClick: () => openManager(),
              },
              ['⚙']
            ),
          ]),
        ]),
        listEl,
        el('div', { className: 'popup-foot' }, [
          el('span', { textContent: '↑↓ 选择 · Tab 快捷插入 · Esc 关闭' }),
          el('span', { textContent: 'Alt+P 管理库' }),
        ]),
      ]
    );

    // 定位到视口安全区域（默认优先向上弹出）
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const estW = Math.min(400, vw - 24);
    const estH = Math.min(355, 92 + Math.max(1, items.length) * 44);
    const caret = state.popup.rect || { left: 24, top: vh - 120, bottom: vh - 96 };

    const left = Math.max(12, Math.min(vw - estW - 12, caret.left));
    let top;
    if (caret.top - estH - 8 >= 12) {
      top = caret.top - estH - 8;
    } else if (caret.bottom + estH + 8 <= vh - 12) {
      top = caret.bottom + 8;
    } else {
      top = Math.max(12, vh - estH - 12);
    }
    popupEl.style.left = `${Math.round(left)}px`;
    popupEl.style.top = `${Math.round(top)}px`;

    return popupEl;
  }

  function updatePopupSelectionVisual() {
    const sr = shadowRootRef;
    if (!sr) return;
    const nodes = sr.querySelectorAll('.popup-item');
    nodes.forEach((node) => {
      const idx = Number(node.getAttribute('data-idx'));
      const active = idx === state.popup.selectedIndex;
      node.classList.toggle('selected', active);
      const topRight = node.querySelector('.popup-row-top .row');
      if (topRight) {
        const oldTab = topRight.querySelector('.tab-hint');
        if (active && !oldTab) {
          topRight.appendChild(
            el('span', { className: 'pill tab-hint', textContent: 'Tab' })
          );
        } else if (!active && oldTab) {
          oldTab.remove();
        }
      }
      if (active) {
        try {
          node.scrollIntoView({ block: 'nearest' });
        } catch (_) {}
      }
    });
  }

  function renderManagerModal() {
    if (!state.manager.open) {
      return null;
    }

    const categories = ['全部', '已置顶'];
    for (const s of store.snippets) {
      if (s.category && !categories.includes(s.category)) {
        categories.push(s.category);
      }
    }

    let pool = store.snippets;
    if (state.manager.category === '已置顶') {
      pool = pool.filter((s) => s.pinned);
    } else if (state.manager.category !== '全部') {
      pool = pool.filter((s) => s.category === state.manager.category);
    }
    const filtered = matchSnippets(pool, state.manager.search).map((r) => r.snippet);

    if (
      filtered.length > 0 &&
      !filtered.some((s) => s.id === state.manager.selectedId) &&
      !state.manager.editingId
    ) {
      state.manager.selectedId = filtered[0].id;
    }

    const activeSnippet = store.snippets.find((s) => s.id === state.manager.selectedId) || null;

    // 左侧列表
    const leftPane = el('div', { className: 'mgr-left' }, [
      el('div', { className: 'mgr-toolbar' }, [
        el('input', {
          id: 'mgr-search',
          className: 'input',
          type: 'text',
          value: state.manager.search,
          placeholder: '搜索标题 / 缩写 / 正文…',
          onInput: (e) => {
            state.manager.search = e.target.value;
            render();
            setTimeout(() => {
              const inp = shadowRootRef?.getElementById('mgr-search');
              if (inp) {
                inp.focus();
                inp.setSelectionRange(inp.value.length, inp.value.length);
              }
            }, 0);
          },
        }),
        el(
          'div',
          { className: 'cat-row' },
          categories.map((cat) =>
            el(
              'button',
              {
                className: `cat-chip${state.manager.category === cat ? ' active' : ''}`,
                onClick: () => {
                  state.manager.category = cat;
                  render();
                },
              },
              [cat]
            )
          )
        ),
      ]),
      el(
        'div',
        { className: 'mgr-list scroll-y' },
        filtered.length > 0
          ? filtered.map((s) =>
              el(
                'div',
                {
                  className: `mgr-item${
                    state.manager.selectedId === s.id && !state.manager.editingId
                      ? ' active'
                      : ''
                  }`,
                  onClick: () => {
                    state.manager.editingId = null;
                    state.manager.draft = null;
                    state.manager.showSettings = false;
                    state.manager.selectedId = s.id;
                    render();
                  },
                },
                [
                  el('div', { className: 'row', style: 'justify-content:space-between;' }, [
                    el('span', {
                      style:
                        'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;',
                      textContent: `${s.pinned ? '★ ' : ''}${s.title}`,
                    }),
                    s.alias
                      ? el('span', { className: 'pill alias', textContent: `#${s.alias}` })
                      : null,
                  ]),
                  el('span', {
                    style: 'font-size:10px;color:var(--muted);',
                    textContent: `${s.category || '自定义'} · 使用 ${s.useCount || 0} 次`,
                  }),
                ]
              )
            )
          : [
              el('div', {
                className: 'empty-box',
                textContent: '当前筛选下暂无模板',
              }),
            ]
      ),
    ]);

    // 右侧详情/编辑/设置
    let rightContent;
    if (state.manager.showSettings) {
      rightContent = renderSettingsPane();
    } else if (state.manager.editingId && state.manager.draft) {
      rightContent = renderEditorPane(state.manager.draft);
    } else if (activeSnippet) {
      rightContent = el('div', { className: 'mgr-detail scroll-y' }, [
        el('div', { className: 'row', style: 'justify-content:space-between;' }, [
          el('div', { className: 'row' }, [
            el('h3', {
              style: 'margin:0;font-size:15px;',
              textContent: activeSnippet.title,
            }),
            activeSnippet.alias
              ? el('span', {
                  className: 'pill alias',
                  textContent: `#${activeSnippet.alias}`,
                })
              : null,
            el('span', {
              className: 'pill',
              textContent: activeSnippet.category || '自定义',
            }),
          ]),
          el('div', { className: 'row' }, [
            el(
              'button',
              {
                className: 'btn',
                onClick: () => {
                  activeSnippet.pinned = !activeSnippet.pinned;
                  saveStore(store);
                  render();
                },
              },
              [activeSnippet.pinned ? '取消置顶' : '★ 置顶']
            ),
            el(
              'button',
              {
                className: 'btn',
                onClick: () => {
                  state.manager.editingId = activeSnippet.id;
                  state.manager.draft = {
                    ...activeSnippet,
                    tagsText: Array.isArray(activeSnippet.tags)
                      ? activeSnippet.tags.join(', ')
                      : '',
                  };
                  render();
                },
              },
              ['编辑']
            ),
            el(
              'button',
              {
                className: 'btn danger',
                onClick: () => {
                  store.snippets = store.snippets.filter((x) => x.id !== activeSnippet.id);
                  if (
                    activeSnippet.builtin &&
                    !store.deletedBuiltinIds.includes(activeSnippet.id)
                  ) {
                    store.deletedBuiltinIds.push(activeSnippet.id);
                  }
                  saveStore(store);
                  state.manager.selectedId = store.snippets[0]?.id || '';
                  render();
                  showToast('已删除模板');
                },
              },
              ['删除']
            ),
          ]),
        ]),
        activeSnippet.tags && activeSnippet.tags.length > 0
          ? el(
              'div',
              { className: 'row' },
              activeSnippet.tags.map((t) => el('span', { className: 'pill', textContent: `#${t}` }))
            )
          : null,
        el('div', {
          className: 'preview-box',
          style: 'max-height:none;flex:1;font-size:12px;color:var(--fg);',
          textContent: activeSnippet.content,
        }),
        el('div', { className: 'row', style: 'justify-content:flex-end;' }, [
          el(
            'button',
            {
              className: 'btn',
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(activeSnippet.content);
                  showToast('已复制模板原文');
                } catch (_) {}
              },
            },
            ['复制原文']
          ),
          el(
            'button',
            {
              className: 'btn primary',
              onClick: () =>
                void applySnippetSelection(activeSnippet, {
                  mode: 'append',
                  targetEl: state.lastEditableEl,
                }),
            },
            ['插入到当前输入框']
          ),
        ]),
      ]);
    } else {
      rightContent = el('div', { className: 'empty-box', style: 'margin:auto;' }, [
        el('div', { textContent: '点击左侧模板查看，或点击上方「+ 新建」创建' }),
      ]);
    }

    return el(
      'div',
      {
        className: 'backdrop',
        onClick: (e) => {
          if (e.target === e.currentTarget) {
            state.manager.open = false;
            render();
          }
        },
      },
      [
        el('div', { className: 'modal' }, [
          el('div', { className: 'modal-head' }, [
            el('div', { className: 'modal-title' }, [
              el('span', { className: 'hash-badge', textContent: '#' }),
              el('span', { textContent: 'Antigravity Prompt 模板库' }),
              el('span', { className: 'pill', textContent: `${store.snippets.length} 条` }),
            ]),
            el('div', { className: 'row' }, [
              el(
                'button',
                {
                  className: 'btn',
                  title: '将当前对话输入框内容收藏为模板',
                  onClick: () => {
                    const txt = readEditableFullText(state.lastEditableEl).trim();
                    openNewSnippetFromContext('', txt);
                  },
                },
                ['+ 从当前输入收藏']
              ),
              el(
                'button',
                {
                  className: 'btn primary',
                  onClick: () => openNewSnippetFromContext('', ''),
                },
                ['+ 新建模板']
              ),
              el(
                'button',
                {
                  className: 'btn',
                  onClick: () => {
                    state.manager.showSettings = !state.manager.showSettings;
                    state.manager.editingId = null;
                    render();
                  },
                },
                [state.manager.showSettings ? '返回列表' : '导入导出 / 设置']
              ),
              el(
                'button',
                {
                  className: 'btn',
                  onClick: () => {
                    state.manager.open = false;
                    render();
                  },
                },
                ['关闭']
              ),
            ]),
          ]),
          el('div', { className: 'modal-body' }, [
            leftPane,
            el('div', { className: 'mgr-right' }, [rightContent]),
          ]),
        ]),
      ]
    );
  }

  function renderEditorPane(draft) {
    const insertToken = (token) => {
      const ta = shadowRootRef?.getElementById('mgr-draft-content');
      if (ta) {
        const s = ta.selectionStart ?? ta.value.length;
        const e = ta.selectionEnd ?? ta.value.length;
        draft.content = ta.value.slice(0, s) + token + ta.value.slice(e);
        ta.value = draft.content;
        ta.focus();
        ta.setSelectionRange(s + token.length, s + token.length);
      } else {
        draft.content = (draft.content || '') + token;
      }
    };

    const quickTokens = [
      ['{{$cursor}}', '光标落点'],
      ['{{变量:默认值}}', '自定义填空'],
      ['{{clipboard}}', '剪贴板'],
      ['{{selection}}', '选中文本'],
      ['{{date}}', '日期'],
    ];

    return el('div', { className: 'mgr-detail scroll-y' }, [
      el('div', { className: 'grid-2' }, [
        el('div', { className: 'field' }, [
          el('span', { className: 'field-label', textContent: '标题（# 优先匹配）*' }),
          el('input', {
            id: 'mgr-draft-title',
            className: 'input',
            value: draft.title || '',
            placeholder: '例如：代码审查 (Code Review)',
            onInput: (e) => {
              draft.title = e.target.value;
            },
          }),
        ]),
        el('div', { className: 'field' }, [
          el('span', { className: 'field-label', textContent: '快捷缩写 alias（可选，如 cr）' }),
          el('input', {
            className: 'input',
            value: draft.alias || '',
            placeholder: '例如：cr',
            onInput: (e) => {
              draft.alias = e.target.value;
            },
          }),
        ]),
      ]),
      el('div', { className: 'grid-2' }, [
        el('div', { className: 'field' }, [
          el('span', { className: 'field-label', textContent: '分类' }),
          el('input', {
            className: 'input',
            value: draft.category || '',
            placeholder: '研发工程 / 调试排错 / 自定义',
            onInput: (e) => {
              draft.category = e.target.value;
            },
          }),
        ]),
        el('div', { className: 'field' }, [
          el('span', { className: 'field-label', textContent: '标签（逗号分隔）' }),
          el('input', {
            className: 'input',
            value: draft.tagsText || '',
            placeholder: 'review, diff, 性能',
            onInput: (e) => {
              draft.tagsText = e.target.value;
            },
          }),
        ]),
      ]),
      el('div', { className: 'field' }, [
        el('div', { className: 'row', style: 'justify-content:space-between;' }, [
          el('span', { className: 'field-label', textContent: 'Prompt 正文 *' }),
          el(
            'div',
            { className: 'var-chips' },
            quickTokens.map(([tok, label]) =>
              el(
                'button',
                {
                  className: 'mini-btn',
                  title: `插入 ${tok}`,
                  onClick: () => insertToken(tok),
                },
                [`+ ${label}`]
              )
            )
          ),
        ]),
        el('textarea', {
          id: 'mgr-draft-content',
          className: 'textarea',
          value: draft.content || '',
          placeholder: '编写你的 Prompt 模板内容，支持 {{变量:默认值}} 与 {{$cursor}}…',
          onInput: (e) => {
            draft.content = e.target.value;
          },
        }),
      ]),
      el('div', { className: 'row', style: 'justify-content:space-between;' }, [
        el('label', { className: 'row', style: 'cursor:pointer;font-size:11px;' }, [
          el('input', {
            type: 'checkbox',
            checked: Boolean(draft.pinned),
            onChange: (e) => {
              draft.pinned = Boolean(e.target.checked);
            },
          }),
          el('span', { textContent: '置顶此模板（# 触发时优先展示）' }),
        ]),
        el('div', { className: 'row' }, [
          el(
            'button',
            {
              className: 'btn',
              onClick: () => {
                state.manager.editingId = null;
                state.manager.draft = null;
                render();
              },
            },
            ['取消']
          ),
          el(
            'button',
            {
              className: 'btn primary',
              onClick: () => {
                const title = String(draft.title || '').trim();
                const content = String(draft.content || '');
                if (!title || !content.trim()) {
                  showToast('请填写模板标题与正文');
                  return;
                }
                const tags = String(draft.tagsText || '')
                  .split(/[,，]/)
                  .map((x) => x.trim())
                  .filter(Boolean);
                const payload = {
                  id:
                    state.manager.editingId && state.manager.editingId !== '__new__'
                      ? state.manager.editingId
                      : `custom-${Date.now()}`,
                  title,
                  alias: String(draft.alias || '').trim().replace(/^#/, ''),
                  category: String(draft.category || '').trim() || '自定义',
                  tags,
                  content,
                  pinned: Boolean(draft.pinned),
                  useCount: Number(draft.useCount) || 0,
                  builtin: Boolean(draft.builtin),
                  updatedAt: Date.now(),
                };
                const existingIdx = store.snippets.findIndex((s) => s.id === payload.id);
                if (existingIdx !== -1) {
                  store.snippets[existingIdx] = payload;
                } else {
                  store.snippets.unshift(payload);
                }
                saveStore(store);
                state.manager.selectedId = payload.id;
                state.manager.editingId = null;
                state.manager.draft = null;
                render();
                showToast('模板已保存');
              },
            },
            ['保存模板']
          ),
        ]),
      ]),
    ]);
  }

  function renderSettingsPane() {
    return el('div', { className: 'mgr-detail scroll-y' }, [
      el('h3', { style: 'margin:0;font-size:14px;', textContent: '交互设置与数据备份' }),
      el('label', { className: 'row', style: 'cursor:pointer;' }, [
        el('input', {
          type: 'checkbox',
          checked: store.prefs.showFloatingBtn,
          onChange: (e) => {
            store.prefs.showFloatingBtn = Boolean(e.target.checked);
            saveStore(store);
            render();
          },
        }),
        el('span', { textContent: '显示右下角「# 模板」轻量悬浮胶囊（关闭后仍可用 # 与 Alt+P）' }),
      ]),
      el('label', { className: 'row', style: 'cursor:pointer;' }, [
        el('input', {
          type: 'checkbox',
          checked: store.prefs.enterConfirms,
          onChange: (e) => {
            store.prefs.enterConfirms = Boolean(e.target.checked);
            saveStore(store);
            render();
          },
        }),
        el('span', { textContent: '允许同时使用 Enter 确认补全（默认仅 Tab 确认，防误发送）' }),
      ]),
      el('div', { className: 'row' }, [
        el(
          'button',
          {
            className: 'btn',
            onClick: async () => {
              const payload = JSON.stringify(
                { version: 1, exportedAt: new Date().toISOString(), snippets: store.snippets },
                null,
                2
              );
              try {
                await navigator.clipboard.writeText(payload);
                showToast('已导出 JSON 到剪贴板');
              } catch (_) {
                const blob = new Blob([payload], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'antigravity-snippets.json';
                a.click();
                showToast('已下载导出文件');
              }
            },
          },
          ['导出全部模板 (JSON)']
        ),
        el(
          'button',
          {
            className: 'btn danger',
            onClick: () => {
              store.deletedBuiltinIds = [];
              store.snippets = mergeImportedSnippets(store.snippets, DEFAULT_SNIPPETS, 'merge');
              saveStore(store);
              render();
              showToast('已恢复并合并预置模板');
            },
          },
          ['恢复预置默认模板']
        ),
      ]),
      el('div', { className: 'field' }, [
        el('span', {
          className: 'field-label',
          textContent: '导入模板（粘贴导出的 JSON 数组或 { snippets: [...] }）',
        }),
        el('textarea', {
          className: 'textarea',
          style: 'min-height:110px;',
          value: state.manager.importText || '',
          placeholder: '粘贴 JSON 内容…',
          onInput: (e) => {
            state.manager.importText = e.target.value;
          },
        }),
        el('div', { className: 'row' }, [
          el(
            'button',
            {
              className: 'btn primary',
              onClick: () => {
                try {
                  const parsed = JSON.parse(state.manager.importText || '');
                  const arr = Array.isArray(parsed) ? parsed : parsed?.snippets;
                  if (!Array.isArray(arr) || arr.length === 0) {
                    showToast('未检测到有效模板数组');
                    return;
                  }
                  store.snippets = mergeImportedSnippets(store.snippets, arr, 'merge');
                  saveStore(store);
                  state.manager.importText = '';
                  render();
                  showToast(`成功导入并合并 ${arr.length} 条模板`);
                } catch (err) {
                  showToast(`JSON 解析失败: ${err.message}`);
                }
              },
            },
            ['合并导入']
          ),
        ]),
      ]),
    ]);
  }

  function render() {
    state.isDark = detectThemeIsDark();
    state.isZh = detectIsZh();
    const sr = getShadowRoot();
    const root = cardRefs.root;
    if (!sr || !root) {
      return;
    }
    root.className = `root ${state.isDark ? 'dark' : 'light'}`;
    root.innerHTML = '';

    // 模板库主入口已迁移至左侧栏原生 MCP App（「插件 > 模板库」），不再渲染右下角悬浮按钮
    const popup = renderPopup();
    if (popup) {
      root.appendChild(popup);
    }

    const mgrModal = renderManagerModal();
    if (mgrModal) {
      root.appendChild(mgrModal);
    }

    if (state.manager.toast) {
      root.appendChild(el('div', { className: 'toast', textContent: state.manager.toast }));
    }
  }

  // ==================== 全局事件监听 ====================

  function onCompositionStart() {
    state.composing = true;
  }

  function onCompositionEnd() {
    state.composing = false;
    setTimeout(evaluateActiveTrigger, 0);
  }

  function onInputOrCaretMove() {
    if (state.composing) {
      return;
    }
    setTimeout(evaluateActiveTrigger, 0);
  }

  function onSelectionChange() {
    try {
      const sel = window.getSelection();
      const txt = sel ? sel.toString().trim() : '';
      const active = getDeepActiveElement();
      if (txt && !isSupportedEditable(active) && !isInsidePluginHost(active)) {
        state.lastSelectionText = txt;
      }
    } catch (_) {}
    if (state.popup.open && !state.composing) {
      evaluateActiveTrigger();
    }
  }

  function stopEventHard(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
  }

  function onKeyDownCapture(e) {
    if (e.isComposing || e.keyCode === 229) {
      return;
    }

    // 全局快捷键 Alt+P 或 Ctrl+Shift+; 打开/关闭模板库
    if (
      (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P')) ||
      (e.ctrlKey && e.shiftKey && e.key === ';')
    ) {
      stopEventHard(e);
      if (state.manager.open) {
        state.manager.open = false;
        render();
      } else {
        openManager();
      }
      return;
    }

    if (state.manager.open && e.key === 'Escape') {
      stopEventHard(e);
      state.manager.open = false;
      render();
      return;
    }

    if (!state.popup.open) {
      return;
    }

    const count = state.popup.results.length;
    if (e.key === 'ArrowDown') {
      if (count > 0) {
        stopEventHard(e);
        state.popup.selectedIndex = (state.popup.selectedIndex + 1) % count;
        updatePopupSelectionVisual();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      if (count > 0) {
        stopEventHard(e);
        state.popup.selectedIndex = (state.popup.selectedIndex - 1 + count) % count;
        updatePopupSelectionVisual();
      }
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      stopEventHard(e);
      state.composing = false;
      if (count > 0) {
        confirmPopupSelection();
      } else {
        closePopup(`${state.popup.hashStart}:${state.popup.query}`);
      }
      return;
    }
    if (store.prefs.enterConfirms && e.key === 'Enter' && !e.shiftKey && count > 0) {
      stopEventHard(e);
      confirmPopupSelection();
      return;
    }
    if (e.key === 'Escape') {
      stopEventHard(e);
      closePopup(`${state.popup.hashStart}:${state.popup.query}`);
    }
  }

  function onFocusIn(e) {
    state.composing = false;
    const ed = findEditableFromTarget(e.target);
    if (ed) {
      state.lastEditableEl = ed;
    }
  }

  function onPointerDown(e) {
    if (!state.popup.open) {
      return;
    }
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const insideHost = path.some((n) => n && n.id === HOST_ID);
    if (!insideHost) {
      setTimeout(() => {
        const active = getDeepActiveElement();
        if (active !== state.popup.targetEl) {
          closePopup();
        }
      }, 0);
    }
  }

  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  document.addEventListener('input', onInputOrCaretMove, true);
  document.addEventListener('keyup', (e) => {
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Home' ||
      e.key === 'End' ||
      e.key === 'Backspace'
    ) {
      onInputOrCaretMove();
    }
  }, true);
  document.addEventListener('click', (e) => {
    if (findEditableFromTarget(e.target)) {
      onInputOrCaretMove();
    }
  }, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onKeyDownCapture, true);
  } else {
    document.addEventListener('keydown', onKeyDownCapture, true);
  }

  // 初始挂载
  render();
})();
