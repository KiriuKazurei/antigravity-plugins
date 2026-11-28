/**
 * Antigravity 任务通知与远程推送插件 (antigravity-notifier) 运行时
 * 纯浏览器 DOM 环境执行（Shadow DOM 隔离），无任何 Node.js 内置模块依赖。
 *
 * 核心特性：
 * - 通过 Connect-RPC 轮询 + EARLY_RPC_TAP + DOM 审批按钮监听，捕捉「任务完成 / 等待授权 / 异常中断」
 * - 支持桌面系统 Notification 弹窗、Web Audio 合成提示音、后台标题闪烁与免打扰模式
 * - 支持防误报基线预热、最短任务时长过滤与事件去重冷却
 * - 内置通知历史面板、配置面板（Alt+N）及 Webhook 配置生成器（配合 Stop Hook 零 CORS 推送）
 */
(function () {
  'use strict';

  const meta = window.__AGY_PLUGIN_META__ || {};
  try {
    delete window.__AGY_PLUGIN_META__;
  } catch (_) {}

  const PREFS_KEY = 'agy_notifier_prefs_v1';
  const HISTORY_KEY = 'agy_notifier_history_v1';
  const HOST_ID = 'agy-notifier-host';
  const LS_SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
  const ACTIVE_POLL_MS = 2500;
  const IDLE_POLL_MS = 6000;
  const APPROVAL_COOLDOWN_MS = 18000;
  const MAX_HISTORY_ITEMS = 30;

  const DEFAULT_PREFS = {
    dnd: false,
    desktopNotify: true,
    soundEnabled: true,
    soundVolume: 0.45,
    titleBlink: true,
    onlyWhenUnfocused: true,
    minTaskSeconds: 5,
    notifyOnComplete: true,
    notifyOnApproval: true,
    notifyOnError: true,
    showFloatingBtn: true,
    webhookDraft: {
      enabled: true,
      provider: 'feishu',
      webhookUrl: '',
      secret: '',
      telegramBotToken: '',
      telegramChatId: '',
      notifyOnComplete: true,
      notifyOnError: true,
      notifyOnMaxLimit: true,
      notifyOnCancel: false,
      titlePrefix: 'Antigravity',
    },
  };

  // ==================== 纯函数：状态机分析 / DOM 审批识别 / 配置生成 ====================

  function parseTimestampMs(raw) {
    if (!raw) return 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw > 1e12 ? raw : raw * 1000;
    }
    const ms = Date.parse(String(raw));
    return Number.isFinite(ms) ? ms : 0;
  }

  function normalizeTrajectoryStatus(rawStatus) {
    const s = String(rawStatus || '').toUpperCase();
    if (!s) return 'UNKNOWN';
    if (/WAIT|APPROV|CONFIRM|INPUT_REQUIRED|PAUSED/.test(s)) return 'WAITING';
    if (/ERROR|FAIL/.test(s)) return 'ERROR';
    if (/RUNNING|ACTIVE|GENERAT|EXECUT|PROGRESS|STREAM/.test(s)) return 'RUNNING';
    if (/IDLE|DONE|COMPLET|FINISH|STOP|CANCEL/.test(s)) return 'IDLE';
    return s;
  }

  /**
   * 对比前后两帧 trajectorySummaries，返回需要触发的通知事件数组。
   * isBaseline 为 true 时仅建立基线，不触发任何历史积压通知。
   */
  function analyzeTrajectoryTransitions(prevMap, summaries, nowMs, prefs, isBaseline = false) {
    const events = [];
    const safePrefs = prefs || DEFAULT_PREFS;
    const minMs = Math.max(0, Number(safePrefs.minTaskSeconds) || 0) * 1000;
    const entries = summaries && typeof summaries === 'object' ? Object.entries(summaries) : [];

    for (const [cid, info] of entries) {
      if (!cid || !info || typeof info !== 'object') continue;
      const nextStatus = normalizeTrajectoryStatus(info.status);
      const summary = String(info.summary || info.title || '').trim();
      const prev = prevMap.get(cid);

      if (isBaseline || !prev) {
        prevMap.set(cid, {
          status: nextStatus,
          summary,
          startMs: nextStatus === 'RUNNING' ? nowMs : 0,
          lastApprovalNotifyMs: 0,
          lastDoneNotifyMs: 0,
        });
        continue;
      }

      const prevStatus = prev.status;
      if (nextStatus === 'RUNNING') {
        if (prevStatus !== 'RUNNING') {
          prev.startMs = nowMs;
        }
        prev.status = 'RUNNING';
        if (summary) prev.summary = summary;
        continue;
      }

      const elapsedMs = prev.startMs > 0 ? Math.max(0, nowMs - prev.startMs) : 0;

      if (nextStatus === 'WAITING') {
        const cooledDown = nowMs - (prev.lastApprovalNotifyMs || 0) >= APPROVAL_COOLDOWN_MS;
        if (prevStatus !== 'WAITING' || cooledDown) {
          if (safePrefs.notifyOnApproval && cooledDown) {
            events.push({
              kind: 'approval',
              cid,
              summary: summary || prev.summary || '当前对话',
              elapsedSec: Math.round(elapsedMs / 1000),
              source: 'rpc',
            });
            prev.lastApprovalNotifyMs = nowMs;
          }
        }
        prev.status = 'WAITING';
        if (summary) prev.summary = summary;
        continue;
      }

      if (nextStatus === 'ERROR' && prevStatus === 'RUNNING') {
        if (safePrefs.notifyOnError) {
          events.push({
            kind: 'error',
            cid,
            summary: summary || prev.summary || '当前对话',
            elapsedSec: Math.round(elapsedMs / 1000),
            source: 'rpc',
          });
        }
        prev.status = 'ERROR';
        prev.startMs = 0;
        continue;
      }

      if (
        (nextStatus === 'IDLE' || nextStatus === 'UNKNOWN') &&
        (prevStatus === 'RUNNING' || prevStatus === 'WAITING')
      ) {
        const cooledDown = nowMs - (prev.lastDoneNotifyMs || 0) >= 4000;
        if (
          prevStatus === 'RUNNING' &&
          safePrefs.notifyOnComplete &&
          cooledDown &&
          elapsedMs >= minMs
        ) {
          events.push({
            kind: 'complete',
            cid,
            summary: summary || prev.summary || '当前对话',
            elapsedSec: Math.round(elapsedMs / 1000),
            source: 'rpc',
          });
          prev.lastDoneNotifyMs = nowMs;
        }
        prev.status = nextStatus;
        prev.startMs = 0;
        if (summary) prev.summary = summary;
        continue;
      }

      prev.status = nextStatus;
      if (summary) prev.summary = summary;
    }

    return events;
  }

  const APPROVAL_POSITIVE_LABELS = new Set([
    'approve',
    '批准',
    'accept',
    '接受',
    'accept step',
    '接受此步骤',
    'allow',
    '允许',
    'allow once',
    '仅允许本次',
    'allow for conversation',
    '在当前对话中允许',
    'always allow',
    '始终允许',
    'run',
    '运行',
    'confirm',
    '确认',
  ]);

  const APPROVAL_NEGATIVE_LABELS = new Set([
    'reject',
    '拒绝',
    'reject step',
    '拒绝此步骤',
    'deny',
    'cancel',
    '取消',
  ]);

  /**
   * 仅基于真实按钮组判定当前界面是否挂起“等待用户授权”，避免误判对话正文中的普通文字。
   */
  function detectApprovalActionInButtons(buttonInfos) {
    if (!Array.isArray(buttonInfos) || buttonInfos.length === 0) {
      return { waiting: false, signature: '' };
    }
    const positiveHits = [];
    let hasNegative = false;

    for (const btn of buttonInfos) {
      if (!btn || btn.insideProse || btn.insideHost) continue;
      if (btn.width <= 0 || btn.height <= 0) continue;
      const label = String(btn.text || btn.ariaLabel || '').trim().toLowerCase();
      if (!label || label.length > 40) continue;
      if (APPROVAL_POSITIVE_LABELS.has(label)) {
        positiveHits.push(label);
      } else if (APPROVAL_NEGATIVE_LABELS.has(label)) {
        hasNegative = true;
      }
    }

    // 必须至少命中明确的审批动作按钮，且伴随拒绝/取消成对按钮（或“允许本次/接受此步骤”专属按钮）
    const strongStandalone = positiveHits.some((l) =>
      l === 'allow once' ||
      l === '仅允许本次' ||
      l === 'accept step' ||
      l === '接受此步骤' ||
      l === 'allow for conversation' ||
      l === '在当前对话中允许'
    );
    if (positiveHits.length > 0 && (hasNegative || strongStandalone)) {
      return {
        waiting: true,
        signature: positiveHits.slice(0, 3).join('|'),
      };
    }
    return { waiting: false, signature: '' };
  }

  function buildConfigJson(draft) {
    const d = draft && typeof draft === 'object' ? draft : DEFAULT_PREFS.webhookDraft;
    const obj = {
      enabled: Boolean(d.enabled),
      provider: String(d.provider || 'feishu'),
      webhookUrl: String(d.webhookUrl || '').trim(),
      secret: String(d.secret || '').trim(),
      telegramBotToken: String(d.telegramBotToken || '').trim(),
      telegramChatId: String(d.telegramChatId || '').trim(),
      customHeaders: {},
      notifyOnComplete: d.notifyOnComplete !== false,
      notifyOnError: d.notifyOnError !== false,
      notifyOnMaxLimit: d.notifyOnMaxLimit !== false,
      notifyOnCancel: Boolean(d.notifyOnCancel),
      titlePrefix: String(d.titlePrefix || 'Antigravity').trim() || 'Antigravity',
    };
    return JSON.stringify(obj, null, 2);
  }

  function locateSidebarEntryGeometry(doc, win) {
    const d = doc || document;
    const w = win || window;
    if (!d || !d.querySelectorAll) {
      return { visible: false };
    }
    const innerH = w.innerHeight || 800;
    const candidates = d.querySelectorAll('button, a, [role="button"]');
    let anchorBtn = null;
    let anchorRect = null;
    let anchorLabel = '';
    let prevBtn = null;
    let prevRect = null;

    for (let i = 0; i < candidates.length; i++) {
      const elNode = candidates[i];
      if (!elNode || typeof elNode.getBoundingClientRect !== 'function') continue;
      if (elNode.closest && elNode.closest(`#${HOST_ID}`)) continue;
      const text = (elNode.textContent || '').trim();
      const aria =
        (elNode.getAttribute && (elNode.getAttribute('aria-label') || elNode.getAttribute('title'))) ||
        '';
      const label = text || aria.trim();
      const isCustom = /^(Customizations|自定义配置)$/i.test(label);
      const isAuto = /^(Automations|自动化任务)$/i.test(label);
      if (!isCustom && !isAuto) continue;

      const r = elNode.getBoundingClientRect();
      if (
        r.width >= 60 &&
        r.height >= 16 &&
        r.height <= 48 &&
        r.left >= 0 &&
        r.left < 320 &&
        r.top >= 20 &&
        r.top < 280
      ) {
        if (isCustom) {
          anchorBtn = elNode;
          anchorRect = r;
          anchorLabel = label;
        } else if (isAuto) {
          prevBtn = elNode;
          prevRect = r;
        }
      }
    }

    if (!anchorBtn || !anchorRect) {
      return { visible: false };
    }

    let sidebarEl = null;
    let sidebarRect = null;
    let cur = anchorBtn.parentElement;
    for (let depth = 0; cur && depth < 12; depth++) {
      if (typeof cur.getBoundingClientRect === 'function') {
        const cr = cur.getBoundingClientRect();
        if (cr.width >= 150 && cr.width <= 420 && cr.height >= innerH * 0.5 && cr.left <= 24) {
          sidebarEl = cur;
          sidebarRect = cr;
          break;
        }
      }
      cur = cur.parentElement;
    }

    if (typeof d.elementFromPoint === 'function') {
      const cx = anchorRect.left + Math.min(24, anchorRect.width / 2);
      const cy = anchorRect.top + anchorRect.height / 2;
      const hit = d.elementFromPoint(cx, cy);
      if (
        hit &&
        hit !== anchorBtn &&
        !(anchorBtn.contains && anchorBtn.contains(hit)) &&
        !(sidebarEl && sidebarEl.contains && sidebarEl.contains(hit))
      ) {
        return { visible: false };
      }
    }

    let nextSectionNode = null;
    let nextSectionTop = Infinity;
    const scope = sidebarEl || d;
    if (scope.querySelectorAll) {
      const nodes = scope.querySelectorAll('div, span, button, h2, h3, p');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || typeof n.getBoundingClientRect !== 'function') continue;
        const txt = (n.textContent || '').trim();
        if (!/^(Plugins|插件|Projects|项目)$/i.test(txt)) continue;
        const nr = n.getBoundingClientRect();
        if (nr.top > anchorRect.bottom - 4 && nr.top < anchorRect.bottom + 180 && nr.left < 280 && nr.top < nextSectionTop) {
          nextSectionNode = n;
          nextSectionTop = nr.top;
        }
      }
    }
    if (!Number.isFinite(nextSectionTop)) nextSectionTop = 0;

    const left = Math.round(anchorRect.left);
    const width = Math.round(anchorRect.width);
    const height = Math.round(anchorRect.height || 30);
    const stepY =
      prevRect && anchorRect.top > prevRect.top + 12
        ? Math.round(anchorRect.top - prevRect.top)
        : Math.round(height + 6);
    let top = Math.round(anchorRect.top + stepY);

    // 若「插件」或「项目」区块紧贴在「远程推送」下方，仅通过外边距为首个区块标题留出与原生一致的呼吸间距
    if (nextSectionNode && nextSectionTop > 0) {
      const btnBottom = top + height;
      const desiredGap = Math.max(18, Math.round(stepY - height + 14));
      const curGap = nextSectionTop - btnBottom;
      if (curGap < desiredGap) {
        try {
          let pBlock = nextSectionNode;
          while (
            pBlock &&
            pBlock.parentElement &&
            typeof pBlock.parentElement.contains === 'function' &&
            !pBlock.parentElement.contains(anchorBtn) &&
            pBlock.parentElement !== sidebarEl
          ) {
            pBlock = pBlock.parentElement;
          }
          if (pBlock && pBlock.style) {
            let baseMt = 0;
            if (pBlock.dataset && pBlock.dataset.agyNotifierBaseMt !== undefined) {
              baseMt = parseFloat(pBlock.dataset.agyNotifierBaseMt) || 0;
            } else {
              try {
                baseMt = parseFloat(w.getComputedStyle(pBlock).marginTop) || 0;
              } catch (_) {}
              if (pBlock.dataset) pBlock.dataset.agyNotifierBaseMt = String(baseMt);
            }
            const curApplied = pBlock.dataset && pBlock.dataset.agyNotifierShift ? parseFloat(pBlock.dataset.agyNotifierShift) || 0 : 0;
            const neededDelta = Math.round(desiredGap - curGap);
            const nextShift = Math.max(12, Math.min(64, curApplied + neededDelta));
            if (nextShift !== curApplied) {
              if (pBlock.dataset) pBlock.dataset.agyNotifierShift = String(nextShift);
              pBlock.style.marginTop = `${baseMt + nextShift}px`;
              const updatedRect = nextSectionNode.getBoundingClientRect();
              if (updatedRect && updatedRect.top) {
                nextSectionTop = updatedRect.top;
              } else {
                nextSectionTop += nextShift - curApplied;
              }
            }
          }
        } catch (_) {}
      }
    }

    if (nextSectionTop > 0 && top + height > nextSectionTop - 4) {
      top = Math.max(Math.round(anchorRect.bottom + 2), Math.round(nextSectionTop - height - 4));
    }

    let fontSize = '13px';
    let fontWeight = '500';
    let paddingLeft = '10px';
    let color = '';
    let iconSize = 15;
    let iconGap = 10;
    try {
      const cs = w.getComputedStyle(anchorBtn);
      if (cs) {
        if (cs.fontSize) fontSize = cs.fontSize;
        if (cs.fontWeight) fontWeight = cs.fontWeight;
        if (cs.paddingLeft) paddingLeft = cs.paddingLeft;
        if (cs.color) color = cs.color;
        if (cs.columnGap && parseFloat(cs.columnGap) > 0) {
          iconGap = Math.round(parseFloat(cs.columnGap));
        } else if (cs.gap && parseFloat(cs.gap) > 0) {
          iconGap = Math.round(parseFloat(cs.gap));
        }
      }
      if (typeof anchorBtn.querySelector === 'function') {
        const svg = anchorBtn.querySelector('svg');
        if (svg && typeof svg.getBoundingClientRect === 'function') {
          const sr = svg.getBoundingClientRect();
          if (sr.width >= 12 && sr.width <= 20) {
            iconSize = Math.round(sr.width);
          }
          if (sr.left > anchorRect.left) {
            paddingLeft = `${Math.round(sr.left - anchorRect.left)}px`;
          }
        }
      }
    } catch (_) {}

    const sidebarRight = sidebarRect
      ? Math.round(sidebarRect.right)
      : Math.round(anchorRect.right + 12);

    return {
      visible: true,
      left,
      top,
      width,
      height,
      sidebarRight,
      fontSize,
      fontWeight,
      paddingLeft,
      color,
      iconSize,
      iconGap,
      isZh: Boolean(w.__AGY_I18N_ACTIVE__) || /自定义配置/.test(anchorLabel),
    };
  }

  window.__AGY_NOTIFIER_TEST_API__ = {
    DEFAULT_PREFS,
    normalizeTrajectoryStatus,
    analyzeTrajectoryTransitions,
    detectApprovalActionInButtons,
    buildConfigJson,
    locateSidebarEntryGeometry,
  };

  // ==================== 环境检查 ====================

  if (typeof document === 'undefined' || !document.body || !document.createElement) {
    return;
  }
  if (window.__AGY_NOTIFIER_ACTIVE__) {
    return;
  }
  window.__AGY_NOTIFIER_ACTIVE__ = true;

  // ==================== 持久化 ====================

  function loadPrefs() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          return {
            ...DEFAULT_PREFS,
            ...p,
            soundVolume:
              typeof p.soundVolume === 'number' && Number.isFinite(p.soundVolume)
                ? Math.max(0, Math.min(1, p.soundVolume))
                : DEFAULT_PREFS.soundVolume,
            minTaskSeconds:
              typeof p.minTaskSeconds === 'number' && Number.isFinite(p.minTaskSeconds)
                ? Math.max(0, p.minTaskSeconds)
                : DEFAULT_PREFS.minTaskSeconds,
            webhookDraft: {
              ...DEFAULT_PREFS.webhookDraft,
              ...(p.webhookDraft && typeof p.webhookDraft === 'object' ? p.webhookDraft : {}),
            },
          };
        }
      }
    } catch (_) {}
    return {
      ...DEFAULT_PREFS,
      webhookDraft: { ...DEFAULT_PREFS.webhookDraft },
    };
  }

  function savePrefs(prefs) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      }
    } catch (_) {}
  }

  function loadHistory() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(HISTORY_KEY) : null;
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.slice(0, MAX_HISTORY_ITEMS);
      }
    } catch (_) {}
    return [];
  }

  function saveHistory(list) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify(list.slice(0, MAX_HISTORY_ITEMS))
        );
      }
    } catch (_) {}
  }

  // ==================== 状态管理 ====================

  const state = {
    prefs: loadPrefs(),
    history: loadHistory(),
    trajectoryStates: new Map(),
    hasBaseline: false,
    anyRunning: false,
    awaitingApproval: false,
    lastDomApprovalSig: '',
    lastDomApprovalMs: 0,
    lastEventByKind: new Map(),
    capturedHeaders: { ...(window.__AGY_CAPTURED_LS_HEADERS__ || {}) },
    modalOpen: false,
    activeTab: 'webhook', // 'webhook' | 'settings' | 'history'
    searchFilter: '',
    sidebarGeo: { visible: false },
    toast: '',
    toastTimer: null,
    isDark: true,
    blinkTimer: null,
    originalTitle: document.title || 'Antigravity',
    blinkFlip: false,
    audioCtx: null,
  };

  // ==================== 音频合成 / 桌面弹窗 / 标题闪烁 ====================

  function playChime(kind) {
    if (!state.prefs.soundEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioCtx !== 'function') return;
    try {
      if (!state.audioCtx) {
        state.audioCtx = new AudioCtx();
      }
      const ctx = state.audioCtx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        void ctx.resume();
      }
      const vol = Math.max(0.05, Math.min(1, state.prefs.soundVolume || 0.45)) * 0.22;
      const notes =
        kind === 'approval'
          ? [
              { freq: 880, start: 0, dur: 0.11 },
              { freq: 880, start: 0.16, dur: 0.14 },
            ]
          : kind === 'error'
          ? [
              { freq: 392, start: 0, dur: 0.16 },
              { freq: 311.13, start: 0.17, dur: 0.22 },
            ]
          : [
              { freq: 523.25, start: 0, dur: 0.11 },
              { freq: 659.25, start: 0.1, dur: 0.11 },
              { freq: 783.99, start: 0.2, dur: 0.18 },
            ];

      const base = ctx.currentTime;
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, base + n.start);
        gain.gain.setValueAtTime(0.0001, base + n.start);
        gain.gain.exponentialRampToValueAtTime(vol, base + n.start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, base + n.start + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(base + n.start);
        osc.stop(base + n.start + n.dur + 0.02);
      }
    } catch (_) {}
  }

  function isWindowUnfocused() {
    try {
      if (document.hidden) return true;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    } catch (_) {}
    return false;
  }

  function stopTitleBlink() {
    if (state.blinkTimer) {
      clearInterval(state.blinkTimer);
      state.blinkTimer = null;
    }
    state.blinkFlip = false;
    try {
      if (state.originalTitle && document.title !== state.originalTitle) {
        document.title = state.originalTitle;
      }
    } catch (_) {}
  }

  function startTitleBlink(prefixText) {
    if (!state.prefs.titleBlink || !isWindowUnfocused()) {
      return;
    }
    if (!state.blinkTimer) {
      state.originalTitle = document.title || state.originalTitle || 'Antigravity';
    } else {
      clearInterval(state.blinkTimer);
    }
    state.blinkFlip = true;
    try {
      document.title = `${prefixText} ${state.originalTitle}`;
    } catch (_) {}
    state.blinkTimer = setInterval(() => {
      if (!isWindowUnfocused()) {
        stopTitleBlink();
        return;
      }
      state.blinkFlip = !state.blinkFlip;
      try {
        document.title = state.blinkFlip
          ? `${prefixText} ${state.originalTitle}`
          : state.originalTitle;
      } catch (_) {}
    }, 1000);
  }

  function sendDesktopNotification(title, body, kind) {
    if (!state.prefs.desktopNotify || typeof Notification !== 'function') {
      return;
    }
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(title, {
          body,
          tag: `agy-notifier-${kind}`,
          silent: true,
        });
        n.onclick = () => {
          try {
            window.focus();
            n.close();
          } catch (_) {}
        };
      } catch (_) {}
    } else if (Notification.permission === 'default') {
      try {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            sendDesktopNotification(title, body, kind);
          }
        }).catch(() => {});
      } catch (_) {}
    }
  }

  function formatEventMeta(ev) {
    if (ev.kind === 'approval') {
      return {
        title: '⚠️ Antigravity 等待您的确认',
        prefix: '【⚠ 等待确认】',
        badge: '等待确认',
        body: ev.summary
          ? `${ev.summary} · 需要批准工具/命令或用户输入`
          : '有一项操作正在等待您的确认',
      };
    }
    if (ev.kind === 'error') {
      return {
        title: '❌ Antigravity 任务异常中断',
        prefix: '【❌ 任务异常】',
        badge: '异常中断',
        body: ev.summary || '执行过程中遇到错误并停止',
      };
    }
    const dur = ev.elapsedSec > 0 ? `（耗时 ${ev.elapsedSec}s）` : '';
    return {
      title: `✅ Antigravity 任务已完成${dur}`,
      prefix: '【✓ 任务完成】',
      badge: '已完成',
      body: ev.summary || '对话生成已结束',
    };
  }

  function dispatchNotificationEvent(ev, isManualTest = false) {
    const info = formatEventMeta(ev);
    const now = Date.now();

    if (!isManualTest) {
      // 跨来源（RPC + DOM）同类型事件 6 秒去重
      const prevSame = state.lastEventByKind.get(ev.kind) || 0;
      if (now - prevSame < 6000) {
        return;
      }
      state.lastEventByKind.set(ev.kind, now);
    }

    // 始终记录通知历史
    const record = {
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      ts: now,
      kind: ev.kind,
      badge: info.badge,
      title: info.title,
      body: info.body,
      isTest: Boolean(isManualTest),
    };
    state.history.unshift(record);
    if (state.history.length > MAX_HISTORY_ITEMS) {
      state.history.length = MAX_HISTORY_ITEMS;
    }
    saveHistory(state.history);

    if (state.prefs.dnd && !isManualTest) {
      render();
      return;
    }

    if (!isManualTest && state.prefs.onlyWhenUnfocused && !isWindowUnfocused()) {
      render();
      return;
    }

    sendDesktopNotification(info.title, info.body, ev.kind);
    playChime(ev.kind);
    if (!isManualTest) {
      startTitleBlink(info.prefix);
    }
    render();
  }

  // ==================== Connect-RPC 监听与轮询 ====================

  function buildRpcHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'connect-protocol-version': '1',
    };
    for (const [k, v] of Object.entries(state.capturedHeaders || {})) {
      if (v) headers[k] = v;
    }
    return headers;
  }

  async function callLsRpc(method, body) {
    const resp = await fetch(`${LS_SERVICE_PREFIX}${method}`, {
      method: 'POST',
      headers: buildRpcHeaders(),
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  }

  function handleTrajectoriesPayload(data) {
    if (!data || typeof data !== 'object') return;
    const summaries = data.trajectorySummaries || data.trajectory_summaries;
    if (!summaries || typeof summaries !== 'object') return;

    const isBaseline = !state.hasBaseline;
    state.hasBaseline = true;

    const events = analyzeTrajectoryTransitions(
      state.trajectoryStates,
      summaries,
      Date.now(),
      state.prefs,
      isBaseline
    );

    let running = false;
    let waiting = false;
    for (const v of state.trajectoryStates.values()) {
      if (v.status === 'RUNNING') running = true;
      if (v.status === 'WAITING') waiting = true;
    }
    const statusChanged = state.anyRunning !== running || state.awaitingApproval !== waiting;
    state.anyRunning = running;
    state.awaitingApproval = waiting;

    for (const ev of events) {
      dispatchNotificationEvent(ev, false);
    }
    if (statusChanged && events.length === 0) {
      render();
    }
  }

  // 无侵入链式挂载 EARLY_RPC_TAP 回调，不覆盖 usage-dashboard 等兄弟插件
  const prevOnHeaders = window.__AGY_ON_RPC_HEADERS__;
  window.__AGY_ON_RPC_HEADERS__ = function (hdrs) {
    if (hdrs && typeof hdrs === 'object') {
      state.capturedHeaders = { ...state.capturedHeaders, ...hdrs };
    }
    if (typeof prevOnHeaders === 'function') {
      try { prevOnHeaders(hdrs); } catch (_) {}
    }
  };

  const prevOnRpcData = window.__AGY_ON_RPC_DATA__;
  window.__AGY_ON_RPC_DATA__ = function (method, data) {
    if (method === 'GetAllCascadeTrajectories') {
      handleTrajectoriesPayload(data);
    }
    if (typeof prevOnRpcData === 'function') {
      try { prevOnRpcData(method, data); } catch (_) {}
    }
  };

  // 若加载前缓存里已有轨迹数据，先建立基线
  if (window.__AGY_CAPTURED_LS_CACHE__ && window.__AGY_CAPTURED_LS_CACHE__.GetAllCascadeTrajectories) {
    handleTrajectoriesPayload(window.__AGY_CAPTURED_LS_CACHE__.GetAllCascadeTrajectories);
  }

  let pollTimer = null;
  async function pollTrajectoriesLoop() {
    try {
      const hdrs = state.capturedHeaders;
      if (hdrs && (hdrs['x-codeium-csrf-token'] || hdrs['x-codeium-ui-token'] || hdrs.authorization)) {
        const data = await callLsRpc('GetAllCascadeTrajectories', {});
        handleTrajectoriesPayload(data);
      }
    } catch (_) {}

    const nextMs = state.anyRunning || state.awaitingApproval ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    pollTimer = setTimeout(pollTrajectoriesLoop, nextMs);
  }

  // ==================== DOM 审批动作条探测（补充感知等待确认） ====================

  function scanDomForApproval() {
    if (!state.prefs.notifyOnApproval) return;
    try {
      const btns = document.querySelectorAll('button, [role="button"]');
      const infos = [];
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        if (!b || typeof b.getBoundingClientRect !== 'function') continue;
        const rect = b.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const insideHost = Boolean(b.closest && b.closest(`#${HOST_ID}`));
        const insideProse = Boolean(
          b.closest && b.closest('pre, code, .prose, [data-lexical-editor]')
        );
        infos.push({
          text: b.textContent || '',
          ariaLabel: b.getAttribute ? b.getAttribute('aria-label') || '' : '',
          insideHost,
          insideProse,
          width: rect.width,
          height: rect.height,
        });
      }
      const res = detectApprovalActionInButtons(infos);
      if (res.waiting) {
        const now = Date.now();
        if (
          res.signature !== state.lastDomApprovalSig ||
          now - state.lastDomApprovalMs >= APPROVAL_COOLDOWN_MS
        ) {
          state.lastDomApprovalSig = res.signature;
          state.lastDomApprovalMs = now;
          state.awaitingApproval = true;
          dispatchNotificationEvent(
            {
              kind: 'approval',
              cid: 'dom-approval',
              summary: '有待确认的命令或步骤权限请求',
              elapsedSec: 0,
              source: 'dom',
            },
            false
          );
        }
      } else {
        state.lastDomApprovalSig = '';
      }
    } catch (_) {}
  }

  // ==================== Shadow DOM 界面 ====================

  let shadowRootRef = null;
  let cardRefs = {};

  function detectThemeIsDark() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) {
        const lum =
          (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
        return lum < 0.5;
      }
    } catch (_) {}
    return true;
  }

  function getShadowRoot() {
    if (shadowRootRef && document.getElementById(HOST_ID)) {
      return shadowRootRef;
    }
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147482990;';
      document.body.appendChild(host);
    }
    shadowRootRef = host.shadowRoot || host.attachShadow({ mode: 'open' });
    buildShell(shadowRootRef);
    return shadowRootRef;
  }

  function buildShell(sr) {
    sr.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      *, *::before, *::after { box-sizing: border-box; }
      .root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        font-size: 12px;
        line-height: 1.45;
      }
      .root.dark {
        --bg: #0f0f12;
        --bg-elev: #0e0e11;
        --surface: #17171c;
        --bento: rgba(255, 255, 255, 0.04);
        --fg: #f4f4f5;
        --fg-soft: #d4d4d8;
        --muted: #8b8b98;
        --border: rgba(255, 255, 255, 0.1);
        --border-soft: rgba(255, 255, 255, 0.06);
        --hover: rgba(255, 255, 255, 0.06);
        --active: rgba(77, 124, 254, 0.16);
        --active-border: rgba(77, 124, 254, 0.55);
        --primary: #4d7cfe;
        --primary-hover: #5f8bff;
        --primary-fg: #ffffff;
        --accent: #34d399;
        --warn: #fbbf24;
        --danger: #f87171;
        --pill: rgba(255, 255, 255, 0.08);
        --shadow: 0 14px 40px rgba(0, 0, 0, 0.56);
        --backdrop: rgba(0, 0, 0, 0.58);
      }
      .root.light {
        --bg: #f8f9fb;
        --bg-elev: #ffffff;
        --surface: #f3f4f6;
        --bento: rgba(0, 0, 0, 0.03);
        --fg: #18181b;
        --fg-soft: #3f3f46;
        --muted: #71717a;
        --border: rgba(0, 0, 0, 0.1);
        --border-soft: rgba(0, 0, 0, 0.06);
        --hover: rgba(0, 0, 0, 0.05);
        --active: rgba(37, 99, 235, 0.1);
        --active-border: rgba(37, 99, 235, 0.45);
        --primary: #2563eb;
        --primary-hover: #1d4ed8;
        --primary-fg: #ffffff;
        --accent: #10b981;
        --warn: #d97706;
        --danger: #dc2626;
        --pill: rgba(0, 0, 0, 0.06);
        --shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
        --backdrop: rgba(15, 23, 42, 0.35);
      }
      .nav-item {
        position: fixed;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: var(--fg-soft);
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
        text-align: left;
        transition: background 0.12s ease, color 0.12s ease;
        user-select: none;
        padding-right: 10px;
      }
      .nav-item:hover {
        background: var(--hover);
        color: var(--fg);
      }
      .nav-item.active {
        background: var(--hover);
        color: var(--fg);
      }
      .nav-left {
        display: flex;
        align-items: center;
        min-width: 0;
        overflow: hidden;
      }
      .nav-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--muted);
        opacity: 0.65;
        flex-shrink: 0;
      }
      .dot.running { background: var(--accent); opacity: 1; box-shadow: 0 0 8px var(--accent); }
      .dot.waiting { background: var(--warn); opacity: 1; box-shadow: 0 0 8px var(--warn); }
      .dot.dnd { background: var(--danger); opacity: 1; }
      .backdrop {
        position: fixed;
        inset: 0;
        background: var(--backdrop);
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .standalone-page {
        position: fixed;
        top: 34px;
        right: 0;
        bottom: 0;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        background: var(--bg-elev);
        color: var(--fg);
        border-left: 1px solid var(--border-soft);
        overflow: hidden;
      }
      .standalone-inner {
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 20px clamp(20px, 4vw, 56px) 0;
      }
      .modal {
        width: 920px;
        max-width: 96vw;
        height: 640px;
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elev);
        color: var(--fg);
        box-shadow: var(--shadow);
        overflow: hidden;
        padding: 18px 24px 0;
      }
      .page-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        padding-bottom: 14px;
      }
      .page-title {
        font-size: 16px;
        font-weight: 600;
        color: var(--fg);
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .seg-group {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--surface);
      }
      .seg-btn {
        border: none;
        background: transparent;
        color: var(--muted);
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .seg-btn:hover { color: var(--fg); }
      .seg-btn.active {
        background: var(--pill);
        color: var(--fg);
        font-weight: 600;
      }
      .search-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid var(--border-soft);
        background: var(--surface);
        margin-bottom: 18px;
      }
      .search-input {
        flex: 1;
        border: none;
        background: transparent;
        color: var(--fg);
        font-size: 12px;
        font-family: inherit;
        outline: none;
      }
      .search-input::placeholder { color: var(--muted); }
      .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 4px;
        padding-bottom: 28px;
        display: flex;
        flex-direction: column;
        gap: 22px;
      }
      .body::-webkit-scrollbar { width: 5px; }
      .body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
      .hero-card {
        display: grid;
        grid-template-columns: minmax(0, 1.02fr) minmax(0, 1fr);
        border-radius: 14px;
        border: 1px solid var(--border-soft);
        background: var(--surface);
        overflow: hidden;
        min-height: 176px;
        flex-shrink: 0;
      }
      .hero-visual {
        position: relative;
        padding: 18px 20px;
        background: radial-gradient(circle at 26% 36%, rgba(77, 124, 254, 0.36), rgba(29, 39, 92, 0.68) 54%, #12131c 100%);
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        align-items: center;
        justify-items: center;
      }
      .root.light .hero-visual {
        background: radial-gradient(circle at 26% 36%, rgba(59, 130, 246, 0.25), rgba(219, 234, 254, 0.85) 60%, #e5edff 100%);
      }
      .hero-tile {
        width: 52px;
        height: 52px;
        border-radius: 13px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(16, 17, 24, 0.78);
        color: #f4f4f5;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
        cursor: pointer;
        font-size: 10px;
        font-weight: 600;
        transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
      }
      .root.light .hero-tile {
        background: rgba(255, 255, 255, 0.9);
        color: #18181b;
        border-color: rgba(0, 0, 0, 0.08);
      }
      .hero-tile:hover { transform: translateY(-2px); }
      .hero-tile.active {
        border: 2px solid var(--primary);
        box-shadow: 0 0 18px rgba(77, 124, 254, 0.42);
      }
      .hero-info {
        padding: 20px 22px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 8px;
      }
      .eyebrow {
        font-size: 11px;
        color: var(--muted);
        font-weight: 500;
      }
      .hero-title {
        font-size: 17px;
        font-weight: 600;
        color: var(--fg);
        margin: 0;
      }
      .hero-desc {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
        margin: 0 0 6px;
      }
      .section-head {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-bottom: 10px;
      }
      .section-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--fg);
      }
      .section-sub {
        font-size: 11px;
        color: var(--muted);
      }
      .catalog-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px 20px;
      }
      .catalog-row {
        min-width: 0;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 10px;
        border-radius: 10px;
        transition: background 0.12s ease;
      }
      .catalog-row:hover {
        background: var(--hover);
      }
      .catalog-left {
        display: flex;
        align-items: center;
        gap: 11px;
        min-width: 0;
        flex: 1;
      }
      .catalog-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: var(--surface);
        border: 1px solid var(--border-soft);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--fg-soft);
        flex-shrink: 0;
        font-size: 14px;
      }
      .catalog-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .catalog-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--fg);
      }
      .catalog-desc {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .card {
        border: 1px solid var(--border-soft);
        background: var(--surface);
        border-radius: 12px;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 11px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .between { justify-content: space-between; }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      @media (max-width: 820px) {
        .hero-card,
        .catalog-grid,
        .grid-2 {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .field-label {
        font-size: 11px;
        color: var(--muted);
        font-weight: 500;
      }
      .input, .select, .textarea {
        width: 100%;
        border: 1px solid var(--border-soft);
        background: var(--bg);
        color: var(--fg);
        border-radius: 8px;
        padding: 7px 10px;
        font-size: 12px;
        font-family: inherit;
        outline: none;
      }
      .input:focus, .select:focus, .textarea:focus {
        border-color: var(--active-border);
      }
      .textarea {
        resize: vertical;
        min-height: 110px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
      }
      .btn {
        border: 1px solid transparent;
        background: var(--pill);
        color: var(--fg-soft);
        border-radius: 999px;
        padding: 5px 13px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.12s ease, color 0.12s ease;
      }
      .btn:hover { background: var(--hover); color: var(--fg); }
      .btn.primary {
        background: var(--primary);
        color: var(--primary-fg);
        font-weight: 600;
      }
      .btn.primary:hover { background: var(--primary-hover); }
      .icon-toggle {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 15px;
        flex-shrink: 0;
      }
      .icon-toggle:hover { background: var(--hover); color: var(--fg); }
      .icon-toggle.on {
        background: var(--active);
        color: var(--primary);
        border-color: var(--active-border);
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--pill);
        color: var(--muted);
        font-size: 10px;
      }
      .pill.ok { color: var(--accent); background: rgba(52, 211, 153, 0.14); }
      .pill.warn { color: var(--warn); }
      .hist-item {
        border: 1px solid var(--border-soft);
        background: var(--surface);
        border-radius: 10px;
        padding: 10px 13px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: var(--surface);
        color: var(--fg);
        border: 1px solid var(--active-border);
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 11px;
        box-shadow: var(--shadow);
        pointer-events: none;
      }
    `;
    sr.appendChild(style);
    const root = document.createElement('div');
    root.className = 'root dark';
    sr.appendChild(root);
    cardRefs = { root };
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'className') node.className = v;
      else if (k === 'style' && typeof v === 'string') node.style.cssText = v;
      else if (k === 'textContent') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== undefined && v !== null && v !== false) {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function renderToastOnly() {
    const root = cardRefs.root;
    if (!root) return;
    const existing = typeof root.querySelector === 'function' ? root.querySelector('.toast') : null;
    if (!state.toast) {
      if (existing && typeof existing.remove === 'function') existing.remove();
      return;
    }
    if (existing) existing.textContent = state.toast;
    else root.appendChild(el('div', { className: 'toast', textContent: state.toast }));
  }

  function showToast(msg) {
    state.toast = msg;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    renderToastOnly();
    state.toastTimer = setTimeout(() => {
      state.toastTimer = null;
      if (state.toast === msg) {
        state.toast = '';
        renderToastOnly();
      }
    }, 2600);
  }

  function formatTimeClock(ms) {
    try {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) {
      return '';
    }
  }

  const WEBHOOK_PROVIDERS = [
    {
      id: 'feishu',
      short: '飞书',
      badge: 'FS',
      name: '飞书机器人 (Feishu)',
      desc: '支持富文本卡片与可选 HMAC-SHA256 签名校验，任务完成或异常时即时推送到群聊。',
      placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...',
    },
    {
      id: 'wecom',
      short: '企微',
      badge: 'WC',
      name: '企业微信机器人 (WeCom)',
      desc: '发送 Markdown 格式摘要，包含当前工作区、模型名称与触发状态。',
      placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...',
    },
    {
      id: 'discord',
      short: 'Discord',
      badge: 'DC',
      name: 'Discord Webhook',
      desc: '发送带状态色条的 Embed 卡片消息，适合个人频道或研发协作通知。',
      placeholder: 'https://discord.com/api/webhooks/...',
    },
    {
      id: 'telegram',
      short: 'TG',
      badge: 'TG',
      name: 'Telegram Bot',
      desc: '通过 Bot Token 与 Chat ID 直推 HTML 格式任务通知到手机端。',
      placeholder: 'https://api.telegram.org/bot<token>/sendMessage',
    },
    {
      id: 'custom',
      short: '自定义',
      badge: 'JSON',
      name: '自定义 JSON Webhook',
      desc: '向任意 HTTP/HTTPS 端点 POST 标准 JSON 载荷，便于接入自有服务或自动化流。',
      placeholder: 'https://your-endpoint.example.com/webhook',
    },
  ];

  function matchesSearch(text) {
    const q = String(state.searchFilter || '').trim().toLowerCase();
    if (!q) return true;
    return String(text || '').toLowerCase().includes(q);
  }

  function renderCatalogToggleRow(iconText, name, desc, isOn, onToggle, extraRight = null) {
    if (!matchesSearch(`${name} ${desc}`)) return null;
    return el('div', { className: 'catalog-row' }, [
      el('div', { className: 'catalog-left' }, [
        el('div', { className: 'catalog-icon', textContent: iconText }),
        el('div', { className: 'catalog-text' }, [
          el('div', { className: 'catalog-name', textContent: name }),
          el('div', { className: 'catalog-desc', textContent: desc }),
        ]),
      ]),
      el('div', { className: 'row', style: 'gap:6px;flex-wrap:nowrap;' }, [
        extraRight,
        el(
          'button',
          {
            className: `icon-toggle${isOn ? ' on' : ''}`,
            title: isOn ? '点击关闭' : '点击启用',
            onClick: onToggle,
          },
          [isOn ? '✓' : '+']
        ),
      ]),
    ]);
  }

  function renderSettingsTab() {
    const p = state.prefs;
    const perm = typeof Notification === 'function' ? Notification.permission : 'unsupported';
    const toggleKey = (key) => {
      p[key] = !p[key];
      savePrefs(p);
      render();
    };

    const channelRows = [
      renderCatalogToggleRow(
        '🔔',
        '桌面系统弹窗 (Notification)',
        perm === 'granted'
          ? '系统通知权限已就绪，点击弹窗可拉起窗口'
          : perm === 'denied'
          ? '系统通知权限已被拒绝，请在系统设置中放行'
          : '点击右侧按钮或授权开启桌面弹窗提醒',
        Boolean(p.desktopNotify),
        () => {
          if (!p.desktopNotify && perm === 'default' && typeof Notification === 'function') {
            Notification.requestPermission().then(() => render()).catch(() => {});
          }
          toggleKey('desktopNotify');
        }
      ),
      renderCatalogToggleRow(
        '🎵',
        'Web Audio 柔和提示音',
        `当前音量 ${Math.round((p.soundVolume || 0.45) * 100)}%，完成/授权/异常区分音色`,
        Boolean(p.soundEnabled),
        () => toggleKey('soundEnabled'),
        el(
          'button',
          {
            className: 'btn',
            style: 'padding:3px 9px;',
            onClick: () => playChime('complete'),
          },
          ['试听']
        )
      ),
      renderCatalogToggleRow(
        '✨',
        '后台标题栏闪烁',
        '窗口处于后台时交替提示「✓ 任务完成 / ⚠ 等待确认」',
        Boolean(p.titleBlink),
        () => toggleKey('titleBlink')
      ),
      renderCatalogToggleRow(
        '👁',
        '仅切出后台时触发提醒',
        '正在当前窗口操作时不弹框不响铃，避免打扰',
        Boolean(p.onlyWhenUnfocused),
        () => toggleKey('onlyWhenUnfocused')
      ),
    ].filter(Boolean);

    const eventRows = [
      renderCatalogToggleRow(
        '✅',
        '任务完成通知',
        `当执行耗时超过 ${p.minTaskSeconds} 秒后自动触发`,
        Boolean(p.notifyOnComplete),
        () => toggleKey('notifyOnComplete')
      ),
      renderCatalogToggleRow(
        '⚠',
        '等待用户授权 / 输入',
        '出现命令批准、文件修改或输入挂起时即时提醒',
        Boolean(p.notifyOnApproval),
        () => toggleKey('notifyOnApproval')
      ),
      renderCatalogToggleRow(
        '❌',
        '任务异常中断',
        '执行报错或触发上限停止时第一时间通知',
        Boolean(p.notifyOnError),
        () => toggleKey('notifyOnError')
      ),
    ].filter(Boolean);

    return el('div', { className: 'body' }, [
      el('div', null, [
        el('div', { className: 'section-head' }, [
          el('div', { className: 'section-title', textContent: '本地提醒通道' }),
          el('div', {
            className: 'section-sub',
            textContent: '在桌面系统弹窗、Web Audio 合成音与标题闪烁之间自由组合。',
          }),
        ]),
        el('div', { className: 'catalog-grid' }, channelRows),
      ]),
      el('div', null, [
        el('div', { className: 'section-head' }, [
          el('div', { className: 'section-title', textContent: '触发事件与防打扰' }),
          el('div', {
            className: 'section-sub',
            textContent: '配置需要感知的任务节点与最短耗时过滤阈值。',
          }),
        ]),
        el('div', { className: 'catalog-grid' }, eventRows),
      ]),
      el('div', { className: 'card' }, [
        el('div', { className: 'row between' }, [
          el('div', { className: 'row' }, [
            el('span', { style: 'color:var(--muted);font-size:11px;', textContent: '最短耗时阈值' }),
            el(
              'select',
              {
                className: 'select',
                style: 'width:auto;',
                value: String(p.minTaskSeconds),
                onChange: (e) => {
                  p.minTaskSeconds = Number(e.target.value) || 0;
                  savePrefs(p);
                  render();
                },
              },
              [0, 5, 15, 30, 60].map((sec) =>
                el('option', {
                  value: String(sec),
                  selected: p.minTaskSeconds === sec,
                  textContent: sec === 0 ? '0 秒（每轮都提醒）' : `${sec} 秒`,
                })
              )
            ),
          ]),
          el('div', { className: 'row' }, [
            el('span', { style: 'color:var(--muted);font-size:11px;', textContent: '提示音量' }),
            el('input', {
              type: 'range',
              min: '0.1',
              max: '1',
              step: '0.05',
              value: String(p.soundVolume),
              onInput: (e) => {
                p.soundVolume = Number(e.target.value) || 0.45;
                savePrefs(p);
              },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  function renderHistoryTab() {
    const filtered = state.history.filter((item) =>
      matchesSearch(`${item.title} ${item.body} ${item.badge}`)
    );
    return el('div', { className: 'body' }, [
      el('div', { className: 'row between' }, [
        el('span', {
          style: 'color:var(--muted);font-size:12px;',
          textContent: `共 ${filtered.length} 条通知记录`,
        }),
        state.history.length > 0
          ? el(
              'button',
              {
                className: 'btn',
                onClick: () => {
                  state.history = [];
                  saveHistory(state.history);
                  render();
                },
              },
              ['清空记录']
            )
          : null,
      ]),
      ...(filtered.length > 0
        ? filtered.map((item) =>
            el('div', { className: 'hist-item' }, [
              el('div', { className: 'row between' }, [
                el('strong', { style: 'font-size:12px;', textContent: item.title }),
                el('span', {
                  className: 'pill',
                  textContent: `${item.isTest ? '测试 · ' : ''}${formatTimeClock(item.ts)}`,
                }),
              ]),
              el('div', {
                style: 'color:var(--muted);font-size:11px;',
                textContent: item.body,
              }),
            ])
          )
        : [
            el('div', {
              className: 'card',
              style: 'text-align:center;color:var(--muted);padding:28px;',
              textContent: '暂无匹配的通知记录，可点击上方「测试本地提醒」体验效果。',
            }),
          ]),
    ]);
  }

  function renderWebhookTab() {
    const d = state.prefs.webhookDraft;
    const activeProvider =
      WEBHOOK_PROVIDERS.find((item) => item.id === d.provider) || WEBHOOK_PROVIDERS[0];
    const jsonPreview = buildConfigJson(d);
    const updateDraft = (patch, reRender = false) => {
      Object.assign(d, patch);
      savePrefs(state.prefs);
      if (reRender) render();
      else {
        const pre = shadowRootRef?.getElementById('notifier-cfg-json');
        if (pre) pre.value = buildConfigJson(d);
      }
    };

    const platformRows = WEBHOOK_PROVIDERS.filter((item) =>
      matchesSearch(`${item.name} ${item.desc} ${item.id}`)
    ).map((item) => {
      const isCurrent = item.id === activeProvider.id;
      return el('div', { className: 'catalog-row' }, [
        el('div', { className: 'catalog-left' }, [
          el('div', { className: 'catalog-icon', textContent: item.badge }),
          el('div', { className: 'catalog-text' }, [
            el('div', { className: 'catalog-name', textContent: item.name }),
            el('div', { className: 'catalog-desc', textContent: item.desc }),
          ]),
        ]),
        el(
          'button',
          {
            className: `icon-toggle${isCurrent ? ' on' : ''}`,
            title: isCurrent ? '当前选中平台' : `切换到 ${item.name}`,
            onClick: () => updateDraft({ provider: item.id }, true),
          },
          [isCurrent ? '✓' : '+']
        ),
      ]);
    });

    return el('div', { className: 'body' }, [
      el('div', { className: 'hero-card' }, [
        el(
          'div',
          { className: 'hero-visual' },
          WEBHOOK_PROVIDERS.map((item) =>
            el(
              'button',
              {
                className: `hero-tile${item.id === activeProvider.id ? ' active' : ''}`,
                title: item.name,
                onClick: () => updateDraft({ provider: item.id }, true),
              },
              [
                el('span', { style: 'font-size:13px;', textContent: item.badge }),
                el('span', { textContent: item.short }),
              ]
            )
          )
        ),
        el('div', { className: 'hero-info' }, [
          el('div', { className: 'eyebrow', textContent: 'Featured · Stop Hook 远程推送' }),
          el('h3', { className: 'hero-title', textContent: activeProvider.name }),
          el('p', { className: 'hero-desc', textContent: activeProvider.desc }),
          el('div', { className: 'row' }, [
            el(
              'button',
              {
                className: 'btn primary',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(buildConfigJson(d));
                    showToast('已复制 notifier-config.json');
                  } catch (_) {}
                },
              },
              ['+ 复制配置']
            ),
            el(
              'button',
              {
                className: 'btn',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(
                      'python "%USERPROFILE%\\.gemini\\config\\plugins\\antigravity-notifier\\scripts\\notify_hook.py" --test'
                    );
                    showToast('已复制终端测试命令');
                  } catch (_) {}
                },
              },
              ['测试命令']
            ),
          ]),
        ]),
      ]),
      platformRows.length > 0
        ? el('div', null, [
            el('div', { className: 'section-head' }, [
              el('div', { className: 'section-title', textContent: '支持的推送平台' }),
              el('div', {
                className: 'section-sub',
                textContent: '由内置 Stop Hook (scripts/notify_hook.py) 在后台非阻塞发送，无跨域限制。',
              }),
            ]),
            el('div', { className: 'catalog-grid' }, platformRows),
          ])
        : null,
      el('div', null, [
        el('div', { className: 'section-head' }, [
          el('div', { className: 'section-title', textContent: '当前通道参数与导出' }),
          el('div', {
            className: 'section-sub',
            textContent:
              '将生成内容保存为 ~/.gemini/config/plugins/antigravity-notifier/runtime/notifier-config.json 即可生效。',
          }),
        ]),
        el('div', { className: 'card' }, [
          el('div', { className: 'grid-2' }, [
            el('div', { className: 'field' }, [
              el('span', { className: 'field-label', textContent: '消息前缀' }),
              el('input', {
                className: 'input',
                value: d.titlePrefix || 'Antigravity',
                onInput: (e) => updateDraft({ titlePrefix: e.target.value }),
              }),
            ]),
            el('label', { className: 'row', style: 'cursor:pointer;padding-top:16px;' }, [
              el('input', {
                type: 'checkbox',
                checked: Boolean(d.enabled),
                onChange: (e) => updateDraft({ enabled: Boolean(e.target.checked) }, true),
              }),
              el('span', { style: 'font-size:12px;', textContent: '启用此 Webhook 远程推送' }),
            ]),
          ]),
          d.provider === 'telegram'
            ? el('div', { className: 'grid-2' }, [
                el('div', { className: 'field' }, [
                  el('span', { className: 'field-label', textContent: 'Bot Token' }),
                  el('input', {
                    className: 'input',
                    value: d.telegramBotToken || '',
                    placeholder: '123456:ABC-DEF...',
                    onInput: (e) => updateDraft({ telegramBotToken: e.target.value }),
                  }),
                ]),
                el('div', { className: 'field' }, [
                  el('span', { className: 'field-label', textContent: 'Chat ID' }),
                  el('input', {
                    className: 'input',
                    value: d.telegramChatId || '',
                    placeholder: '-100123456789',
                    onInput: (e) => updateDraft({ telegramChatId: e.target.value }),
                  }),
                ]),
              ])
            : el('div', { className: 'field' }, [
                el('span', { className: 'field-label', textContent: 'Webhook URL' }),
                el('input', {
                  className: 'input',
                  value: d.webhookUrl || '',
                  placeholder: activeProvider.placeholder,
                  onInput: (e) => updateDraft({ webhookUrl: e.target.value }),
                }),
              ]),
          d.provider === 'feishu'
            ? el('div', { className: 'field' }, [
                el('span', { className: 'field-label', textContent: '飞书签名校验 Secret（可选）' }),
                el('input', {
                  className: 'input',
                  value: d.secret || '',
                  placeholder: '若机器人开启了签名校验请填写',
                  onInput: (e) => updateDraft({ secret: e.target.value }),
                }),
              ])
            : null,
          el('div', { className: 'field' }, [
            el('span', { className: 'field-label', textContent: '生成的 notifier-config.json' }),
            el('textarea', {
              id: 'notifier-cfg-json',
              className: 'textarea',
              readOnly: true,
              value: jsonPreview,
            }),
          ]),
        ]),
      ]),
    ]);
  }

  function createBellIconSvg(size = 15) {
    const svgNS = 'http://www.w3.org/2000/svg';
    if (typeof document.createElementNS !== 'function') {
      return el('span', { textContent: '🔔' });
    }
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p1 = document.createElementNS(svgNS, 'path');
    p1.setAttribute('d', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9');
    const p2 = document.createElementNS(svgNS, 'path');
    p2.setAttribute('d', 'M13.73 21a2 2 0 0 1-3.46 0');
    svg.appendChild(p1);
    svg.appendChild(p2);
    return svg;
  }

  function renderSidebarEntryOnly(geo) {
    const root = cardRefs.root;
    if (!root) return;
    const oldNav = typeof root.querySelector === 'function' ? root.querySelector('.nav-item') : null;
    if (oldNav && typeof oldNav.remove === 'function') {
      oldNav.remove();
    }
    if (!geo || !geo.visible) {
      return;
    }

    const dotClass = state.prefs.dnd
      ? 'dot dnd'
      : state.awaitingApproval
      ? 'dot waiting'
      : state.anyRunning
      ? 'dot running'
      : 'dot';

    const colorStyle = geo.color ? `color:${geo.color};` : '';
    const iconSize = geo.iconSize || 15;
    const iconGap = geo.iconGap || 10;

    const navBtn = el(
      'button',
      {
        id: 'agy-notifier-sidebar-btn',
        className: `nav-item${state.modalOpen ? ' active' : ''}`,
        style: `left:${geo.left}px;top:${geo.top}px;width:${geo.width}px;height:${geo.height}px;font-size:${geo.fontSize};font-weight:${geo.fontWeight || '500'};padding-left:${geo.paddingLeft};${colorStyle}`,
        title: '远程推送与任务通知设置 (Alt+N)',
        onMousedown: (e) => e.preventDefault(),
        onClick: () => {
          state.modalOpen = !state.modalOpen;
          render();
        },
      },
      [
        el('span', { className: 'nav-left', style: `gap:${iconGap}px;` }, [
          createBellIconSvg(iconSize),
          el('span', {
            className: 'nav-label',
            textContent: geo.isZh ? '远程推送' : 'Remote Push',
          }),
        ]),
        el('span', { className: dotClass }),
      ]
    );
    root.insertBefore ? root.insertBefore(navBtn, root.firstChild || null) : root.appendChild(navBtn);
  }

  function render() {
    state.isDark = detectThemeIsDark();
    // 「远程推送」入口已迁移至左侧栏原生「插件」分组 (MCP App global entrypoint)，不再向左侧栏注入 DOM 按钮或修改 marginTop
    state.sidebarGeo = { visible: false };
    const sr = getShadowRoot();
    const root = cardRefs.root;
    if (!sr || !root) return;

    root.className = `root ${state.isDark ? 'dark' : 'light'}`;
    root.innerHTML = '';

    if (state.modalOpen) {
      const segBtn = (id, label) =>
        el(
          'button',
          {
            className: `seg-btn${state.activeTab === id ? ' active' : ''}`,
            onClick: () => {
              state.activeTab = id;
              render();
            },
          },
          [label]
        );

      const content =
        state.activeTab === 'history'
          ? renderHistoryTab()
          : state.activeTab === 'settings'
          ? renderSettingsTab()
          : renderWebhookTab();

      const panelChildren = [
        el('div', { className: 'page-head' }, [
          el('div', { className: 'page-title' }, [
            el('span', {
              className: state.prefs.dnd
                ? 'dot dnd'
                : state.awaitingApproval
                ? 'dot waiting'
                : state.anyRunning
                ? 'dot running'
                : 'dot',
            }),
            el('span', { textContent: '远程推送' }),
          ]),
          el('div', { className: 'row' }, [
            el('div', { className: 'seg-group' }, [
              segBtn('webhook', '远程推送'),
              segBtn('settings', '本地提醒'),
              segBtn('history', `记录 (${state.history.length})`),
            ]),
            el(
              'button',
              {
                className: 'btn',
                onClick: () =>
                  dispatchNotificationEvent(
                    {
                      kind: 'complete',
                      cid: 'manual-test',
                      summary: '这是一条桌面弹窗与提示音测试通知',
                      elapsedSec: 12,
                      source: 'manual',
                    },
                    true
                  ),
              },
              ['测试提醒']
            ),
            el(
              'button',
              {
                className: 'btn',
                onClick: () => {
                  state.modalOpen = false;
                  render();
                },
              },
              ['关闭']
            ),
          ]),
        ]),
        el('div', { className: 'search-bar' }, [
          el('span', { style: 'color:var(--muted);font-size:12px;', textContent: '⌕' }),
          el('input', {
            id: 'notifier-search-input',
            className: 'search-input',
            type: 'text',
            value: state.searchFilter || '',
            placeholder: '搜索推送平台、提醒通道或通知记录…',
            onInput: (e) => {
              state.searchFilter = e.target.value;
              render();
              setTimeout(() => {
                const inp = shadowRootRef?.getElementById('notifier-search-input');
                if (inp && typeof inp.focus === 'function') {
                  inp.focus();
                  if (typeof inp.setSelectionRange === 'function') {
                    inp.setSelectionRange(inp.value.length, inp.value.length);
                  }
                }
              }, 0);
            },
          }),
          el(
            'button',
            {
              className: 'btn',
              style: 'padding:3px 10px;',
              onClick: () => {
                state.prefs.dnd = !state.prefs.dnd;
                savePrefs(state.prefs);
                render();
              },
            },
            [state.prefs.dnd ? '免打扰: 开' : '免打扰: 关']
          ),
        ]),
        content,
      ];

      if (state.sidebarGeo && state.sidebarGeo.visible) {
        root.appendChild(
          el(
            'div',
            {
              id: 'agy-notifier-standalone',
              className: 'standalone-page',
              style: `left:${state.sidebarGeo.sidebarRight}px;`,
            },
            [el('div', { className: 'standalone-inner' }, panelChildren)]
          )
        );
      } else {
        root.appendChild(
          el(
            'div',
            {
              className: 'backdrop',
              onClick: (e) => {
                if (e.target === e.currentTarget) {
                  state.modalOpen = false;
                  render();
                }
              },
            },
            [el('div', { id: 'agy-notifier-standalone', className: 'modal' }, panelChildren)]
          )
        );
      }
    }

    if (state.toast) {
      root.appendChild(el('div', { className: 'toast', textContent: state.toast }));
    }
  }

  // 点击左侧边栏其他原生导航/对话项时，自动退出独立界面
  document.addEventListener(
    'click',
    (e) => {
      if (!state.modalOpen) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.some((n) => n && n.id === HOST_ID)) return;
      const btn = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
      if (btn && state.sidebarGeo && state.sidebarGeo.visible) {
        const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
        if (r && r.left < state.sidebarGeo.sidebarRight) {
          state.modalOpen = false;
          render();
        }
      }
    },
    true
  );

  window.addEventListener(
    'resize',
    () => {
      if (state.modalOpen) {
        // 原生左侧栏入口已由 MCP App 接管，不再轮询或修改左侧栏 DOM 几何
      const nextGeo = { visible: false };
        state.sidebarGeo = nextGeo;
        renderSidebarEntryOnly(nextGeo);
        const page = shadowRootRef?.getElementById('agy-notifier-standalone');
        if (page && nextGeo.visible && page.className === 'standalone-page') {
          page.style.left = `${nextGeo.sidebarRight}px`;
        }
      } else {
        render();
      }
    },
    true
  );

  // ==================== 全局事件监听与启动 ====================

  window.addEventListener('focus', stopTitleBlink, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      stopTitleBlink();
    }
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        e.stopPropagation();
        state.modalOpen = !state.modalOpen;
        render();
        return;
      }
      if (state.modalOpen && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        state.modalOpen = false;
        render();
      }
    },
    true
  );

  function normalizeLeftSidebarPluginsGap() {
    try {
      if (typeof document === 'undefined' || !document.querySelectorAll) return;
      const btns = document.querySelectorAll('button, a, [role="button"]');
      let custBtn = null;
      let custRect = null;
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        if (!b || (b.closest && b.closest(`#${HOST_ID}`))) continue;
        const txt = (b.textContent || '').trim();
        if (!/^(Customizations|自定义配置|自定义)$/i.test(txt)) continue;
        const r = b.getBoundingClientRect();
        if (r.left >= 0 && r.left < 240 && r.top > 30 && r.top < 360 && r.width > 40 && r.height > 16) {
          custBtn = b;
          custRect = r;
          break;
        }
      }
      if (!custBtn || !custRect) return;

      const nodes = document.querySelectorAll('div, span, button, h2, h3, p');
      let plugNode = null;
      let plugRect = null;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n || (n.closest && n.closest(`#${HOST_ID}`))) continue;
        const txt = (n.textContent || '').trim();
        if (!/^(Plugins|插件)$/i.test(txt)) continue;
        const r = n.getBoundingClientRect();
        if (r.left >= 0 && r.left < 240 && r.top > custRect.bottom && r.top < custRect.bottom + 120 && r.height > 8 && r.height < 40) {
          plugNode = n;
          plugRect = r;
          break;
        }
      }
      if (!plugNode || !plugRect) return;

      let pBlock = plugNode;
      while (
        pBlock &&
        pBlock.parentElement &&
        pBlock.parentElement !== document.body &&
        typeof pBlock.parentElement.contains === 'function' &&
        !pBlock.parentElement.contains(custBtn)
      ) {
        pBlock = pBlock.parentElement;
      }
      if (!pBlock || !pBlock.style) return;

      const targetGap = 14;
      const curGap = plugRect.top - custRect.bottom;
      if (pBlock.dataset && pBlock.dataset.agyGapAdjusted === '1') {
        if (curGap >= targetGap - 3 && curGap <= targetGap + 5) return;
      }
      if (curGap <= targetGap + 4) return;

      let baseMt = 0;
      if (pBlock.dataset && pBlock.dataset.agyGapBaseMt !== undefined) {
        baseMt = parseFloat(pBlock.dataset.agyGapBaseMt) || 0;
      } else {
        baseMt = parseFloat(window.getComputedStyle(pBlock).marginTop) || 0;
        if (pBlock.dataset) pBlock.dataset.agyGapBaseMt = String(baseMt);
      }
      const curApplied = pBlock.dataset && pBlock.dataset.agyGapDelta ? parseFloat(pBlock.dataset.agyGapDelta) || 0 : 0;
      const delta = Math.max(0, Math.min(32, Math.round(curApplied + (curGap - targetGap))));
      if (pBlock.dataset) {
        pBlock.dataset.agyGapDelta = String(delta);
        pBlock.dataset.agyGapAdjusted = '1';
      }
      pBlock.style.marginTop = `${baseMt - delta}px`;
    } catch (_) {}
  }

  // 节流观察 DOM 审批按钮 & 左侧栏「插件」区块间距归一化
  let domScanTimer = null;
  if (typeof MutationObserver === 'function') {
    const obs = new MutationObserver(() => {
      if (domScanTimer) return;
      domScanTimer = setTimeout(() => {
        domScanTimer = null;
        scanDomForApproval();
        normalizeLeftSidebarPluginsGap();
      }, 450);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  render();
  setTimeout(normalizeLeftSidebarPluginsGap, 300);
  pollTimer = setTimeout(pollTrajectoriesLoop, 1500);
})();
