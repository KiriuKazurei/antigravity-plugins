import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Antigravity Snippets', version: '2.0.0' }, {});

const state = {
  snippets: [],
  categories: [],
  totalCount: 0,
  query: '',
  activeCategory: '',
  selectedId: '',
  draft: null,
  confirmDelete: false,
  toast: '',
  toastTimer: null,
  hasToolResult: false,
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    const el = document.getElementById('sn-toast');
    if (el) el.classList.remove('show');
  }, 2000);
  const el = document.getElementById('sn-toast');
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
  }
}

async function callTool(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) throw new Error(res?.content?.[0]?.text || '调用失败');
  if (res?.structuredContent) return res.structuredContent;
  return JSON.parse(res?.content?.[0]?.text || '{}');
}

function applyPayload(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.snippets)) state.snippets = data.snippets;
  if (Array.isArray(data.categories)) state.categories = data.categories;
  if (typeof data.totalCount === 'number') state.totalCount = data.totalCount;
  if (data.savedId) state.selectedId = data.savedId;
  if (!state.selectedId && state.snippets.length) {
    selectSnippet(state.snippets[0].id);
  } else if (state.selectedId) {
    const found = state.snippets.find((s) => s.id === state.selectedId);
    if (found && !state.draft) state.draft = { ...found, tagsStr: (found.tags || []).join(', ') };
  }
  renderCats();
  renderList();
  renderDetail();
}

function selectSnippet(id) {
  state.selectedId = id;
  state.confirmDelete = false;
  const found = state.snippets.find((s) => s.id === id);
  state.draft = found ? { ...found, tagsStr: (found.tags || []).join(', ') } : null;
  renderList();
  renderDetail();
}

function startNewSnippet() {
  state.selectedId = '';
  state.confirmDelete = false;
  state.draft = { id: '', title: '', alias: '', category: '自定义', tagsStr: '', content: '', pinned: false };
  renderList();
  renderDetail();
  document.getElementById('sn-f-title')?.focus();
}

