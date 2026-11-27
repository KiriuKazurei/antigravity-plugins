/**
 * antigravity-context-menu 单元测试
 * 覆盖：路径提取与清洗、file:// 编解码、行号剥离、光标偏移命中、
 * 可拓展注册中心 (Registry) 与 pluginLoader.js resolveSystemPath。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getVersion: () => '2.0.0-test' }, shell: {}, dialog: {}, BrowserWindow: {} };
  }
  return origLoad.apply(this, arguments);
};

const ctxMenu = require('./context-menu.js');
const loader = require('../scripts/pluginLoader.js');
Module._load = origLoad;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    throw err;
  }
}

console.log('Running antigravity-context-menu unit tests...');

test('decodeFileUrlToPath: Windows file:/// URL with line anchor and Chinese/spaces', () => {
  const res = ctxMenu.decodeFileUrlToPath('file:///E:/AI/My%20Docs/%E6%B5%8B%E8%AF%95.md#L12-L34');
  assert.strictEqual(res.path, 'E:\\AI\\My Docs\\测试.md');
  assert.strictEqual(res.line, 12);
  assert.strictEqual(res.endLine, 34);
});

test('decodeFileUrlToPath: UNC file:// URL', () => {
  const res = ctxMenu.decodeFileUrlToPath('file://wsl.localhost/Ubuntu/home/dev/app.py');
  assert.strictEqual(res.path, '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app.py');
});

test('stripLocationSuffix: handles :line:col, #L10-L20, (12,4) without breaking drive letter', () => {
  const a = ctxMenu.stripLocationSuffix('E:\\AI\\Agy\\runtime\\app.ts:42:10');
  assert.strictEqual(a.path, 'E:\\AI\\Agy\\runtime\\app.ts');
  assert.strictEqual(a.line, 42);
  assert.strictEqual(a.column, 10);

  const b = ctxMenu.stripLocationSuffix('C:\\proj\\main.cs(18, 4)');
  assert.strictEqual(b.path, 'C:\\proj\\main.cs');
  assert.strictEqual(b.line, 18);
  assert.strictEqual(b.column, 4);

  const c = ctxMenu.stripLocationSuffix('E:\\AI\\Agy\\README.md#L5-L20');
  assert.strictEqual(c.path, 'E:\\AI\\Agy\\README.md');
  assert.strictEqual(c.line, 5);
  assert.strictEqual(c.endLine, 20);
});

test('extractBestPathFromText: whole path with spaces inside inline code', () => {
  const info = ctxMenu.extractBestPathFromText('`C:\\Program Files\\Git\\bin\\git.exe`', { platform: 'win32' });
  assert.ok(info);
  assert.strictEqual(info.path, 'C:\\Program Files\\Git\\bin\\git.exe');
  assert.strictEqual(info.isLikelyFile, true);
  assert.strictEqual(info.filename, 'git.exe');
  assert.strictEqual(info.parentDir, 'C:\\Program Files\\Git\\bin');
});

test('extractBestPathFromText: path embedded in Chinese sentence with punctuation', () => {
  const text = '请先查看 E:\\AI\\Agy\\scripts\\manage_plugins.py，然后运行测试！';
  const info = ctxMenu.extractBestPathFromText(text, { platform: 'win32' });
  assert.ok(info);
  assert.strictEqual(info.path, 'E:\\AI\\Agy\\scripts\\manage_plugins.py');
});

test('extractPathsFromText: picks the path closest to caret offset when multiple exist', () => {
  const text = '对比 C:\\dirA\\alpha.js 和 D:\\dirB\\beta.ts 的区别';
  const secondIdx = text.indexOf('beta.ts');
  const picked = ctxMenu.extractBestPathFromText(text, { offset: secondIdx, platform: 'win32' });
  assert.ok(picked);
  assert.strictEqual(picked.path, 'D:\\dirB\\beta.ts');
});

test('extractBestPathFromText: supports ~, %USERPROFILE%, UNC/WSL and POSIX paths', () => {
  const home = ctxMenu.extractBestPathFromText('配置文件在 ~/.gemini/config/plugins 目录', { platform: 'win32' });
  assert.ok(home && home.kind === 'home');
  assert.strictEqual(home.path, '~/.gemini/config/plugins');

  const env = ctxMenu.extractBestPathFromText('%USERPROFILE%\\.gemini\\config\\config.json', { platform: 'win32' });
  assert.ok(env && env.kind === 'env');

  const unc = ctxMenu.extractBestPathFromText('\\\\wsl$\\Ubuntu\\home\\alice\\repo', { platform: 'win32' });
  assert.ok(unc && unc.kind === 'unc');
  assert.strictEqual(unc.isLikelyFile, false);

  const posix = ctxMenu.extractBestPathFromText('日志位于 /var/log/nginx/error.log 中', { platform: 'linux' });
  assert.ok(posix && posix.kind === 'posix-abs');
  assert.strictEqual(posix.path, '/var/log/nginx/error.log');
});

test('extractBestPathFromText: ignores HTTP/HTTPS URLs and ordinary text', () => {
  assert.strictEqual(ctxMenu.extractBestPathFromText('访问 https://github.com/KiriuKazurei/antigravity-plugins 查看'), null);
  assert.strictEqual(ctxMenu.extractBestPathFromText('当前版本 v1.0.0，时间 12:30'), null);
});

test('toFileUrl: encodes spaces and Unicode cleanly', () => {
  assert.strictEqual(
    ctxMenu.toFileUrl('E:\\AI\\My Folder\\说明.md'),
    'file:///E:/AI/My%20Folder/%E8%AF%B4%E6%98%8E.md'
  );
  assert.strictEqual(
    ctxMenu.toFileUrl('/Users/alice/my doc.txt'),
    'file:///Users/alice/my%20doc.txt'
  );
});

test('renderActionTemplate: replaces variables accurately', () => {
  const out = ctxMenu.renderActionTemplate('查看 {{filename}} ({{dir}}) | {{selection_encoded}}', {
    selectionText: 'a b',
    pathInfo: { path: 'E:\\AI\\Agy\\README.md', posixPath: 'E:/AI/Agy/README.md', dir: 'E:\\AI\\Agy', parentDir: 'E:\\AI\\Agy', filename: 'README.md' },
  });
  assert.strictEqual(out, '查看 README.md (E:\\AI\\Agy) | a%20b');
});

test('createMenuRegistry: priority ordering, enable/disable, clean separators and registerAction', () => {
  const reg = ctxMenu.createMenuRegistry({ disabledModules: ['mod-b'] });
  reg.registerModule({
    id: 'mod-c',
    name: 'C',
    priority: 30,
    getItems: () => [{ id: 'c1', label: 'C1' }],
  });
  reg.registerModule({
    id: 'mod-a',
    name: 'A',
    priority: 10,
    getItems: () => [{ id: 'a1', label: 'A1' }],
  });
  reg.registerModule({
    id: 'mod-b',
    name: 'B',
    priority: 20,
    getItems: () => [{ id: 'b1', label: 'B1' }],
  });
  reg.registerAction({
    id: 'ext-1',
    label: 'External Action',
    when: (ctx) => Boolean(ctx.flag),
    run: () => {},
  });

  const items1 = reg.buildMenuItems({ flag: true }, {});
  const ids1 = items1.map((i) => i.type === 'separator' ? '---' : i.id);
  assert.deepStrictEqual(ids1, ['a1', '---', 'c1', '---', 'ext-1']);

  reg.setModuleEnabled('mod-b', true);
  const items2 = reg.buildMenuItems({ flag: false }, {});
  const ids2 = items2.map((i) => i.type === 'separator' ? '---' : i.id);
  assert.deepStrictEqual(ids2, ['a1', '---', 'b1', '---', 'c1']);
});

test('pluginLoader.resolveSystemPath: resolves real files, ~ home, file:// URL and nearest parent', () => {
  const thisFile = __filename;
  const r1 = loader.resolveSystemPath(thisFile);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.exists, true);
  assert.strictEqual(r1.isFile, true);

  const r2 = loader.resolveSystemPath(ctxMenu.toFileUrl(thisFile) + '#L1-L5');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.exists, true);
  assert.strictEqual(path.resolve(r2.resolvedPath), path.resolve(thisFile));

  const rHome = loader.resolveSystemPath('~');
  assert.strictEqual(rHome.ok, true);
  assert.strictEqual(rHome.exists, true);
  assert.strictEqual(rHome.isDirectory, true);
  assert.strictEqual(path.resolve(rHome.resolvedPath), path.resolve(os.homedir()));

  const nonExist = path.join(__dirname, 'does_not_exist_dir', 'missing.txt');
  const rMissing = loader.resolveSystemPath(nonExist);
  assert.strictEqual(rMissing.ok, true);
  assert.strictEqual(rMissing.exists, false);
  assert.strictEqual(path.resolve(rMissing.nearestExistingParent), path.resolve(__dirname));
});

test('extractCommandFromText: recognizes CLI commands, prompts, env prefixes and PowerShell cmdlets', () => {
  const c1 = ctxMenu.extractCommandFromText('python scripts/manage_plugins.py install');
  assert.ok(c1);
  assert.strictEqual(c1.binary, 'python');
  assert.strictEqual(c1.command, 'python scripts/manage_plugins.py install');

  const c2 = ctxMenu.extractCommandFromText('$ git status --short');
  assert.ok(c2 && c2.binary === 'git' && c2.command === 'git status --short');

  const c3 = ctxMenu.extractCommandFromText('PS E:\\AI\\Agy> npm run build');
  assert.ok(c3 && c3.binary === 'npm' && c3.command === 'npm run build');

  const c4 = ctxMenu.extractCommandFromText('NODE_ENV=test pnpm test');
  assert.ok(c4 && c4.binary === 'pnpm');

  const c5 = ctxMenu.extractCommandFromText('Get-ChildItem -Path . -Force');
  assert.ok(c5);

  const c6 = ctxMenu.extractCommandFromText('./deploy.sh --prod');
  assert.ok(c6);
});

test('extractCommandFromText: does not misclassify versions, filenames, shortcuts or bare nouns', () => {
  assert.strictEqual(ctxMenu.extractCommandFromText('app.asar.staged'), null);
  assert.strictEqual(ctxMenu.extractCommandFromText('v2.4.0'), null);
  assert.strictEqual(ctxMenu.extractCommandFromText('Ctrl+R'), null);
  assert.strictEqual(ctxMenu.extractCommandFromText('python'), null);
  assert.strictEqual(ctxMenu.extractCommandFromText('https://github.com/a/b'), null);
});

test('convertNativeMenuItems & hasNativeCopyItem: preserves native ids, submenus, icons and danger semantics', () => {
  const clicked = [];
  const native = [
    { id: 'rename', label: 'Rename', accelerator: 'F2' },
    { id: 'pin', label: 'Pin', type: 'checkbox', checked: true },
    { type: 'separator' },
    {
      id: 'more',
      label: 'More',
      type: 'submenu',
      submenu: [{ id: 'copy', label: 'Copy' }],
    },
    { id: 'delete', label: 'Delete' },
  ];
  const converted = ctxMenu.convertNativeMenuItems(
    native,
    (id) => clicked.push(id),
    (lbl) => (lbl === 'Rename' ? '重命名' : lbl)
  );
  assert.strictEqual(converted.length, 5);
  assert.strictEqual(converted[0].label, '重命名');
  assert.strictEqual(converted[0].icon, 'edit');
  assert.strictEqual(converted[0].shortcut, 'F2');
  assert.strictEqual(converted[1].icon, 'check');
  assert.strictEqual(converted[2].type, 'separator');
  assert.strictEqual(converted[3].submenu[0].nativeId, 'copy');
  assert.strictEqual(converted[4].danger, true);
  assert.strictEqual(converted[4].icon, 'trash');

  converted[0].onClick();
  converted[3].submenu[0].onClick();
  assert.deepStrictEqual(clicked, ['rename', 'copy']);

  assert.strictEqual(ctxMenu.hasNativeCopyItem([{ id: 'copy', label: 'Copy' }]), true);
  assert.strictEqual(ctxMenu.hasNativeCopyItem([{ id: 'rename', label: '重命名' }]), false);
});

console.log(`All ${passed} tests passed!`);
