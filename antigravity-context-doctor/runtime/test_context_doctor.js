const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('Testing antigravity-context-doctor...');

const rootDir = path.join(__dirname, '..');
const scriptPath = path.join(__dirname, 'context-doctor.js');
const manifestPath = path.join(rootDir, 'plugin.json');
const hooksPath = path.join(rootDir, 'hooks.json');
const loaderPath = path.join(rootDir, 'scripts', 'pluginLoader.js');

assert(fs.existsSync(scriptPath), 'runtime/context-doctor.js must exist');
assert(fs.existsSync(manifestPath), 'plugin.json must exist');
assert(fs.existsSync(hooksPath), 'hooks.json must exist');
assert(fs.existsSync(loaderPath), 'scripts/pluginLoader.js must exist');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'antigravity-context-doctor');
assert(Array.isArray(manifest.uiScripts) && manifest.uiScripts.includes('runtime/context-doctor.js'));

const code = fs.readFileSync(scriptPath, 'utf8');
assert(!/\brequire\s*\(/.test(code), 'context-doctor.js must not call require()');
new vm.Script(code, { filename: 'context-doctor.js' });

// ==================== 1. 纯逻辑单元测试 ====================

let prevHeaderCalled = false;
let prevCascadeCalled = false;
let prevRpcCalled = false;

const apiCtx = vm.createContext({
  window: null,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  console,
  Date,
  Map,
  Set,
  Math,
  Promise,
  JSON,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Error,
});

apiCtx.window = apiCtx;
apiCtx.__AGY_I18N_ACTIVE__ = true;
apiCtx.__AGY_ON_RPC_HEADERS__ = () => {
  prevHeaderCalled = true;
};
apiCtx.__AGY_ON_CASCADE_CHANGE__ = () => {
  prevCascadeCalled = true;
};
apiCtx.__AGY_ON_RPC_DATA__ = () => {
  prevRpcCalled = true;
};
apiCtx.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
};
apiCtx.addEventListener = () => {};
apiCtx.fetch = () =>
  Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });

vm.runInContext(code, apiCtx, { filename: 'context-doctor.js' });

const api = apiCtx.__AGY_CONTEXT_DOCTOR_TEST_API__;
assert(api, '__AGY_CONTEXT_DOCTOR_TEST_API__ must be exposed');

// 验证链式 RPC Tap 共存，不会覆盖前置插件回调
apiCtx.__AGY_ON_RPC_HEADERS__({ 'x-codeium-csrf-token': 'tok-123' });
apiCtx.__AGY_ON_CASCADE_CHANGE__('cid-1', 'GetCascadeTrajectory');
apiCtx.__AGY_ON_RPC_DATA__('GetUserStatus', {});
assert.strictEqual(prevHeaderCalled, true, 'must chain previous __AGY_ON_RPC_HEADERS__');
assert.strictEqual(prevCascadeCalled, true, 'must chain previous __AGY_ON_CASCADE_CHANGE__');
assert.strictEqual(prevRpcCalled, true, 'must chain previous __AGY_ON_RPC_DATA__');

// 1.1 resolveModelContextLimit
assert.strictEqual(api.resolveModelContextLimit('Gemini 4 Hydrogen', '', {}), 1000000);
assert.strictEqual(api.resolveModelContextLimit('Claude Sonnet 4.5', '', {}), 200000);
assert.strictEqual(api.resolveModelContextLimit('Claude Sonnet 4.5 (1M)', '', {}), 1000000);
assert.strictEqual(
  api.resolveModelContextLimit('Claude Sonnet 4.5', '', { 'Claude Sonnet 4.5': 400000 }),
  400000
);

// 1.2 estimateTokensFromText
assert(api.estimateTokensFromText('你好世界') >= 4);
assert(api.estimateTokensFromText('a'.repeat(100)) >= 25);