function renderCats() {
  const el = document.getElementById('sn-cats');
  if (!el) return;
  el.innerHTML = [
    `<button type="button" class="sn-cat ${!state.activeCategory ? 'active' : ''}" data-cat="">全部 (${state.totalCount})</button>`,
    ...state.categories.map(
      (c) => `<button type="button" class="sn-cat ${state.activeCategory === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    ),
  ].join('');
}

function renderList() {
  const el = document.getElementById('sn-list');
  if (!el) return;
  el.innerHTML = state.snippets.length
    ? state.snippets
        .map(
          (s) => `<button type="button" class="sn-item ${s.id === state.selectedId ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
            <div class="sn-item-head">
              <span class="sn-item-title">${s.pinned ? '📌 ' : ''}${escapeHtml(s.title)}</span>
              ${s.alias ? `<span class="sn-alias">#${escapeHtml(s.alias)}</span>` : ''}
            </div>
            <div class="sn-item-sub">${escapeHtml(s.category || '未分类')} · ${escapeHtml((s.content || '').slice(0, 48))}</div>
          </button>`
        )
        .join('')
    : '<div style="padding:20px;text-align:center;color:var(--fg-muted)">暂无匹配模板</div>';
}

function renderDetail() {
  const el = document.getElementById('sn-detail');
  if (!el) return;
  const d = state.draft;
  if (!d) {
    el.innerHTML = '<div style="padding:28px;text-align:center;color:var(--fg-muted)">选择左侧模板进行查看或编辑，或点击「+ 新建模板」。</div>';
    return;
  }
  el.innerHTML = `
    <div class="sn-form-row">
      <input class="sn-input" id="sn-f-title" value="${escapeHtml(d.title)}" placeholder="模板标题" />
      <input class="sn-input" id="sn-f-alias" value="${escapeHtml(d.alias)}" placeholder="触发别名 (如 cr)" />
      <input class="sn-input" id="sn-f-cat" value="${escapeHtml(d.category)}" placeholder="分类" />
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <input class="sn-input" id="sn-f-tags" style="flex:1" value="${escapeHtml(d.tagsStr || '')}" placeholder="标签（逗号分隔，如 review, debug）" />
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" id="sn-f-pin" ${d.pinned ? 'checked' : ''} /> 置顶
      </label>
    </div>
    <textarea class="sn-textarea" id="sn-f-content" placeholder="输入 Prompt 模板正文，支持 {{$cursor}} 光标锚点…">${escapeHtml(d.content)}</textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="sn-btn primary" id="sn-save-btn">保存模板</button>
      <button type="button" class="sn-btn" id="sn-copy-btn">复制正文</button>
      <div class="sn-spacer"></div>
      ${
        d.id
          ? state.confirmDelete
            ? '<button type="button" class="sn-btn danger" id="sn-confirm-del">确认删除</button><button type="button" class="sn-btn" id="sn-cancel-del">取消</button>'
            : '<button type="button" class="sn-btn danger" id="sn-del-btn">删除</button>'
          : ''
      }
    </div>
  `;
}

async function refresh() {
  try {
    const data = await callTool('app_get_state', { query: state.query, category: state.activeCategory });
    applyPayload(data);
  } catch (err) {
    showToast(err.message);
  }
}

function mountShellOnce() {
  const root = document.getElementById('app');
  if (!root || root.dataset.mounted === '1') return;
  root.dataset.mounted = '1';
  root.innerHTML = `
    <div class="sn-shell">
      <div class="sn-top">
        <span class="sn-title">Prompt 模板库</span>
        <input class="sn-input" id="sn-search" style="width:220px" placeholder="搜索标题、#别名 或内容…" />
        <div class="sn-spacer"></div>
        <button type="button" class="sn-btn primary" id="sn-new-btn">+ 新建模板</button>
        <button type="button" class="sn-btn" id="sn-refresh-btn">↻</button>
      </div>
      <div class="sn-cats" id="sn-cats"></div>
      <div class="sn-main">
        <div class="sn-list" id="sn-list"></div>
        <div class="sn-detail" id="sn-detail"></div>
      </div>
    </div>
    <div class="sn-toast" id="sn-toast"></div>
  `;

  let timer = null;
  document.getElementById('sn-search').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => refresh(), 160);
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'sn-new-btn') return startNewSnippet();
    if (btn.id === 'sn-refresh-btn') return refresh();
    if (btn.hasAttribute('data-cat')) {
      state.activeCategory = btn.getAttribute('data-cat') || '';
      return refresh();
    }
    if (btn.hasAttribute('data-id')) return selectSnippet(btn.getAttribute('data-id'));
    if (btn.id === 'sn-save-btn') {
      const title = document.getElementById('sn-f-title')?.value || '';
      const alias = document.getElementById('sn-f-alias')?.value || '';
      const category = document.getElementById('sn-f-cat')?.value || '自定义';
      const tagsStr = document.getElementById('sn-f-tags')?.value || '';
      const pinned = Boolean(document.getElementById('sn-f-pin')?.checked);
      const content = document.getElementById('sn-f-content')?.value || '';
      const tags = tagsStr.replace(/，/g, ',').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
      try {
        const data = await callTool('app_save', {
          id: state.draft?.id || undefined,
          title,
          alias,
          category,
          tags,
          pinned,
          content,
        });
        state.draft = null;
        applyPayload(data);
        showToast('模板已保存');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (btn.id === 'sn-copy-btn') {
      const content = document.getElementById('sn-f-content')?.value || '';
      try {
        await navigator.clipboard.writeText(content);
        showToast('已复制到剪贴板');
      } catch {
        showToast('复制失败，请手动全选复制');
      }
      return;
    }
    if (btn.id === 'sn-del-btn') {
      state.confirmDelete = true;
      return renderDetail();
    }
    if (btn.id === 'sn-cancel-del') {
      state.confirmDelete = false;
      return renderDetail();
    }
    if (btn.id === 'sn-confirm-del') {
      try {
        const data = await callTool('app_delete', { id: state.draft?.id });
        state.selectedId = '';
        state.draft = null;
        state.confirmDelete = false;
        applyPayload(data);
        showToast('已删除模板');
      } catch (err) {
        showToast(err.message);
      }
    }
  });
}

function applyTheme(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.ontoolinput = () => {};
app.ontoolresult = (res) => {
  if (res?.structuredContent) {
    state.hasToolResult = true;
    applyPayload(res.structuredContent);
  }
};
app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function bootstrap() {
  mountShellOnce();
  renderDetail();
  try {
    await app.connect();
    applyTheme(app.getHostContext());
    if (!state.hasToolResult) await refresh();
  } catch (err) {
    showToast(`连接宿主失败: ${err.message}`);
  }
}

bootstrap();
