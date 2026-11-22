const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Module = require('module');

console.log('Testing antigravity-usage-dashboard and pluginLoader.js...');

const widgetPath = path.join(__dirname, 'usage-dashboard.js');
const manifestPath = path.join(__dirname, '..', 'plugin.json');
const loaderPath = path.join(__dirname, '..', 'scripts', 'pluginLoader.js');

assert(fs.existsSync(widgetPath), 'usage-dashboard.js must exist');
assert(fs.existsSync(manifestPath), 'plugin.json must exist');
assert(fs.existsSync(loaderPath), 'pluginLoader.js must exist');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'antigravity-usage-dashboard');
assert(Array.isArray(manifest.uiScripts) && manifest.uiScripts.includes('runtime/usage-dashboard.js'));

const widgetCode = fs.readFileSync(widgetPath, 'utf8');
assert(!/\brequire\s*\(/.test(widgetCode), 'usage-dashboard.js must not call require()');
new vm.Script(widgetCode, { filename: 'usage-dashboard.js' });

// 1. Run usage-dashboard.js in a minimal browser VM
const sandboxWindow = {
  __AGY_PLUGIN_META__: { id: 'antigravity-usage-dashboard', appVersion: '2.34.0' },
  __AGY_I18N_ACTIVE__: true,
  __AGY_USAGE_HISTORY_INIT__: {
    totals: { totalTokens: 50000, turns: 2 },
    byModel: {
      'Gemini 4 Hydrogen': { totalTokens: 50000, inputTokens: 40000, outputTokens: 10000, thinkingTokens: 0, cacheReadTokens: 0 },
    },
    sessions: {},
    events: [
      { ts: '2026-11-22T01:00:00.000Z', cascadeId: 'old-cid', executionId: 'old-exec', model: 'Gemini 4 Hydrogen', totalTokens: 50000, outputTokens: 10000, tps: 50 },
    ],
  },
  innerHeight: 800,
  localStorage: {
    _map: new Map(),
    getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
    setItem(k, v) { this._map.set(k, String(v)); },
  },
  requestAnimationFrame: (cb) => {
    void cb;
    return 1;
  },
  addEventListener: () => {},
  getComputedStyle: () => ({ backgroundColor: 'rgb(18, 18, 22)' }),
  fetch: () => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) }),
};

const fakeDocument = {
  readyState: 'loading',
  documentElement: { lang: 'zh-CN' },
  body: null,
  addEventListener: () => {},
  querySelectorAll: () => [],
};

const ctx = vm.createContext({
  window: sandboxWindow,
  document: fakeDocument,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  Promise,
  JSON,
  Error,
  setTimeout: () => 0,
  setInterval: () => 0,
  console,
});

vm.runInContext(widgetCode, ctx);
const hooks = sandboxWindow.__AGY_USAGE_DASHBOARD_TEST_HOOK__;
assert(hooks && typeof hooks.normalizeUsageData === 'function', 'test hooks must be exposed');

// 2. Test X-Codeium-UI-Token capture & formatters
assert.strictEqual(hooks.mergeCapturedHeaders({ 'X-Codeium-UI-Token': 'ui-tok-123' }), true);
assert.strictEqual(hooks.state.capturedHeaders['x-codeium-ui-token'], 'ui-tok-123');
assert.strictEqual(hooks.formatTokens(842), '842');
assert.strictEqual(hooks.formatTokens(18460), '18.5K');
assert.strictEqual(hooks.formatTokens(145200), '145K');
assert.strictEqual(hooks.formatTokens(1250000), '1.25M');
assert.strictEqual(hooks.formatTps(64.24), '64.2 t/s');
assert.strictEqual(hooks.formatTps(null), '--');
assert.strictEqual(hooks.parseProtoDurationSec('2.5s'), 2.5);
assert.strictEqual(hooks.parseProtoDurationSec({ seconds: '1', nanos: 500000000 }), 1.5);

