import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

const TOGGLE_PANE_SCHEMA = z.object({ isError: z.boolean().optional() }).passthrough();
const app = new App({ name: 'Antigravity KB', version: '2.0.0' }, {});

const state = {
  vaults: [],
  activeVaultId: 'personal',
  activeVault: null,
  notes: [],
  tags: [],
  totalCount: 0,
  query: '',
  activeTag: '',
  activeNote: null,
  activeNoteVaultId: '',
  draft: '',
  draftRev: 0,
  dirty: false,
  mode: 'preview', // preview | edit | split
  saveHint: '',
  creating: false,
  confirmDelete: false,
  addingVault: false,
  hostCaps: {},
  toast: '',
  toastTimer: null,
  saveTimer: null,
  listReqSeq: 0,
  readReqSeq: 0,
  saveChain: Promise.resolve(true),
  hasToolResult: false,
};

function showToast(msg) {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    const el = document.getElementById('kb-toast');
    if (el) el.classList.remove('show');
  }, 2200);
  const el = document.getElementById('kb-toast');
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(rawText) {
  const placeholders = [];
  const withTokens = String(rawText || '').replace(
    /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
    (_, target, alias) => {
      const idx = placeholders.length;
      const cleanTarget = target.trim();
      const label = (alias || cleanTarget).trim();
      placeholders.push(
        `<button type="button" class="kb-wikilink" data-wikilink="${escapeHtml(cleanTarget)}">${escapeHtml(label)}</button>`
      );
      return `\u0000WL${idx}\u0000`;
    }
  );
  let out = escapeHtml(withTokens);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\u0000WL(\d+)\u0000/g, (_, i) => placeholders[Number(i)] || '');
  return out;
}

function renderMarkdown(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let i = 0;
  if (lines[0] && lines[0].trim() === '---') {
    for (let j = 1; j < Math.min(lines.length, 80); j++) {
      if (lines[j].trim() === '---' || lines[j].trim() === '...') {
        i = j + 1;
        break;
      }
    }
  }
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();
    if (!trim) {
      closeList();
      continue;
    }
    if (trim.startsWith('```')) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const hMatch = /^(#{1,3})\s+(.+)$/.exec(trim);
    if (hMatch) {
      closeList();
      const lvl = hMatch[1].length;
      html.push(`<h${lvl}>${renderInlineMarkdown(hMatch[2])}</h${lvl}>`);
      continue;
    }
    if (trim.startsWith('> ')) {
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(trim.slice(2))}</blockquote>`);
      continue;
    }
    const taskMatch = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(trim);
    if (taskMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html.push(
        `<li class="kb-task"><input type="checkbox" data-task-line="${i}" ${checked ? 'checked' : ''} /><span>${renderInlineMarkdown(taskMatch[2])}</span></li>`
      );
      continue;
    }
    const liMatch = /^[-*]\s+(.+)$/.exec(trim);
    if (liMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(liMatch[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${renderInlineMarkdown(trim)}</p>`);
  }
  closeList();
  return html.join('');
}

async function callTool(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) {
    throw new Error(res?.content?.[0]?.text || '调用失败');
  }
  if (res?.structuredContent) return res.structuredContent;
  const txt = res?.content?.[0]?.text || '{}';
  try {
    return JSON.parse(txt);
  } catch {
    return { text: txt };
  }
}

function updateSaveHint() {
  const el = document.getElementById('kb-save-hint');
  if (el) el.textContent = state.saveHint;
}

function renderTagsOnly() {
  const el = document.getElementById('kb-tags');
  if (!el) return;
  el.innerHTML = [
    `<button type="button" class="kb-tag ${!state.activeTag ? 'active' : ''}" data-tag="">全部 (${state.totalCount})</button>`,
    ...state.tags.map(
      (t) =>
        `<button type="button" class="kb-tag ${state.activeTag === t.tag ? 'active' : ''}" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} (${t.count})</button>`
    ),
  ].join('');
}

