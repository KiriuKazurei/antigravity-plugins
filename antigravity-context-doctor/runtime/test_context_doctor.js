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
assert.strictEqual(api.resolveModelContextLimit('custom-v2m', 'MODEL_V1M', {}), 1000000);
assert.strictEqual(api.resolveModelContextLimit('Claude v2m', 'MODEL_V1M', {}), 200000);

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

assert.strictEqual(typeof api.computeSquarifiedTreemap, 'function', 'expose the area layout');
assert.strictEqual(api.computeSquarifiedTreemap([]).length, 0);
const solo = api.computeSquarifiedTreemap([{ id: 'solo', value: 2 }], 5, 10, 70, 30)[0];
assert.deepStrictEqual([solo.x, solo.y, solo.w, solo.h], [5, 10, 70, 30]);
for (const values of [[7, 20, 7, 50, -1, 0, 16], [1, 1, 1, 1], [1, 1000000, 3, 2]]) {
  const positive = values.filter(value => value > 0);
  const total = positive.reduce((sum, value) => sum + value, 0);
  const tiles = api.computeSquarifiedTreemap(values.map((value, id) => ({ value, id })));
  assert.strictEqual(tiles.length, positive.length);
  assert.strictEqual(new Set(tiles.map(tile => tile.id)).size, tiles.length);
  tiles.forEach((tile, index) => {
    assert(tile.w > 0 && tile.h > 0 && tile.x >= 0 && tile.y >= 0);
    assert(tile.x + tile.w <= 100 && tile.y + tile.h <= 100);
    const fraction = values[tile.id] / total;
    assert(Math.abs(tile.w * tile.h / 10000 / fraction - 1) < 0.005);
    if (values.every(value => value === 1)) assert.strictEqual(tile.w, tile.h);
    for (const other of tiles.slice(index + 1)) {
      const overlap = (axis, size) => Math.min(tile[axis] + tile[size], other[axis] + other[size]) - Math.max(tile[axis], other[axis]);
      assert(overlap('x', 'w') < 1e-10 || overlap('y', 'h') < 1e-10);
    }
  });
}

