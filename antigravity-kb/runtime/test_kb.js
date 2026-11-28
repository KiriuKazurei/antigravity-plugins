/**
 * antigravity-kb 单元测试套件
 * 1. 验证 runtime/kb.js 纯函数（Frontmatter、双链、反向链接、Markdown 渲染与 XSS 防护、[[ 触发与替换、复选框写回）
 * 2. 验证 scripts/pluginLoader.js KB 桥接核心函数（路径穿越拦截、Vault 扫描、全文检索）
 * 3. 验证 scripts/kb_mcp.py MCP Server 完整 stdio JSON-RPC 生命周期（initialize/tools/list/kb_write/kb_list/kb_search/kb_read/kb_append）
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');

const kb = require('./kb.js');

function testMarkdownHelpers() {
  const sample = [
    '---',
    'title: "Electron 打包排错"',
    'tags: [Antigravity, 调试]',
    'aliases: [asar-debug]',
    '---',
    '',
    '# Electron 打包排错',
    '',
    '参考 [[插件开发指南|开发手册]] 以及 #热更新 标签。',
    '',
    '- [ ] 检查 app.asar 哈希',
    '- [x] 验证 SessionStart 钩子',
    '',
    '```js',
    'const [[notALink]] = [];',
    'console.log("<script>alert(1)</script>");',
    '```',
  ].join('\n');

  const parsed = kb.parseFrontmatterAndBody(sample);
  assert.strictEqual(parsed.meta.title, 'Electron 打包排错');
  assert.deepStrictEqual(parsed.meta.tags, ['Antigravity', '调试']);
  assert.deepStrictEqual(parsed.meta.aliases, ['asar-debug']);
  assert(parsed.body.startsWith('\n# Electron'));

  // 代码块中的 [[notALink]] 不应被提取为双链
  const links = kb.extractWikilinks(sample);
  assert.deepStrictEqual(links, ['插件开发指南']);

  // 反向链接计算
  const backlinks = kb.computeBacklinks(
    { relPath: 'guides/插件开发指南.md', title: '插件开发指南' },
    [
      { relPath: 'guides/插件开发指南.md', title: '插件开发指南', links: [] },
      { relPath: 'debug/asar.md', title: 'Electron 打包排错', links: ['插件开发指南'] },
      { relPath: 'other.md', title: '无关笔记', links: ['其他'] },
    ]
  );
  assert.strictEqual(backlinks.length, 1);
  assert.strictEqual(backlinks[0].relPath, 'debug/asar.md');

  // 任务复选框翻转
  const lineIdx = sample.split('\n').findIndex((l) => l.includes('检查 app.asar 哈希'));
  const toggled = kb.toggleCheckboxAtLine(sample, lineIdx);
  assert(toggled.includes('- [x] 检查 app.asar 哈希'));

  // Markdown 渲染 & XSS 防护
  const html = kb.renderMarkdownToHtml('<img src=x onerror=alert(1)>\n\n[[插件开发指南|手册]]\n\n- [ ] 待办');
  assert(!html.includes('<img src=x'));
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert(html.includes('data-wikilink="插件开发指南"'));
  assert(html.includes('class="kb-task-cb"'));
}

function testWikiTriggerAndComposer() {
  const input = '请参考这份排查笔记 [[asar';
  const trig = kb.detectWikiTrigger(input, input.length);
  assert(trig);
  assert.strictEqual(trig.query, 'asar');
  assert.strictEqual(trig.start, input.indexOf('[['));

  // 已闭合的 [[...]] 不再触发
  const closed = '已引用 [[asar]] 继续';
  assert.strictEqual(kb.detectWikiTrigger(closed, closed.length), null);

  const note = { relPath: 'debug/asar.md', title: 'ASAR 排查' };
  const formatted = kb.formatNoteForComposer(
    note,
    '---\ntitle: "ASAR 排查"\n---\n\n第一行结论',
    'quote',
    'C:\\Users\\test\\.gemini\\kb\\debug\\asar.md'
  );
  assert(formatted.includes('> **知识库参考：ASAR 排查**'));
  assert(formatted.includes('> 第一行结论'));
  assert(!formatted.includes('title: "ASAR 排查"'));

  const replaced = kb.applyWikiTriggerReplacement(input, trig, formatted);
  assert(replaced.text.startsWith('请参考这份排查笔记 > **知识库参考：ASAR 排查**'));

  // 路径清理防御穿越
  assert.strictEqual(kb.sanitizeRelPath('../../secret/note'), 'secret/note.md');
  assert.strictEqual(kb.sanitizeRelPath('docs/readme.MD'), 'docs/readme.MD');
}

function testPluginLoaderKbBridge() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getVersion: () => '2.34.0' }, shell: {}, dialog: {} };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  let loader;
  try {
    loader = require('../scripts/pluginLoader.js');
  } finally {
    Module._load = origLoad;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kb-loader-'));
  try {
    assert.strictEqual(loader.resolveSafeKbPath(tmpDir, '../outside.md'), null);
    assert.strictEqual(loader.resolveSafeKbPath(tmpDir, 'C:/Windows/win.md'), null);
    assert.strictEqual(loader.resolveSafeKbPath(tmpDir, 'bad\0name.md'), null);
    const valid = loader.resolveSafeKbPath(tmpDir, 'sub/hello');
    assert(valid && valid.relPath === 'sub/hello.md');

    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    fs.writeFileSync(
      valid.fullPath,
      '---\ntitle: "测试笔记"\ntags: [单元测试, KB]\n---\n\n这里记录了 Connect-RPC 排查过程与 [[目标笔记]]。\n',
      'utf8'
    );

    const scan = loader.scanKbVault(tmpDir);
    assert.strictEqual(scan.ok, true);
    assert.strictEqual(scan.notes.length, 1);
    assert.strictEqual(scan.notes[0].title, '测试笔记');
    assert.deepStrictEqual(scan.notes[0].tags, ['单元测试', 'KB']);
    assert.deepStrictEqual(scan.notes[0].links, ['目标笔记']);

    const searchRes = loader.searchKbVault(tmpDir, { query: 'Connect-RPC', tag: 'KB' });
    assert.strictEqual(searchRes.ok, true);
    assert.strictEqual(searchRes.matches.length, 1);
    assert(searchRes.matches[0].snippets.length >= 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testMcpServerEndToEnd() {
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-kb-mcp-'));
  const mcpPath = path.resolve(__dirname, '..', 'scripts', 'kb_mcp.py');
  try {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'kb_write',
          arguments: {
            vault: tmpVault,
            rel_path: 'guides/git-tips',
            title: 'Git 常用救援技巧',
            tags: ['Git', '技巧'],
            content: '使用 `git reflog` 找回误删提交，关联 [[Electron 排查]]。',
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'kb_write',
          arguments: {
            vault: tmpVault,
            rel_path: 'Electron 排查.md',
            content: '# Electron 排查\n\n暂无内容。\n',
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'kb_append', arguments: { vault: tmpVault, note: 'Electron 排查', section: '补充', content: '补充一条记录。' } },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'kb_search', arguments: { vault: tmpVault, query: 'reflog' } },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'kb_read', arguments: { vault: tmpVault, note: 'Electron 排查' } },
      },
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'kb_write', arguments: { vault: tmpVault, rel_path: '../../escape.md', content: 'bad' } },
      },
    ];

    const proc = spawnSync('python', [mcpPath], {
      input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      env: { ...process.env, AGY_KB_DEFAULT_VAULT: tmpVault },
    });
    assert.strictEqual(proc.status, 0, `kb_mcp.py exited with ${proc.status}: ${proc.stderr}`);
    const lines = proc.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const byId = new Map(lines.map((m) => [m.id, m]));

    assert.strictEqual(byId.get(1).result.serverInfo.name, 'antigravity-kb');
    const toolNames = byId.get(2).result.tools.map((t) => t.name);
    for (const reqTool of ['kb_list', 'kb_search', 'kb_read', 'kb_write', 'kb_append']) {
      assert(toolNames.includes(reqTool), `kb_mcp.py must expose ${reqTool}`);
    }
    assert.strictEqual(byId.get(3).result.isError, false);

    const searchPayload = JSON.parse(byId.get(6).result.content[0].text);
    assert.strictEqual(searchPayload.count, 1);
    assert.strictEqual(searchPayload.matches[0].rel_path, 'guides/git-tips.md');

    const readPayload = JSON.parse(byId.get(7).result.content[0].text);
    assert(readPayload.content.includes('补充一条记录。'));
    assert.strictEqual(readPayload.backlinks.length, 1);
    assert.strictEqual(readPayload.backlinks[0].rel_path, 'guides/git-tips.md');

    // 路径越界必须拒绝
    assert.strictEqual(byId.get(8).result.isError, true);
  } finally {
    fs.rmSync(tmpVault, { recursive: true, force: true });
  }
}

function testEmptyRightPaneVirtualTabAndSidebarDock() {
  const code = fs.readFileSync(path.join(__dirname, 'kb.js'), 'utf8');
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      textContent: '',
      style: { cssText: '', setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
      dataset: {},
      attributes: {},
      children: [],
      listeners: {},
      parentElement: null,
      get parentNode() { return this.parentElement; },
      classList: {
        toggle(cls, force) {
          const set = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
          if (force === undefined) {
            if (set.has(cls)) set.delete(cls);
            else set.add(cls);
          } else if (force) set.add(cls);
          else set.delete(cls);
          el.className = Array.from(set).join(' ');
        },
        add(cls) { this.toggle(cls, true); },
        remove(cls) { this.toggle(cls, false); },
      },
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      attachShadow() {
        const sr = makeEl('shadow-root');
        sr.host = this;
        this.shadowRoot = sr;
        return sr;
      },
      appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
      insertBefore(c) { c.parentElement = this; this.children.unshift(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentElement = null; },
      contains(n) { return n === this || this.children.some((c) => c === n || (c.contains && c.contains(n))); },
      closest(sel) {
        let cur = this;
        const ids = sel.split(',').map((s) => s.trim()).filter((s) => s.startsWith('#')).map((s) => s.slice(1));
        while (cur) {
          if (ids.includes(cur.id)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      getBoundingClientRect() { return this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
      querySelectorAll(sel) {
        const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
        const out = [];
        const walk = (n) => {
          for (const c of n.children || []) {
            const matched = parts.some((p) => {
              if (p.startsWith('.')) return String(c.className || '').split(/\s+/).includes(p.slice(1));
              if (p.startsWith('#')) return c.id === p.slice(1);
              if (/^[a-z0-9]+$/i.test(p)) return c.tagName.toLowerCase() === p.toLowerCase();
              return false;
            });
            if (matched) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      getElementById(id) {
        const walk = (n) => {
          for (const c of n.children || []) {
            if (c.id === id) return c;
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        return walk(this);
      },
      set innerHTML(v) { if (v === '') this.children = []; },
    };
    return el;
  }

  const body = makeEl('body');
  const sidebar = makeEl('div');
  sidebar._rect = { left: 0, top: 0, right: 242, bottom: 800, width: 242, height: 800 };
  const custBtn = makeEl('button');
  custBtn.textContent = '自定义配置';
  custBtn._rect = { left: 10, top: 112, right: 230, bottom: 144, width: 220, height: 32 };
  const projectsHdr = makeEl('div');
  projectsHdr.textContent = '项目';
  projectsHdr._rect = { left: 12, top: 180, right: 92, bottom: 198, width: 80, height: 18 };
  sidebar.appendChild(custBtn);
  sidebar.appendChild(projectsHdr);
  body.appendChild(sidebar);

  const splitRoot = makeEl('div');
  const chatCol = makeEl('div');
  const composer = makeEl('textarea');
  composer._rect = { left: 260, top: 680, right: 720, bottom: 760, width: 460, height: 80 };
  chatCol.appendChild(composer);
  const rightPane = makeEl('div');
  rightPane._rect = { left: 740, top: 36, right: 1280, bottom: 800, width: 540, height: 764 };
  splitRoot.appendChild(chatCol);
  splitRoot.appendChild(rightPane);
  body.appendChild(splitRoot);

  const doc = {
    readyState: 'complete',
    body,
    head: makeEl('head'),
    documentElement: { lang: 'zh-CN' },
    createElement: (t) => makeEl(t),
    createElementNS: (_, t) => makeEl(t),
    getElementById: (id) => body.getElementById(id),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    elementFromPoint: () => custBtn,
    addEventListener() {},
  };

  const ctx = vm.createContext({
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    navigator: { language: 'zh-CN', platform: 'Win32' },
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 22)', borderRadius: '10px', marginTop: '0px', fontSize: '13px', fontWeight: '500', paddingLeft: '10px' }),
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: function (t, init) { this.type = t; this.detail = init && init.detail; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    Date,
    Map,
    Set,
  });
  ctx.window = ctx;
  vm.runInContext(code, ctx, { filename: 'kb.js' });

  // 1. 统一左侧栏基座应自动挂载并注册「知识库」
  assert(ctx.__AGY_SIDEBAR_DOCK__, 'KB must initialize or join unified sidebar dock');
  assert(ctx.__AGY_SIDEBAR_DOCK__._items.has('antigravity-kb'), 'KB must register into unified sidebar dock');
  const dockHost = doc.getElementById('agy-sidebar-plugins-dock');
  assert(dockHost && dockHost.shadowRoot, 'Unified sidebar dock host must exist');

  // 2. 在 0 原生标签的空右侧栏打开知识库 -> 应在顶栏渲染虚拟标签条 .vtab-bar
  const api = ctx.__AGY_KB_TEST_API__;
  api.openKbInPane(false);
  const kbHost = doc.getElementById('agy-kb-host');
  const vTabBar = kbHost.shadowRoot.querySelector('.vtab-bar');
  assert(vTabBar && !vTabBar.className.includes('hidden'), 'KB must show seamless .vtab-bar in empty right pane');
  assert.strictEqual(vTabBar.style.left, '752px');
  assert.strictEqual(vTabBar.style.top, '44px');
}

testMarkdownHelpers();
testWikiTriggerAndComposer();
testPluginLoaderKbBridge();
testMcpServerEndToEnd();
testEmptyRightPaneVirtualTabAndSidebarDock();
console.log('antigravity-kb tests passed!');
