const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');

console.log('Testing antigravity-notifier...');

const rootDir = path.join(__dirname, '..');
const notifierPath = path.join(__dirname, 'notifier.js');
const manifestPath = path.join(rootDir, 'plugin.json');
const hooksPath = path.join(rootDir, 'hooks.json');
const loaderPath = path.join(rootDir, 'scripts', 'pluginLoader.js');
const notifyHookPath = path.join(rootDir, 'scripts', 'notify_hook.py');

assert(fs.existsSync(notifierPath), 'runtime/notifier.js must exist');
assert(fs.existsSync(manifestPath), 'plugin.json must exist');
assert(fs.existsSync(hooksPath), 'hooks.json must exist');
assert(fs.existsSync(loaderPath), 'scripts/pluginLoader.js must exist');
assert(fs.existsSync(notifyHookPath), 'scripts/notify_hook.py must exist');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'antigravity-notifier');
assert(Array.isArray(manifest.uiScripts) && manifest.uiScripts.includes('runtime/notifier.js'));

const hooksJson = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
assert(hooksJson['notifier-auto-heal'] && Array.isArray(hooksJson['notifier-auto-heal'].SessionStart));
assert(hooksJson['notifier-stop-webhook'] && Array.isArray(hooksJson['notifier-stop-webhook'].Stop));