// 3. Test computeGeneratorMetrics + turnEvents extraction
const enumToLabel = new Map([
  ['MODEL_PLACEHOLDER_H1', 'Gemini 4 Hydrogen (High)'],
  ['MODEL_PLACEHOLDER_A1', 'Orchestrator (Argon)'],
]);
const metrics = hooks.computeGeneratorMetrics(
  [
    {
      executionId: 'exec-1',
      chatModel: {
        model: 'MODEL_PLACEHOLDER_H1',
        streamingDuration: '2s',
        usage: { inputTokens: '10000', outputTokens: '500', thinkingOutputTokens: '100' },
      },
    },
    {
      executionId: 'exec-2',
      chatModel: {
        model: 'MODEL_PLACEHOLDER_H1',
        streamingDuration: '2s',
        usage: { inputTokens: '12000', outputTokens: '200' },
      },
    },
    {
      executionId: 'exec-2',
      chatModel: {
        model: 'MODEL_PLACEHOLDER_A1',
        streamingDuration: { seconds: '3', nanos: 0 },
        usage: { inputTokens: '8000', outputTokens: '300', cacheReadTokens: '4000' },
      },
    },
  ],
  'cid-live',
  enumToLabel
);
assert.strictEqual(metrics.turnCalls, 2);
assert.strictEqual(metrics.turnTokens, 20500);
assert.strictEqual(metrics.tps, 100);
assert.strictEqual(metrics.sessionTokens, 31000);
assert.strictEqual(metrics.turnEvents.length, 2);

// Test persistence queueing & draining
assert.strictEqual(hooks.recordEventsToHistory(metrics.turnEvents, 'cid-live', metrics), true);
const drained = sandboxWindow.__AGY_DRAIN_USAGE_HISTORY__();
assert(drained && Array.isArray(drained.events) && drained.events.length === 2);
assert(drained.sessions['cid-live'].totalTokens === 31000);
assert.strictEqual(sandboxWindow.__AGY_DRAIN_USAGE_HISTORY__(), null, 'second drain must return null');

// 4. Test shared quota pool merging fallback when quotaSummary is empty + tokenModels page
const now = Date.UTC(2026, 10, 22, 10, 0, 0);
const resetIn2h = new Date(now + 2 * 3600000 + 15 * 60000).toISOString();
const resetIn6d4h = new Date(now + (6 * 24 + 4) * 3600000).toISOString();

const normalizedFallback = hooks.normalizeUsageData(
  {
    activeCascadeId: 'cid-live',
    activeGeneratorMetadata: {
      generatorMetadata: [
        {
          executionId: 'exec-2',
          chatModel: {
            model: 'MODEL_PLACEHOLDER_A1',
            streamingDuration: '1s',
            usage: { inputTokens: '4000', outputTokens: '100' },
          },
        },
      ],
    },
    userStatus: {
      pro: true,
      planInfo: { planName: 'Pro' },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_CLAUDE_OPUS' }, quotaInfo: { remainingFraction: 1, resetTime: resetIn2h } },
          { label: 'Claude Sonnet 5.5 (High)', modelOrAlias: { model: 'MODEL_CLAUDE_SONNET' }, quotaInfo: { remainingFraction: 1, resetTime: resetIn2h } },
          { label: 'GPT-OSS 120B', modelOrAlias: { model: 'MODEL_GPT' }, quotaInfo: { remainingFraction: 1, resetTime: resetIn2h } },
          { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_A1' }, quotaInfo: { remainingFraction: 0.63, resetTime: resetIn6d4h } },
          { label: 'Gemini 4 Argon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_A2' }, quotaInfo: { remainingFraction: 0.63, resetTime: resetIn6d4h } },
          { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_H1' }, quotaInfo: { remainingFraction: 0.85, resetTime: resetIn2h } },
          { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_N1' }, quotaInfo: { remainingFraction: 0.85, resetTime: resetIn2h } },
          { label: 'Gemini 3.8 Flash (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_F1' }, quotaInfo: { remainingFraction: 0.85, resetTime: resetIn2h } },
        ],
      },
    },
  },
  hooks.state.history
);

