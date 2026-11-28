import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

const TOGGLE_PANE_SCHEMA = z.object({ isError: z.boolean().optional() }).passthrough();
const app = new App({ name: 'Antigravity Context Doctor', version: '2.0.0' }, {});

const CAT_META = {
  system_overhead: { label: '系统提示词', color: 'var(--slate)' },
  user: { label: '用户提问', color: 'var(--accent)' },
  assistant: { label: 'AI & Thinking', color: 'var(--purple)' },
  file_read: { label: '文件读取', color: 'var(--cyan)' },
  command: { label: '终端命令', color: 'var(--amber)' },
  file_edit: { label: '文件编辑', color: 'var(--green)' },
  agent_tool: { label: 'Subagent/MCP', color: 'var(--rose)' },
};

const state = {
  snapshot: null,
  activeTab: 'handoff', // handoff | overview | hitters | fleet | global
  selectedCascadeId: '',
  treemapMode: 'window', // window | used
  catFilter: 'all',
  hitterQuery: '',
  handoffDraft: '',
  handoffDirty: false,
  settingsOpen: false,
  hostCaps: {},
  toast: '',
  toastTimer: null,
  reqSeq: 0,
  fetching: false,
  hasToolResult: false,
  treemapWidth: 420,
};

let treemapResizeObserver = null;
let resizeRaf = 0;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 100000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  if (v < 1000000) return `${Math.round(v / 1000)}K`;
  return `${(v / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

function showToast(msg) {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    const el = document.getElementById('cd-toast');
    if (el) el.classList.remove('show');
  }, 2200);
  const el = document.getElementById('cd-toast');
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
  }
}

function getTreemapHeight(itemCount, width) {
  const base = width < 320 ? 196 : 188;
  if (itemCount <= 3) return base;
  return Math.min(276, base + (itemCount - 3) * 20);
}

function normalizeTreemapWeights(sortedItems) {
  const n = sortedItems.length;
  if (!n) return [];
  const totalVal = sortedItems.reduce((acc, it) => acc + it.value, 0) || 1;
  if (n === 1) {
    return sortedItems.map((it) => ({ ...it, layoutWeight: 1, pct: 100 }));
  }

  // 当「剩余空间」占比极大时，限制其最大视觉占比，确保已用分类块始终有充足的可见与可点击区域
  const remItem = sortedItems.find((it) => it.isRemaining);
  const usedItems = sortedItems.filter((it) => !it.isRemaining);
  const itemsWithPct = sortedItems.map((it) => ({
    ...it,
    pct: Number(((it.value / totalVal) * 100).toFixed(1)),
  }));

  if (remItem && usedItems.length > 0) {
    const rawRemShare = remItem.value / totalVal;
    const maxRemShare = Math.max(0.5, 0.72 - Math.max(0, usedItems.length - 1) * 0.045);
    const remShare = Math.min(rawRemShare, maxRemShare);
    const usedBudget = Math.max(0.28, 1 - remShare);
    const usedTotal = usedItems.reduce((acc, it) => acc + it.value, 0) || 1;
    // 每个已用分类保底视觉权重，避免 200:1 悬殊比例下小块被压成 2px 不可见细条
    const minEachUsed = Math.min(usedBudget / (usedItems.length * 1.45), 0.12);
    const rawUsedWeights = usedItems.map((it) => Math.max(minEachUsed, (it.value / usedTotal) * usedBudget));
    const sumUsedW = rawUsedWeights.reduce((a, b) => a + b, 0) || 1;
    const scaleUsed = usedBudget / sumUsedW;

    let uIdx = 0;
    return itemsWithPct.map((it) => {
      if (it.isRemaining) return { ...it, layoutWeight: remShare };
      const w = rawUsedWeights[uIdx++] * scaleUsed;
      return { ...it, layoutWeight: w };
    });
  }

  const minShare = Math.min(0.095, 0.48 / n);
  const rawWeights = itemsWithPct.map((it) => Math.max(minShare, it.value / totalVal));
  const sumW = rawWeights.reduce((a, b) => a + b, 0) || 1;
  return itemsWithPct.map((it, idx) => ({ ...it, layoutWeight: rawWeights[idx] / sumW }));
}

function squarifyWorst(rowAreas, shortSide) {
  if (!rowAreas.length || shortSide <= 0) return Infinity;
  const s = rowAreas.reduce((a, b) => a + b, 0);
  const rMax = Math.max(...rowAreas);
  const rMin = Math.min(...rowAreas);
  if (s <= 0 || rMin <= 0) return Infinity;
  const s2 = s * s;
  const w2 = shortSide * shortSide;
  return Math.max((w2 * rMax) / s2, s2 / (w2 * rMin));
}

function computeTreemap(items, containerW = 420, containerH = 192) {
  const valid = items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
  if (!valid.length) return [];

  const W = Math.max(200, Number(containerW) || 420);
  const H = Math.max(140, Number(containerH) || 192);
  const weighted = normalizeTreemapWeights(valid);
  const totalWeight = weighted.reduce((acc, it) => acc + it.layoutWeight, 0) || 1;
  const totalArea = W * H;

  const queue = weighted.map((it) => ({
    ...it,
    area: (it.layoutWeight / totalWeight) * totalArea,
  }));

  const tiles = [];
  let rx = 0;
  let ry = 0;
  let rw = W;
  let rh = H;

  const layoutRow = (row) => {
    const rowArea = row.reduce((acc, it) => acc + it.area, 0);
    if (rowArea <= 0 || rw <= 0 || rh <= 0) return;
    if (rw >= rh) {
      // 沿左侧放一竖列，宽 = rowArea / rh
      const colW = Math.min(rw, rowArea / rh);
      let cy = ry;
      for (let i = 0; i < row.length; i++) {
        const it = row[i];
        const th = i === row.length - 1 ? Math.max(0, ry + rh - cy) : Math.min(ry + rh - cy, it.area / colW);
        tiles.push({ ...it, pxX: rx, pxY: cy, pxW: colW, pxH: th });
        cy += th;
      }
      rx += colW;
      rw = Math.max(0, W - rx);
    } else {
      // 沿顶部放一横行，高 = rowArea / rw
      const rowH = Math.min(rh, rowArea / rw);
      let cx = rx;
      for (let i = 0; i < row.length; i++) {
        const it = row[i];
        const tw = i === row.length - 1 ? Math.max(0, rx + rw - cx) : Math.min(rx + rw - cx, it.area / rowH);
        tiles.push({ ...it, pxX: cx, pxY: ry, pxW: tw, pxH: rowH });
        cx += tw;
      }
      ry += rowH;
      rh = Math.max(0, H - ry);
    }
  };

  let row = [];
  for (let i = 0; i < queue.length; i++) {
    const next = queue[i];
    if (!row.length) {
      row.push(next);
      continue;
    }
    const shortSide = Math.min(rw, rh);
    const curAreas = row.map((it) => it.area);
    const nextAreas = [...curAreas, next.area];
    if (squarifyWorst(nextAreas, shortSide) <= squarifyWorst(curAreas, shortSide)) {
      row.push(next);
    } else {
      layoutRow(row);
      row = [next];
    }
  }
  if (row.length) layoutRow(row);

  return tiles.map((t) => {
    const pxX = Math.max(0, Math.min(W, t.pxX));
    const pxY = Math.max(0, Math.min(H, t.pxY));
    const pxW = Math.max(0, Math.min(W - pxX, t.pxW));
    const pxH = Math.max(0, Math.min(H - pxY, t.pxH));
    return {
      ...t,
      pxW,
      pxH,
      x: (pxX / W) * 100,
      y: (pxY / H) * 100,
      w: (pxW / W) * 100,
      h: (pxH / H) * 100,
      isCompact: pxH < 48,
      isNarrow: pxW < 88,
    };
  });
}

function renderTrendSvg(trend) {
  if (!trend || trend.length < 2) {
    return '<div class="cd-kpi-sub">调用轮次不足，暂无演进曲线。</div>';
  }
  const W = 360;
  const H = 84;
  const pad = 8;
  const maxVal = Math.max(1, ...trend.map((p) => p.contextTokens || 0));
  const stepX = (W - pad * 2) / Math.max(1, trend.length - 1);
  const pts = trend.map((p, i) => {
    const x = pad + i * stepX;
    const y = H - pad - ((p.contextTokens || 0) / maxVal) * (H - pad * 2);
    return { x, y, ...p };
  });
  const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${H - pad} L${pts[0].x.toFixed(1)},${H - pad} Z`;
  const dots = pts
    .map((p) => {
      const fill = p.compacted ? 'var(--green)' : p.spiked ? 'var(--amber)' : 'var(--accent)';
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="${fill}" />`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="84" preserveAspectRatio="none">
    <path d="${areaD}" fill="rgba(77, 124, 254, 0.14)" />
    <path d="${lineD}" fill="none" stroke="var(--accent)" stroke-width="1.8" />
    ${dots}
  </svg>`;
}

async function callTool(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) {
    throw new Error(res?.content?.[0]?.text || '调用失败');
  }
  if (res?.structuredContent) return res.structuredContent;
  return JSON.parse(res?.content?.[0]?.text || '{}');
}