// 1.3 parseGeneratorCalls: 含压缩检测与双口径 Cache 统计
const enumMap = new Map([['MODEL_GEMINI_4', 'Gemini 4 Hydrogen (High)']]);
const genStats = api.parseGeneratorCalls(
  [
    {
      executionId: 'e1',
      timestamp: '2026-11-22T10:00:00Z',
      chatModel: {
        model: 'MODEL_GEMINI_4',
        streamingDuration: '2.0s',
        usage: {
          inputTokens: 120000,
          cacheReadTokens: 80000,
          outputTokens: 2000,
          thinkingOutputTokens: 500,
        },
      },
    },
    {
      executionId: 'e2',
      timestamp: '2026-11-22T10:01:00Z',
      chatModel: {
        model: 'MODEL_GEMINI_4',
        streamingDuration: '1.0s',
        usage: {
          inputTokens: 160000,
          cacheReadTokens: 120000,
          outputTokens: 1000,
        },
      },
    },
    {
      // 模拟压缩事件：上下文骤降 >25% 且 >8K
      executionId: 'e3',
      timestamp: '2026-11-22T10:02:00Z',
      chatModel: {
        model: 'MODEL_GEMINI_4',
        streamingDuration: '1.0s',
        usage: {
          inputTokens: 60000,
          cacheReadTokens: 40000,
          outputTokens: 800,
        },
      },
    },
  ],
  enumMap
);

assert.strictEqual(genStats.callCount, 3);
assert.strictEqual(genStats.compactionCount, 1);
assert.strictEqual(genStats.spikeCount, 1);
assert.strictEqual(genStats.latestCall.promptContextTokens, 60000);
assert.strictEqual(genStats.latestCall.model, 'Gemini 4 Hydrogen (High)');
assert(genStats.cacheHitRate > 65);

// 1.4 extractStepsFromTrajectoryResponse & analyzeTrajectorySteps
const steps = api.extractStepsFromTrajectoryResponse({
  trajectory: {
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { query: '请帮我排查登录接口超时问题' } },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        viewFile: { absolutePath: 'e:/repo/auth.ts', content: 'x'.repeat(8000) },
      },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        viewFile: { absolutePath: 'e:/repo/auth.ts', content: 'y'.repeat(1000) },
      },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        viewFile: { absolutePath: 'e:/repo/auth.ts', content: 'z'.repeat(1000) },
      },
      {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_ERROR',
        runCommand: {
          commandLine: 'npm test',
          combinedOutput: { full: 'FAIL auth.test.ts\n' + 'log line\n'.repeat(1200) },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        codeAction: { targetFile: 'e:/repo/auth.ts', replacement: 'fix timeout' },
      },
      {
        type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
        invokeSubagent: { role: 'Log Analyzer', conversationId: 'sub-1', prompt: 'Analyze auth logs' },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        plannerResponse: {
          thinking: 'Checking timeout config',
          response: '已定位到 Redis 连接池未释放导致登录超时，并已修复 auth.ts。',
        },
      },
    ],
  },
});

const stepStats = api.analyzeTrajectorySteps(steps);
assert.strictEqual(stepStats.stepCount, 8);
assert.strictEqual(stepStats.repeatedReads.length, 1);
assert.strictEqual(stepStats.repeatedReads[0].path, 'e:/repo/auth.ts');
assert.strictEqual(stepStats.repeatedReads[0].reads, 3);
assert.strictEqual(stepStats.repeatedReads[0].edits, 1);
assert.strictEqual(stepStats.subagentCalls.length, 1);
assert.strictEqual(stepStats.recentErrors.length, 1);
assert(stepStats.heavyHitters[0].estTokens >= stepStats.heavyHitters[1].estTokens);
assert.strictEqual(stepStats.categories.command.count, 1);

// 1.5 buildContextInsights (7-day + fleet)
const nowMs = Date.parse('2026-11-23T08:00:00Z');
const genByCid = new Map([
  [
    'cid-main',
    [
      {
        executionId: 'e1',
        timestamp: '2026-11-23T06:00:00Z',
        chatModel: {
          model: 'MODEL_GEMINI_4',
          usage: { inputTokens: 880000, cacheReadTokens: 600000, outputTokens: 5000 },
        },
      },
    ],
  ],
  [
    'sub-1',
    [
      {
        executionId: 'se1',
        timestamp: '2026-11-23T06:05:00Z',
        chatModel: {
          model: 'MODEL_GEMINI_4',
          usage: { inputTokens: 15000, cacheReadTokens: 0, outputTokens: 1200 },
        },
      },
    ],
  ],
]);