function renderListOnly() {
  const el = document.getElementById('kb-list');
  if (!el) return;
  el.innerHTML = state.notes.length
    ? state.notes
        .map((n) => {
          const active =
            state.activeNote &&
            state.activeNoteVaultId === state.activeVaultId &&
            state.activeNote.rel_path === n.rel_path;
          return `<button type="button" class="kb-item ${active ? 'active' : ''}" data-open-note="${escapeHtml(n.rel_path)}">
            <div class="kb-item-title">${escapeHtml(n.title || n.rel_path)}</div>
            <div class="kb-item-path">${escapeHtml(n.rel_path)}</div>
            ${n.excerpt ? `<div class="kb-item-excerpt">${escapeHtml(n.excerpt)}</div>` : ''}
          </button>`;
        })
        .join('')
    : '<div class="kb-empty">暂无匹配笔记</div>';
}

function renderPreviewBodyOnly() {
  const el = document.getElementById('kb-preview-md');
  if (el) el.innerHTML = renderMarkdown(state.draft);
}

function renderPaneOnly() {
  const el = document.getElementById('kb-pane');
  if (!el) return;
  const canAttach = Boolean(state.hostCaps?.updateModelContext);
  const note = state.activeNote;
  const backlinks = Array.isArray(note?.backlinks) ? note.backlinks : [];
  if (!note) {
    el.innerHTML = '<div class="kb-empty">从左侧选择一篇笔记，或点击「+ 新建」开始记录。</div>';
    return;
  }
  el.innerHTML = `
    <div class="kb-pane-bar">
      <div class="kb-mode-tabs">
        <button type="button" class="kb-mode-btn ${state.mode === 'preview' ? 'active' : ''}" data-mode="preview">预览</button>
        <button type="button" class="kb-mode-btn ${state.mode === 'edit' ? 'active' : ''}" data-mode="edit">编辑</button>
        <button type="button" class="kb-mode-btn ${state.mode === 'split' ? 'active' : ''}" data-mode="split">分栏</button>
      </div>
      <span class="kb-save-hint" id="kb-save-hint">${escapeHtml(state.saveHint)}</span>
      <div class="kb-spacer"></div>
      ${canAttach ? '<button type="button" class="kb-btn sm" id="kb-attach-btn" title="附加到下一条对话">附加到对话</button>' : ''}
      ${note.file_uri ? '<button type="button" class="kb-btn sm" id="kb-open-file-btn" title="在编辑器标签页中打开">打开文件</button>' : ''}
      ${
        state.confirmDelete
          ? '<button type="button" class="kb-btn sm danger" id="kb-confirm-del-btn">确认删除</button><button type="button" class="kb-btn sm" id="kb-cancel-del-btn">取消</button>'
          : '<button type="button" class="kb-btn sm danger" id="kb-del-btn" title="删除笔记">删除</button>'
      }
    </div>
    <div class="kb-content ${state.mode === 'split' ? 'split' : ''}">
      ${state.mode === 'edit' || state.mode === 'split' ? `<textarea class="kb-editor" id="kb-editor" spellcheck="false">${escapeHtml(state.draft)}</textarea>` : ''}
      ${
        state.mode === 'preview' || state.mode === 'split'
          ? `<div class="kb-preview" id="kb-preview">
              <div id="kb-preview-md">${renderMarkdown(state.draft)}</div>
              ${
                backlinks.length
                  ? `<div class="kb-backlinks">
                      <div class="kb-backlinks-title">反向链接 (${backlinks.length})</div>
                      <div class="kb-backlinks-list">
                        ${backlinks.map((b) => `<button type="button" class="kb-wikilink" data-wikilink="${escapeHtml(b.rel_path)}">${escapeHtml(b.title || b.rel_path)}</button>`).join('')}
                      </div>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }
    </div>
  `;
  const editor = document.getElementById('kb-editor');
  if (editor) {
    editor.oninput = () => {
      state.draft = editor.value;
      state.draftRev += 1;
      scheduleAutosave();
      if (state.mode === 'split') renderPreviewBodyOnly();
    };
  }
}

function renderInlineFormsOnly() {
  const el = document.getElementById('kb-forms');
  if (!el) return;
  if (state.creating) {
    el.innerHTML = `<div class="kb-inline-form">
      <input class="kb-input" id="kb-new-input" placeholder="输入笔记路径或名称，如 debugging/notes.md" />
      <button type="button" class="kb-btn primary sm" id="kb-new-submit">创建</button>
      <button type="button" class="kb-btn sm" id="kb-new-cancel">取消</button>
    </div>`;
    const inp = document.getElementById('kb-new-input');
    inp?.focus();
    if (inp) {
      inp.onkeydown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') createNote(inp.value);
        if (e.key === 'Escape') {
          state.creating = false;
          renderInlineFormsOnly();
        }
      };
    }
  } else if (state.addingVault) {
    el.innerHTML = `<div class="kb-inline-form">
      <input class="kb-input" id="kb-vault-path-input" placeholder="输入本地目录绝对路径，如 E:\\Notes" />
      <button type="button" class="kb-btn primary sm" id="kb-vault-submit">挂载</button>
      <button type="button" class="kb-btn sm" id="kb-vault-cancel">取消</button>
    </div>`;
    document.getElementById('kb-vault-path-input')?.focus();
  } else {
    el.innerHTML = '';
  }
}