function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  state.snapshot = snap;
  if (!state.handoffDirty && snap.active?.handoffPrompt) {
    state.handoffDraft = snap.active.handoffPrompt;
  }
}

async function refreshSnapshot(cascadeId, { force = false } = {}) {
  if (state.fetching && !force) return;
  const seq = ++state.reqSeq;
  state.fetching = true;
  try {
    const cid = cascadeId !== undefined ? cascadeId : state.selectedCascadeId;
    const data = await callTool('app_snapshot', cid ? { cascade_id: cid } : {});
    if (seq !== state.reqSeq) return;
    applySnapshot(data);
    render();
  } catch (err) {
    if (seq === state.reqSeq) showToast(err.message);
  } finally {
    if (seq === state.reqSeq) state.fetching = false;
  }
}

async function openFileInNativeTab(fileUri) {
  if (!fileUri) return;
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri: fileUri },
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

function buildTreemapHtml(a) {
  const cats = a.categories || {};
  const usedItems = Object.entries(CAT_META)
    .map(([key, meta]) => ({
      key,
      label: meta.label,
      color: meta.color,
      value: Number(cats[key] || 0),
    }))
    .filter((it) => it.value > 0);

  const remaining = Math.max(0, (a.windowLimit || 0) - (a.latestContextTokens || 0));
  const mapItems =
    state.treemapMode === 'window' && remaining > 0
      ? [...usedItems, { key: 'remaining', label: '剩余空间', color: 'var(--border)', value: remaining, isRemaining: true }]
      : usedItems;
  const treemapW = Math.max(200, state.treemapWidth || 420);
  const treemapH = getTreemapHeight(mapItems.length, treemapW);
  const tiles = computeTreemap(mapItems, treemapW, treemapH);
  const tilesHtml = tiles
    .map(
      (t) => `<div class="cd-tile-slot" style="left:${t.x.toFixed(3)}%;top:${t.y.toFixed(3)}%;width:${t.w.toFixed(3)}%;height:${t.h.toFixed(3)}%">
        <button type="button" class="cd-tile ${t.isRemaining ? 'remaining' : ''} ${t.isCompact ? 'compact' : ''} ${t.isNarrow ? 'narrow' : ''} ${state.catFilter === t.key ? 'active' : ''}" style="--tile-color:${t.color}" title="${escapeHtml(t.label)} · ${fmtTokens(t.value)} (${t.pct}%)" ${t.isRemaining ? 'disabled' : `data-cat="${t.key}"`}>
          <strong>${escapeHtml(t.label)}</strong>
          <span>${fmtTokens(t.value)}</span>
        </button>
      </div>`
    )
    .join('');
  return { usedItems, remaining, treemapH, tilesHtml };
}