const insights = api.buildContextInsights(
  {
    'cid-main': {
      summary: '修复登录超时',
      stepCount: 8,
      lastModifiedTime: '2026-11-23T06:10:00Z',
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
    'sub-1': {
      summary: 'Log Analyzer',
      stepCount: 3,
      lastModifiedTime: '2026-11-23T06:08:00Z',
      parentCascadeId: 'cid-main',
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
  },
  genByCid,
  enumMap,
  {},
  nowMs
);

assert.strictEqual(insights.daily7d.length, 7);
assert.strictEqual(insights.activeSessionsCount, 1);
assert(insights.total7dTokens > 890000);
assert.strictEqual(insights.sessions.find((s) => s.cascadeId === 'sub-1').isSubtrajectory, true);

// 1.6 diagnoseContextHealth & generateHandoffPrompt
const activeAnalysis = {
  cascadeId: 'cid-main',
  summary: '修复登录超时',
  model: 'Gemini 4 Hydrogen',
  windowLimit: 1000000,
  latestContextTokens: 880000,
  occupancyPct: 88,
  genStats,
  stepStats,
};

const diags = api.diagnoseContextHealth(
  activeAnalysis,
  { warnThresholdPct: 75, criticalThresholdPct: 90 },
  true
);
assert(diags.some((d) => d.level === 'warning'));

const handoffZh = api.generateHandoffPrompt(
  activeAnalysis,
  { includeGoal: true, includeFiles: true, includeCommands: true, includeConclusions: true, includeDiagnostics: true },
  true
);
assert(handoffZh.includes('修复登录超时'));
assert(handoffZh.includes('e:/repo/auth.ts'));
assert(handoffZh.includes('npm test'));

const handoffEn = api.generateHandoffPrompt(
  activeAnalysis,
  { includeGoal: true, includeFiles: true, includeCommands: true, includeConclusions: true, includeDiagnostics: true },
  false
);
assert(handoffEn.includes('Session Handoff'));

// ==================== 2. Shadow DOM 渲染集成测试 ====================

function makeFakeElement(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    value: '',
    style: { cssText: '' },
    attributes: {},
    children: [],
    parentNode: null,
    parentElement: null,
    listeners: {},
    shadowRoot: null,
    _rect: { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
    getBoundingClientRect() {
      return this._rect;
    },
    closest() {
      return null;
    },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode || cur.parentElement;
      }
      return false;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) {
      return this.attributes[k] || null;
    },
    appendChild(child) {
      if (!child) return child;
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (!child) return child;
      child.parentNode = this;
      child.parentElement = this;
      const idx = this.children.indexOf(ref);
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
        child.parentElement = null;
      }
      return child;
    },
    addEventListener(evt, fn) {
      if (!this.listeners[evt]) this.listeners[evt] = [];
      this.listeners[evt].push(fn);
    },
    removeEventListener() {},
    attachShadow() {
      const sr = makeFakeElement('shadow-root');
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length > 0 ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const stack = [...this.children];
      while (stack.length) {
        const cur = stack.shift();
        if (cur.nodeType === 1) {
          if (
            (sel === 'input.input' && cur.tagName === 'INPUT') ||
            (sel === '[data-agy-cd-menu-item="1"]' && cur.getAttribute('data-agy-cd-menu-item') === '1') ||
            (sel === '[data-agy-cd-tab="1"]' && cur.getAttribute('data-agy-cd-tab') === '1') ||
            (sel === '.agy-cd-menu-badge' && String(cur.className).includes('agy-cd-menu-badge')) ||
            (sel === '.agy-cd-aux-tab-lbl' && String(cur.className).includes('agy-cd-aux-tab-lbl')) ||
            (sel === '.agy-cd-aux-tab-pct' && String(cur.className).includes('agy-cd-aux-tab-pct'))
          ) {
            out.push(cur);
          }
          if (cur.children && cur.children.length) stack.push(...cur.children);
        }
      }
      return out;
    },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
  Object.defineProperty(node, 'nextSibling', {
    get() {
      const p = node.parentNode;
      if (!p || !Array.isArray(p.children)) return null;
      const idx = p.children.indexOf(node);
      return idx !== -1 && idx + 1 < p.children.length ? p.children[idx + 1] : null;
    },
  });
  Object.defineProperty(node, 'textContent', {
    get() {
      if (node._txt) return node._txt;
      if (node.children && node.children.length) {
        return node.children.map((c) => c.textContent || '').join('');
      }
      return '';
    },
    set(v) {
      node._txt = String(v || '');
      if (v === '') node.children = [];
    },
  });
  return node;
}