function syncVaultSelect() {
  const sel = document.getElementById('kb-vault-select');
  if (!sel) return;
  sel.innerHTML = state.vaults
    .map(
      (v) =>
        `<option value="${escapeHtml(v.id)}" ${v.id === state.activeVaultId ? 'selected' : ''}>${escapeHtml(v.label || v.id)}</option>`
    )
    .join('');
}

function mountShellOnce() {
  const root = document.getElementById('app');
  if (!root || root.dataset.mounted === '1') return;
  root.dataset.mounted = '1';
  root.innerHTML = `
    <div class="kb-shell">
      <div class="kb-topbar">
        <select class="kb-select" id="kb-vault-select" title="切换知识库"></select>
        <button type="button" class="kb-btn primary" id="kb-new-btn">+ 新建</button>
        <div class="kb-spacer"></div>
        <button type="button" class="kb-btn icon" id="kb-add-vault-btn" title="挂载本地目录">📁</button>
        <button type="button" class="kb-btn icon" id="kb-refresh-btn" title="刷新">↻</button>
      </div>
      <div id="kb-forms"></div>
      <div class="kb-search-row">
        <input class="kb-input" id="kb-search-input" placeholder="搜索标题、#标签 或摘要…" />
        <div class="kb-tags" id="kb-tags"></div>
      </div>
      <div class="kb-main">
        <div class="kb-list" id="kb-list"></div>
        <div class="kb-pane" id="kb-pane"></div>
      </div>
    </div>
    <div class="kb-toast" id="kb-toast"></div>
  `;

  let searchTimer = null;
  const searchInput = document.getElementById('kb-search-input');
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshList(), 180);
  });

  document.getElementById('kb-vault-select').addEventListener('change', async (e) => {
    const nextVault = e.target.value;
    const saved = await flushDirtyBeforeNavigation();
    if (!saved) {
      e.target.value = state.activeVaultId;
      return;
    }
    try {
      const data = await callTool('kb_app_switch_vault', { vault_id: nextVault });
      state.activeNote = null;
      state.activeNoteVaultId = '';
      state.draft = '';
      state.dirty = false;
      state.saveHint = '';
      applyListPayload(data);
      renderPaneOnly();
    } catch (err) {
      showToast(err.message);
      e.target.value = state.activeVaultId;
    }
  });

  // 统一事件委托，避免局部重绘丢失绑定
  root.addEventListener('click', async (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    if (target.id === 'kb-new-btn') {
      state.creating = !state.creating;
      state.addingVault = false;
      renderInlineFormsOnly();
      return;
    }
    if (target.id === 'kb-new-submit') {
      createNote(document.getElementById('kb-new-input')?.value);
      return;
    }
    if (target.id === 'kb-new-cancel') {
      state.creating = false;
      renderInlineFormsOnly();
      return;
    }
    if (target.id === 'kb-add-vault-btn') {
      state.addingVault = !state.addingVault;
      state.creating = false;
      renderInlineFormsOnly();
      return;
    }
    if (target.id === 'kb-vault-submit') {
      const p = document.getElementById('kb-vault-path-input')?.value;
      if (!p) return;
      const saved = await flushDirtyBeforeNavigation();
      if (!saved) return;
      try {
        const data = await callTool('kb_app_add_vault', { path: p });
        state.addingVault = false;
        state.activeNote = null;
        state.activeNoteVaultId = '';
        state.draft = '';
        state.dirty = false;
        renderInlineFormsOnly();
        applyListPayload(data);
        renderPaneOnly();
        showToast('已挂载知识库目录');
      } catch (err) {
        showToast(err.message);
      }
      return;
    }
    if (target.id === 'kb-vault-cancel') {
      state.addingVault = false;
      renderInlineFormsOnly();
      return;
    }
    if (target.id === 'kb-refresh-btn') {
      refreshList();
      return;
    }
    if (target.hasAttribute('data-tag')) {
      state.activeTag = target.getAttribute('data-tag') || '';
      refreshList();
      return;
    }
    if (target.hasAttribute('data-open-note')) {
      openNote(target.getAttribute('data-open-note'), state.activeVaultId);
      return;
    }
    if (target.hasAttribute('data-mode')) {
      state.mode = target.getAttribute('data-mode') || 'preview';
      renderPaneOnly();
      return;
    }
    if (target.hasAttribute('data-wikilink')) {
      openNote(target.getAttribute('data-wikilink'), state.activeNoteVaultId || state.activeVaultId);
      return;
    }
    if (target.id === 'kb-attach-btn') {
      attachNoteToContext();
      return;
    }
    if (target.id === 'kb-open-file-btn') {
      openFileInNativeTab();
      return;
    }
    if (target.id === 'kb-del-btn') {
      state.confirmDelete = true;
      renderPaneOnly();
      return;
    }
    if (target.id === 'kb-confirm-del-btn') {
      deleteActiveNote();
      return;
    }
    if (target.id === 'kb-cancel-del-btn') {
      state.confirmDelete = false;
      renderPaneOnly();
    }
  });

  root.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb || cb.tagName !== 'INPUT' || !cb.hasAttribute('data-task-line')) return;
    const lineIdx = Number(cb.getAttribute('data-task-line'));
    const lines = state.draft.split(/\r?\n/);
    if (Number.isInteger(lineIdx) && lines[lineIdx]) {
      lines[lineIdx] = lines[lineIdx].replace(/^(\s*[-*]\s+\[)[ xX](\])/, `$1${cb.checked ? 'x' : ' '}$2`);
      state.draft = lines.join('\n');
      state.draftRev += 1;
      state.dirty = true;
      const ed = document.getElementById('kb-editor');
      if (ed) ed.value = state.draft;
      saveCurrentNote();
    }
  });
}