const code = fs.readFileSync(notifierPath, 'utf8');
assert(!/\brequire\s*\(/.test(code), 'notifier.js must not call require()');
new vm.Script(code, { filename: 'notifier.js' });

// 1. 纯函数测试
const apiCtx = vm.createContext({
  setTimeout,
  clearTimeout,
  console,
  Date,
  Map,
  Set,
});
apiCtx.window = apiCtx;
vm.runInContext(code, apiCtx, { filename: 'notifier.js' });

const api = apiCtx.__AGY_NOTIFIER_TEST_API__;
assert(api, '__AGY_NOTIFIER_TEST_API__ must be exposed');
const plain = (v) => JSON.parse(JSON.stringify(v));

// 1.1 状态机基线预热与状态跃迁测试
const prevMap = new Map();
const prefs = { ...api.DEFAULT_PREFS, minTaskSeconds: 5 };

// 首次基线：即使有 RUNNING / WAITING 也不得误报
const baselineEvents = plain(
  api.analyzeTrajectoryTransitions(
    prevMap,
    {
      c1: { status: 'CASCADE_RUN_STATUS_RUNNING', summary: '重构模块' },
      c2: { status: 'CASCADE_RUN_STATUS_IDLE', summary: '历史对话' },
    },
    10000,
    prefs,
    true
  )
);
assert.strictEqual(baselineEvents.length, 0, 'Baseline must never emit notifications');

// 2 秒后结束（< 5s 阈值）：不应触发完成通知
const shortDone = plain(
  api.analyzeTrajectoryTransitions(
    prevMap,
    {
      c1: { status: 'CASCADE_RUN_STATUS_IDLE', summary: '重构模块' },
    },
    12000,
    prefs,
    false
  )
);
assert.strictEqual(shortDone.length, 0, 'Short task under minTaskSeconds must be filtered');

// c2 重新开始运行 -> 进入 WAITING -> 立即触发 approval
api.analyzeTrajectoryTransitions(
  prevMap,
  { c2: { status: 'CASCADE_RUN_STATUS_RUNNING', summary: '执行测试' } },
  20000,
  prefs,
  false
);
const waitEvents = plain(
  api.analyzeTrajectoryTransitions(
    prevMap,
    { c2: { status: 'CASCADE_RUN_STATUS_WAITING_FOR_USER', summary: '执行测试' } },
    22000,
    prefs,
    false
  )
);
assert.strictEqual(waitEvents.length, 1);
assert.strictEqual(waitEvents[0].kind, 'approval');

// c2 恢复运行，10 秒后完成（>= 5s）：触发 complete
api.analyzeTrajectoryTransitions(
  prevMap,
  { c2: { status: 'CASCADE_RUN_STATUS_RUNNING', summary: '执行测试' } },
  25000,
  prefs,
  false
);
const doneEvents = plain(
  api.analyzeTrajectoryTransitions(
    prevMap,
    { c2: { status: 'CASCADE_RUN_STATUS_IDLE', summary: '执行测试' } },
    35000,
    prefs,
    false
  )
);
assert.strictEqual(doneEvents.length, 1);
assert.strictEqual(doneEvents[0].kind, 'complete');
assert.strictEqual(doneEvents[0].elapsedSec, 10);

// c3 运行中报错：触发 error
api.analyzeTrajectoryTransitions(
  prevMap,
  { c3: { status: 'CASCADE_RUN_STATUS_RUNNING', summary: '部署构建' } },
  40000,
  prefs,
  false
);
const errEvents = plain(
  api.analyzeTrajectoryTransitions(
    prevMap,
    { c3: { status: 'CASCADE_RUN_STATUS_ERROR', summary: '部署构建' } },
    42000,
    prefs,
    false
  )
);
assert.strictEqual(errEvents.length, 1);
assert.strictEqual(errEvents[0].kind, 'error');

// 1.2 DOM 审批按钮识别测试（必须过滤正文里的普通文本）
assert.strictEqual(
  api.detectApprovalActionInButtons([
    { text: 'Approve', insideProse: true, insideHost: false, width: 60, height: 24 },
    { text: 'Reject', insideProse: true, insideHost: false, width: 60, height: 24 },
  ]).waiting,
  false,
  'Buttons inside prose must be ignored'
);
assert.strictEqual(
  api.detectApprovalActionInButtons([
    { text: '批准', insideProse: false, insideHost: false, width: 64, height: 28 },
    { text: '拒绝', insideProse: false, insideHost: false, width: 64, height: 28 },
  ]).waiting,
  true,
  'Paired approve/reject buttons must trigger waiting'
);
assert.strictEqual(
  api.detectApprovalActionInButtons([
    { text: '仅允许本次', insideProse: false, insideHost: false, width: 80, height: 28 },
  ]).waiting,
  true,
  'Allow-once button must trigger waiting'
);

// 1.3 Webhook JSON 生成测试
const cfgJson = JSON.parse(
  api.buildConfigJson({
    enabled: true,
    provider: 'feishu',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
    secret: 'sec123',
  })
);
assert.strictEqual(cfgJson.provider, 'feishu');
assert.strictEqual(cfgJson.secret, 'sec123');

// 1.4 侧边栏「自定义配置」下方入口定位测试（等间距对齐 + 项目留白推开）
const fakeAutoBtn = {
  textContent: '自动化任务',
  getBoundingClientRect: () => ({ left: 10, top: 76, right: 230, bottom: 108, width: 220, height: 32 }),
};
const fakeProjectsHeader = {
  textContent: '项目',
  style: {},
  dataset: {},
  _shifted: 0,
  getBoundingClientRect() {
    const baseTop = 182 + this._shifted;
    return { left: 12, top: baseTop, bottom: baseTop + 18, width: 80, height: 18 };
  },
};
const fakeSidebarParent = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 242, bottom: 800, width: 242, height: 800 }),
  contains: () => true,
  querySelectorAll: () => [fakeProjectsHeader],
};
const fakeCustomBtn = {
  textContent: '自定义配置',
  getBoundingClientRect: () => ({ left: 10, top: 112, right: 230, bottom: 144, width: 220, height: 32 }),
  parentElement: fakeSidebarParent,
};
fakeProjectsHeader.parentElement = fakeSidebarParent;
Object.defineProperty(fakeProjectsHeader.style, 'marginTop', {
  set(v) { fakeProjectsHeader._shifted = parseFloat(v) || 0; },
  get() { return fakeProjectsHeader._shifted + 'px'; },
  configurable: true,
});
const geo = plain(
  api.locateSidebarEntryGeometry(
    {
      querySelectorAll: () => [fakeAutoBtn, fakeCustomBtn],
      elementFromPoint: () => fakeCustomBtn,
    },
    {
      innerHeight: 800,
      getComputedStyle: (el) =>
        el === fakeProjectsHeader
          ? { marginTop: '0px' }
          : { fontSize: '13px', fontWeight: '500', paddingLeft: '10px', color: 'rgb(212, 212, 216)' },
    }
  )
);
assert.strictEqual(geo.visible, true);
assert.strictEqual(geo.left, 10);
assert.strictEqual(geo.top, 148, 'Vertical pitch must match Automations -> Customizations (36px)');
assert.strictEqual(geo.height, 32);
assert.strictEqual(geo.width, 220);
assert.strictEqual(geo.sidebarRight, 242);
assert.strictEqual(geo.isZh, true);
assert(
  fakeProjectsHeader.getBoundingClientRect().top - (geo.top + geo.height) >= 16,
  'Projects header must keep breathing room below Remote Push button'
);

// 2. Python Stop Hook 安全性与载荷构建测试
const pyCheck = spawnSync(
  'python',
  [
    '-c',
    [
      'import sys, json;',
      `sys.path.insert(0, ${JSON.stringify(path.join(rootDir, 'scripts'))});`,
      'import notify_hook;',
      'ev = notify_hook.classify_stop_event({"terminationReason":"NO_TOOL_CALL","workspacePaths":["E:/AI/Agy"],"modelName":"Gemini","lastUserInput":"修复bug"}, {"notifyOnComplete":True,"titlePrefix":"AGY"});',
      'assert ev["kind"] == "complete";',
      'u, h, b = notify_hook.build_webhook_request({"provider":"feishu","webhookUrl":"https://open.feishu.cn/hook","secret":"s1"}, ev);',
      'assert b["msg_type"] == "interactive" and "sign" in b;',
      'u2, h2, b2 = notify_hook.build_webhook_request({"provider":"wecom","webhookUrl":"https://qyapi.weixin.qq.com/hook"}, ev);',
      'assert b2["msgtype"] == "markdown";',
      'u3, h3, b3 = notify_hook.build_webhook_request({"provider":"telegram","telegramBotToken":"123:abc","telegramChatId":"999"}, ev);',
      'assert "api.telegram.org/bot123:abc/sendMessage" in u3 and b3["chat_id"] == "999";',
      'ok_bad, _ = notify_hook.deliver_webhook({"provider":"custom","webhookUrl":"file:///etc/passwd"}, ev);',
      'assert ok_bad is False;',
      'print("py_ok");',
    ].join(' '),
  ],
  { encoding: 'utf8' }
);
assert.strictEqual(pyCheck.status, 0, `Python notify_hook check failed: ${pyCheck.stderr}`);
assert(pyCheck.stdout.includes('py_ok'));

