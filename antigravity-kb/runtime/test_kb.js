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
    assert.strictEqual(byId.get(2).result.tools.length, 5);
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

testMarkdownHelpers();
testWikiTriggerAndComposer();
testPluginLoaderKbBridge();
testMcpServerEndToEnd();
console.log('antigravity-kb tests passed!');