function renderOverview(a) {
  const { usedItems, remaining, treemapH, tilesHtml } = buildTreemapHtml(a);

  const allHitters = a.heavyHitters || [];
  const filteredHitters = allHitters
    .filter((h) => state.catFilter === 'all' || h.category === state.catFilter)
    .slice(0, 8);

  const health = a.health || { level: 'unknown', title: '暂无上下文数据', desc: '' };
  const healthLabel =
    health.level === 'critical'
      ? '危险'
      : health.level === 'warn'
        ? '偏高'
        : health.level === 'ok'
          ? '健康'
          : '无数据';

  return `
    <div class="cd-hero">
      <div>
        <div class="cd-kpi-label">已用上下文 <span class="cd-badge ${health.level}">${healthLabel}</span></div>
        <div class="cd-kpi-val"><strong>${fmtTokens(a.latestContextTokens)}</strong><span class="cd-kpi-sub">/ ${fmtTokens(a.windowLimit)} token</span></div>
        <div class="cd-kpi-sub">已用 ${Math.round(a.occupancyPct || 0)}% · 剩余 ${fmtTokens(remaining)}</div>
      </div>
      <div>
        <div class="cd-kpi-label">提示词缓存</div>
        <div class="cd-kpi-val"><strong>${(a.cacheHitPct || 0).toFixed(1)}%</strong><span class="cd-kpi-sub">命中</span></div>
        <div class="cd-track"><span style="width:${Math.min(100, a.cacheHitPct || 0)}%"></span></div>
        <div class="cd-kpi-sub">累计命中 ${fmtTokens(a.totalCacheRead)} · ${a.callCount || 0} 次调用 · 压缩 ${a.compactions || 0}</div>
      </div>
    </div>

    <div class="cd-card">
      <div class="cd-card-head">
        <span>上下文构成拆解</span>
        <div class="cd-chips">
          <button type="button" class="cd-chip ${state.treemapMode === 'window' ? 'active' : ''}" data-tmode="window">窗口占比</button>
          <button type="button" class="cd-chip ${state.treemapMode === 'used' ? 'active' : ''}" data-tmode="used">已用占比</button>
        </div>
      </div>
      <div class="cd-treemap" id="cd-treemap" style="height:${treemapH}px">
        ${tilesHtml}
      </div>
      <div class="cd-legend">
        <button type="button" class="cd-legend-item ${state.catFilter === 'all' ? 'active' : ''}" data-cat="all">全部</button>
        ${usedItems
          .map(
            (it) => `<button type="button" class="cd-legend-item ${state.catFilter === it.key ? 'active' : ''}" data-cat="${it.key}">
              <span class="cd-swatch" style="background:${it.color}"></span>${escapeHtml(it.label)} ${fmtTokens(it.value)}
            </button>`
          )
          .join('')}
      </div>
      ${
        filteredHitters.length
          ? filteredHitters
              .map(
                (h) => `<div class="cd-row">
                  <div class="cd-row-left">
                    <span class="cd-tag">${escapeHtml(h.badge)}</span>
                    <span class="cd-row-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</span>
                  </div>
                  <span class="cd-mono">${fmtTokens(h.estTokens)} (${h.sharePct}%)</span>
                </div>`
              )
              .join('')
          : allHitters.length && state.catFilter !== 'all'
            ? `<div class="cd-kpi-sub">当前分类下暂无上榜大户步骤，点击「全部」查看全部大户。</div>`
            : `<div class="cd-kpi-sub">暂无轨迹步骤明细（${escapeHtml(a.rpcDiag?.steps || '等待数据')}），仍可查看窗口统计。</div>`
      }
    </div>

    <div class="cd-card">
      <div class="cd-card-head">
        <span>上下文演进趋势 (近 ${a.trend?.length || 0} 轮)</span>
        <span class="cd-kpi-sub">峰值 ${fmtTokens(a.peakContextTokens)}</span>
      </div>
      ${renderTrendSvg(a.trend)}
    </div>

    <div class="cd-health ${health.level}">
      <div class="cd-health-title">${escapeHtml(health.title)}</div>
      <div class="cd-health-desc">${escapeHtml(health.desc)}</div>
    </div>
  `;
}