// 8 models sharing 3 pools -> must collapse into 3 shared pools in quotaPools!
assert.strictEqual(normalizedFallback.quotaPools.length, 3, 'must merge shared quota models into 3 pools');
assert.strictEqual(normalizedFallback.quotaPools[0].name, 'Gemini Models');
assert.strictEqual(normalizedFallback.quotaPools[0].includedModels.length, 3);
assert.strictEqual(normalizedFallback.quotaPools[1].name, 'Gemini 4 Argon');
assert.strictEqual(normalizedFallback.quotaPools[1].includedModels.length, 2);
assert.strictEqual(normalizedFallback.quotaPools[2].name, 'Claude & GPT');
assert.strictEqual(normalizedFallback.quotaPools[2].includedModels.length, 3);

// tokenModels must keep individual models and preserve persisted history (Gemini 4 Hydrogen >= 50000)
const hydrogenTokenEntry = normalizedFallback.tokenModels.find((m) => m.name === 'Gemini 4 Hydrogen');
assert(hydrogenTokenEntry && hydrogenTokenEntry.totalTokens >= 50000, 'persisted history tokens must be preserved');

// Official quotaSummary groups take priority
const normalizedOfficial = hooks.normalizeUsageData(
  {
    quotaSummary: {
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', remainingFraction: 1, resetTime: resetIn6d4h },
              { displayName: 'Five Hour Limit Remaining', remainingFraction: 1 },
            ],
          },
          {
            displayName: 'Gemini 4 Argon',
            buckets: [{ displayName: 'Gemini 4 Argon Weekly Limit', remainingFraction: 0.63, resetTime: resetIn6d4h }],
          },
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', remainingFraction: 0.84, resetTime: resetIn6d4h },
              { displayName: 'Five Hour Limit Remaining', remainingFraction: 0.85, resetTime: resetIn2h },
            ],
          },
        ],
      },
    },
  },
  hooks.state.history
);
assert.strictEqual(normalizedOfficial.quotaPools.length, 3);
assert.strictEqual(normalizedOfficial.quotaPools[0].name, 'Gemini Models');
assert.strictEqual(normalizedOfficial.quotaPools[0].buckets.length, 2);
assert.strictEqual(normalizedOfficial.quotaPools[1].name, 'Gemini 4 Argon');
assert.strictEqual(normalizedOfficial.quotaPools[2].name, 'Claude and GPT models');

const filteredPools = hooks.filterVisibleEntries(normalizedOfficial.quotaPools, ['Claude and GPT models']);
assert.strictEqual(filteredPools.length, 2);

// 5. Test locateSidebarGeometry returns safeMaxHeight
const sidebarEl = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 230, height: 800, right: 230, bottom: 800 }),
  contains: (node) => node === settingsBtn,
  parentElement: null,
};
const settingsBtn = {
  textContent: '设置',
  getAttribute: () => null,
  getBoundingClientRect: () => ({ left: 12, top: 752, width: 206, height: 34, right: 218, bottom: 786 }),
  contains: () => false,
  parentElement: sidebarEl,
};
const geom = hooks.locateSidebarGeometry(
  {
    querySelectorAll: () => [settingsBtn],
    elementFromPoint: () => settingsBtn,
  },
  { innerHeight: 800 }
);
assert.strictEqual(geom.visible, true);
assert(geom.safeMaxHeight >= 500 && geom.safeMaxHeight <= 620);