function applyListPayload(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.vaults)) state.vaults = data.vaults;
  if (data.activeVaultId) state.activeVaultId = data.activeVaultId;
  if (data.activeVault) state.activeVault = data.activeVault;
  if (Array.isArray(data.notes)) state.notes = data.notes;
  if (Array.isArray(data.tags)) state.tags = data.tags;
  if (typeof data.totalCount === 'number') state.totalCount = data.totalCount;
  if (typeof data.query === 'string') {
    state.query = data.query;
    const inp = document.getElementById('kb-search-input');
    if (inp && document.activeElement !== inp) inp.value = data.query;
  }
  if (typeof data.activeTag === 'string') state.activeTag = data.activeTag;
  syncVaultSelect();
  renderTagsOnly();
  renderListOnly();
}

async function refreshList() {
  const seq = ++state.listReqSeq;
  try {
    const data = await callTool('kb_app_get_state', {
      vault: state.activeVaultId,
      query: state.query,
      tag: state.activeTag,
    });
    if (seq !== state.listReqSeq) return;
    applyListPayload(data);
  } catch (err) {
    if (seq === state.listReqSeq) showToast(err.message);
  }
}

function saveCurrentNote() {
  if (!state.activeNote || !state.activeNoteVaultId) return Promise.resolve(true);
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  const boundVault = state.activeNoteVaultId;
  const boundPath = state.activeNote.rel_path;
  const contentSnapshot = state.draft;
  const revSnapshot = state.draftRev;

  state.saveChain = state.saveChain.then(async () => {
    state.saveHint = '保存中…';
    updateSaveHint();
    try {
      const data = await callTool('kb_app_save_note', {
        rel_path: boundPath,
        content: contentSnapshot,
        vault: boundVault,
        overwrite: true,
      });
      const stillSameDoc =
        state.activeNote &&
        state.activeNoteVaultId === boundVault &&
        state.activeNote.rel_path === boundPath;
      if (stillSameDoc && state.draftRev === revSnapshot) {
        state.dirty = false;
        state.saveHint = '已保存';
        if (data.note) state.activeNote = data.note;
        updateSaveHint();
      } else if (stillSameDoc) {
        state.saveHint = '未保存';
        updateSaveHint();
      }
      if (boundVault === state.activeVaultId) {
        if (Array.isArray(data.notes)) state.notes = data.notes;
        if (Array.isArray(data.tags)) state.tags = data.tags;
        if (typeof data.totalCount === 'number') state.totalCount = data.totalCount;
        renderTagsOnly();
        renderListOnly();
      }
      return true;
    } catch (err) {
      state.saveHint = '保存失败';
      updateSaveHint();
      showToast(`保存失败: ${err.message}`);
      return false;
    }
  });
  return state.saveChain;
}