function renderHitterRowsHtml(a) {
  const q = state.hitterQuery.trim().toLowerCase();
  const list = (a.heavyHitters || []).filter(
    (h) => !q || `${h.title} ${h.badge} ${h.preview}`.toLowerCase().includes(q)
  );
  return list.length
    ? list
        .map(
          (h) => `<div class="cd-row">
            <div class="cd-row-left">
              <span class="cd-tag">#${h.index} ${escapeHtml(h.badge)}</span>
              <span class="cd-row-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</span>
            </div>
            <span class="cd-mono">${fmtTokens(h.estTokens)} · ${h.sharePct}%</span>
          </div>`
        )
        .join('')
    : '<div class="cd-kpi-sub">暂无匹配的大户步骤。</div>';
}

function renderHitters(a) {
  return `
    <input class="cd-input" id="cd-hitter-search" value="${escapeHtml(state.hitterQuery)}" placeholder="筛选步骤标题、命令或类型…" />
    <div id="cd-hitter-list" style="display:flex;flex-direction:column;gap:8px">${renderHitterRowsHtml(a)}</div>
  `;
}

function renderFleet(a) {
  const files = a.fileActivities || [];
  const fleet = a.fleet || [];
  return `
    <div class="cd-card">
      <div class="cd-card-head"><span>热点文件 (${files.length})</span><span class="cd-kpi-sub">点击在侧栏打开</span></div>
      ${
        files.length
          ? files
              .map(
                (f) => `<div class="cd-row">
                  <div class="cd-row-left">
                    ${f.fileUri ? `<button type="button" class="cd-btn" style="height:22px;padding:0 6px;font-size:11px" data-open-uri="${escapeHtml(f.fileUri)}">打开</button>` : ''}
                    <span class="cd-row-title" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
                  </div>
                  <span class="cd-mono">读${f.reads}/改${f.edits} · ${fmtTokens(f.estTokens)}</span>
                </div>`
              )
              .join('')
          : '<div class="cd-kpi-sub">暂未检测到文件读写记录。</div>'
      }
    </div>
    <div class="cd-card">
      <div class="cd-card-head"><span>Subagent 编队 (${fleet.length})</span></div>
      ${
        fleet.length
          ? fleet
              .map(
                (s) => `<div class="cd-row">
                  <div class="cd-row-left">
                    <span class="cd-tag">${s.isRunning ? '运行中' : '已完成'}</span>
                    <span class="cd-row-title">${escapeHtml(s.title)}</span>
                  </div>
                  <button type="button" class="cd-btn" style="height:22px;padding:0 7px;font-size:11px" data-inspect-cid="${escapeHtml(s.cascadeId)}">查看</button>
                </div>`
              )
              .join('')
          : '<div class="cd-kpi-sub">当前会话暂无子代理编队。</div>'
      }
    </div>
  `;
}