const fakeBody = makeFakeElement('body');
const fakeHead = makeFakeElement('head');

// 模拟原生右侧边栏、顶部原生标签栏（审查确认 +）与「插件 > Swarm」子菜单
const mockAuxWrapper = makeFakeElement('div');
mockAuxWrapper._rect = { left: 480, top: 4, width: 780, height: 780, right: 1260, bottom: 784 };

const mockTabStrip = makeFakeElement('div');
mockTabStrip._rect = { left: 492, top: 6, width: 320, height: 30, right: 812, bottom: 36 };
const mockReviewTab = makeFakeElement('button');
mockReviewTab.setAttribute('role', 'tab');
mockReviewTab.textContent = '审查确认';
mockReviewTab._rect = { left: 496, top: 8, width: 92, height: 26, right: 588, bottom: 34 };
const mockPlusBtn = makeFakeElement('button');
mockPlusBtn.textContent = '+';
mockPlusBtn._rect = { left: 594, top: 8, width: 26, height: 26, right: 620, bottom: 34 };
mockTabStrip.appendChild(mockReviewTab);
mockTabStrip.appendChild(mockPlusBtn);

const mockAuxPane = makeFakeElement('div');
mockAuxPane._rect = { left: 480, top: 40, width: 780, height: 744, right: 1260, bottom: 784 };
const mockUrlInput = makeFakeElement('input');
mockUrlInput.setAttribute('placeholder', 'Search or enter a URL');
mockUrlInput._rect = { left: 540, top: 90, width: 520, height: 34, right: 1060, bottom: 124 };
mockAuxPane.appendChild(mockUrlInput);

mockAuxWrapper.appendChild(mockTabStrip);
mockAuxWrapper.appendChild(mockAuxPane);

const mockPluginsPopup = makeFakeElement('div');
mockPluginsPopup._rect = { left: 540, top: 360, width: 220, height: 96, right: 760, bottom: 456 };
const mockPopupHeader = makeFakeElement('div');
mockPopupHeader.textContent = '插件';
const mockSwarmBtn = makeFakeElement('button');
mockSwarmBtn.className = 'native-menu-item';
mockSwarmBtn.setAttribute('role', 'menuitem');
mockSwarmBtn.textContent = 'Swarm';
mockPluginsPopup.appendChild(mockPopupHeader);
mockPluginsPopup.appendChild(mockSwarmBtn);
fakeBody.appendChild(mockAuxWrapper);
fakeBody.appendChild(mockPluginsPopup);

const fakeDoc = {
  readyState: 'complete',
  documentElement: { lang: 'zh-CN' },
  head: fakeHead,
  body: fakeBody,
  createElement: (tag) => makeFakeElement(tag),
  createElementNS: (_ns, tag) => makeFakeElement(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t || '') }),
  getElementById(id) {
    const stack = [...fakeHead.children, ...fakeBody.children];
    while (stack.length) {
      const cur = stack.shift();
      if (cur.id === id) return cur;
      if (cur.children) stack.push(...cur.children);
    }
    return null;
  },
  querySelectorAll(sel) {
    const out = [];
    const stack = [...fakeBody.children];
    const tags = new Set(sel.split(',').map((s) => s.trim().toUpperCase()));
    while (stack.length) {
      const cur = stack.shift();
      if (cur.nodeType === 1) {
        const matchTag = tags.has(cur.tagName);
        const matchAttr =
          (sel.includes('[data-agy-cd-menu-item="1"]') && cur.getAttribute('data-agy-cd-menu-item') === '1') ||
          (sel.includes('[data-agy-cd-tab="1"]') && cur.getAttribute('data-agy-cd-tab') === '1') ||
          (sel.includes('input[placeholder]') && cur.tagName === 'INPUT' && cur.getAttribute('placeholder')) ||
          (sel.includes('[role="tab"]') && cur.getAttribute('role') === 'tab') ||
          (sel.includes('[role="menu"]') && cur.getAttribute('role') === 'menu') ||
          (sel.includes('[role="menuitem"]') && cur.getAttribute('role') === 'menuitem') ||
          (sel.includes('[role="button"]') && cur.getAttribute('role') === 'button');
        if (matchTag || matchAttr) out.push(cur);
        if (cur.children && cur.children.length) stack.push(...cur.children);
      }
    }
    return out;
  },
  addEventListener: () => {},
  dispatchEvent: () => true,
};

