/**
 * Antigravity 统一左侧栏「插件」基座 (core/sidebarDock.js)
 * - 供 antigravity-kb、antigravity-notifier、antigravity-snippets 协同使用
 * - 以单例形式挂载在 window.__AGY_SIDEBAR_DOCK__，各插件内联同版本守卫，保证单装可用、多装零重叠、间距均匀
 */
(function (globalObj) {
  'use strict';

  function ensureAgySidebarDock() {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !document.body ||
      !document.createElement
    ) {
      return null;
    }
    const DOCK_VERSION = 1;
    if (window.__AGY_SIDEBAR_DOCK__ && window.__AGY_SIDEBAR_DOCK__.version >= DOCK_VERSION) {
      return window.__AGY_SIDEBAR_DOCK__;
    }
    const DOCK_HOST_ID = 'agy-sidebar-plugins-dock';
    const items =
      window.__AGY_SIDEBAR_DOCK__ && window.__AGY_SIDEBAR_DOCK__._items instanceof Map
        ? window.__AGY_SIDEBAR_DOCK__._items
        : new Map();
    let lastGeo = { visible: false };
    let syncTimer = null;
    let shiftedBlock = null;
    let hostEl = null;
    let shadowRef = null;
    let containerEl = null;

    function isInsideAnyHost(el) {
      if (!el || !el.closest) return false;
      return Boolean(
        el.closest(
          '#agy-sidebar-plugins-dock, #agy-kb-host, #agy-context-doctor-host, #agy-usage-dashboard-host, #agy-snippets-host, #agy-notifier-host'
        )
      );
    }

    function detectDark() {
      try {
        const bg = window.getComputedStyle(document.body).backgroundColor;
        const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (m) {
          return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255 < 0.5;
        }
      } catch (_) {}
      return true;
    }

    function makeIconSvg(kind, size) {
      const sz = Number(size) || 15;
      if (typeof document.createElementNS !== 'function') {
        const sp = document.createElement('span');
        sp.textContent =
          kind === 'book' ? '📖' : kind === 'bell' ? '🔔' : kind === 'hash' ? '#' : '🧩';
        return sp;
      }
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(sz));
      svg.setAttribute('height', String(sz));
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.75');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.style.flexShrink = '0';
      svg.style.opacity = '0.88';
      const addPath = (d) => {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      };
      if (kind === 'book') {
        addPath('M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20');
      } else if (kind === 'bell') {
        addPath('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
        addPath('M13.73 21a2 2 0 0 1-3.46 0');
      } else if (kind === 'hash') {
        addPath('M4 9h16');
        addPath('M4 15h16');
        addPath('M10 3L8 21');
        addPath('M16 3l-2 18');
      } else {
        addPath('M12 2L15 8L21 9L16.5 14L18 20L12 17L6 20L7.5 14L3 9L9 8Z');
      }
      return svg;
    }

    function ensureDom() {
      if (hostEl && shadowRef && containerEl) return true;
      hostEl = document.getElementById(DOCK_HOST_ID);
      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.id = DOCK_HOST_ID;
        hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482900;';
        document.body.appendChild(hostEl);
      }
      shadowRef =
        hostEl.shadowRoot || (hostEl.attachShadow ? hostEl.attachShadow({ mode: 'open' }) : hostEl);
      const existingRoot =
        typeof shadowRef.getElementById === 'function'
          ? shadowRef.getElementById('agy-dock-root')
          : null;
      if (!existingRoot) {
        shadowRef.innerHTML = '';
        const style = document.createElement('style');
        style.textContent = `
          :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
          .dock { position: fixed; display: flex; flex-direction: column; pointer-events: auto; box-sizing: border-box; }
          .dock.hidden { display: none; }
          .dock-head {
            display: flex; align-items: center; height: 22px; margin-bottom: 4px;
            font-size: 12px; font-weight: 500; user-select: none; letter-spacing: 0.01em;
            color: rgba(161, 161, 170, 0.88);
          }
          .dock.light .dock-head { color: rgba(100, 116, 139, 0.9); }
          .dock-list { display: flex; flex-direction: column; gap: 2px; }
          .dock-item {
            width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
            border: 0; border-radius: 8px; background: transparent; color: #d4d4d8;
            font-family: inherit; cursor: pointer; box-sizing: border-box; text-align: left;
            padding-right: 10px; transition: background 0.12s ease, color 0.12s ease;
          }
          .dock.light .dock-item { color: #334155; }
          .dock-item:hover { background: rgba(255, 255, 255, 0.06); color: #f4f4f5; }
          .dock.light .dock-item:hover { background: rgba(15, 23, 42, 0.06); color: #0f172a; }
          .dock-item.active { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
          .dock.light .dock-item.active { background: rgba(15, 23, 42, 0.09); color: #0f172a; }
          .dock-left { display: inline-flex; align-items: center; min-width: 0; overflow: hidden; }
          .dock-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .dock-dot { width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0; background: #71717a; }
          .dock-dot.running { background: #34d399; box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.18); }
          .dock-dot.waiting { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.22); }
          .dock-dot.dnd { background: #52525b; opacity: 0.6; }
        `;
        shadowRef.appendChild(style);
        containerEl = document.createElement('div');
        containerEl.id = 'agy-dock-root';
        containerEl.className = 'dock hidden';
        shadowRef.appendChild(containerEl);
      } else {
        containerEl = existingRoot;
      }
      return Boolean(containerEl);
    }

    function resetShiftedBlock() {
      if (
        shiftedBlock &&
        shiftedBlock.style &&
        shiftedBlock.dataset &&
        shiftedBlock.dataset.agyDockBaseMt !== undefined
      ) {
        try {
          shiftedBlock.style.marginTop = `${parseFloat(shiftedBlock.dataset.agyDockBaseMt) || 0}px`;
          shiftedBlock.dataset.agyDockShift = '0';
        } catch (_) {}
      }
    }

    function syncNow() {
      syncTimer = null;
      if (!ensureDom()) return;
      const list = Array.from(items.values()).sort((a, b) => (a.order || 50) - (b.order || 50));
      if (list.length === 0 || typeof document.querySelectorAll !== 'function') {
        containerEl.className = 'dock hidden';
        lastGeo = { visible: false };
        resetShiftedBlock();
        return;
      }

      const innerH = window.innerHeight || 800;
      const candidates = document.querySelectorAll('button, a, [role="button"]');
      let anchorBtn = null;
      let anchorRect = null;
      let anchorLabel = '';
      for (let i = 0; i < candidates.length; i++) {
        const node = candidates[i];
        if (!node || typeof node.getBoundingClientRect !== 'function' || isInsideAnyHost(node)) continue;
        const txt = (node.textContent || '').trim();
        const aria =
          (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title'))) || '';
        const lbl = txt || aria.trim();
        if (!/^(Customizations|自定义配置|自定义)$/i.test(lbl)) continue;
        const r = node.getBoundingClientRect();
        if (
          r.width >= 60 &&
          r.height >= 16 &&
          r.height <= 48 &&
          r.left >= 0 &&
          r.left < 320 &&
          r.top >= 20 &&
          r.top < 320
        ) {
          anchorBtn = node;
          anchorRect = r;
          anchorLabel = lbl;
          break;
        }
      }

      if (!anchorBtn || !anchorRect) {
        containerEl.className = 'dock hidden';
        lastGeo = { visible: false };
        return;
      }

      let sidebarEl = null;
      let sidebarRect = null;
      let cur = anchorBtn.parentElement;
      for (let depth = 0; cur && depth < 12; depth++) {
        if (typeof cur.getBoundingClientRect === 'function') {
          const cr = cur.getBoundingClientRect();
          if (cr.width >= 150 && cr.width <= 420 && cr.height >= innerH * 0.45 && cr.left <= 24) {
            sidebarEl = cur;
            sidebarRect = cr;
            break;
          }
        }
        cur = cur.parentElement;
      }

      if (typeof document.elementFromPoint === 'function') {
        const cx = anchorRect.left + Math.min(24, anchorRect.width / 2);
        const cy = anchorRect.top + anchorRect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (
          hit &&
          hit !== anchorBtn &&
          !(anchorBtn.contains && anchorBtn.contains(hit)) &&
          !(sidebarEl && sidebarEl.contains && sidebarEl.contains(hit)) &&
          !isInsideAnyHost(hit)
        ) {
          containerEl.className = 'dock hidden';
          lastGeo = { visible: false };
          return;
        }
      }

      const rowH = Math.round(anchorRect.height || 30);
      const rowGap = 2;
      const headerH = 22;
      const headerGap = 4;
      const topGap = 14;
      const bottomGap = 14;
      const dockLeft = Math.round(anchorRect.left);
      const dockWidth = Math.round(anchorRect.width);
      const dockTop = Math.round(anchorRect.bottom + topGap);
      const dockHeight =
        headerH + headerGap + list.length * rowH + Math.max(0, list.length - 1) * rowGap;
      const dockBottom = dockTop + dockHeight;

      const scope = sidebarEl || document;
      let nextSectionNode = null;
      let nextSectionTop = Infinity;
      if (scope && typeof scope.querySelectorAll === 'function') {
        const nodes = scope.querySelectorAll('div, span, button, h2, h3, p');
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (!n || typeof n.getBoundingClientRect !== 'function' || isInsideAnyHost(n)) continue;
          const txt = (n.textContent || '').trim();
          if (!/^(Plugins|插件|Projects|项目)$/i.test(txt)) continue;
          const nr = n.getBoundingClientRect();
          if (
            nr.top > anchorRect.bottom - 10 &&
            nr.top < innerH - 16 &&
            nr.left < 280 &&
            nr.height > 8 &&
            nr.height < 44 &&
            nr.top < nextSectionTop
          ) {
            nextSectionNode = n;
            nextSectionTop = nr.top;
          }
        }
      }

      if (nextSectionNode && Number.isFinite(nextSectionTop)) {
        try {
          let pBlock = nextSectionNode;
          while (
            pBlock &&
            pBlock.parentElement &&
            pBlock.parentElement !== document.body &&
            pBlock.parentElement !== sidebarEl &&
            typeof pBlock.parentElement.contains === 'function' &&
            !pBlock.parentElement.contains(anchorBtn)
          ) {
            pBlock = pBlock.parentElement;
          }
          if (pBlock && pBlock.style) {
            shiftedBlock = pBlock;
            let baseMt = 0;
            if (pBlock.dataset && pBlock.dataset.agyDockBaseMt !== undefined) {
              baseMt = parseFloat(pBlock.dataset.agyDockBaseMt) || 0;
            } else {
              try {
                baseMt = parseFloat(window.getComputedStyle(pBlock).marginTop) || 0;
              } catch (_) {}
              if (pBlock.dataset) pBlock.dataset.agyDockBaseMt = String(baseMt);
            }
            const curApplied =
              pBlock.dataset && pBlock.dataset.agyDockShift
                ? parseFloat(pBlock.dataset.agyDockShift) || 0
                : 0;
            const desiredTop = dockBottom + bottomGap;
            const delta = Math.round(desiredTop - nextSectionTop);
            if (Math.abs(delta) >= 2) {
              const nextShift = Math.max(-40, Math.min(280, curApplied + delta));
              if (nextShift !== curApplied) {
                if (pBlock.dataset) pBlock.dataset.agyDockShift = String(nextShift);
                pBlock.style.marginTop = `${baseMt + nextShift}px`;
              }
            }
          }
        } catch (_) {}
      }

      let fontSize = '13px';
      let fontWeight = '500';
      let paddingLeft = '10px';
      let color = '';
      let iconSize = 15;
      let iconGap = 10;
      try {
        const cs = window.getComputedStyle(anchorBtn);
        if (cs) {
          if (cs.fontSize) fontSize = cs.fontSize;
          if (cs.fontWeight) fontWeight = cs.fontWeight;
          if (cs.paddingLeft) paddingLeft = cs.paddingLeft;
          if (cs.color) color = cs.color;
          if (cs.columnGap && parseFloat(cs.columnGap) > 0) iconGap = Math.round(parseFloat(cs.columnGap));
          else if (cs.gap && parseFloat(cs.gap) > 0) iconGap = Math.round(parseFloat(cs.gap));
        }
        const svg =
          typeof anchorBtn.querySelector === 'function' ? anchorBtn.querySelector('svg') : null;
        if (svg && typeof svg.getBoundingClientRect === 'function') {
          const sr = svg.getBoundingClientRect();
          if (sr.width >= 12 && sr.width <= 20) iconSize = Math.round(sr.width);
          if (sr.left > anchorRect.left) paddingLeft = `${Math.round(sr.left - anchorRect.left)}px`;
        }
      } catch (_) {}

      const isDark = detectDark();
      const isZh = Boolean(window.__AGY_I18N_ACTIVE__) || /自定义/.test(anchorLabel);
      const sidebarRight = sidebarRect
        ? Math.round(sidebarRect.right)
        : Math.round(anchorRect.right + 12);

      lastGeo = {
        visible: true,
        left: dockLeft,
        top: dockTop,
        width: dockWidth,
        height: dockHeight,
        sidebarRight,
        isDark,
        isZh,
      };

      containerEl.className = `dock ${isDark ? 'dark' : 'light'}`;
      containerEl.style.left = `${dockLeft}px`;
      containerEl.style.top = `${dockTop}px`;
      containerEl.style.width = `${dockWidth}px`;
      containerEl.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'dock-head';
      head.style.paddingLeft = paddingLeft;
      head.textContent = isZh ? '插件' : 'Plugins';
      containerEl.appendChild(head);

      const listEl = document.createElement('div');
      listEl.className = 'dock-list';
      for (const item of list) {
        const active = typeof item.isActive === 'function' ? Boolean(item.isActive()) : false;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-dock-plugin-id', item.id);
        btn.className = `dock-item${active ? ' active' : ''}`;
        btn.style.height = `${rowH}px`;
        btn.style.paddingLeft = paddingLeft;
        btn.style.fontSize = fontSize;
        btn.style.fontWeight = fontWeight;
        if (color && !active) btn.style.color = color;
        if (item.title) btn.title = item.title;
        btn.addEventListener('mousedown', (e) => {
          if (e && e.preventDefault) e.preventDefault();
        });
        btn.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          try {
            window.dispatchEvent(
              new CustomEvent('agy-sidebar-plugin-activated', { detail: { id: item.id } })
            );
          } catch (_) {}
          if (typeof item.onClick === 'function') item.onClick();
          scheduleSync();
        });

        const left = document.createElement('span');
        left.className = 'dock-left';
        left.style.gap = `${iconGap}px`;
        left.appendChild(makeIconSvg(item.icon, iconSize));
        const lbl = document.createElement('span');
        lbl.className = 'dock-lbl';
        lbl.textContent = isZh ? item.label : item.labelEn || item.label;
        left.appendChild(lbl);
        btn.appendChild(left);

        if (typeof item.getDotClass === 'function') {
          const dotCls = item.getDotClass();
          if (dotCls) {
            const dot = document.createElement('span');
            dot.className = `dock-dot ${dotCls}`.trim();
            btn.appendChild(dot);
          }
        }
        listEl.appendChild(btn);
      }
      containerEl.appendChild(listEl);
    }

    function scheduleSync() {
      if (syncTimer) return;
      syncTimer = setTimeout(syncNow, 40);
    }

    if (typeof MutationObserver === 'function' && document.body) {
      const obs = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          if (!isInsideAnyHost(mutations[i].target)) {
            scheduleSync();
            break;
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', scheduleSync, true);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('scroll', scheduleSync, true);
    }

    const api = {
      version: DOCK_VERSION,
      _items: items,
      register(item) {
        if (!item || !item.id) return;
        items.set(item.id, item);
        syncNow();
      },
      unregister(id) {
        items.delete(id);
        scheduleSync();
      },
      refresh() {
        syncNow();
      },
      getGeometry() {
        return lastGeo;
      },
    };
    window.__AGY_SIDEBAR_DOCK__ = api;
    setTimeout(syncNow, 250);
    setTimeout(syncNow, 1200);
    return api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ensureAgySidebarDock };
  }
  if (globalObj && typeof globalObj === 'object') {
    globalObj.__AGY_ENSURE_SIDEBAR_DOCK__ = ensureAgySidebarDock;
  }
})(typeof window !== 'undefined' ? window : globalThis);