async function flushDirtyBeforeNavigation() {
  if (!state.dirty) return true;
  return await saveCurrentNote();
}

function scheduleAutosave() {
  state.dirty = true;
  state.saveHint = '未保存';
  updateSaveHint();
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (state.dirty) saveCurrentNote();
  }, 900);
}

async function openNote(ref, vaultId) {
  if (!ref) return;
  const targetVault = vaultId || state.activeVaultId;
  const ok = await flushDirtyBeforeNavigation();
  if (!ok) return;
  const seq = ++state.readReqSeq;
  try {
    const data = await callTool('kb_app_read_note', {
      note: ref,
      vault: targetVault,
    });
    if (seq !== state.readReqSeq) return;
    state.activeNote = data;
    state.activeNoteVaultId = data.vault || targetVault;
    state.draft = data.content || '';
    state.draftRev += 1;
    state.dirty = false;
    state.confirmDelete = false;
    state.saveHint = '';
    renderListOnly();
    renderPaneOnly();
  } catch (err) {
    if (seq === state.readReqSeq) showToast(err.message);
  }
}

async function createNote(titleInput) {
  const raw = String(titleInput || '').trim();
  if (!raw) return;
  const ok = await flushDirtyBeforeNavigation();
  if (!ok) return;
  const relPath = raw.endsWith('.md') ? raw : `${raw}.md`;
  const title = raw.replace(/\.md$/i, '').split('/').pop();
  const content = `---\ntitle: ${title}\ntags: []\n---\n\n# ${title}\n\n`;
  const targetVault = state.activeVaultId;
  try {
    const data = await callTool('kb_app_save_note', {
      rel_path: relPath,
      content,
      vault: targetVault,
      overwrite: false,
    });
    state.creating = false;
    state.activeNote = data.note;
    state.activeNoteVaultId = targetVault;
    state.draft = data.note?.content || content;
    state.draftRev += 1;
    state.dirty = false;
    state.mode = 'edit';
    if (Array.isArray(data.notes)) state.notes = data.notes;
    if (Array.isArray(data.tags)) state.tags = data.tags;
    if (typeof data.totalCount === 'number') state.totalCount = data.totalCount;
    renderInlineFormsOnly();
    renderTagsOnly();
    renderListOnly();
    renderPaneOnly();
    showToast(`已创建 ${relPath}`);
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteActiveNote() {
  if (!state.activeNote || !state.activeNoteVaultId) return;
  const targetVault = state.activeNoteVaultId;
  const targetRel = state.activeNote.rel_path;
  try {
    const data = await callTool('kb_app_delete_note', {
      rel_path: targetRel,
      vault: targetVault,
    });
    state.confirmDelete = false;
    state.activeNote = null;
    state.activeNoteVaultId = '';
    state.draft = '';
    state.dirty = false;
    if (targetVault === state.activeVaultId) {
      if (Array.isArray(data.notes)) state.notes = data.notes;
      if (Array.isArray(data.tags)) state.tags = data.tags;
      if (typeof data.totalCount === 'number') state.totalCount = data.totalCount;
    }
    renderTagsOnly();
    renderListOnly();
    renderPaneOnly();
    showToast('已删除笔记');
  } catch (err) {
    showToast(err.message);
  }
}

async function attachNoteToContext() {
  if (!state.activeNote) return;
  try {
    await app.updateModelContext({
      content: [
        {
          type: 'text',
          text: `# 知识库笔记：${state.activeNote.title} (${state.activeNote.rel_path})\n\n${state.draft}`,
        },
      ],
    });
    showToast('已附加到下一条对话上下文');
  } catch (err) {
    showToast(`附加失败: ${err.message}`);
  }
}

async function openFileInNativeTab() {
  const uri = state.activeNote?.file_uri;
  if (!uri) return;
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri },
      },
      TOGGLE_PANE_SCHEMA
    );
    if (res?.isError) {
      showToast('当前视图不支持打开原生文件标签页');
    }
  } catch (err) {
    showToast(`打开文件失败: ${err.message}`);
  }
}

function applyThemeFromContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

// Register handlers BEFORE connect()
app.ontoolinput = ({ arguments: args } = {}) => {
  if (args && typeof args === 'object') {
    if (typeof args.query === 'string') state.query = args.query;
    if (typeof args.tag === 'string') state.activeTag = args.tag.replace(/^#/, '');
  }
};

app.ontoolresult = async (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  state.hasToolResult = true;
  const ok = await flushDirtyBeforeNavigation();
  if (!ok) {
    showToast('当前笔记保存失败，已保留本地草稿');
    return;
  }
  const vaultChanged = Boolean(sc.activeVaultId && sc.activeVaultId !== state.activeVaultId);
  applyListPayload(sc);
  if (vaultChanged) {
    state.activeNote = null;
    state.activeNoteVaultId = '';
    state.draft = '';
    state.dirty = false;
    renderPaneOnly();
  }
  if (sc.initialNoteRef) {
    await openNote(sc.initialNoteRef, sc.activeVaultId || state.activeVaultId);
  }
};

app.onhostcontextchanged = (ctx) => applyThemeFromContext(ctx);

async function bootstrap() {
  mountShellOnce();
  renderPaneOnly();
  try {
    await app.connect();
    state.hostCaps = app.getHostCapabilities() || {};
    applyThemeFromContext(app.getHostContext());
    if (!state.hasToolResult && !state.notes.length) {
      await refreshList();
      if (!state.activeNote && state.notes.length) {
        await openNote(state.notes[0].rel_path, state.activeVaultId);
      }
    } else {
      renderPaneOnly();
    }
  } catch (err) {
    showToast(`连接宿主失败: ${err.message}`);
  }
}

bootstrap();