const domCtx = vm.createContext({
  window: null,
  document: fakeDoc,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: (fn) => {
    fn();
    return 1;
  },
  console,
  Date,
  Map,
  Set,
  Math,
  Promise,
  JSON,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Error,
  innerWidth: 1280,
  innerHeight: 800,
});
domCtx.window = domCtx;
domCtx.__AGY_I18N_ACTIVE__ = true;
domCtx.getComputedStyle = () => ({ backgroundColor: 'rgb(20, 22, 27)', borderRadius: '10px' });
domCtx.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
};
domCtx.addEventListener = () => {};
domCtx.removeEventListener = () => {};
domCtx.fetch = () =>
  Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });

vm.runInContext(code, domCtx, { filename: 'context-doctor.js' });

const hostEl = fakeDoc.getElementById('agy-context-doctor-host');
assert(hostEl && hostEl.shadowRoot, 'Shadow DOM host #agy-context-doctor-host must be mounted');

const domApi = domCtx.__AGY_CONTEXT_DOCTOR_TEST_API__;
const st = domApi.getState();
assert.strictEqual(st.prefs.showEdgeTab, false, 'floating edge tab must be disabled by default');

st.activeCascadeId = 'cid-main';
st.rawSources.trajectories = {
  trajectorySummaries: {
    'cid-main': { summary: '测试会话', stepCount: 8, lastModifiedTime: '2026-11-23T06:10:00Z' },
  },
};
st.generatorCache.set('cid-main', { stamp: '1', list: genByCid.get('cid-main') });
st.stepsCache.set('cid-main', { stamp: '1', steps });

// 验证注入到原生「插件 >」子菜单（boot 时已自动注入且多次调用保持幂等不重复）
domApi.renderAll();
domApi.syncPluginsMenuInjection();
const injectedItems = fakeDoc.querySelectorAll('[data-agy-cd-menu-item="1"]');
assert.strictEqual(injectedItems.length, 1, 'must inject exactly one Context Doctor item into Plugins submenu');
assert(injectedItems[0].textContent.includes('上下文洞察'));

// 验证识别顶部原生标签栏并停靠在标签栏下方内容区
const stripInfo = domApi.locateNativeAuxTabStrip();
assert.strictEqual(stripInfo.found, true, 'must detect native Aux Pane top tab strip');

const auxRect = domApi.locateNativeAuxPane();
assert.strictEqual(auxRect.found, true, 'must detect native Aux Pane rect');
assert.strictEqual(auxRect.hasNativeTabStrip, true);
assert.strictEqual(auxRect.left, 480);
assert.strictEqual(auxRect.width, 780);
assert(auxRect.top >= 38, 'content area must sit strictly below the native top tab strip');

domApi.openContextDoctorInPane(false);
assert.strictEqual(st.tabOpen, true);
assert.strictEqual(st.prefs.open, true);
assert.strictEqual(st.openedInNativePane, true);

// 验证分页标签已插入到「审查确认」之后、「+」之前
const injectedTabs = fakeDoc.querySelectorAll('[data-agy-cd-tab="1"]');
assert.strictEqual(injectedTabs.length, 1, 'must inject one tab into native Aux Pane tab strip');
assert.strictEqual(injectedTabs[0].getAttribute('data-active'), 'true');
assert.strictEqual(mockTabStrip.children[1], injectedTabs[0], 'injected tab must sit before + button');

for (const tab of ['overview', 'hitters', 'fleet', 'insights', 'handoff']) {
  st.prefs.activeTab = tab;
  domApi.recomputeState();
  domApi.renderAll();
}

// 切到原生「审查确认」分页时保留标签但隐藏内容
domApi.switchAwayFromContextDoctor();
assert.strictEqual(st.tabOpen, true);
assert.strictEqual(st.prefs.open, false);
assert.strictEqual(fakeDoc.querySelectorAll('[data-agy-cd-tab="1"]').length, 1);
assert.strictEqual(injectedTabs[0].getAttribute('data-active'), 'false');

// 彻底关闭分页标签后移除 DOM 标签
domApi.closeContextDoctor();
assert.strictEqual(st.tabOpen, false);
assert.strictEqual(st.prefs.open, false);
assert.strictEqual(fakeDoc.querySelectorAll('[data-agy-cd-tab="1"]').length, 0);

console.log('All antigravity-context-doctor tests passed!');