// 6. Test pluginLoader.js: mergeUsageHistory JSON persistence + early tap + UI injection
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-loader-test-'));
try {
  const pluginsDir = path.join(tmpHome, '.gemini', 'config', 'plugins');
  const zhDir = path.join(pluginsDir, 'antigravity-zh-cn', 'runtime');
  const dashDir = path.join(pluginsDir, 'antigravity-usage-dashboard', 'runtime');
  fs.mkdirSync(zhDir, { recursive: true });
  fs.mkdirSync(dashDir, { recursive: true });

  fs.writeFileSync(path.join(pluginsDir, 'antigravity-zh-cn', 'plugin.json'), '{"name":"antigravity-zh-cn"}');
  fs.writeFileSync(path.join(zhDir, 'i18n-engine.js'), 'window.__ZH_LOADED__ = true;');
  fs.writeFileSync(path.join(zhDir, 'zh-CN.json'), '{"exact":{"Settings":"设置"}}');

  fs.writeFileSync(
    path.join(pluginsDir, 'antigravity-usage-dashboard', 'plugin.json'),
    JSON.stringify({
      name: 'antigravity-usage-dashboard',
      uiScripts: ['runtime/usage-dashboard.js', '../escape.js'],
    })
  );
  fs.writeFileSync(path.join(dashDir, 'usage-dashboard.js'), 'window.__DASH_LOADED__ = true;');
  fs.writeFileSync(
    path.join(dashDir, 'usage-history.json'),
    JSON.stringify({ version: 1, totals: { totalTokens: 100, turns: 1 }, byModel: {}, daily: {}, sessions: {}, events: [] })
  );

  const origLoad = Module._load;
  const injectedScripts = [];
  let domReadyHandler = null;
  let commitLoadHandler = null;
  Module._load = function () {
    if (arguments[0] === 'electron') {
      return { app: { getVersion: () => '2.34.0' } };
    }
    if (arguments[0] === 'os') {
      return { ...os, homedir: () => tmpHome };
    }
    return origLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve(loaderPath)];
  const pluginLoader = require(loaderPath);
  Module._load = origLoad;

  // Test mergeUsageHistory upsert & deduplication
  const h1 = pluginLoader.mergeUsageHistory(null, {
    events: [
      {
        ts: '2026-11-22T12:00:00.000Z',
        cascadeId: 'c1',
        executionId: 'e1',
        model: 'Gemini 4 Hydrogen',
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        tps: 50,
      },
    ],
    sessions: { c1: { totalTokens: 1200, calls: 1, lastTps: 50 } },
  });
  assert.strictEqual(h1.totals.totalTokens, 1200);
  assert.strictEqual(h1.totals.turns, 1);
  assert.strictEqual(h1.daily['2026-11-22'].totalTokens, 1200);
  // Upsert same executionId with updated token count
  const h2 = pluginLoader.mergeUsageHistory(h1, {
    events: [
      {
        ts: '2026-11-22T12:00:05.000Z',
        cascadeId: 'c1',
        executionId: 'e1',
        model: 'Gemini 4 Hydrogen',
        inputTokens: 1500,
        outputTokens: 500,
        totalTokens: 2000,
        tps: 60,
      },
    ],
  });
  assert.strictEqual(h2.totals.turns, 1, 'upsert must not double count turn');
  assert.strictEqual(h2.totals.totalTokens, 2000);
  assert.strictEqual(h2.byModel['Gemini 4 Hydrogen'].totalTokens, 2000);

  pluginLoader.attachWebContents({
    getType: () => 'window',
    getURL: () => 'https://127.0.0.1:54321/',
    on: (evt, fn) => {
      if (evt === 'dom-ready') domReadyHandler = fn;
      if (evt === 'did-commit-load') commitLoadHandler = fn;
    },
    executeJavaScript: (code) => {
      injectedScripts.push(code);
      return Promise.resolve();
    },
  });
  commitLoadHandler({}, 'https://127.0.0.1:54321/', false, true);
  domReadyHandler();
  assert(
    injectedScripts.some((s) => s.includes('__AGY_USAGE_HISTORY_INIT__') && s.includes('__DASH_LOADED__')),
    'must inject persisted usage history into dashboard script'
  );
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// 7. Test Connect-Protocol-Version header deduplication & startup auth race
async function runAsyncRpcTests() {
  // Even if early tap or external state injects lowercase connect-protocol-version / content-type,
  // buildRpcHeaders and callLsRpc must produce a single Connect-Protocol-Version: "1" header.
  assert.strictEqual(
    hooks.mergeCapturedHeaders({
      'Connect-Protocol-Version': '1',
      'connect-protocol-version': '1',
      'Content-Type': 'application/proto',
      'X-Codeium-Csrf-Token': 'csrf-abc',
    }),
    true
  );
  assert.strictEqual(hooks.state.capturedHeaders['connect-protocol-version'], undefined);
  assert.strictEqual(hooks.state.capturedHeaders['content-type'], undefined);
  assert.strictEqual(hooks.state.capturedHeaders['x-codeium-csrf-token'], 'csrf-abc');

  // Force-inject lowercase keys directly into state.capturedHeaders & early-tap global to test defense-in-depth
  hooks.state.capturedHeaders['connect-protocol-version'] = '1';
  hooks.state.capturedHeaders['content-type'] = 'application/proto';
  sandboxWindow.__AGY_CAPTURED_LS_HEADERS__ = {
    'connect-protocol-version': '2',
    'x-codeium-csrf-token': 'csrf-xyz',
  };

  const built = hooks.buildRpcHeaders(hooks.state.capturedHeaders);
  const fetchHeaders = new Headers(built);
  assert.strictEqual(fetchHeaders.get('Connect-Protocol-Version'), '1');
  assert.strictEqual(fetchHeaders.get('Content-Type'), 'application/json');
  assert.strictEqual(fetchHeaders.get('x-codeium-csrf-token'), 'csrf-abc');

  let seenProtoHeader = null;
  let seenCsrfHeader = null;
  sandboxWindow.fetch = (_url, init) => {
    const h = new Headers(init.headers);
    seenProtoHeader = h.get('Connect-Protocol-Version');
    seenCsrfHeader = h.get('x-codeium-csrf-token');
    if (seenProtoHeader !== '1') {
      return Promise.resolve({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              code: 'invalid_argument',
              message: `Connect-Protocol-Version must be "1": got "${seenProtoHeader}"`,
            })
          ),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ ok: true }),
    });
  };

  const rpcResp = await hooks.callLsRpc('GetUserStatus', {});
  assert.deepStrictEqual(rpcResp, { ok: true });
  assert.strictEqual(seenProtoHeader, '1');
  assert.strictEqual(seenCsrfHeader, 'csrf-xyz');

  // Test startup race: unauthenticated refreshAllUsage in-flight while CSRF token arrives
  delete hooks.state.capturedHeaders['x-codeium-ui-token'];
  delete hooks.state.capturedHeaders['x-codeium-csrf-token'];
  delete hooks.state.capturedHeaders['authorization'];
  delete sandboxWindow.__AGY_CAPTURED_LS_HEADERS__;
  hooks.state.error = null;
  hooks.state.waitingAuth = false;
  hooks.state.lastUpdatedAt = 0;

  const pendingResolvers = [];
  let callCount = 0;
  sandboxWindow.fetch = (url, init) => {
    callCount++;
    const h = new Headers(init.headers);
    const csrf = h.get('x-codeium-csrf-token');
    if (!csrf) {
      return new Promise((resolve) => {
        pendingResolvers.push(() =>
          resolve({
            ok: false,
            status: 401,
            text: () => Promise.resolve('missing csrf token'),
          })
        );
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () =>
        Promise.resolve(
          url.includes('RetrieveUserQuotaSummary')
            ? { response: { groups: [] } }
            : { userStatus: { pro: true, planInfo: { planName: 'Pro' } } }
        ),
    });
  };

  const firstRefresh = hooks.refreshAllUsage(false);
  // Simulate token arriving while initial unauthenticated request is still in-flight
  hooks.mergeCapturedHeaders({ 'x-codeium-csrf-token': 'late-csrf' });
  // Trigger a concurrent refreshAllUsage call like __AGY_ON_RPC_HEADERS__ would
  await hooks.refreshAllUsage(false);
  while (pendingResolvers.length > 0) {
    pendingResolvers.shift()();
  }
  await firstRefresh;
  // Wait for queued retry in finally() to settle
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(hooks.state.error, null, 'must retry with late token without sticking on error');
  assert(hooks.state.lastUpdatedAt > 0, 'must succeed after queued retry');
  assert(callCount >= 4, 'must have executed retry calls with captured token');

  // 8. Test upsert thinkingTokens/cacheReadTokens subtraction + duplicate modelEnum guard
  hooks.recordEventsToHistory([
    {
      ts: '2026-11-22T15:00:00.000Z',
      cascadeId: 'cid-upsert',
      executionId: 'exec-up',
      model: 'Test Model',
      modelEnum: 'MODEL_TEST',
      inputTokens: 100,
      outputTokens: 50,
      thinkingTokens: 30,
      cacheReadTokens: 200,
      totalTokens: 150,
      tps: 10,
    },
  ]);
  hooks.recordEventsToHistory([
    {
      ts: '2026-11-22T15:00:02.000Z',
      cascadeId: 'cid-upsert',
      executionId: 'exec-up',
      model: 'Test Model',
      modelEnum: 'MODEL_TEST',
      inputTokens: 100,
      outputTokens: 80,
      thinkingTokens: 45,
      cacheReadTokens: 200,
      totalTokens: 180,
      tps: 15,
    },
  ]);
  assert.strictEqual(hooks.state.history.byModel['Test Model'].thinkingTokens, 45);
  assert.strictEqual(hooks.state.history.byModel['Test Model'].cacheReadTokens, 200);

  const dupEnumNorm = hooks.normalizeUsageData(
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Test Model (High)', modelOrAlias: { model: 'MODEL_TEST' } },
            { label: 'Test Model (Low)', modelOrAlias: { model: 'MODEL_TEST' } },
          ],
        },
      },
      activeGeneratorMetadata: {
        generatorMetadata: [
          {
            executionId: 'exec-d1',
            chatModel: {
              model: 'MODEL_TEST',
              usage: { inputTokens: '500', outputTokens: '100' },
            },
          },
        ],
      },
    },
    null
  );
  const testEntry = dupEnumNorm.tokenModels.find((m) => m.name === 'Test Model');
  assert.strictEqual(testEntry && testEntry.totalTokens, 600, 'duplicate modelEnum in clientConfigs must not double count');

  // 9. Test pickActiveCascadeId updates when URL changes after fallback selection
  hooks.state.activeCascadeId = '';
  delete sandboxWindow.__AGY_CAPTURED_CASCADE_ID__;
  sandboxWindow.location = { pathname: '/', search: '' };
  hooks.state.rawSources.trajectories = {
    trajectorySummaries: {
      '11111111-1111-1111-1111-111111111111': { lastModifiedTime: '2026-11-22T10:00:00Z' },
    },
  };
  assert.strictEqual(hooks.pickActiveCascadeId(), '11111111-1111-1111-1111-111111111111');
  sandboxWindow.location = { pathname: '/c/22222222-2222-2222-2222-222222222222', search: '' };
  assert.strictEqual(hooks.pickActiveCascadeId(), '22222222-2222-2222-2222-222222222222');
}

let asyncTestsDone = false;
process.on('exit', (code) => {
  if (code === 0 && !asyncTestsDone) {
    console.error('Async tests did not complete!');
    process.exitCode = 1;
  }
});

runAsyncRpcTests()
  .then(() => {
    asyncTestsDone = true;
    console.log('All usage-dashboard and pluginLoader tests passed!');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