const makeModel = (latest, limit, stats = stepStats, zh = true) => api.buildContextTreemapModel({
  latestContextTokens: latest, windowLimit: limit, stepStats: stats,
}, zh);
const measured = stepStats.totalStepTokens + 123;
const windowModel = makeModel(measured, measured * 10);
assert.strictEqual(windowModel.usedTokens, measured);
assert.strictEqual(windowModel.remainingTokens, measured * 9);
assert.strictEqual(windowModel.occupancyPct, 10);
const overhead = windowModel.categories.find(cat => cat.key === 'system_overhead');
assert.deepStrictEqual([overhead.label, overhead.tokens], ['系统提示词', 123]);
const free = windowModel.windowTiles.find(tile => tile.key === 'remaining');
assert.deepStrictEqual([free.x, free.w, free.shareOfWindow], [28, 72, 90]);
assert.strictEqual(makeModel(measured, measured * 2).windowTiles.find(tile => tile.key === 'remaining').x, 50);
assert(!windowModel.usedTiles.some(tile => tile.key === 'remaining'));
for (const tile of windowModel.usedTiles) {
  assert(Math.abs(tile.w * tile.h / 100 - tile.tokens / measured * 100) < 1e-8);
  const part = windowModel.windowTiles.find(item => item.key === tile.key);
  assert(Math.abs(part.w * part.h / 28 - tile.shareOfUsed) < 1e-8);
}
const sumTokens = items => items.reduce((sum, item) => sum + item.tokens, 0);
const scaled = makeModel(701, 500);
assert.strictEqual(sumTokens(scaled.categories), 701);
assert.strictEqual(sumTokens(scaled.detailItems), 701);
assert.strictEqual(scaled.remainingTokens, 0);
assert(!scaled.windowTiles.some(tile => tile.key === 'remaining'));
assert(!scaled.categories.some(cat => cat.key === 'system_overhead'));
for (const cat of scaled.categories) {
  assert(Math.abs(cat.tokens - 701 * stepStats.categories[cat.key].sharePct / 100) < 1);
}
assert.strictEqual(makeModel(0, measured).usedTokens, stepStats.totalStepTokens);
const emptyModel = makeModel(0, 100, api.analyzeTrajectorySteps([]));
assert.strictEqual(emptyModel.windowTiles[0].w, 100);
assert.strictEqual(emptyModel.usedTiles.length, 0);
const groupedStats = api.analyzeTrajectorySteps([...steps, ...steps, {
  type: 'RUN_COMMAND', runCommand: { commandLine: 'npm test --verbose', output: 'final line' },
}]);
const grouped = makeModel(groupedStats.totalStepTokens, measured, groupedStats, false);
assert.strictEqual(grouped.detailItems.find(item => item.category === 'command').count, 3);
assert.strictEqual(grouped.detailItems.find(item => item.category === 'agent_tool').count, 2);
assert.strictEqual(grouped.detailItems.filter(item => item.category === 'user').length, 2);
assert.strictEqual(grouped.detailItems.filter(item => item.category === 'assistant').length, 2);
const reads = windowModel.detailItems.find(item => item.category === 'file_read');
assert(reads.label.includes('auth.ts') && reads.count === 3 && reads.tokens === stepStats.categories.file_read.estTokens);
assert(reads.preview.includes('x'.repeat(1500)) && reads.preview.includes('z'.repeat(100)));
assert(windowModel.detailItems.find(item => item.category === 'command').isError);
assert(windowModel.detailItems.some(item => item.tag === 'system' && item.tokens === 123));
assert(windowModel.detailItems.every((item, index, items) => !index || item.tokens <= items[index - 1].tokens));

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
      if (child.parentNode) child.parentNode.removeChild(child);
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
      const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const tags = new Set(parts.map((s) => s.toUpperCase()));
      while (stack.length) {
        const cur = stack.shift();
        if (cur.nodeType === 1) {
          const matched =
            tags.has(cur.tagName) ||
            (/^\.[\w-]+$/.test(sel) && cur.className.split(/\s+/).includes(sel.slice(1))) ||
            (sel === 'input.input' && cur.tagName === 'INPUT') ||
            (sel === '.sidebar' && String(cur.className).includes('sidebar')) ||
            (sel.includes('[data-agy-cd-menu-item="1"]') && cur.getAttribute('data-agy-cd-menu-item') === '1') ||
            (sel.includes('[data-agy-cd-tab="1"]') && cur.getAttribute('data-agy-cd-tab') === '1') ||
            (sel.includes('[role="tab"]') && cur.getAttribute('role') === 'tab') ||
            (sel.includes('[role="button"]') && cur.getAttribute('role') === 'button') ||
            (sel.includes('[data-state]') && cur.getAttribute('data-state') !== null) ||
            (sel === '.agy-cd-menu-badge' && String(cur.className).includes('agy-cd-menu-badge')) ||
            (sel === '.agy-cd-aux-tab-lbl' && String(cur.className).includes('agy-cd-aux-tab-lbl')) ||
            (sel === '.agy-cd-aux-tab-pct' && String(cur.className).includes('agy-cd-aux-tab-pct'));
          if (matched) {
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
const docListeners = {};
let notifyHostMutation;

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
  addEventListener(type, listener) { docListeners[type] = listener; },
  dispatchEvent: () => true,
};

const domCtx = vm.createContext({
  window: null,
  document: fakeDoc,
  MutationObserver: class {
    constructor(callback) { notifyHostMutation = callback; }
    observe() {}
  },
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

domCtx.localStorage.setItem('agy_context_doctor_prefs_v2', JSON.stringify({ open: true }));
fakeBody.removeChild(mockAuxWrapper);
vm.runInContext(code, domCtx, { filename: 'context-doctor.js' });

const hostEl = fakeDoc.getElementById('agy-context-doctor-host');
assert(hostEl && hostEl.shadowRoot, 'Shadow DOM host #agy-context-doctor-host must be mounted');

const domApi = domCtx.__AGY_CONTEXT_DOCTOR_TEST_API__;
const st = domApi.getState();
const sidebar = hostEl.shadowRoot.querySelector('.sidebar');
const isClosed = () => sidebar.className.split(/\s+/).includes('closed');
assert(isClosed(), 'restoring open prefs on the welcome page must not show a floating panel');
fakeBody.appendChild(mockAuxWrapper);
notifyHostMutation([{ target: fakeBody }]);
assert(!isClosed() && mockTabStrip.querySelector('[data-agy-cd-tab="1"]'), 'restore must dock when the native strip mounts');
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

{
  st.stepsCache.set('cid-main', { stamp: '2', steps: steps.concat(Array(11).fill(steps[0])) });
  domApi.recomputeState();
  domApi.renderAll();
  const root = hostEl.shadowRoot;
  const all = selector => root.querySelectorAll(selector);
  const byKey = (selector, key) => all(selector).find(node => node.getAttribute('data-category') === key);
  const click = node => { assert(node, 'control must exist'); node.listeners.click[0](); };
  const hero = root.querySelector('.hero-grid');
  assert(hero && hero.children.length === 2 && hero.textContent.includes('已用上下文') && hero.textContent.includes('提示词缓存'));
  assert.strictEqual(all('.gauge-nums').length, 0);
  assert(root.querySelector('.model-tag') && root.querySelector('.treemap-canvas').textContent.includes('剩余空间'));
  assert.strictEqual(all('.detail-row').length, 10);
  click(root.querySelector('.overview-more'));
  assert(all('.detail-row').length > 10);
  click(root.querySelector('.overview-more'));
  assert.strictEqual(all('.detail-row').length, 10);
  click(byKey('.treemap-tile', 'file_read'));
  assert.strictEqual(all('.detail-row').length, 1);
  assert(root.querySelector('.detail-row').textContent.includes('×3'));
  assert.strictEqual(byKey('.overview-filter', 'file_read').getAttribute('aria-pressed'), 'true');
  click(root.querySelector('.detail-row'));
  const preview = root.querySelector('.overview-preview');
  assert(preview.textContent.includes('z'.repeat(100)) && preview.textContent.includes('复制'));
  let copied = '';
  domCtx.navigator = { clipboard: { writeText(text) { copied = text; } } };
  click(preview.querySelector('button'));
  assert.strictEqual(copied, reads.preview);
  click(root.querySelector('.detail-row'));
  assert(!root.querySelector('.overview-preview'));
  click(byKey('.overview-legend-item', 'file_read'));
  assert.strictEqual(all('.detail-row').length, 10);
  click(byKey('.overview-filter', 'command'));
  assert.strictEqual(byKey('.treemap-tile', 'command').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(byKey('.overview-legend-item', 'command').getAttribute('aria-pressed'), 'true');
  assert(root.querySelector('.detail-row').textContent.includes('npm test'));
  const mode = key => all('.treemap-mode').find(node => node.getAttribute('data-mode') === key);
  click(mode('used'));
  assert(!byKey('.treemap-tile', 'remaining') && mode('used').getAttribute('aria-pressed') === 'true');
  click(mode('window'));
  assert(byKey('.treemap-tile', 'remaining'));
  click(byKey('.overview-filter', 'all'));
  click(all('.tab').find(node => node.textContent === '大户'));
  assert(root.querySelector('.seg-bar'));
  click(all('.tab').find(node => node.textContent === '总览'));
  assert(!root.querySelector('.seg-bar'));
  st.isZh = false;
  st.isDark = false;
  domApi.renderAll();
  assert(root.querySelector('.root').className.includes('light'));
  assert(root.querySelector('.hero-grid').textContent.includes('Prompt Cache'));
  assert(root.querySelector('.treemap-canvas').textContent.includes('Free Space'));
  const analysis = st.computed.activeAnalysis;
  analysis.stepStats = domApi.analyzeTrajectorySteps([]);
  st.rpcDiag.steps = 'test-step-timeout';
  analysis.windowLimit = analysis.latestContextTokens;
  analysis.occupancyPct = 100;
  domApi.renderAll();
  assert(root.querySelector('.warn-banner') && root.querySelector('.health-badge').textContent === 'Critical');
  assert(root.querySelector('.overview-breakdown').textContent.includes('test-step-timeout'));
  assert(all('.detail-row').some(node => node.textContent.includes('System prompts')));
  st.rpcDiag.steps = '';
  st.stepsCache.set('cid-main', { stamp: '1', steps });
}

for (const tab of ['overview', 'hitters', 'fleet', 'insights', 'handoff']) {
  st.prefs.activeTab = tab;
  domApi.recomputeState();
  domApi.renderAll();
}

// 回归验证 1：无 explicitCid 的迟到 RPC 响应不得污染 activeCascadeId / stepsCache
const stepsCountBefore = st.stepsCache.size;
const mainStepsBefore = st.stepsCache.get('cid-main').steps.length;
domCtx.__AGY_ON_RPC_DATA__('GetCascadeTrajectorySteps', {
  trajectory: {
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: { userResponse: 'other-session-leak' },
      },
    ],
  },
});
assert.strictEqual(st.activeCascadeId, 'cid-main', 'missing cascadeId RPC must not overwrite activeCascadeId');
assert.strictEqual(st.stepsCache.size, stepsCountBefore, 'missing cascadeId RPC must not insert stray cache entry');
assert.strictEqual(st.stepsCache.get('cid-main').steps.length, mainStepsBefore, 'missing cascadeId RPC must not overwrite cid-main steps');

// 回归验证 2：renderAll({ fromPoll: true }) 在用户聚焦搜索框时不销毁 INPUT（保护中文 IME 与光标），且本地筛选不重建 INPUT
st.prefs.activeTab = 'hitters';
domApi.renderAll();
const bodyInputBefore = hostEl.shadowRoot.querySelector('input.input');
assert(bodyInputBefore, 'hitters tab must render search input');
hostEl.shadowRoot.activeElement = bodyInputBefore;
domApi.renderAll({ fromPoll: true });
assert.strictEqual(
  hostEl.shadowRoot.querySelector('input.input'),
  bodyInputBefore,
  'poll renderAll({ fromPoll: true }) must preserve active input element'
);
if (Array.isArray(bodyInputBefore.listeners.input) && bodyInputBefore.listeners.input.length > 0) {
  bodyInputBefore.listeners.input[0]({ target: { value: 'auth' } });
  assert.strictEqual(
    hostEl.shadowRoot.querySelector('input.input'),
    bodyInputBefore,
    'typing in hitters search must only update listWrap and keep input element intact'
  );
}
hostEl.shadowRoot.activeElement = null;

// 回归验证 3：菜单徽章在跨越告警/危险阈值后重刷颜色，并在回落时清除内联警告色
st.generatorCache.set('cid-main', {
  stamp: 'high',
  list: [
    {
      executionId: 'e-high',
      timestamp: '2026-11-23T06:12:00Z',
      chatModel: {
        model: 'Claude Sonnet 4.5',
        usage: { inputTokens: 180000, cacheReadTokens: 0, outputTokens: 2000 },
      },
    },
  ],
});
domApi.recomputeState();
domApi.syncPluginsMenuInjection();
const badgeEl = injectedItems[0].querySelector('.agy-cd-menu-badge');
assert(badgeEl, 'menu item must contain badge element');
assert.strictEqual(badgeEl.style.color, '#f87171', 'critical occupancy must color menu badge red');

st.generatorCache.set('cid-main', {
  stamp: 'low',
  list: [
    {
      executionId: 'e-low',
      timestamp: '2026-11-23T06:13:00Z',
      chatModel: {
        model: 'Claude Sonnet 4.5',
        usage: { inputTokens: 10000, cacheReadTokens: 0, outputTokens: 500 },
      },
    },
  ],
});
domApi.recomputeState();
domApi.syncPluginsMenuInjection();
assert.strictEqual(badgeEl.style.color, '', 'normal occupancy must reset inline badge color');

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

// 回归验证 4：右侧边栏仅打开浏览器动态网页标题标签页（无 role="tab"、无 placeholder 地址栏、纯 SVG + 按钮）时，仍须识别为原生标签页而非独立悬浮侧栏
const prevChildren = fakeDoc.body.children.slice();
fakeDoc.body.children = [hostEl];

const splitRoot = makeFakeElement('div');
splitRoot._rect = { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
const chatPane = makeFakeElement('div');
chatPane._rect = { left: 0, top: 0, right: 520, bottom: 800, width: 520, height: 800 };
const composerEl = makeFakeElement('textarea');
composerEl._rect = { left: 20, top: 700, right: 500, bottom: 780, width: 480, height: 80 };
chatPane.appendChild(composerEl);

const browserAuxPane = makeFakeElement('div');
browserAuxPane._rect = { left: 520, top: 0, right: 1280, bottom: 800, width: 760, height: 800 };
const browserTabStrip = makeFakeElement('div');
browserTabStrip._rect = { left: 520, top: 4, right: 1260, bottom: 36, width: 740, height: 32 };
const siteTab1 = makeFakeElement('button');
siteTab1.textContent = '127.0.0.1:8768';
siteTab1._rect = { left: 530, top: 6, right: 670, bottom: 34, width: 140, height: 28 };
const siteTab2 = makeFakeElement('button');
siteTab2.textContent = '拧螺丝页面';
siteTab2._rect = { left: 676, top: 6, right: 796, bottom: 34, width: 120, height: 28 };
const svgPlusBtn = makeFakeElement('button');
svgPlusBtn.textContent = '';
svgPlusBtn._rect = { left: 802, top: 8, right: 826, bottom: 32, width: 24, height: 24 };
const plusSvg = makeFakeElement('svg');
plusSvg.setAttribute('class', 'lucide lucide-plus');
svgPlusBtn.appendChild(plusSvg);
browserTabStrip.appendChild(siteTab1);
browserTabStrip.appendChild(siteTab2);
browserTabStrip.appendChild(svgPlusBtn);

const urlBar = makeFakeElement('input');
urlBar._rect = { left: 600, top: 44, right: 1220, bottom: 72, width: 620, height: 28 };
urlBar.value = '127.0.0.1:8768';
browserAuxPane.appendChild(browserTabStrip);
browserAuxPane.appendChild(urlBar);

splitRoot.appendChild(chatPane);
splitRoot.appendChild(browserAuxPane);
fakeDoc.body.appendChild(splitRoot);

const browserAuxRect = domApi.locateNativeAuxPane();
assert.strictEqual(browserAuxRect.found, true, 'must locate browser aux pane via URL value / composer split');
assert.strictEqual(browserAuxRect.hasNativeTabStrip, true, 'must locate dynamic-title browser tab strip');
assert.strictEqual(browserAuxRect.left, 520);
assert.strictEqual(browserAuxRect.width, 760);
assert(browserAuxRect.top >= 38, 'browser pane content must sit below dynamic tab strip');

domApi.openContextDoctorInPane(false);
assert.strictEqual(st.openedInNativePane, true, 'must dock into native browser pane instead of floating drawer');
assert.strictEqual(st.tabOpen, true);
const browserInjectedTabs = fakeDoc.querySelectorAll('[data-agy-cd-tab="1"]');
assert.strictEqual(browserInjectedTabs.length, 1, 'must inject tab into dynamic browser tab strip');
assert.strictEqual(browserTabStrip.children[2], browserInjectedTabs[0], 'injected tab must sit before SVG + button');
assert(
  hostEl.shadowRoot.querySelector('.sidebar').className.includes('docked-aux'),
  'sidebar must use docked-aux class instead of floating overlay'
);

domApi.closeContextDoctor();
browserAuxPane.removeChild(urlBar);
chatPane.removeChild(composerEl);
const leftStrip = makeFakeElement('div');
leftStrip._rect = { left: 80, top: 4, right: 200, bottom: 36, width: 120, height: 32 };
const leftPlus = makeFakeElement('button');
leftPlus.textContent = '+';
leftPlus._rect = { left: 100, top: 6, right: 124, bottom: 30, width: 24, height: 24 };
leftStrip.appendChild(leftPlus);
chatPane.appendChild(leftStrip);
siteTab1.textContent = 'Run VAC build';
siteTab2.textContent = 'npm run dev';
const plusWrapper = makeFakeElement('div');
plusWrapper._rect = { left: 1248, top: 66, right: 1280, bottom: 98, width: 32, height: 32 };
svgPlusBtn._rect = plusWrapper._rect;
browserTabStrip.removeChild(svgPlusBtn);
plusWrapper.appendChild(svgPlusBtn);
browserTabStrip.appendChild(plusWrapper);
browserTabStrip._rect = { left: 520, top: 62, right: 1280, bottom: 104, width: 760, height: 42 };
for (const tab of [siteTab1, siteTab2]) Object.assign(tab._rect, { top: 66, bottom: 94 });
browserAuxPane._rect = { ...browserAuxPane._rect, top: 60, height: 740 };
const nativeDock = domApi.locateNativeAuxPane();
assert.strictEqual(nativeDock.paneEl, browserAuxPane, 'dynamic task tabs must identify the right pane without a composer or URL');
siteTab1.tagName = siteTab2.tagName = 'DIV';
domApi.openContextDoctorInPane(false);
const taskTab = browserTabStrip.querySelector('[data-agy-cd-tab="1"]');
assert(taskTab && browserTabStrip.children[2] === taskTab && !leftStrip.contains(taskTab), 'inject before wrapped + in the matching native strip');
assert.strictEqual(hostEl.parentElement, fakeBody, 'host must remain on document.body to avoid mutating React pane DOM');
assert(parseFloat(sidebar.style.left) === 520 && parseFloat(sidebar.style.top) >= browserTabStrip._rect.bottom && !isClosed(), 'content must align to native pane below tab row');
const clickEvent = target => ({ target, preventDefault() {}, stopPropagation() {} });
docListeners.click(clickEvent(siteTab1));
assert(isClosed() && taskTab.getAttribute('aria-selected') === 'false', 'clicking a dynamic tab must release the native content');
taskTab.listeners.click[0](clickEvent(taskTab));
assert(!isClosed() && taskTab.getAttribute('aria-selected') === 'true');
splitRoot.removeChild(browserAuxPane);
domApi.renderAll();
assert(isClosed(), 'a removed pane must never fall back to a cached rect or a floating drawer');
const replacedStrip = makeFakeElement('div');
replacedStrip._rect = browserTabStrip._rect;
for (const native of [siteTab1, siteTab2, plusWrapper]) replacedStrip.appendChild(native);
browserAuxPane.removeChild(browserTabStrip);
browserAuxPane.appendChild(replacedStrip);
splitRoot.appendChild(browserAuxPane);
domApi.renderAll();
assert(!isClosed() && replacedStrip.querySelectorAll('[data-agy-cd-tab="1"]').length === 1, 'remount into the replacement strip without duplicating tabs');
domApi.closeContextDoctor();
splitRoot.removeChild(browserAuxPane);
const toggle = makeFakeElement('button');
toggle.setAttribute('aria-label', 'Toggle Side Panel');
toggle._rect = { left: 1220, top: 4, right: 1252, bottom: 36, width: 32, height: 32 };
let toggleCount = 0;
toggle.click = () => { toggleCount++; };
fakeBody.appendChild(toggle);
fakeBody.appendChild(mockPluginsPopup);
injectedItems[0].listeners.click[0](clickEvent(injectedItems[0]));
assert.strictEqual(toggleCount, 1, 'menu action must request the native pane exactly once');
assert(isClosed(), 'waiting for the native pane must not open a drawer');
splitRoot.appendChild(browserAuxPane);
domApi.renderAll();
const menuTab = replacedStrip.querySelector('[data-agy-cd-tab="1"]');
assert(menuTab && !isClosed(), 'delayed menu-open must dock once the native pane exists');
menuTab.querySelector('.agy-cd-aux-tab-close').listeners.click[0](clickEvent(menuTab));
assert(isClosed() && !replacedStrip.querySelector('[data-agy-cd-tab="1"]'));

// 回归验证 5：右侧边栏关闭时，聊天消息滚动区及其中带 data-state 的文件链接 <a> 绝对不能被误识别为右侧边栏或注入标签
splitRoot.removeChild(browserAuxPane);
chatPane._rect = { left: 220, top: 40, right: 1280, bottom: 800, width: 1060, height: 760 };
const chatScroll = makeFakeElement('div');
chatScroll._rect = { left: 220, top: 40, right: 1280, bottom: 680, width: 1060, height: 640 };
const msgPara = makeFakeElement('p');
msgPara._rect = { left: 420, top: 52, right: 1080, bottom: 84, width: 660, height: 32 };
const fileLink = makeFakeElement('a');
fileLink.setAttribute('data-state', 'closed');
fileLink.textContent = 'install_context_doctor.py';
fileLink._rect = { left: 460, top: 54, right: 640, bottom: 80, width: 180, height: 26 };
msgPara.appendChild(fileLink);
chatScroll.appendChild(msgPara);
chatPane.appendChild(chatScroll);
chatPane.appendChild(composerEl);
composerEl._rect = { left: 420, top: 700, right: 1080, bottom: 780, width: 660, height: 80 };
assert.strictEqual(domApi.locateNativeAuxPane().found, false, 'chat scroll container with file links must never be misdetected as right aux pane');
st.tabOpen = true;
st.prefs.open = true;
st.allowFloatingFallback = false;
domApi.renderAll();
assert.strictEqual(msgPara.querySelectorAll('[data-agy-cd-tab="1"]').length, 0, 'must never inject tab into chat message paragraph');
assert(isClosed(), 'auto-restore when right pane is closed must stay hidden');
domApi.closeContextDoctor();

fakeDoc.body.children = prevChildren;

console.log('All antigravity-context-doctor tests passed!');