function renderGlobal(snap) {
  const gs = snap.globalStats || {};
  const sessions = snap.sessions || [];
  return `
    <div class="cd-hero">
      <div class="cd-card">
        <div class="cd-kpi-label">近 7 天会话</div>
        <div class="cd-kpi-val"><strong>${gs.sessions7d || 0}</strong><span class="cd-kpi-sub">/ 共 ${gs.totalSessions || 0}</span></div>
      </div>
      <div class="cd-card">
        <div class="cd-kpi-label">近 7 天步骤</div>
        <div class="cd-kpi-val"><strong>${gs.totalSteps7d || 0}</strong><span class="cd-kpi-sub">运行中 ${gs.runningCount || 0}</span></div>
      </div>
    </div>
    <div class="cd-card">
      <div class="cd-card-head"><span>全部会话 (点击切换洞察目标)</span></div>
      ${
        sessions.length
          ? sessions
              .map((s) => {
                const isCur = s.cascadeId === snap.active?.cascadeId;
                return `<div class="cd-row" style="${isCur ? 'border-color:var(--accent)' : ''}">
                  <div class="cd-row-left">
                    <span class="cd-tag">${s.isRunning ? '运行中' : `${s.stepCount} 步`}</span>
                    <span class="cd-row-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>
                  </div>
                  <button type="button" class="cd-btn" style="height:22px;padding:0 8px;font-size:11px" data-inspect-cid="${escapeHtml(s.cascadeId)}">${isCur ? '当前' : '查看'}</button>
                </div>`;
              })
              .join('')
          : '<div class="cd-kpi-sub">暂无会话列表。</div>'
      }
    </div>
  `;
}