// 3. 链式挂钩 EARLY_RPC_TAP 兼容性测试（不覆盖已有兄弟插件回调）
let siblingHeaderCalled = false;
let siblingRpcCalled = false;
const fakeNotifications = [];
function FakeNotification(title, opts) {
  fakeNotifications.push({ title, opts });
}
FakeNotification.permission = 'granted';

function makeFakeEl(tag) {
  return {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    style: { cssText: '' },
    children: [],
    listeners: {},
    attachShadow() {
      const sr = makeFakeEl('shadow-root');
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    },
    setAttribute(k, v) { if (k === 'id') this.id = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener(t, fn) {
      this.listeners[t] = this.listeners[t] || [];
      this.listeners[t].push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of this.listeners[ev.type] || []) fn(ev);
    },
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : '';
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      const walk = (n) => {
        for (const c of n.children || []) {
          if (id && c.id === id) return c;
          if (cls && String(c.className || '').split(/\s+/).includes(cls)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(this);
    },
    getElementById(id) { return this.querySelector('#' + id); },
    set innerHTML(v) { if (v === '') this.children = []; },
    set textContent(v) { this._t = String(v); },
  };
}
const fakeBody = makeFakeEl('body');
const fakeSidebarAnchor = {
  textContent: '自定义配置',
  getBoundingClientRect: () => ({ left: 10, top: 112, right: 230, bottom: 144, width: 220, height: 32 }),
  parentElement: {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 242, bottom: 800, width: 242, height: 800 }),
    contains: () => true,
    querySelectorAll: () => [],
  },
};
const fakeDoc = {
  body: fakeBody,
  title: 'Antigravity',
  hidden: true,
  hasFocus: () => false,
  createElement: (t) => makeFakeEl(t),
  createTextNode: (t) => ({ nodeType: 3, text: String(t) }),
  getElementById: (id) => fakeBody.children.find((c) => c.id === id) || null,
  querySelectorAll: () => [fakeSidebarAnchor],
  elementFromPoint: () => fakeSidebarAnchor,
  addEventListener() {},
};

const domCtx = vm.createContext({
  document: fakeDoc,
  Notification: FakeNotification,
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  },
  getComputedStyle: () => ({ backgroundColor: 'rgb(24, 24, 28)' }),
  addEventListener() {},
  __AGY_ON_RPC_HEADERS__: () => { siblingHeaderCalled = true; },
  __AGY_ON_RPC_DATA__: () => { siblingRpcCalled = true; },
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  console,
  Date,
  Map,
  Set,
});
domCtx.window = domCtx;
vm.runInContext(code, domCtx, { filename: 'notifier.js' });

domCtx.__AGY_ON_RPC_HEADERS__({ 'x-codeium-csrf-token': 'tok' });
domCtx.__AGY_ON_RPC_DATA__('GetAllCascadeTrajectories', {
  trajectorySummaries: {
    'cid-1': { status: 'CASCADE_RUN_STATUS_RUNNING', summary: '长耗时构建' },
  },
});
assert(siblingHeaderCalled && siblingRpcCalled, 'Must preserve sibling RPC tap callbacks');

// 模拟 8 秒后任务完成且窗口处于后台 -> 触发 Notification
const realNow = Date.now;
domCtx.Date.now = () => realNow() + 8000;
domCtx.__AGY_ON_RPC_DATA__('GetAllCascadeTrajectories', {
  trajectorySummaries: {
    'cid-1': { status: 'CASCADE_RUN_STATUS_IDLE', summary: '长耗时构建' },
  },
});
assert.strictEqual(fakeNotifications.length, 1, 'Must fire desktop notification on completion');
assert(fakeNotifications[0].title.includes('任务已完成'));

// 4. 左侧栏「远程推送」入口已迁移至原生 MCP App，不再向左侧栏 DOM 注入按钮
const hostEl = fakeDoc.getElementById('agy-notifier-host');
const sidebarBtn = hostEl.shadowRoot.getElementById('agy-notifier-sidebar-btn');
assert.strictEqual(sidebarBtn, null, 'Legacy injected sidebar button must not render (migrated to native MCP App)');

console.log('All antigravity-notifier tests passed!');
