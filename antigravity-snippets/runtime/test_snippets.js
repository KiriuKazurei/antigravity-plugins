const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('Testing antigravity-snippets...');

const rootDir = path.join(__dirname, '..');
const snippetPath = path.join(__dirname, 'snippets.js');
const manifestPath = path.join(rootDir, 'plugin.json');
const hooksPath = path.join(rootDir, 'hooks.json');
const loaderPath = path.join(rootDir, 'scripts', 'pluginLoader.js');

assert(fs.existsSync(snippetPath), 'runtime/snippets.js must exist');
assert(fs.existsSync(manifestPath), 'plugin.json must exist');
assert(fs.existsSync(hooksPath), 'hooks.json must exist');
assert(fs.existsSync(loaderPath), 'scripts/pluginLoader.js must exist');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'antigravity-snippets');
assert(Array.isArray(manifest.uiScripts) && manifest.uiScripts.includes('runtime/snippets.js'));

const code = fs.readFileSync(snippetPath, 'utf8');
assert(!/\brequire\s*\(/.test(code), 'snippets.js must not call require()');
new vm.Script(code, { filename: 'snippets.js' });

// 1. 测试纯函数 API（无 DOM 环境）
const apiWindow = {};
const apiCtx = vm.createContext({
  window: apiWindow,
  setTimeout,
  clearTimeout,
  console,
  Date,
  Map,
  Set,
});
apiCtx.window = apiCtx;
vm.runInContext(code, apiCtx, { filename: 'snippets.js' });

const api = apiCtx.__AGY_SNIPPETS_TEST_API__;
assert(api, '__AGY_SNIPPETS_TEST_API__ must be exposed');
const plain = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

// 1.1 extractHashTrigger 测试
assert.deepStrictEqual(plain(api.extractHashTrigger('#')), {
  query: '',
  hashStart: 0,
  caretOffset: 1,
});
assert.deepStrictEqual(plain(api.extractHashTrigger('#cr')), {
  query: 'cr',
  hashStart: 0,
  caretOffset: 3,
});
assert.deepStrictEqual(plain(api.extractHashTrigger('请帮我用 #代码')), {
  query: '代码',
  hashStart: 5,
  caretOffset: 8,
});
assert.deepStrictEqual(plain(api.extractHashTrigger('请帮我#cr')), {
  query: 'cr',
  hashStart: 3,
  caretOffset: 6,
});
assert.strictEqual(api.extractHashTrigger('## 标题'), null, '## must not trigger');
assert.strictEqual(api.extractHashTrigger('# 标题'), null, '# followed by space must not trigger');
assert.strictEqual(api.extractHashTrigger('https://example.com/#sec'), null, 'URL hash must not trigger');
assert.strictEqual(api.extractHashTrigger('PR#123'), null, 'alphanumeric# must not trigger');
assert.strictEqual(api.extractHashTrigger('C#'), null, 'C# must not trigger');
assert.deepStrictEqual(plain(api.extractHashTrigger('第一行 #old\n#bug')), {
  query: 'bug',
  hashStart: 9,
  caretOffset: 13,
});

// 1.2 matchSnippets 优先级测试：title > alias > tag > body
const sampleSnippets = [
  {
    id: 'body-only',
    title: '普通问题提问',
    alias: 'q',
    category: '通用',
    tags: ['提问'],
    content: '请帮我分析一下性能与并发瓶颈问题。',
    pinned: true,
    useCount: 99,
    updatedAt: 9999999999999,
  },
  {
    id: 'title-match',
    title: '性能优化与复杂度评估',
    alias: 'p',
    category: '调试',
    tags: ['perf'],
    content: '评估时间复杂度与空间复杂度。',
    pinned: false,
    useCount: 0,
    updatedAt: 1000,
  },
  {
    id: 'alias-exact',
    title: '代码审查 (Code Review)',
    alias: 'cr',
    category: '研发',
    tags: ['review'],
    content: '检查正确性。',
    pinned: false,
    useCount: 0,
    updatedAt: 1000,
  },
];

const perfMatches = api.matchSnippets(sampleSnippets, '性能');
assert.strictEqual(perfMatches.length, 2);
assert.strictEqual(
  perfMatches[0].snippet.id,
  'title-match',
  'Title match must strictly outrank pinned/high-use body match'
);
assert.strictEqual(perfMatches[1].snippet.id, 'body-only');
assert.strictEqual(perfMatches[1].matchType, 'body');

const crMatches = api.matchSnippets(sampleSnippets, 'cr');
assert.strictEqual(crMatches[0].snippet.id, 'alias-exact');
assert.strictEqual(crMatches[0].matchType, 'alias-exact');

const emptyMatches = api.matchSnippets(sampleSnippets, '');
assert.strictEqual(emptyMatches[0].snippet.id, 'body-only', 'Empty query prioritizes pinned');

// 1.3 变量解析与渲染测试
const tpl = '日期={{date}}，语言={{语言:TypeScript}}，关注={{关注点}}\n```\n{{$cursor}}\n```';
const parsedVars = plain(api.parseTemplateVariables(tpl));
assert.deepStrictEqual(parsedVars, [
  { name: '语言', defaultValue: 'TypeScript' },
  { name: '关注点', defaultValue: '' },
]);

const rendered = api.renderTemplate(
  tpl,
  { 语言: '', 关注点: '内存泄漏' },
  { date: '2026-11-22' }
);
assert.strictEqual(
  rendered.text,
  '日期=2026-11-22，语言=TypeScript，关注=内存泄漏\n```\n\n```'
);
assert.strictEqual(
  rendered.text.slice(0, rendered.cursorOffset),
  '日期=2026-11-22，语言=TypeScript，关注=内存泄漏\n```\n'
);

// 1.4 导入合并测试
const merged = api.mergeImportedSnippets(
  [{ id: 'a', title: '旧标题', content: 'old' }],
  [
    { id: 'a', title: '新标题', content: 'new' },
    { title: '全新模板', content: 'hello {{$cursor}}' },
  ],
  'merge'
);
assert.strictEqual(merged.length, 2);
assert.strictEqual(merged[0].title, '新标题');
assert.strictEqual(merged[1].title, '全新模板');

function FakeHTMLTextAreaElement() {}
Object.defineProperty(FakeHTMLTextAreaElement.prototype, 'value', {
  get() { return this._val ?? ''; },
  set(v) { this._val = String(v); },
  configurable: true,
});
function FakeHTMLInputElement() {}
Object.defineProperty(FakeHTMLInputElement.prototype, 'value', {
  get() { return this._val ?? ''; },
  set(v) { this._val = String(v); },
  configurable: true,
});

// 2. 最小 DOM 交互集成测试（模拟输入 #ask -> 上下键 -> Tab 快捷插入）
function createFakeElement(tag) {
  const lower = tag.toLowerCase();
  const base =
    lower === 'textarea'
      ? Object.create(FakeHTMLTextAreaElement.prototype)
      : lower === 'input'
      ? Object.create(FakeHTMLInputElement.prototype)
      : {};
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors({
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    style: { cssText: '' },
    children: [],
    attributes: {},
    listeners: {},
    _val: '',
    selectionStart: 0,
    selectionEnd: 0,
    scrollLeft: 0,
    scrollTop: 0,
    disabled: false,
    readOnly: false,
    shadowRoot: null,
    attachShadow() {
      const root = createFakeElement('shadow-root');
      root.host = this;
      this.shadowRoot = root;
      return root;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    },
    getAttribute(k) { return this.attributes[k] || null; },
    appendChild(child) {
      if (child && child.nodeType === 11 && Array.isArray(child.children)) {
        for (const c of child.children) this.appendChild(c);
        return child;
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      }
    },
    get childNodes() {
      return this.children;
    },
    getRootNode() { return fakeDoc; },
    contains(n) {
      if (n === this) return true;
      return this.children.some((c) => c === n || (c.contains && c.contains(n)));
    },
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    dispatchEvent(ev) {
      const fns = this.listeners[ev.type] || [];
      for (const fn of fns) fn(ev);
      return !ev.defaultPrevented;
    },
    focus() { fakeDoc.activeElement = this; },
    setSelectionRange(s, e) {
      this.selectionStart = s;
      this.selectionEnd = e;
    },
    getBoundingClientRect() {
      return { left: 100, top: 600, right: 500, bottom: 680, width: 400, height: 80 };
    },
    querySelectorAll(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (cls && String(c.className || '').split(/\s+/).includes(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    getElementById(id) {
      const walk = (node) => {
        for (const c of node.children || []) {
          if (c.id === id) return c;
          const sub = walk(c);
          if (sub) return sub;
        }
        return null;
      };
      return walk(this);
    },
    classList: {
      toggle() {},
    },
    set innerHTML(v) {
      if (v === '') this.children = [];
    },
    set textContent(v) {
      this._text = String(v);
    },
    get textContent() {
      if (this._text) return this._text;
      return (this.children || []).map((c) => c.text || c.textContent || '').join('');
    },
  }));
}

const docListeners = {};
const fakeBody = createFakeElement('body');
const fakeTextarea = createFakeElement('textarea');
fakeBody.appendChild(fakeTextarea);

const fakeDoc = {
  body: fakeBody,
  documentElement: { lang: 'zh-CN' },
  activeElement: fakeTextarea,
  createElement: (tag) => createFakeElement(tag),
  createTextNode: (txt) => ({ nodeType: 3, text: String(txt), contains: () => false }),
  createDocumentFragment: () => ({
    nodeType: 11,
    children: [],
    appendChild(c) { this.children.push(c); return c; },
  }),
  getElementById: (id) => fakeBody.getElementById(id),
  addEventListener(type, fn) {
    docListeners[type] = docListeners[type] || [];
    docListeners[type].push(fn);
  },
  execCommand: () => false,
};

const fakeStorage = {
  _map: new Map(),
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
  setItem(k, v) { this._map.set(k, String(v)); },
};

const winListeners = {};
const domCtx = vm.createContext({
  document: fakeDoc,
  addEventListener(type, fn) {
    winListeners[type] = winListeners[type] || [];
    winListeners[type].push(fn);
  },
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: fakeStorage,
  HTMLTextAreaElement: FakeHTMLTextAreaElement,
  HTMLInputElement: FakeHTMLInputElement,
  InputEvent: function (type, init) { this.type = type; Object.assign(this, init); },
  Event: function (type, init) { this.type = type; Object.assign(this, init); },
  ClipboardEvent: function (type, init) {
    this.type = type;
    this.defaultPrevented = false;
    Object.assign(this, init);
    this.preventDefault = () => { this.defaultPrevented = true; };
  },
  DataTransfer: function () {
    this._data = {};
    this.setData = (k, v) => { this._data[k] = String(v); };
    this.getData = (k) => this._data[k] || '';
  },
  getComputedStyle: () => ({ backgroundColor: 'rgb(24, 24, 28)', fontSize: '13px', lineHeight: '20px' }),
  getSelection: () => null,
  navigator: {},
  setTimeout: (fn, ms) => {
    if (ms === 0) {
      fn();
      return 1;
    }
    return setTimeout(fn, ms);
  },
  clearTimeout,
  console,
  Date,
  Map,
  Set,
});
domCtx.window = domCtx;
vm.runInContext(code, domCtx, { filename: 'snippets.js' });

// 模拟输入 "请先 #ask"
fakeTextarea.value = '请先 #ask';
fakeTextarea.selectionStart = 8;
fakeTextarea.selectionEnd = 8;
for (const fn of docListeners.input || []) {
  fn({ target: fakeTextarea });
}

const hostEl = fakeDoc.getElementById('agy-snippets-host');
assert(hostEl && hostEl.shadowRoot, 'Shadow host must be mounted');
const popupEl = hostEl.shadowRoot.getElementById('agy-snippets-popup');
assert(popupEl, 'Popup must open on #ask input');

// 测试 ArrowDown -> ArrowUp 切换选中项（确保 window capture 拦截且 stopImmediatePropagation 调用）
const items = popupEl.querySelectorAll('.popup-item');
assert(items.length >= 1, 'Popup must contain matched items');
let arrowHandled = false;
const keyListeners = winListeners.keydown || docListeners.keydown || [];
assert(winListeners.keydown && winListeners.keydown.length > 0, 'keydown must attach on window capture');
for (const fn of keyListeners) {
  fn({
    key: 'ArrowDown',
    isComposing: false,
    keyCode: 40,
    preventDefault() { arrowHandled = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  fn({
    key: 'ArrowUp',
    isComposing: false,
    keyCode: 38,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
assert(arrowHandled, 'ArrowDown must be intercepted when popup is open');

// 按 Tab 确认选中（builtin-ask 不含自定义变量，仅含 {{$cursor}}，应直接插入）
let prevented = false;
let stopped = false;
let immediateStopped = false;
for (const fn of keyListeners) {
  fn({
    key: 'Tab',
    isComposing: false,
    keyCode: 9,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    stopImmediatePropagation() { immediateStopped = true; },
  });
}

assert(prevented && stopped && immediateStopped, 'Tab key must be hard-stopped synchronously');
assert(
  fakeTextarea.value.startsWith('请先 先不要直接修改代码。'),
  `Expected #ask to be replaced by builtin-ask content, got: ${fakeTextarea.value}`
);
assert(!fakeTextarea.value.includes('{{$cursor}}'), '{{$cursor}} marker must be stripped');
assert(!fakeTextarea.value.includes('#ask'), '#ask token must be replaced');
const expectedCaret = fakeTextarea.value.indexOf('需求补充：') + '需求补充：'.length;
assert.strictEqual(fakeTextarea.selectionStart, expectedCaret, 'Caret must land at {{$cursor}} position');
const savedStore = JSON.parse(fakeStorage.getItem('agy_snippets_store_v1'));
const askItem = savedStore.snippets.find((s) => s.id === 'builtin-ask');
assert.strictEqual(askItem.useCount, 1, 'useCount must increment after Tab confirm');

// 测试鼠标 mousedown 点击浮层项（防止重渲染吞掉 click）
fakeTextarea.value = '用 #bug';
fakeTextarea.selectionStart = 6;
fakeTextarea.selectionEnd = 6;
for (const fn of docListeners.input || []) {
  fn({ target: fakeTextarea });
}
const popupEl2 = hostEl.shadowRoot.getElementById('agy-snippets-popup');
assert(popupEl2, 'Popup must open on #bug');
const firstRow = popupEl2.querySelectorAll('.popup-item')[0];
assert(firstRow, 'Popup must show matched row for #bug');
firstRow.dispatchEvent({
  type: 'mousedown',
  button: 0,
  preventDefault() {},
  stopPropagation() {},
});
assert(
  fakeTextarea.value.startsWith('用 请协助定位以下问题的根本原因'),
  `Expected mousedown to insert builtin-bug, got: ${fakeTextarea.value}`
);

// 3. 测试 contenteditable 富文本（模拟 Lexical/ProseMirror 监听 paste 事件）
const ceTextNode = { nodeType: 3, nodeValue: '#ask', contains: () => false };
const ceSpan = createFakeElement('span');
ceSpan.appendChild(ceTextNode);
const cePara = createFakeElement('p');
cePara.appendChild(ceSpan);
const ceBox = createFakeElement('div');
ceBox.isContentEditable = true;
ceBox.appendChild(cePara);
Object.defineProperty(ceBox, 'innerText', {
  get() { return ceTextNode.nodeValue; },
});
fakeBody.appendChild(ceBox);

let pastedText = '';
ceBox.addEventListener('paste', (ev) => {
  pastedText = ev.clipboardData.getData('text/plain');
  ceTextNode.nodeValue = pastedText;
  ev.preventDefault();
});

const ceSelection = {
  isCollapsed: true,
  rangeCount: 1,
  _range: {
    startContainer: ceTextNode,
    startOffset: 4,
    setStart(n, o) { this.startContainer = n; this.startOffset = o; },
    setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
    toString() {
      return ceTextNode.nodeValue.slice(this.startOffset, this.endOffset);
    },
    getClientRects() { return [{ left: 100, top: 500, bottom: 520, width: 10, height: 20 }]; },
    cloneRange() { return this; },
  },
  getRangeAt() { return this._range; },
  removeAllRanges() {},
  addRange(r) { this._range = r; },
};
fakeDoc.createRange = () => ({
  setStart(n, o) { this.startContainer = n; this.startOffset = o; },
  setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
  collapse() {},
  toString() {
    return ceTextNode.nodeValue.slice(this.startOffset, this.endOffset);
  },
});
fakeDoc.dispatchEvent = () => true;
domCtx.getSelection = () => ceSelection;
fakeDoc.activeElement = ceBox;

for (const fn of docListeners.input || []) {
  fn({ target: ceBox });
}
const popupEl3 = hostEl.shadowRoot.getElementById('agy-snippets-popup');
assert(popupEl3, 'Popup must open on contenteditable #ask');

for (const fn of keyListeners) {
  fn({
    key: 'Tab',
    isComposing: false,
    keyCode: 9,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
assert(
  pastedText.startsWith('先不要直接修改代码。'),
  `Expected contenteditable paste event to receive builtin-ask, got: ${pastedText}`
);
assert.strictEqual(domCtx.__AGY_SNIPPETS_LAST_INSERT__.method, 'paste');

// 4. 测试 ArrowDown + Tab 切换到第 2 项（builtin-ask）与 Shift+Tab 不误拦截
fakeTextarea.value = '#';
fakeTextarea.selectionStart = 1;
fakeTextarea.selectionEnd = 1;
fakeDoc.activeElement = fakeTextarea;
for (const fn of docListeners.input || []) {
  fn({ target: fakeTextarea });
}
const popupEl4 = hostEl.shadowRoot.getElementById('agy-snippets-popup');
assert(popupEl4, 'Popup must open on bare #');

let shiftTabPrevented = false;
for (const fn of keyListeners) {
  fn({
    key: 'Shift',
    isComposing: false,
    keyCode: 16,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  fn({
    key: 'Tab',
    shiftKey: true,
    isComposing: false,
    keyCode: 9,
    preventDefault() { shiftTabPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
assert(!shiftTabPrevented, 'Shift+Tab must not be hijacked');

// 模拟输入法残留 compositionstart 后按 ArrowDown + Tab 选中第 2 项（builtin-ask）
for (const fn of docListeners.compositionstart || []) {
  fn({});
}
for (const fn of keyListeners) {
  fn({
    key: 'ArrowDown',
    isComposing: false,
    keyCode: 40,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  fn({
    key: 'Tab',
    isComposing: false,
    keyCode: 9,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
assert(
  fakeTextarea.value.startsWith('请协助定位以下问题的根本原因'),
  `Expected ArrowDown + Tab to insert second item (builtin-bug, useCount=1), got: ${fakeTextarea.value}`
);

// 5. 测试 #cr 按 Tab 直接快捷插入，绝不弹出二次确认弹窗
fakeTextarea.value = '#cr';
fakeTextarea.selectionStart = 3;
fakeTextarea.selectionEnd = 3;
for (const fn of docListeners.input || []) {
  fn({ target: fakeTextarea });
}
for (const fn of keyListeners) {
  fn({
    key: 'Tab',
    isComposing: false,
    keyCode: 9,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
assert(
  !hostEl.shadowRoot.querySelector('.var-modal'),
  'Tab must insert directly without popping up any confirmation modal'
);
assert(
  fakeTextarea.value.includes('Code Review'),
  `Expected Tab on #cr to insert builtin-cr directly, got: ${fakeTextarea.value}`
);

// 6. 稳定性测试：子节点 focusin 需爬升至最外层 contenteditable 宿主，且非折叠选区插入不崩溃
ceSpan.isContentEditable = true;
cePara.isContentEditable = true;
for (const fn of docListeners.focusin || []) {
  fn({ target: ceSpan });
}
ceTextNode.nodeValue = 'hello world';
ceSelection.isCollapsed = false;
ceSelection._range = {
  startContainer: ceTextNode,
  startOffset: 6,
  endContainer: ceTextNode,
  endOffset: 11,
  collapsed: false,
  setStart(n, o) { this.startContainer = n; this.startOffset = o; },
  setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
  toString() { return ceTextNode.nodeValue.slice(this.startOffset, this.endOffset); },
  getClientRects() { return [{ left: 100, top: 500, bottom: 520, width: 10, height: 20 }]; },
  cloneRange() { return this; },
};
let ceReplacedText = '';
ceBox.listeners.paste = [];
ceBox.addEventListener('paste', (ev) => {
  ceReplacedText = ev.clipboardData.getData('text/plain');
  ceTextNode.nodeValue = 'hello ' + ceReplacedText;
  ev.preventDefault();
});
// 打开管理面板并从“立即插入”按钮向非折叠选区插入（并验证期间 toast 不销毁输入节点）
for (const fn of keyListeners) {
  fn({
    key: 'p',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 80,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
}
const searchInputBeforeToast = hostEl.shadowRoot.getElementById('mgr-search');
assert(searchInputBeforeToast, 'Manager search input must exist');
// 触发复制原文 toast（不应重渲染销毁 searchInputBeforeToast 引用）
const copyBtn = hostEl.shadowRoot.querySelectorAll('.btn').find((b) => b.textContent === '复制原文');
assert(copyBtn, 'Copy button must exist in manager');
let copiedText = '';
domCtx.navigator.clipboard = {
  writeText: (t) => { copiedText = t; return Promise.resolve(); },
  readText: () => Promise.resolve('CLIP_ERR'),
};
copyBtn.dispatchEvent({ type: 'click' });
assert.strictEqual(
  hostEl.shadowRoot.getElementById('mgr-search'),
  searchInputBeforeToast,
  'showToast must not wipe and rebuild manager DOM nodes'
);

const insertBtn = hostEl.shadowRoot.querySelectorAll('.btn').find((b) => b.textContent === '插入到当前输入框');
assert(insertBtn, 'Insert button must exist in manager');
insertBtn.dispatchEvent({ type: 'click' });

setTimeout(() => {
  assert(ceReplacedText.length > 0, 'Non-collapsed contenteditable selection must receive inserted snippet');

  // 7. 稳定性测试：已卸载节点（isConnected=false）兜底走剪贴板而不报错崩溃
  copiedText = '';
  ceBox.isConnected = false;
  fakeTextarea.isConnected = false;
  domCtx.document.activeElement = null;
  for (const fn of keyListeners) {
    fn({
      key: 'p',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 80,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
    });
  }
  const insertBtn2 = hostEl.shadowRoot.querySelectorAll('.btn').find((b) => b.textContent === '插入到当前输入框');
  insertBtn2.dispatchEvent({ type: 'click' });
  assert(copiedText.length > 0, 'Detached targetEl must fall back to clipboard copy');

  // 8. 稳定性测试：损坏的 localStorage JSON 不影响安全初始化
  const brokenStorage = {
    getItem: () => '{corrupt-json',
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  const brokenCtx = vm.createContext({
    document: fakeDoc,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: brokenStorage,
    getComputedStyle: () => ({ backgroundColor: 'rgb(24, 24, 28)' }),
    setTimeout,
    clearTimeout,
    console,
    Date,
    Map,
    Set,
  });
  brokenCtx.window = brokenCtx;
  vm.runInContext(code, brokenCtx, { filename: 'snippets.js' });
  assert(
    brokenCtx.__AGY_SNIPPETS_TEST_API__.DEFAULT_SNIPPETS.length >= 8,
    'Corrupt localStorage must gracefully fall back to defaults'
  );

  console.log('All antigravity-snippets tests passed!');
  process.exit(0);
}, 30);