function renderHandoff() {
  const canAttach = Boolean(state.hostCaps?.updateModelContext);
  const canSend = Boolean(state.hostCaps?.message);
  return `
    <div class="cd-card">
      <div class="cd-card-head">
        <span>跨会话交接 Prompt</span>
        <button type="button" class="cd-btn" style="height:22px;font-size:11px" id="cd-regen-handoff">重新生成</button>
      </div>
      <textarea class="cd-textarea" id="cd-handoff-ta">${escapeHtml(state.handoffDraft)}</textarea>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${canAttach ? '<button type="button" class="cd-btn primary" id="cd-attach-handoff">附加到下一条对话</button>' : ''}
        ${canSend ? '<button type="button" class="cd-btn" id="cd-send-handoff">直接发送到对话</button>' : ''}
        <button type="button" class="cd-btn" id="cd-copy-handoff">复制 Prompt</button>
      </div>
    </div>
  `;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  const snap = state.snapshot;
  const a = snap?.active;
  const prefs = snap?.prefs || { warnThresholdPct: 75, criticalThresholdPct: 90 };

  let bodyHtml = '<div class="cd-kpi-sub" style="padding:20px;text-align:center">正在采集上下文洞察数据…</div>';
  if (a) {
    if (state.activeTab === 'overview') bodyHtml = renderOverview(a);
    else if (state.activeTab === 'hitters') bodyHtml = renderHitters(a);
    else if (state.activeTab === 'fleet') bodyHtml = renderFleet(a);
    else if (state.activeTab === 'global') bodyHtml = renderGlobal(snap);
    else if (state.activeTab === 'handoff') bodyHtml = renderHandoff();
  }

  root.innerHTML = `
    <div class="cd-shell">
      <div class="cd-topbar">
        <div class="cd-title-wrap">
          <div class="cd-sess-title">${escapeHtml(a?.title || '上下文洞察')}</div>
        </div>
        <div class="cd-actions">
          ${a ? `<span class="cd-model-pill">${escapeHtml(a.model)} · ${fmtTokens(a.windowLimit)}</span>` : ''}
          <button type="button" class="cd-btn icon" id="cd-refresh-btn" title="刷新">↻</button>
          <button type="button" class="cd-btn icon" id="cd-settings-btn" title="设置">⚙</button>
        </div>
      </div>
      ${
        state.settingsOpen
          ? `<div class="cd-settings">
              <div class="cd-setting-row">
                <span>上下文预警阈值</span>
                <div class="cd-chips">
                  ${[65, 75, 85]
                    .map(
                      (p) =>
                        `<button type="button" class="cd-chip ${prefs.warnThresholdPct === p ? 'active' : ''}" data-warn-pct="${p}">${p}%</button>`
                    )
                    .join('')}
                </div>
              </div>
              <div class="cd-setting-row">
                <span>诊断状态</span>
                <span class="cd-mono">traj:${escapeHtml(a?.rpcDiag?.traj || '-')} · gen:${escapeHtml(a?.rpcDiag?.gen || '-')} · steps:${escapeHtml(a?.rpcDiag?.steps || '-')}</span>
              </div>
            </div>`
          : ''
      }
      <div class="cd-tabs">
        ${[
          ['overview', '总览'],
          ['hitters', '大户'],
          ['fleet', '文件&编队'],
          ['global', '全局'],
          ['handoff', '交接'],
        ]
          .map(
            ([id, label]) =>
              `<button type="button" class="cd-tab ${state.activeTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`
          )
          .join('')}
      </div>
      <div class="cd-body">${bodyHtml}</div>
    </div>
    <div class="cd-toast ${state.toast ? 'show' : ''}" id="cd-toast">${escapeHtml(state.toast)}</div>
  `;

  bindEvents();
}

function syncTreemapToWidth(width) {
  const nextW = Math.max(200, Math.round(width || 0));
  if (!nextW || Math.abs(nextW - state.treemapWidth) < 4) return;
  state.treemapWidth = nextW;
  const el = document.getElementById('cd-treemap');
  const active = state.snapshot?.active;
  if (!el || !active || state.activeTab !== 'overview') return;
  const { treemapH, tilesHtml } = buildTreemapHtml(active);
  el.style.height = `${treemapH}px`;
  el.innerHTML = tilesHtml;
  el.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.getAttribute('data-cat') || 'all';
      state.catFilter = state.catFilter === key ? 'all' : key;
      render();
    };
  });
}

function observeTreemapResize() {
  if (treemapResizeObserver) {
    treemapResizeObserver.disconnect();
    treemapResizeObserver = null;
  }
  const el = document.getElementById('cd-treemap');
  if (!el) return;
  const curW = el.clientWidth;
  if (curW >= 200 && Math.abs(curW - state.treemapWidth) >= 4) {
    syncTreemapToWidth(curW);
  }
  if (typeof ResizeObserver === 'function') {
    treemapResizeObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (!w) return;
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => syncTreemapToWidth(w));
    });
    treemapResizeObserver.observe(el);
  }
}

function bindEvents() {
  const refBtn = document.getElementById('cd-refresh-btn');
  if (refBtn) refBtn.onclick = () => refreshSnapshot(undefined, { force: true });
  observeTreemapResize();

  const setBtn = document.getElementById('cd-settings-btn');
  if (setBtn) {
    setBtn.onclick = () => {
      state.settingsOpen = !state.settingsOpen;
      render();
    };
  }

  document.querySelectorAll('[data-warn-pct]').forEach((btn) => {
    btn.onclick = async () => {
      const pct = Number(btn.getAttribute('data-warn-pct'));
      try {
        const snap = await callTool('app_save_prefs', {
          cascade_id: state.selectedCascadeId || undefined,
          prefs: { warnThresholdPct: pct },
        });
        applySnapshot(snap);
        render();
        showToast(`预警阈值已设为 ${pct}%`);
      } catch (err) {
        showToast(err.message);
      }
    };
  });

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      state.activeTab = btn.getAttribute('data-tab') || 'overview';
      render();
    };
  });

  document.querySelectorAll('[data-tmode]').forEach((btn) => {
    btn.onclick = () => {
      state.treemapMode = btn.getAttribute('data-tmode') || 'window';
      render();
    };
  });

  document.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.getAttribute('data-cat') || 'all';
      state.catFilter = state.catFilter === key ? 'all' : key;
      render();
    };
  });

  // 仅增量更新列表，保留输入框焦点与中文 IME 组合态
  const hitterSearch = document.getElementById('cd-hitter-search');
  if (hitterSearch) {
    hitterSearch.oninput = () => {
      state.hitterQuery = hitterSearch.value;
      const listEl = document.getElementById('cd-hitter-list');
      if (listEl && state.snapshot?.active) {
        listEl.innerHTML = renderHitterRowsHtml(state.snapshot.active);
      }
    };
  }

  document.querySelectorAll('[data-open-uri]').forEach((btn) => {
    btn.onclick = () => openFileInNativeTab(btn.getAttribute('data-open-uri'));
  });

  document.querySelectorAll('[data-inspect-cid]').forEach((btn) => {
    btn.onclick = () => {
      state.selectedCascadeId = btn.getAttribute('data-inspect-cid') || '';
      state.activeTab = 'overview';
      state.handoffDirty = false;
      refreshSnapshot(state.selectedCascadeId);
    };
  });

  const ta = document.getElementById('cd-handoff-ta');
  if (ta) {
    ta.oninput = () => {
      state.handoffDraft = ta.value;
      state.handoffDirty = true;
    };
  }
  const regen = document.getElementById('cd-regen-handoff');
  if (regen) {
    regen.onclick = () => {
      state.handoffDirty = false;
      state.handoffDraft = state.snapshot?.active?.handoffPrompt || '';
      render();
    };
  }
  const attachBtn = document.getElementById('cd-attach-handoff');
  if (attachBtn) {
    attachBtn.onclick = async () => {
      try {
        await app.updateModelContext({ content: [{ type: 'text', text: state.handoffDraft }] });
        showToast('已附加交接摘要到下一条对话');
      } catch (err) {
        showToast(err.message);
      }
    };
  }
  const sendBtn = document.getElementById('cd-send-handoff');
  if (sendBtn) {
    sendBtn.onclick = async () => {
      try {
        await app.sendMessage({ role: 'user', content: [{ type: 'text', text: state.handoffDraft }] });
        showToast('已发送交接 Prompt');
      } catch (err) {
        showToast(err.message);
      }
    };
  }
  const copyBtn = document.getElementById('cd-copy-handoff');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(state.handoffDraft);
        showToast('已复制到剪贴板');
      } catch {
        showToast('复制失败，请手动全选复制');
      }
    };
  }
}

function applyThemeFromContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

// Register handlers BEFORE connect()
app.ontoolinput = ({ arguments: args } = {}) => {
  if (args && typeof args === 'object' && typeof args.cascade_id === 'string') {
    state.selectedCascadeId = args.cascade_id;
  }
};
app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    state.hasToolResult = true;
    applySnapshot(result.structuredContent);
    render();
  }
};
app.onhostcontextchanged = (ctx) => applyThemeFromContext(ctx);

async function bootstrap() {
  render();
  try {
    await app.connect();
    state.hostCaps = app.getHostCapabilities() || {};
    applyThemeFromContext(app.getHostContext());
    if (!state.hasToolResult && !state.snapshot) {
      await refreshSnapshot();
    } else {
      render();
    }
    // 仅在视图可见且用户未在编辑输入框时定期轻量刷新
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const activeTag = document.activeElement?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
      refreshSnapshot();
    }, 15000);
  } catch (err) {
    showToast(`连接宿主失败: ${err.message}`);
  }
}

bootstrap();
