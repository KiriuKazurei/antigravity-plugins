/**
 * Antigravity 侧边栏浮动模型 Usage Dashboard（插件运行时）
 * 纯浏览器 DOM 环境执行，无任何 Node.js 内置模块依赖。
 */
(function () {
  'use strict';

  const meta = window.__AGY_PLUGIN_META__ || {};
  try {
    delete window.__AGY_PLUGIN_META__;
  } catch (_) {}

  if (window.__AGY_USAGE_DASHBOARD_ACTIVE__) {
    return;
  }
  window.__AGY_USAGE_DASHBOARD_ACTIVE__ = true;

  const PREFS_KEY = 'agy_usage_dashboard_prefs_v2';
  const LS_SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
  const AUTO_REFRESH_MS = 30000;
  const ACTIVE_SESSION_POLL_MS = 5000;
  const COUNTDOWN_TICK_MS = 30000;
  const MAX_TRAJECTORIES_FOR_TOKENS = 15;
  const DEFAULT_CARD_HEIGHT = 250;
  const MIN_CARD_HEIGHT = 135;
  const HOST_ID = 'agy-usage-dashboard-host';

  // ==================== 状态与偏好设置 ====================

  function loadPrefs() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            collapsed: Boolean(parsed.collapsed),
            showUsed: Boolean(parsed.showUsed),
            hiddenPools: Array.isArray(parsed.hiddenPools)
              ? parsed.hiddenPools.filter((x) => typeof x === 'string')
              : [],
            hiddenModels: Array.isArray(parsed.hiddenModels)
              ? parsed.hiddenModels.filter((x) => typeof x === 'string')
              : [],
            customHeight:
              typeof parsed.customHeight === 'number' && Number.isFinite(parsed.customHeight)
                ? parsed.customHeight
                : null,
          };
        }
      }
    } catch (_) {}
    return {
      collapsed: false,
      showUsed: false,
      hiddenPools: [],
      hiddenModels: [],
      customHeight: null,
    };
  }

  function savePrefs(prefs) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      }
    } catch (_) {}
  }

  function initHistoryStore() {
    const raw = window.__AGY_USAGE_HISTORY_INIT__;
    try {
      delete window.__AGY_USAGE_HISTORY_INIT__;
    } catch (_) {}
    if (raw && typeof raw === 'object') {
      return {
        totals: raw.totals || { totalTokens: 0, turns: 0 },
        byModel: raw.byModel && typeof raw.byModel === 'object' ? { ...raw.byModel } : {},
        sessions: raw.sessions && typeof raw.sessions === 'object' ? { ...raw.sessions } : {},
        events: Array.isArray(raw.events) ? [...raw.events] : [],
      };
    }
    return {
      totals: { totalTokens: 0, turns: 0 },
      byModel: {},
      sessions: {},
      events: [],
    };
  }

  const state = {
    prefs: loadPrefs(),
    settingsOpen: false,
    loading: false,
    error: null,
    waitingAuth: false,
    lastUpdatedAt: 0,
    capturedHeaders: {},
    capturedMetadata: null,
    activeCascadeId: '',
    trajectoryCache: new Map(),
    history: initHistoryStore(),
    sentEventFingerprints: new Map(), // cascadeId::executionId -> fingerprint
    pendingEvents: [],
    pendingSessions: {},
    rawSources: {
      userStatus: null,
      quotaSummary: null,
      availableModels: null,
      cascadeConfigs: null,
      trajectories: null,
      activeGeneratorMetadata: null,
      otherGeneratorMetadatas: [],
    },
    normalized: {
      planName: '',
      credits: [],
      quotaPools: [],
      tokenModels: [],
      sessionMetrics: {
        cascadeId: '',
        turnTokens: 0,
        turnInputTokens: 0,
        turnOutputTokens: 0,
        turnThinkingTokens: 0,
        turnCacheReadTokens: 0,
        turnCalls: 0,
        tps: null,
        sessionTokens: 0,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
        sessionThinkingTokens: 0,
        sessionCacheReadTokens: 0,
        sessionCalls: 0,
      },
    },
    isDark: true,
    isZh: true,
  };

  // Seed sentEventFingerprints from loaded JSON history so we don't re-emit unchanged past turns
  for (const ev of state.history.events) {
    if (ev && ev.cascadeId && ev.executionId) {
      state.sentEventFingerprints.set(
        `${ev.cascadeId}::${ev.executionId}`,
        `${ev.totalTokens}:${ev.outputTokens}:${ev.tps ?? 'null'}:${ev.model}`
      );
    }
  }

  window.__AGY_DRAIN_USAGE_HISTORY__ = function () {
    if (state.pendingEvents.length === 0 && Object.keys(state.pendingSessions).length === 0) {
      return null;
    }
    const batch = {
      events: state.pendingEvents.splice(0, state.pendingEvents.length),
      sessions: state.pendingSessions,
    };
    state.pendingSessions = {};
    return batch;
  };

  // ==================== 纯逻辑与格式化 ====================

  function clampFraction(val) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return null;
    }
    if (val < 0) return 0;
    if (val > 1) return 1;
    return val;
  }

  function parseNum(val) {
    if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
    if (typeof val === 'string' && val.trim()) {
      const n = Number(val);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function parseTimestampMs(ts) {
    if (!ts) return null;
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      return ts > 1e12 ? ts : ts * 1000;
    }
    if (typeof ts === 'object' && ts.seconds !== undefined) {
      const sec = Number(ts.seconds);
      const nanos = Number(ts.nanos || 0);
      if (Number.isFinite(sec)) {
        return sec * 1000 + Math.floor(nanos / 1e6);
      }
    }
    return null;
  }

  function parseProtoDurationSec(dur) {
    if (!dur) return 0;
    if (typeof dur === 'number') {
      return Number.isFinite(dur) && dur > 0 ? dur : 0;
    }
    if (typeof dur === 'string') {
      const m = dur.trim().match(/^(-?\d+(?:\.\d+)?)s$/i);
      if (m) {
        const v = Number(m[1]);
        return Number.isFinite(v) && v > 0 ? v : 0;
      }
      return 0;
    }
    if (typeof dur === 'object') {
      const sec = Number(dur.seconds || 0);
      const nanos = Number(dur.nanos || 0);
      const total = (Number.isFinite(sec) ? sec : 0) + (Number.isFinite(nanos) ? nanos / 1e9 : 0);
      return total > 0 ? total : 0;
    }
    return 0;
  }

  function formatTokens(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 100000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    if (v < 1000000) return `${Math.round(v / 1000)}K`;
    return `${(v / 1000000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }

  function formatTps(tps) {
    if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) {
      return '--';
    }
    return tps >= 100 ? `${Math.round(tps)} t/s` : `${tps.toFixed(1)} t/s`;
  }

  function formatResetCountdown(resetMs, nowMs, isZh) {
    if (!resetMs || !Number.isFinite(resetMs)) return '';
    const diff = resetMs - nowMs;
    if (diff <= 0) {
      return isZh ? '已重置' : 'Ready';
    }
    const totalMin = Math.floor(diff / 60000);
    if (totalMin < 1) {
      return '<1m';
    }
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) {
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours > 0) {
      return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
    return `${mins}m`;
  }

  function formatLocalClock(ms) {
    if (!ms || !Number.isFinite(ms)) return '';
    try {
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch (_) {
      return '';
    }
  }

  function formatLocalDateTime(ms) {
    if (!ms || !Number.isFinite(ms)) return '';
    try {
      const d = new Date(ms);
      const yyyy = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mo}-${dd} ${hh}:${mm}`;
    } catch (_) {
      return '';
    }
  }

  function extractQuotaInfo(quotaInfo) {
    if (!quotaInfo || typeof quotaInfo !== 'object') {
      return { remainingFraction: null, resetMs: null };
    }
    const resetMs = parseTimestampMs(quotaInfo.resetTime);
    let frac = clampFraction(quotaInfo.remainingFraction);
    if (frac === null && quotaInfo.remainingFraction === undefined && resetMs !== null) {
      frac = 0;
    }
    return { remainingFraction: frac, resetMs };
  }

  function baseModelFamily(label) {
    if (!label || typeof label !== 'string') return '';
    return label
      .replace(/\s*\((?:Extra\s*High|High|Medium|Low|Fast|Thinking|Preview|Experimental|Lite)\)\s*$/i, '')
      .replace(/\s+(?:Extra\s*High|High|Medium|Low)\s*$/i, '')
      .trim();
  }

  function inferQuotaPoolName(name) {
    const s = String(name || '');
    if (/argon/i.test(s)) return 'Gemini 4 Argon';
    if (/gemini|neon|hydrogen|carbon/i.test(s)) return 'Gemini Models';
    if (/claude|gpt|openai/i.test(s)) return 'Claude & GPT';
    return baseModelFamily(s) || s;
  }

  function getPoolPriority(name) {
    const s = String(name || '');
    if (/argon/i.test(s)) return 1;
    if (/gemini|neon|hydrogen|carbon/i.test(s)) return 0;
    if (/claude/i.test(s)) return 2;
    if (/gpt|openai/i.test(s)) return 3;
    return 4;
  }

  function formatPoolTitle(name, isZh) {
    const s = String(name || '').trim();
    if (!s) return isZh ? '其他模型' : 'Other';
    if (/^claude\s+and\s+gpt\s+models$/i.test(s)) return 'Claude & GPT';
    return s;
  }

  function formatWindowLabel(displayName, windowStr, poolName, isZh) {
    const raw = `${displayName || ''} ${windowStr || ''}`.trim();
    if (/five\s*hour|5\s*-?\s*hour|\b5h\b/i.test(raw)) {
      return isZh ? '5h 额度' : '5h Limit';
    }
    if (/weekly|7\s*d(?:ay)?s?|\b1w\b/i.test(raw)) {
      return isZh ? '周额度' : 'Weekly';
    }
    if (/daily|24\s*h|\b1d\b/i.test(raw)) {
      return isZh ? '日额度' : 'Daily';
    }
    let label = String(displayName || windowStr || '').trim();
    if (poolName && label.toLowerCase().startsWith(poolName.toLowerCase())) {
      label = label.slice(poolName.length).trim();
    }
    label = label.replace(/\s*Limit\s*Remaining$/i, '').replace(/\s*Remaining$/i, '').trim();
    return label || (isZh ? '共享额度' : 'Quota');
  }

  function computeGeneratorMetrics(generatorMetadataList, cascadeId, enumToLabelMap) {
    const empty = {
      turnTokens: 0,
      turnInputTokens: 0,
      turnOutputTokens: 0,
      turnThinkingTokens: 0,
      turnCacheReadTokens: 0,
      turnCalls: 0,
      tps: null,
      sessionTokens: 0,
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
      sessionThinkingTokens: 0,
      sessionCacheReadTokens: 0,
      sessionCalls: 0,
      byModelEnum: new Map(),
      turnEvents: [],
    };

    if (!Array.isArray(generatorMetadataList) || generatorMetadataList.length === 0) {
      return empty;
    }

    const calls = [];
    const byExecId = new Map();

    for (const gm of generatorMetadataList) {
      if (!gm || typeof gm !== 'object') continue;
      const cm = gm.chatModel;
      if (!cm || typeof cm !== 'object' || !cm.usage) continue;
      const u = cm.usage;
      const inputTokens = parseNum(u.inputTokens);
      const thinkingTokens = parseNum(u.thinkingOutputTokens);
      const responseTokens = parseNum(u.responseOutputTokens);
      const rawOutput = parseNum(u.outputTokens);
      const outputTokens = rawOutput > 0 ? rawOutput : thinkingTokens + responseTokens;
      const cacheReadTokens = parseNum(u.cacheReadTokens);
      const cacheWriteTokens = parseNum(u.cacheWriteTokens);
      const totalTokens = inputTokens + outputTokens;
      const streamSec = parseProtoDurationSec(cm.streamingDuration);
      const modelEnum = String(cm.model || u.model || '').trim();
      const executionId = gm.executionId ? String(gm.executionId) : '';
      const tsRaw =
        (cm.chatStartMetadata && cm.chatStartMetadata.startTime) ||
        gm.timestamp ||
        '';

      empty.sessionInputTokens += inputTokens;
      empty.sessionOutputTokens += outputTokens;
      empty.sessionThinkingTokens += thinkingTokens;
      empty.sessionCacheReadTokens += cacheReadTokens;
      empty.sessionTokens += totalTokens;
      empty.sessionCalls += 1;

      if (modelEnum) {
        const prev = empty.byModelEnum.get(modelEnum) || {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        prev.totalTokens += totalTokens;
        prev.inputTokens += inputTokens;
        prev.outputTokens += outputTokens;
        prev.thinkingTokens += thinkingTokens;
        prev.cacheReadTokens += cacheReadTokens;
        prev.cacheWriteTokens += cacheWriteTokens;
        empty.byModelEnum.set(modelEnum, prev);
      }

      const callRec = {
        executionId,
        modelEnum,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cacheReadTokens,
        totalTokens,
        streamSec,
        ts: tsRaw ? String(tsRaw) : '',
      };
      calls.push(callRec);

      if (cascadeId && executionId) {
        const curExec = byExecId.get(executionId) || {
          cascadeId,
          executionId,
          modelEnum,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          streamSec: 0,
          streamOutput: 0,
          ts: callRec.ts,
        };
        curExec.inputTokens += inputTokens;
        curExec.outputTokens += outputTokens;
        curExec.thinkingTokens += thinkingTokens;
        curExec.cacheReadTokens += cacheReadTokens;
        curExec.totalTokens += totalTokens;
        if (modelEnum) curExec.modelEnum = modelEnum;
        if (streamSec > 0 && outputTokens > 0) {
          curExec.streamSec += streamSec;
          curExec.streamOutput += outputTokens;
        }
        if (callRec.ts) curExec.ts = callRec.ts;
        byExecId.set(executionId, curExec);
      }
    }

    if (calls.length === 0) {
      return empty;
    }

    for (const ex of byExecId.values()) {
      const resolvedName =
        (enumToLabelMap && ex.modelEnum && enumToLabelMap.get(ex.modelEnum)) ||
        ex.modelEnum ||
        'unknown';
      const tpsVal =
        ex.streamSec > 0 && ex.streamOutput > 0
          ? Number((ex.streamOutput / ex.streamSec).toFixed(2))
          : null;
      empty.turnEvents.push({
        ts: ex.ts || new Date().toISOString(),
        cascadeId: ex.cascadeId,
        executionId: ex.executionId,
        model: baseModelFamily(resolvedName) || resolvedName,
        modelEnum: ex.modelEnum,
        inputTokens: ex.inputTokens,
        outputTokens: ex.outputTokens,
        thinkingTokens: ex.thinkingTokens,
        cacheReadTokens: ex.cacheReadTokens,
        totalTokens: ex.totalTokens,
        streamingSec: Number(ex.streamSec.toFixed(3)),
        tps: tpsVal,
      });
    }

    const lastCall = calls[calls.length - 1];
    const targetExecId = lastCall.executionId;
    const turnCalls = targetExecId
      ? calls.filter((c) => c.executionId === targetExecId)
      : [lastCall];

    let turnStreamSec = 0;
    let turnStreamOutput = 0;
    for (const c of turnCalls) {
      empty.turnInputTokens += c.inputTokens;
      empty.turnOutputTokens += c.outputTokens;
      empty.turnThinkingTokens += c.thinkingTokens;
      empty.turnCacheReadTokens += c.cacheReadTokens;
      empty.turnTokens += c.totalTokens;
      empty.turnCalls += 1;
      if (c.streamSec > 0 && c.outputTokens > 0) {
        turnStreamSec += c.streamSec;
        turnStreamOutput += c.outputTokens;
      }
    }

    if (turnStreamSec > 0 && turnStreamOutput > 0) {
      empty.tps = turnStreamOutput / turnStreamSec;
    } else if (lastCall.streamSec > 0 && lastCall.outputTokens > 0) {
      empty.tps = lastCall.outputTokens / lastCall.streamSec;
    }

    return empty;
  }

  function recordEventsToHistory(turnEvents, sessionId, metrics) {
    let added = false;
    for (const ev of turnEvents) {
      const key = `${ev.cascadeId}::${ev.executionId}`;
      const fp = `${ev.totalTokens}:${ev.outputTokens}:${ev.tps ?? 'null'}:${ev.model}`;
      if (state.sentEventFingerprints.get(key) === fp) continue;
      state.sentEventFingerprints.set(key, fp);
      state.pendingEvents.push(ev);
      added = true;

      // Update in-memory history immediately
      const idx = state.history.events.findIndex(
        (x) => x && x.cascadeId === ev.cascadeId && x.executionId === ev.executionId
      );
      if (idx !== -1) {
        const prev = state.history.events[idx];
        const curModel = state.history.byModel[prev.model];
        if (curModel) {
          curModel.totalTokens = Math.max(0, (curModel.totalTokens || 0) - (prev.totalTokens || 0));
          curModel.inputTokens = Math.max(0, (curModel.inputTokens || 0) - (prev.inputTokens || 0));
          curModel.outputTokens = Math.max(0, (curModel.outputTokens || 0) - (prev.outputTokens || 0));
          curModel.thinkingTokens = Math.max(0, (curModel.thinkingTokens || 0) - (prev.thinkingTokens || 0));
          curModel.cacheReadTokens = Math.max(0, (curModel.cacheReadTokens || 0) - (prev.cacheReadTokens || 0));
        }
        state.history.totals.totalTokens = Math.max(
          0,
          (state.history.totals.totalTokens || 0) - (prev.totalTokens || 0)
        );
        state.history.events[idx] = ev;
      } else {
        state.history.events.push(ev);
        state.history.totals.turns = (state.history.totals.turns || 0) + 1;
      }
      state.history.totals.totalTokens = (state.history.totals.totalTokens || 0) + ev.totalTokens;
      if (!state.history.byModel[ev.model]) {
        state.history.byModel[ev.model] = {
          modelEnum: ev.modelEnum,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
        };
      }
      const m = state.history.byModel[ev.model];
      m.totalTokens = (m.totalTokens || 0) + ev.totalTokens;
      m.inputTokens = (m.inputTokens || 0) + ev.inputTokens;
      m.outputTokens = (m.outputTokens || 0) + ev.outputTokens;
      m.thinkingTokens = (m.thinkingTokens || 0) + ev.thinkingTokens;
      m.cacheReadTokens = (m.cacheReadTokens || 0) + ev.cacheReadTokens;
    }

    if (sessionId && metrics && metrics.sessionCalls > 0) {
      const prevSess = state.history.sessions[sessionId];
      const tpsFixed = typeof metrics.tps === 'number' ? Number(metrics.tps.toFixed(2)) : null;
      if (
        !prevSess ||
        prevSess.totalTokens !== metrics.sessionTokens ||
        prevSess.calls !== metrics.sessionCalls ||
        prevSess.lastTps !== tpsFixed
      ) {
        const snap = {
          lastUpdatedAt: new Date().toISOString(),
          totalTokens: metrics.sessionTokens,
          inputTokens: metrics.sessionInputTokens,
          outputTokens: metrics.sessionOutputTokens,
          calls: metrics.sessionCalls,
          lastTurnTokens: metrics.turnTokens,
          lastTps: tpsFixed,
        };
        state.history.sessions[sessionId] = snap;
        state.pendingSessions[sessionId] = snap;
        added = true;
      }
    }
    return added;
  }

  function normalizeUsageData(rawSources, historyStore) {
    const userStatusRoot = rawSources && rawSources.userStatus;
    const userStatus = (userStatusRoot && userStatusRoot.userStatus) || userStatusRoot || null;
    const topPlanInfo = (userStatusRoot && userStatusRoot.planInfo) || (userStatus && userStatus.planInfo) || null;
    const planStatus = (userStatus && userStatus.planStatus) || null;

    let planName = '';
    if (planStatus && planStatus.planInfo && planStatus.planInfo.planName) {
      planName = String(planStatus.planInfo.planName);
    } else if (topPlanInfo && topPlanInfo.planName) {
      planName = String(topPlanInfo.planName);
    } else if (userStatus && userStatus.pro === true) {
      planName = 'Pro';
    }

    const credits = [];
    if (planStatus && typeof planStatus === 'object') {
      const addCredit = (label, usedRaw, availRaw) => {
        const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? usedRaw : null;
        const avail = typeof availRaw === 'number' && Number.isFinite(availRaw) ? availRaw : null;
        if (avail !== null && avail > 0) {
          credits.push({
            label,
            used: used || 0,
            total: avail,
            remaining: Math.max(0, avail - (used || 0)),
          });
        } else if (used !== null && used > 0) {
          credits.push({ label, used, total: null, remaining: null });
        }
      };
      addCredit('Prompt', planStatus.usedPromptCredits, planStatus.availablePromptCredits);
      addCredit('Flow', planStatus.usedFlowCredits, planStatus.availableFlowCredits);
      addCredit('Flex', planStatus.usedFlexCredits, planStatus.availableFlexCredits);
    }

    // 收集 enum -> label 映射
    const enumToLabelMap = new Map();
    const cascadeData =
      (userStatus && userStatus.cascadeModelConfigData) ||
      (rawSources && rawSources.cascadeConfigs && rawSources.cascadeConfigs.cascadeModelConfigData) ||
      (rawSources && rawSources.cascadeConfigs) ||
      null;

    const clientConfigs =
      cascadeData && Array.isArray(cascadeData.clientModelConfigs)
        ? cascadeData.clientModelConfigs
        : [];

    for (const cfg of clientConfigs) {
      if (!cfg || typeof cfg !== 'object') continue;
      const label = cfg.label ? String(cfg.label).trim() : '';
      const me = (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) || '';
      if (label && me) {
        enumToLabelMap.set(String(me), label);
      }
    }

    // 计算当前对话指标 + 汇总各轨迹 Token
    const activeCid = (rawSources && rawSources.activeCascadeId) || '';
    const activeMeta = rawSources && rawSources.activeGeneratorMetadata;
    const activeList =
      (activeMeta && (activeMeta.generatorMetadata || activeMeta.generator_metadata)) ||
      (Array.isArray(activeMeta) ? activeMeta : []);
    const activeMetrics = computeGeneratorMetrics(activeList, activeCid, enumToLabelMap);

    const tokenStatsByEnum = new Map();
    const accumulateEnumMap = (m) => {
      if (!m) return;
      for (const [k, v] of m.entries()) {
        const cur = tokenStatsByEnum.get(k) || {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
        };
        cur.totalTokens += v.totalTokens;
        cur.inputTokens += v.inputTokens;
        cur.outputTokens += v.outputTokens;
        cur.thinkingTokens += v.thinkingTokens;
        cur.cacheReadTokens += v.cacheReadTokens;
        tokenStatsByEnum.set(k, cur);
      }
    };
    accumulateEnumMap(activeMetrics.byModelEnum);

    if (rawSources && Array.isArray(rawSources.otherGeneratorMetadatas)) {
      for (const item of rawSources.otherGeneratorMetadatas) {
        const cid = item && item.cascadeId ? item.cascadeId : '';
        const list = Array.isArray(item) ? item : item && item.list;
        if (!Array.isArray(list)) continue;
        const m = computeGeneratorMetrics(list, cid, enumToLabelMap);
        accumulateEnumMap(m.byModelEnum);
      }
    }

    const sessionMetrics = {
      cascadeId: activeCid,
      turnTokens: activeMetrics.turnTokens,
      turnInputTokens: activeMetrics.turnInputTokens,
      turnOutputTokens: activeMetrics.turnOutputTokens,
      turnThinkingTokens: activeMetrics.turnThinkingTokens,
      turnCacheReadTokens: activeMetrics.turnCacheReadTokens,
      turnCalls: activeMetrics.turnCalls,
      tps: activeMetrics.tps,
      sessionTokens: activeMetrics.sessionTokens,
      sessionInputTokens: activeMetrics.sessionInputTokens,
      sessionOutputTokens: activeMetrics.sessionOutputTokens,
      sessionThinkingTokens: activeMetrics.sessionThinkingTokens,
      sessionCacheReadTokens: activeMetrics.sessionCacheReadTokens,
      sessionCalls: activeMetrics.sessionCalls,
    };

    // ==================== 1. 剩余额度视图：共享额度池合并 ====================
    const quotaPools = [];
    const qsRoot = rawSources && rawSources.quotaSummary;
    const qs = (qsRoot && (qsRoot.response || qsRoot.summary)) || qsRoot || null;

    if (qs && typeof qs === 'object' && Array.isArray(qs.groups) && qs.groups.length > 0) {
      for (const g of qs.groups) {
        if (!g || !Array.isArray(g.buckets)) continue;
        const gName = String(g.displayName || '').trim();
        const buckets = [];
        for (const b of g.buckets) {
          if (!b || typeof b !== 'object' || b.disabled) continue;
          const bName = String(b.displayName || b.bucketId || gName || '').trim();
          const resetMs = parseTimestampMs(b.resetTime);
          let frac = clampFraction(b.remainingFraction);
          if (frac === null && typeof b.remainingAmount === 'number') {
            frac = b.remainingAmount <= 0 ? 0 : null;
          }
          if (frac === null && resetMs !== null) frac = 0;
          if (frac === null && b.remainingAmount === undefined) {
            if (resetMs === null) continue;
            frac = 0;
          }
          buckets.push({
            id: String(b.bucketId || `${gName}::${bName}`),
            displayName: bName,
            window: b.window ? String(b.window) : '',
            remainingFraction: frac,
            remainingAmount: typeof b.remainingAmount === 'number' ? b.remainingAmount : null,
            resetMs,
          });
        }
        if (buckets.length > 0) {
          const poolId = gName || buckets[0].displayName;
          quotaPools.push({
            id: poolId,
            name: poolId,
            priority: getPoolPriority(poolId),
            description: g.description ? String(g.description) : '',
            includedModels: [],
            buckets,
          });
        }
      }
    }

    // 回退：把 clientModelConfigs 中共享相同配额的模型合并成共享额度池
    if (quotaPools.length === 0) {
      const sourceConfigs = [];
      for (const cfg of clientConfigs) {
        if (!cfg || typeof cfg !== 'object' || cfg.disabled) continue;
        const label = cfg.label ? String(cfg.label).trim() : '';
        if (!label) continue;
        const q = extractQuotaInfo(cfg.quotaInfo);
        if (q.remainingFraction === null && q.resetMs === null) continue;
        sourceConfigs.push({
          label,
          remainingFraction: q.remainingFraction,
          resetMs: q.resetMs,
        });
      }

      if (sourceConfigs.length === 0 && rawSources && rawSources.availableModels) {
        const amRoot = rawSources.availableModels;
        const models =
          (amRoot.response && Array.isArray(amRoot.response.models) && amRoot.response.models) ||
          (Array.isArray(amRoot.models) && amRoot.models) ||
          [];
        for (const m of models) {
          if (!m || typeof m !== 'object') continue;
          const label = String(m.displayName || m.modelId || '').trim();
          if (!label) continue;
          const q = extractQuotaInfo(m.quotaInfo);
          if (q.remainingFraction === null && q.resetMs === null) continue;
          sourceConfigs.push({
            label,
            remainingFraction: q.remainingFraction,
            resetMs: q.resetMs,
          });
        }
      }

      const poolMap = new Map();
      for (const cfg of sourceConfigs) {
        const poolName = inferQuotaPoolName(cfg.label);
        let pool = poolMap.get(poolName);
        if (!pool) {
          pool = {
            id: poolName,
            name: poolName,
            priority: getPoolPriority(poolName),
            description: '',
            includedModels: [],
            buckets: [],
            _bucketMap: new Map(),
          };
          poolMap.set(poolName, pool);
        }
        const fam = baseModelFamily(cfg.label) || cfg.label;
        if (!pool.includedModels.includes(fam)) {
          pool.includedModels.push(fam);
        }
        const fracKey = cfg.remainingFraction !== null ? cfg.remainingFraction.toFixed(3) : 'null';
        const resetBucket = cfg.resetMs !== null ? String(Math.round(cfg.resetMs / 120000)) : 'null';
        const bKey = `${fracKey}::${resetBucket}`;
        if (!pool._bucketMap.has(bKey)) {
          const b = {
            id: `${poolName}::${bKey}`,
            displayName: pool.includedModels.length <= 1 ? fam : '',
            window: '',
            remainingFraction: cfg.remainingFraction,
            remainingAmount: null,
            resetMs: cfg.resetMs,
          };
          pool._bucketMap.set(bKey, b);
          pool.buckets.push(b);
        }
      }
      for (const pool of poolMap.values()) {
        delete pool._bucketMap;
        quotaPools.push(pool);
      }
    } else if (clientConfigs.length > 0) {
      // 顺便给官方分组补充包含的模型列表用于 tooltip
      for (const pool of quotaPools) {
        for (const cfg of clientConfigs) {
          if (!cfg || cfg.disabled || !cfg.label) continue;
          const inferred = inferQuotaPoolName(cfg.label);
          if (
            inferred.toLowerCase() === pool.name.toLowerCase() ||
            (/claude|gpt/i.test(pool.name) && /claude|gpt/i.test(inferred))
          ) {
            const fam = baseModelFamily(cfg.label) || cfg.label;
            if (!pool.includedModels.includes(fam)) {
              pool.includedModels.push(fam);
            }
          }
        }
      }
    }

    quotaPools.sort((a, b) => a.priority - b.priority);

    // ==================== 2. 消耗额度视图：逐模型 Token 消耗明细 ====================
    const tokenModelMap = new Map();
    const histByModel = (historyStore && historyStore.byModel) || {};

    const ensureTokenEntry = (familyName) => {
      let entry = tokenModelMap.get(familyName);
      if (!entry) {
        entry = {
          id: familyName,
          name: familyName,
          priority: getPoolPriority(familyName),
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
          remainingFraction: null,
          resetMs: null,
        };
        tokenModelMap.set(familyName, entry);
      }
      return entry;
    };

    // 先灌入 clientModelConfigs，保证即使暂未使用的模型也可在消耗页/筛选中看到并关联实时配额
    const seenModelEnums = new Set();
    for (const cfg of clientConfigs) {
      if (!cfg || typeof cfg !== 'object' || cfg.disabled || !cfg.label) continue;
      const fam = baseModelFamily(String(cfg.label)) || String(cfg.label);
      const entry = ensureTokenEntry(fam);
      const q = extractQuotaInfo(cfg.quotaInfo);
      if (entry.remainingFraction === null && q.remainingFraction !== null) {
        entry.remainingFraction = q.remainingFraction;
        entry.resetMs = q.resetMs;
      }
      const me = (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) || '';
      const meKey = me ? String(me) : '';
      const liveStats = meKey && !seenModelEnums.has(meKey) ? tokenStatsByEnum.get(meKey) : null;
      if (liveStats) {
        seenModelEnums.add(meKey);
        entry.totalTokens += liveStats.totalTokens;
        entry.inputTokens += liveStats.inputTokens;
        entry.outputTokens += liveStats.outputTokens;
        entry.thinkingTokens += liveStats.thinkingTokens;
        entry.cacheReadTokens += liveStats.cacheReadTokens;
      }
    }

    // 补充不在 clientModelConfigs 中的已使用模型（如已下线旧模型）
    for (const [meKey, liveStats] of tokenStatsByEnum.entries()) {
      if (seenModelEnums.has(meKey)) continue;
      const resolvedLabel = enumToLabelMap.get(meKey) || meKey;
      const fam = baseModelFamily(resolvedLabel) || resolvedLabel;
      const entry = ensureTokenEntry(fam);
      seenModelEnums.add(meKey);
      entry.totalTokens += liveStats.totalTokens;
      entry.inputTokens += liveStats.inputTokens;
      entry.outputTokens += liveStats.outputTokens;
      entry.thinkingTokens += liveStats.thinkingTokens;
      entry.cacheReadTokens += liveStats.cacheReadTokens;
    }

    // 先按模型家族归并持久化历史记录，再与实时统计取最大值合并（历史已归档的对话不会丢失）
    const histByFam = new Map();
    for (const [mName, hStats] of Object.entries(histByModel)) {
      if (!hStats || typeof hStats !== 'object') continue;
      const fam = baseModelFamily(mName) || mName;
      const cur = histByFam.get(fam) || {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
      };
      cur.totalTokens += Number(hStats.totalTokens) || 0;
      cur.inputTokens += Number(hStats.inputTokens) || 0;
      cur.outputTokens += Number(hStats.outputTokens) || 0;
      cur.thinkingTokens += Number(hStats.thinkingTokens) || 0;
      cur.cacheReadTokens += Number(hStats.cacheReadTokens) || 0;
      histByFam.set(fam, cur);
    }
    for (const [fam, hStats] of histByFam.entries()) {
      const entry = ensureTokenEntry(fam);
      if (hStats.totalTokens > entry.totalTokens) {
        entry.totalTokens = hStats.totalTokens;
        entry.inputTokens = hStats.inputTokens;
        entry.outputTokens = hStats.outputTokens;
        entry.thinkingTokens = hStats.thinkingTokens;
        entry.cacheReadTokens = hStats.cacheReadTokens;
      }
    }

    const tokenModels = Array.from(tokenModelMap.values()).sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.totalTokens - a.totalTokens;
    });

    return {
      planName,
      credits,
      quotaPools,
      tokenModels,
      sessionMetrics,
    };
  }

  // ==================== 宿主环境探测与几何定位 ====================

  function detectThemeIsDark() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) {
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return lum < 0.5;
      }
    } catch (_) {}
    return true;
  }

  function detectIsZh(settingsText) {
    if (window.__AGY_I18N_ACTIVE__) return true;
    if (settingsText && /设置/.test(settingsText)) return true;
    try {
      if (document.documentElement && /^zh/i.test(document.documentElement.lang || '')) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function locateSidebarGeometry(doc, win) {
    const d = doc || document;
    const w = win || window;
    if (!d || !d.querySelectorAll) {
      return { visible: false };
    }
    const innerH = w.innerHeight || 800;
    const candidates = d.querySelectorAll('button, a, [role="button"]');
    let bestBtn = null;
    let bestRect = null;
    let bestText = '';

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el || typeof el.getBoundingClientRect !== 'function') continue;
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
      const label = text || aria.trim();
      if (!/^(Settings|设置)$/i.test(label)) continue;

      const r = el.getBoundingClientRect();
      if (
        r.width > 24 &&
        r.height >= 16 &&
        r.height <= 72 &&
        r.left >= 0 &&
        r.left < 320 &&
        r.bottom > innerH - 130 &&
        r.top < innerH
      ) {
        if (!bestRect || r.left < bestRect.left || r.top > bestRect.top) {
          bestBtn = el;
          bestRect = r;
          bestText = label;
        }
      }
    }

    if (!bestBtn || !bestRect) {
      return { visible: false };
    }

    let sidebarEl = null;
    let sidebarRect = null;
    let cur = bestBtn.parentElement;
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

    const leftBase = sidebarRect ? sidebarRect.left : Math.max(0, bestRect.left - 8);
    const widthBase = sidebarRect ? sidebarRect.width : Math.max(220, bestRect.right + 12);
    if (widthBase < 130) {
      return { visible: false };
    }

    if (typeof d.elementFromPoint === 'function') {
      const cx = bestRect.left + Math.min(24, bestRect.width / 2);
      const cy = bestRect.top + bestRect.height / 2;
      const hit = d.elementFromPoint(cx, cy);
      if (hit && hit !== bestBtn && !bestBtn.contains(hit) && !(sidebarEl && sidebarEl.contains(hit))) {
        return { visible: false };
      }
    }

    const padX = 10;
    const left = Math.round(leftBase + padX);
    const width = Math.round(Math.max(168, widthBase - padX * 2));
    const bottom = Math.round(Math.max(44, innerH - bestRect.top + 8));
    // 安全最大高度：永不覆盖顶部导航（留足 >= 145px）
    const safeMaxHeight = Math.round(Math.max(MIN_CARD_HEIGHT, bestRect.top - 145));

    return {
      visible: true,
      left,
      width,
      bottom,
      safeMaxHeight,
      settingsText: bestText,
    };
  }

  // ==================== 网络监听与主动抓取 ====================

  function mergeCapturedHeaders(hdrObj) {
    if (!hdrObj || typeof hdrObj !== 'object') return false;
    let changed = false;
    for (const [k, v] of Object.entries(hdrObj)) {
      if (!k || v === undefined || v === null) continue;
      const lower = String(k).toLowerCase();
      if (
        lower === 'x-codeium-ui-token' ||
        lower === 'x-codeium-csrf-token' ||
        lower === 'authorization' ||
        lower === 'x-requested-with'
      ) {
        const strVal = String(v);
        if (strVal && state.capturedHeaders[lower] !== strVal) {
          state.capturedHeaders[lower] = strVal;
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * 构造 Connect-RPC 请求头，按小写键去重并固定协议版本，避免大小写重复键导致 Fetch 拼接成 "1, 1"。
   */
  function buildRpcHeaders(capturedHeaders) {
    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };
    if (capturedHeaders && typeof capturedHeaders === 'object') {
      for (const [k, v] of Object.entries(capturedHeaders)) {
        if (!k || v === undefined || v === null) continue;
        const strVal = String(v);
        if (!strVal) continue;
        const lower = String(k).toLowerCase();
        if (lower === 'content-type' || lower === 'connect-protocol-version') continue;
        headers[lower] = strVal;
      }
    }
    return headers;
  }

  function hasAuthTokenCaptured() {
    return Boolean(
      state.capturedHeaders['x-codeium-ui-token'] ||
        state.capturedHeaders['x-codeium-csrf-token'] ||
        state.capturedHeaders['authorization']
    );
  }

  function captureHeadersFromInit(init, input) {
    const found = {};
    const keep = (k, v) => {
      if (!k || v === undefined || v === null) return;
      found[String(k).toLowerCase()] = String(v);
    };
    try {
      if (input && typeof input === 'object' && input.headers && typeof input.headers.forEach === 'function') {
        input.headers.forEach((v, k) => keep(k, v));
      }
      if (init && init.headers) {
        if (typeof init.headers.forEach === 'function') {
          init.headers.forEach((v, k) => keep(k, v));
        } else if (Array.isArray(init.headers)) {
          for (const pair of init.headers) {
            if (Array.isArray(pair) && pair.length >= 2) keep(pair[0], pair[1]);
          }
        } else if (typeof init.headers === 'object') {
          for (const [k, v] of Object.entries(init.headers)) keep(k, v);
        }
      }
      if (init && typeof init.body === 'string' && init.body.trim().startsWith('{')) {
        const parsed = JSON.parse(init.body);
        if (parsed && parsed.metadata && typeof parsed.metadata === 'object') {
          state.capturedMetadata = parsed.metadata;
        }
        const cid = parsed && (parsed.cascadeId || parsed.trajectoryId || parsed.conversationId);
        if (typeof cid === 'string' && cid.length > 8) {
          state.activeCascadeId = cid;
        }
      }
    } catch (_) {}
    return mergeCapturedHeaders(found);
  }

  let suppressTapGenMetaCount = 0;

  function handleRpcPayload(method, json) {
    if (!json || typeof json !== 'object') return;
    let touched = false;
    if (method === 'GetUserStatus') {
      state.rawSources.userStatus = json;
      touched = true;
    } else if (method === 'RetrieveUserQuotaSummary') {
      state.rawSources.quotaSummary = json;
      touched = true;
    } else if (method === 'GetAvailableModels') {
      state.rawSources.availableModels = json;
      touched = true;
    } else if (method === 'GetCascadeModelConfigData' || method === 'GetCascadeModelConfigs') {
      state.rawSources.cascadeConfigs = json;
      touched = true;
    } else if (method === 'GetAllCascadeTrajectories') {
      state.rawSources.trajectories = json;
      touched = true;
    } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      if (suppressTapGenMetaCount > 0) return;
      state.rawSources.activeGeneratorMetadata = json;
      touched = true;
    }
    if (touched) {
      state.lastUpdatedAt = Date.now();
      state.error = null;
      state.waitingAuth = false;
      recomputeAndRender();
    }
  }

  function bootstrapFromEarlyTap() {
    if (window.__AGY_CAPTURED_LS_HEADERS__) {
      mergeCapturedHeaders(window.__AGY_CAPTURED_LS_HEADERS__);
    }
    if (window.__AGY_CAPTURED_CASCADE_ID__) {
      state.activeCascadeId = window.__AGY_CAPTURED_CASCADE_ID__;
    }
    if (window.__AGY_CAPTURED_LS_CACHE__) {
      const cache = window.__AGY_CAPTURED_LS_CACHE__;
      for (const method of Object.keys(cache)) {
        handleRpcPayload(method, cache[method]);
      }
    }
    window.__AGY_ON_RPC_HEADERS__ = (hdrs) => {
      const changed = mergeCapturedHeaders(hdrs);
      if (changed && (!state.lastUpdatedAt || state.waitingAuth || state.error)) {
        refreshAllUsage(false);
      }
    };
    window.__AGY_ON_CASCADE_CHANGE__ = (cid) => {
      if (cid && cid !== state.activeCascadeId) {
        state.activeCascadeId = cid;
        refreshSessionMetricsOnly();
      } else if (cid) {
        setTimeout(() => refreshSessionMetricsOnly(), 600);
      }
    };
    window.__AGY_ON_RPC_DATA__ = (method, data) => {
      handleRpcPayload(method, data);
    };
  }

  function installFallbackHooks() {
    if (window.__AGY_EARLY_RPC_TAP__ || window.__AGY_USAGE_FETCH_HOOKED__) {
      return;
    }
    window.__AGY_USAGE_FETCH_HOOKED__ = true;

    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        if (init && init.__agyInternal) {
          return origFetch.apply(this, arguments);
        }
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (_) {}

        const idx = url.indexOf(LS_SERVICE_PREFIX);
        let method = '';
        if (idx !== -1) {
          method = url.slice(idx + LS_SERVICE_PREFIX.length).split('?')[0];
          const changed = captureHeadersFromInit(init, input);
          if (changed && (!state.lastUpdatedAt || state.waitingAuth || state.error)) {
            setTimeout(() => refreshAllUsage(false), 60);
          }
        }

        const resPromise = origFetch.apply(this, arguments);
        if (
          method === 'GetUserStatus' ||
          method === 'RetrieveUserQuotaSummary' ||
          method === 'GetAvailableModels' ||
          method === 'GetCascadeModelConfigData' ||
          method === 'GetCascadeModelConfigs' ||
          method === 'GetAllCascadeTrajectories' ||
          method === 'GetCascadeTrajectoryGeneratorMetadata'
        ) {
          resPromise
            .then((resp) => {
              if (!resp || !resp.ok || typeof resp.clone !== 'function') return null;
              const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
              if (!ct.includes('json')) return null;
              return resp.clone().json().then((data) => handleRpcPayload(method, data));
            })
            .catch(() => {});
        }
        return resPromise;
      };
    }

    if (typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype) {
      const origOpen = window.XMLHttpRequest.prototype.open;
      const origSetHeader = window.XMLHttpRequest.prototype.setRequestHeader;
      window.XMLHttpRequest.prototype.open = function (_m, u) {
        try {
          this.__agyUrl = typeof u === 'string' ? u : String(u || '');
        } catch (_) {}
        return origOpen.apply(this, arguments);
      };
      window.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
          if (this.__agyUrl && this.__agyUrl.indexOf(LS_SERVICE_PREFIX) !== -1) {
            const changed = mergeCapturedHeaders({ [k]: v });
            if (changed && (!state.lastUpdatedAt || state.waitingAuth || state.error)) {
              setTimeout(() => refreshAllUsage(false), 60);
            }
          }
        } catch (_) {}
        return origSetHeader.apply(this, arguments);
      };
    }
  }

  async function callLsRpc(method, payload) {
    if (window.__AGY_CAPTURED_LS_HEADERS__) {
      mergeCapturedHeaders(window.__AGY_CAPTURED_LS_HEADERS__);
    }
    const headers = buildRpcHeaders(state.capturedHeaders);
    const resp = await window.fetch(LS_SERVICE_PREFIX + method, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(payload || {}),
      __agyInternal: true,
    });
    if (!resp.ok) {
      let detail = '';
      try {
        detail = (await resp.text()).trim();
      } catch (_) {}
      const err = new Error(detail ? `HTTP ${resp.status}: ${detail.slice(0, 80)}` : `HTTP ${resp.status}`);
      err.status = resp.status;
      err.detail = detail;
      throw err;
    }
    return resp.json();
  }

  let lastTapCascadeId = '';
  let lastUrlCascadeId = '';

  function pickActiveCascadeId() {
    const tapCid = window.__AGY_CAPTURED_CASCADE_ID__ ? String(window.__AGY_CAPTURED_CASCADE_ID__) : '';
    if (tapCid && tapCid !== lastTapCascadeId) {
      lastTapCascadeId = tapCid;
      state.activeCascadeId = tapCid;
      return tapCid;
    }

    let urlCid = '';
    try {
      const urlPart = `${window.location.pathname || ''}${window.location.search || ''}`;
      const m = urlPart.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) urlCid = m[0];
    } catch (_) {}

    if (urlCid && urlCid !== lastUrlCascadeId) {
      lastUrlCascadeId = urlCid;
      state.activeCascadeId = urlCid;
      return urlCid;
    }

    if (state.activeCascadeId) return state.activeCascadeId;
    if (tapCid) {
      state.activeCascadeId = tapCid;
      return tapCid;
    }
    if (urlCid) {
      state.activeCascadeId = urlCid;
      return urlCid;
    }

    const summaries =
      state.rawSources.trajectories && state.rawSources.trajectories.trajectorySummaries;
    if (summaries && typeof summaries === 'object') {
      let bestId = '';
      let bestScore = -1;
      for (const [cid, info] of Object.entries(summaries)) {
        if (!info || typeof info !== 'object') continue;
        const modMs = parseTimestampMs(info.lastModifiedTime) || 0;
        const isRunning = /RUNNING/i.test(String(info.status || ''));
        const score = isRunning ? modMs + 1e13 : modMs;
        if (score > bestScore) {
          bestScore = score;
          bestId = cid;
        }
      }
      if (bestId) {
        state.activeCascadeId = bestId;
        return bestId;
      }
    }
    return '';
  }

  async function fetchGeneratorMetadataCached(cid, stamp, forceRefreshActive) {
    if (!cid) return [];
    const cached = state.trajectoryCache.get(cid);
    if (!forceRefreshActive && cached && stamp && cached.stamp === stamp) {
      return cached.list;
    }
    const resp = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId: cid,
      generatorMetadataOffset: 0,
      includeMessages: false,
    });
    const list = (resp && (resp.generatorMetadata || resp.generator_metadata)) || [];
    state.trajectoryCache.set(cid, { stamp: stamp || String(Date.now()), list });
    return list;
  }

  function syncPersistenceFromSources() {
    const userStatusRoot = state.rawSources.userStatus;
    const userStatus = (userStatusRoot && userStatusRoot.userStatus) || userStatusRoot || null;
    const clientConfigs =
      (userStatus &&
        userStatus.cascadeModelConfigData &&
        Array.isArray(userStatus.cascadeModelConfigData.clientModelConfigs) &&
        userStatus.cascadeModelConfigData.clientModelConfigs) ||
      [];
    const enumToLabel = new Map();
    for (const cfg of clientConfigs) {
      const me = (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) || '';
      if (cfg.label && me) enumToLabel.set(String(me), String(cfg.label));
    }

    const activeCid = state.rawSources.activeCascadeId || '';
    const activeMeta = state.rawSources.activeGeneratorMetadata;
    const activeList = (activeMeta && (activeMeta.generatorMetadata || activeMeta.generator_metadata)) || [];
    if (activeCid && Array.isArray(activeList) && activeList.length > 0) {
      const m = computeGeneratorMetrics(activeList, activeCid, enumToLabel);
      recordEventsToHistory(m.turnEvents, activeCid, m);
    }

    if (Array.isArray(state.rawSources.otherGeneratorMetadatas)) {
      for (const item of state.rawSources.otherGeneratorMetadatas) {
        const cid = item && item.cascadeId;
        const list = item && item.list;
        if (cid && Array.isArray(list) && list.length > 0) {
          const m = computeGeneratorMetrics(list, cid, enumToLabel);
          recordEventsToHistory(m.turnEvents, cid, m);
        }
      }
    }
  }

  async function refreshSessionAndModelTokens(includeHistory) {
    if (!hasAuthTokenCaptured()) return;
    try {
      const trajResp = await callLsRpc('GetAllCascadeTrajectories', {
        excludeSubtrajectories: true,
      });
      if (trajResp && trajResp.trajectorySummaries) {
        state.rawSources.trajectories = trajResp;
      }
    } catch (_) {}

    const activeCid = pickActiveCascadeId();
    state.rawSources.activeCascadeId = activeCid;

    const summaries =
      (state.rawSources.trajectories && state.rawSources.trajectories.trajectorySummaries) || {};

    let activeMetaSnapshot = state.rawSources.activeGeneratorMetadata;
    if (activeCid) {
      try {
        const info = summaries[activeCid];
        const stamp = info ? `${info.stepCount || 0}:${info.lastModifiedTime || ''}` : '';
        const list = await fetchGeneratorMetadataCached(activeCid, stamp, true);
        activeMetaSnapshot = { generatorMetadata: list };
        state.rawSources.activeGeneratorMetadata = activeMetaSnapshot;
      } catch (_) {}
    }

    if (includeHistory && summaries && typeof summaries === 'object') {
      const sorted = Object.entries(summaries)
        .filter(([cid]) => cid !== activeCid)
        .sort((a, b) => {
          const ta = parseTimestampMs(a[1] && a[1].lastModifiedTime) || 0;
          const tb = parseTimestampMs(b[1] && b[1].lastModifiedTime) || 0;
          return tb - ta;
        })
        .slice(0, MAX_TRAJECTORIES_FOR_TOKENS);

      const otherLists = [];
      const batchSize = 4;
      suppressTapGenMetaCount++;
      try {
        for (let i = 0; i < sorted.length; i += batchSize) {
          const chunk = sorted.slice(i, i + batchSize);
          const res = await Promise.allSettled(
            chunk.map(async ([cid, info]) => {
              const stamp = `${(info && info.stepCount) || 0}:${(info && info.lastModifiedTime) || ''}`;
              const list = await fetchGeneratorMetadataCached(cid, stamp, false);
              return { cascadeId: cid, list };
            })
          );
          for (const r of res) {
            if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.list)) {
              otherLists.push(r.value);
            }
          }
        }
        state.rawSources.otherGeneratorMetadatas = otherLists;
      } finally {
        if (activeCid && activeMetaSnapshot) {
          state.rawSources.activeGeneratorMetadata = activeMetaSnapshot;
        }
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => {
            suppressTapGenMetaCount = Math.max(0, suppressTapGenMetaCount - 1);
          });
      }
    }

    syncPersistenceFromSources();
  }

  let sessionRefreshInFlight = false;
  async function refreshSessionMetricsOnly() {
    if (sessionRefreshInFlight || !hasAuthTokenCaptured()) return;
    sessionRefreshInFlight = true;
    try {
      await refreshSessionAndModelTokens(false);
      recomputeAndRender();
    } finally {
      sessionRefreshInFlight = false;
    }
  }

  let pendingRefreshAfterLoad = false;
  let pendingRefreshManual = false;

  async function refreshAllUsage(manual) {
    if (state.loading) {
      pendingRefreshAfterLoad = true;
      if (manual) pendingRefreshManual = true;
      return;
    }
    state.loading = true;
    pendingRefreshAfterLoad = false;
    const hadAuthBefore = hasAuthTokenCaptured();
    if (manual) {
      state.error = null;
    }
    render();

    try {
      const statusPayload = state.capturedMetadata ? { metadata: state.capturedMetadata } : {};
      const results = await Promise.allSettled([
        callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: Boolean(manual) }),
        callLsRpc('GetUserStatus', statusPayload),
      ]);

      let anySuccess = false;
      if (results[0].status === 'fulfilled' && results[0].value) {
        state.rawSources.quotaSummary = results[0].value;
        anySuccess = true;
      }
      if (results[1].status === 'fulfilled' && results[1].value) {
        state.rawSources.userStatus = results[1].value;
        anySuccess = true;
      }

      const preview = normalizeUsageData(state.rawSources, state.history);
      if (preview.quotaPools.length === 0) {
        try {
          const avail = await callLsRpc('GetAvailableModels', { forceRefresh: Boolean(manual) });
          if (avail) {
            state.rawSources.availableModels = avail;
            anySuccess = true;
          }
        } catch (_) {}
      }

      if (anySuccess) {
        await refreshSessionAndModelTokens(true);
        state.lastUpdatedAt = Date.now();
        state.error = null;
        state.waitingAuth = false;
      } else {
        const firstErr = results.find((r) => r.status === 'rejected');
        const reason = firstErr && firstErr.reason;
        const msg = (reason && reason.message) || 'Unavailable';
        const isMissingToken =
          (!hadAuthBefore || !hasAuthTokenCaptured()) &&
          reason &&
          (reason.status === 400 || reason.status === 401 || reason.status === 403 || /csrf|token/i.test(msg));
        if (isMissingToken) {
          state.waitingAuth = true;
          state.error = null;
          if (!hadAuthBefore && hasAuthTokenCaptured()) {
            pendingRefreshAfterLoad = true;
          }
        } else {
          state.waitingAuth = false;
          state.error = msg;
        }
      }
    } catch (err) {
      state.error = (err && err.message) || 'Error';
    } finally {
      state.loading = false;
      recomputeAndRender();
      if (pendingRefreshAfterLoad) {
        const nextManual = pendingRefreshManual;
        pendingRefreshManual = false;
        pendingRefreshAfterLoad = false;
        refreshAllUsage(nextManual);
      }
    }
  }

  // ==================== UI 渲染 (Shadow DOM) ====================

  let hostEl = null;
  let shadowRoot = null;
  let cardEl = null;
  let styleEl = null;
  let lastGeometry = { visible: false };
  let isResizing = false;

  const CSS_TEXT = `
    :host {
      all: initial;
      position: fixed;
      z-index: 45;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
      box-sizing: border-box;
    }
    * {
      box-sizing: border-box;
    }
    .card {
      pointer-events: auto;
      width: 100%;
      display: flex;
      flex-direction: column;
      border-radius: 10px;
      border: 1px solid var(--agy-border);
      background: var(--agy-bg);
      color: var(--agy-fg);
      box-shadow: var(--agy-shadow);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      overflow: hidden;
      font-size: 11px;
      line-height: 1.35;
    }
    .card.dark {
      --agy-bg: rgba(24, 24, 28, 0.94);
      --agy-bento: rgba(255, 255, 255, 0.035);
      --agy-fg: #e4e4e7;
      --agy-muted: #8b8b96;
      --agy-border: rgba(255, 255, 255, 0.09);
      --agy-border-soft: rgba(255, 255, 255, 0.06);
      --agy-hover: rgba(255, 255, 255, 0.06);
      --agy-track: rgba(255, 255, 255, 0.09);
      --agy-pill-bg: rgba(255, 255, 255, 0.07);
      --agy-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      --agy-accent: #34d399;
    }
    .card.light {
      --agy-bg: rgba(250, 250, 252, 0.96);
      --agy-bento: rgba(0, 0, 0, 0.03);
      --agy-fg: #18181b;
      --agy-muted: #71717a;
      --agy-border: rgba(0, 0, 0, 0.1);
      --agy-border-soft: rgba(0, 0, 0, 0.06);
      --agy-hover: rgba(0, 0, 0, 0.05);
      --agy-track: rgba(0, 0, 0, 0.09);
      --agy-pill-bg: rgba(0, 0, 0, 0.05);
      --agy-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
      --agy-accent: #10b981;
    }
    .resize-handle {
      height: 6px;
      width: 100%;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .resize-handle::after {
      content: "";
      width: 28px;
      height: 2px;
      border-radius: 999px;
      background: transparent;
      transition: background 0.15s ease;
    }
    .resize-handle:hover::after,
    .resize-handle.dragging::after {
      background: var(--agy-muted);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 9px 6px;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .header:hover {
      background: var(--agy-hover);
    }
    .title-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #34d399;
    }
    .dot.warn { background: #fbbf24; }
    .dot.crit { background: #f87171; }
    .dot.idle { background: var(--agy-muted); }
    .title {
      font-weight: 600;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 999px;
      background: var(--agy-pill-bg);
      color: var(--agy-muted);
      white-space: nowrap;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .icon-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--agy-muted);
      width: 20px;
      height: 20px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      font-size: 11px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .icon-btn:hover {
      background: var(--agy-hover);
      color: var(--agy-fg);
    }
    .spin {
      animation: agy-spin 0.8s linear infinite;
    }
    @keyframes agy-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .body {
      border-top: 1px solid var(--agy-border-soft);
      padding: 6px 8px 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .mini-dash {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      flex-shrink: 0;
    }
    .mini-cell {
      background: var(--agy-bento);
      border: 1px solid var(--agy-border-soft);
      border-radius: 6px;
      padding: 4px 5px;
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .mini-label {
      font-size: 9.5px;
      color: var(--agy-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-val {
      font-size: 11px;
      font-weight: 600;
      color: var(--agy-fg);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mini-val.accent {
      color: var(--agy-accent);
    }
    .credits-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
      font-size: 10px;
      color: var(--agy-muted);
      padding-bottom: 4px;
      border-bottom: 1px dashed var(--agy-border-soft);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .credit-chip b {
      color: var(--agy-fg);
      font-weight: 500;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      overflow-y: auto;
      padding-right: 2px;
      flex: 1;
      min-height: 0;
    }
    .list::-webkit-scrollbar {
      width: 4px;
    }
    .list::-webkit-scrollbar-thumb {
      background: var(--agy-border);
      border-radius: 999px;
    }
    .pool-box {
      background: var(--agy-bento);
      border: 1px solid var(--agy-border-soft);
      border-radius: 7px;
      padding: 5px 7px 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
    }
    .pool-title {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--agy-fg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .pool-sub {
      font-size: 9.5px;
      color: var(--agy-muted);
      font-weight: 400;
    }
    .row {
      display: flex;
      flex-direction: column;
      gap: 2.5px;
      flex-shrink: 0;
    }
    .row-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }
    .model-name {
      font-size: 10.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    }
    .win-label {
      font-size: 10.5px;
      color: var(--agy-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
    }
    .row-meta {
      display: flex;
      align-items: baseline;
      gap: 5px;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    .reset-tag {
      font-size: 10px;
      color: var(--agy-muted);
    }
    .pct {
      font-size: 11px;
      font-weight: 600;
      min-width: 30px;
      text-align: right;
    }
    .pct.tok {
      color: var(--agy-fg);
      font-size: 10.5px;
      min-width: 44px;
    }
    .pct.good { color: #34d399; }
    .pct.warn { color: #fbbf24; }
    .pct.crit { color: #f87171; }
    .pct.muted { color: var(--agy-muted); }
    .bar-track {
      height: 3px;
      border-radius: 999px;
      background: var(--agy-track);
      overflow: hidden;
      width: 100%;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.25s ease;
      background: #34d399;
    }
    .bar-fill.warn { background: #fbbf24; }
    .bar-fill.crit { background: #f87171; }
    .bar-fill.muted { background: var(--agy-muted); }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      font-size: 10px;
      color: var(--agy-muted);
      padding-top: 4px;
      border-top: 1px solid var(--agy-border-soft);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .footer-btn {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--agy-muted);
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 4px;
      font-size: 10px;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-family: inherit;
    }
    .footer-btn:hover {
      background: var(--agy-hover);
      color: var(--agy-fg);
    }
    .footer-btn.active {
      background: var(--agy-pill-bg);
      color: var(--agy-fg);
    }
    .settings-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      flex-shrink: 0;
    }
    .preset-group {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .pill-btn {
      appearance: none;
      border: 1px solid var(--agy-border);
      background: var(--agy-bento);
      color: var(--agy-fg);
      border-radius: 5px;
      padding: 2px 6px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
    }
    .pill-btn:hover {
      background: var(--agy-hover);
    }
    .height-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      color: var(--agy-muted);
      padding: 3px 4px;
      background: var(--agy-bento);
      border-radius: 6px;
      flex-shrink: 0;
    }
    .check-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 5px;
      border-radius: 5px;
      cursor: pointer;
      flex-shrink: 0;
      user-select: none;
    }
    .check-row:hover {
      background: var(--agy-hover);
    }
    .check-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .check-box {
      width: 13px;
      height: 13px;
      accent-color: #34d399;
      margin: 0;
      flex-shrink: 0;
      cursor: pointer;
    }
    .json-note {
      font-size: 9.5px;
      color: var(--agy-muted);
      flex-shrink: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .empty {
      padding: 8px 4px;
      text-align: center;
      color: var(--agy-muted);
      font-size: 10.5px;
      line-height: 1.45;
      word-break: break-word;
    }
  `;

  function ensureDomMounted() {
    if (hostEl && hostEl.isConnected) {
      return true;
    }
    if (!document.body) {
      return false;
    }
    hostEl = document.getElementById(HOST_ID);
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = HOST_ID;
      document.body.appendChild(hostEl);
    }
    shadowRoot = hostEl.shadowRoot || hostEl.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '';
    styleEl = document.createElement('style');
    styleEl.textContent = CSS_TEXT;
    cardEl = document.createElement('div');
    cardEl.className = 'card dark';
    shadowRoot.appendChild(styleEl);
    shadowRoot.appendChild(cardEl);
    return true;
  }

  function createSvgIcon(type, spinning) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', type === 'gear' ? '11' : '12');
    svg.setAttribute('height', type === 'gear' ? '11' : '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (spinning) {
      svg.setAttribute('class', 'spin');
    }
    if (type === 'gear') {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '12');
      c.setAttribute('r', '3');
      svg.appendChild(c);
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute(
        'd',
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
      );
      svg.appendChild(p);
      return svg;
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (type === 'refresh') {
      path.setAttribute('d', 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6');
    } else if (type === 'chevron-down') {
      path.setAttribute('d', 'M6 9l6 6 6-6');
    } else if (type === 'chevron-up') {
      path.setAttribute('d', 'M18 15l-6-6-6 6');
    }
    svg.appendChild(path);
    return svg;
  }

  function levelClassForRemaining(frac) {
    if (frac === null || frac === undefined) return 'muted';
    if (frac >= 0.5) return 'good';
    if (frac >= 0.2) return 'warn';
    return 'crit';
  }

  function filterVisibleEntries(list, hiddenIds) {
    if (!Array.isArray(hiddenIds) || hiddenIds.length === 0) return list;
    const hiddenSet = new Set(hiddenIds);
    return list.filter((item) => !hiddenSet.has(item.id));
  }

  function computeEffectiveHeight(geom) {
    const safeMax = geom.safeMaxHeight || 360;
    const target = state.prefs.customHeight !== null ? state.prefs.customHeight : DEFAULT_CARD_HEIGHT;
    return Math.round(Math.max(MIN_CARD_HEIGHT, Math.min(safeMax, target)));
  }

  function attachResizeDrag(handleEl, geom) {
    handleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      handleEl.classList.add('dragging');
      const startY = e.clientY;
      const startHeight = cardEl.getBoundingClientRect().height || computeEffectiveHeight(geom);
      const safeMax = geom.safeMaxHeight || 360;

      const onMove = (ev) => {
        const dy = startY - ev.clientY;
        const nextH = Math.round(Math.max(MIN_CARD_HEIGHT, Math.min(safeMax, startHeight + dy)));
        state.prefs.customHeight = nextH;
        cardEl.style.height = `${nextH}px`;
        cardEl.style.maxHeight = `${safeMax}px`;
      };

      const onUp = () => {
        isResizing = false;
        handleEl.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        savePrefs(state.prefs);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  function renderMiniDash(bodyEl, sm, zh) {
    const dash = document.createElement('div');
    dash.className = 'mini-dash';

    const makeCell = (labelText, valText, titleText, isAccent) => {
      const cell = document.createElement('div');
      cell.className = 'mini-cell';
      if (titleText) cell.title = titleText;
      const lbl = document.createElement('span');
      lbl.className = 'mini-label';
      lbl.textContent = labelText;
      const val = document.createElement('span');
      val.className = isAccent ? 'mini-val accent' : 'mini-val';
      val.textContent = valText;
      cell.appendChild(lbl);
      cell.appendChild(val);
      return cell;
    };

    const turnVal = sm.turnCalls > 0 ? formatTokens(sm.turnTokens) : '--';
    const turnTip =
      sm.turnCalls > 0
        ? `${zh ? '本轮输入' : 'Turn In'}: ${formatTokens(sm.turnInputTokens)} · ${
            zh ? '输出' : 'Out'
          }: ${formatTokens(sm.turnOutputTokens)}${
            sm.turnThinkingTokens > 0
              ? ` (${zh ? '思考' : 'Think'} ${formatTokens(sm.turnThinkingTokens)})`
              : ''
          }${
            sm.turnCacheReadTokens > 0
              ? ` · ${zh ? '缓存' : 'Cache'} ${formatTokens(sm.turnCacheReadTokens)}`
              : ''
          }`
        : zh
        ? '暂无当前轮次 Token 数据'
        : 'No turn token data yet';

    const tpsVal = formatTps(sm.tps);
    const tpsTip =
      sm.tps && sm.tps > 0
        ? `${zh ? '本轮生成速度' : 'Turn generation speed'}: ${tpsVal}`
        : zh
        ? '暂无流式输出速度数据'
        : 'No TPS data yet';

    const sessVal = sm.sessionCalls > 0 ? formatTokens(sm.sessionTokens) : '--';
    const sessTip =
      sm.sessionCalls > 0
        ? `${zh ? '会话输入' : 'Session In'}: ${formatTokens(sm.sessionInputTokens)} · ${
            zh ? '输出' : 'Out'
          }: ${formatTokens(sm.sessionOutputTokens)} · ${zh ? '调用' : 'Calls'}: ${sm.sessionCalls}`
        : zh
        ? '暂无当前 Session Token 数据'
        : 'No session token data yet';

    dash.appendChild(makeCell(zh ? '本轮 Token' : 'Turn Tok', turnVal, turnTip, false));
    dash.appendChild(makeCell('TPS', tpsVal, tpsTip, Boolean(sm.tps && sm.tps > 0)));
    dash.appendChild(makeCell(zh ? '会话总计' : 'Session', sessVal, sessTip, false));
    bodyEl.appendChild(dash);
  }

  function renderSettingsPanel(bodyEl, data, geom, zh) {
    const isTokenPage = state.prefs.showUsed;
    const targetList = isTokenPage ? data.tokenModels : data.quotaPools;
    const hiddenKey = isTokenPage ? 'hiddenModels' : 'hiddenPools';

    const bar = document.createElement('div');
    bar.className = 'settings-bar';

    const presets = document.createElement('div');
    presets.className = 'preset-group';

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'pill-btn';
    allBtn.textContent = zh ? '全选' : 'All';
    allBtn.addEventListener('click', () => {
      state.prefs[hiddenKey] = [];
      savePrefs(state.prefs);
      render();
    });
    presets.appendChild(allBtn);

    const gemBtn = document.createElement('button');
    gemBtn.type = 'button';
    gemBtn.className = 'pill-btn';
    gemBtn.textContent = zh ? '仅 Gemini' : 'Gemini';
    gemBtn.addEventListener('click', () => {
      state.prefs[hiddenKey] = targetList
        .filter((it) => !/gemini|argon|neon|hydrogen|carbon/i.test(it.name))
        .map((it) => it.id);
      savePrefs(state.prefs);
      render();
    });
    presets.appendChild(gemBtn);

    const invBtn = document.createElement('button');
    invBtn.type = 'button';
    invBtn.className = 'pill-btn';
    invBtn.textContent = zh ? '反选' : 'Invert';
    invBtn.addEventListener('click', () => {
      const curHidden = new Set(state.prefs[hiddenKey] || []);
      state.prefs[hiddenKey] = targetList
        .filter((it) => !curHidden.has(it.id))
        .map((it) => it.id);
      savePrefs(state.prefs);
      render();
    });
    presets.appendChild(invBtn);

    bar.appendChild(presets);

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'pill-btn';
    doneBtn.textContent = zh ? '完成' : 'Done';
    doneBtn.addEventListener('click', () => {
      state.settingsOpen = false;
      render();
    });
    bar.appendChild(doneBtn);
    bodyEl.appendChild(bar);

    // 高度调节条
    const hBar = document.createElement('div');
    hBar.className = 'height-bar';
    const curH = computeEffectiveHeight(geom);
    const hLabel = document.createElement('span');
    hLabel.textContent = zh ? `高度: ${curH}px (可拖顶部)` : `Height: ${curH}px`;
    hBar.appendChild(hLabel);

    const hBtns = document.createElement('div');
    hBtns.className = 'preset-group';
    const stepHeight = (delta) => {
      const safeMax = geom.safeMaxHeight || 360;
      const next = Math.round(Math.max(MIN_CARD_HEIGHT, Math.min(safeMax, curH + delta)));
      state.prefs.customHeight = next;
      savePrefs(state.prefs);
      render();
    };
    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'pill-btn';
    minusBtn.textContent = '-';
    minusBtn.addEventListener('click', () => stepHeight(-30));
    hBtns.appendChild(minusBtn);

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'pill-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', () => stepHeight(30));
    hBtns.appendChild(plusBtn);

    const resetHBtn = document.createElement('button');
    resetHBtn.type = 'button';
    resetHBtn.className = 'pill-btn';
    resetHBtn.textContent = zh ? '默认' : 'Reset';
    resetHBtn.addEventListener('click', () => {
      state.prefs.customHeight = null;
      savePrefs(state.prefs);
      render();
    });
    hBtns.appendChild(resetHBtn);
    hBar.appendChild(hBtns);
    bodyEl.appendChild(hBar);

    // 复选框列表
    const list = document.createElement('div');
    list.className = 'list';
    const hiddenSet = new Set(state.prefs[hiddenKey] || []);
    for (const item of targetList) {
      const row = document.createElement('label');
      row.className = 'check-row';

      const left = document.createElement('div');
      left.className = 'check-left';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'check-box';
      cb.checked = !hiddenSet.has(item.id);
      cb.addEventListener('change', () => {
        const nextSet = new Set(state.prefs[hiddenKey] || []);
        if (cb.checked) {
          nextSet.delete(item.id);
        } else {
          nextSet.add(item.id);
        }
        state.prefs[hiddenKey] = Array.from(nextSet);
        savePrefs(state.prefs);
        render();
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'model-name';
      nameSpan.textContent = isTokenPage ? item.name : formatPoolTitle(item.name, zh);
      left.appendChild(cb);
      left.appendChild(nameSpan);
      row.appendChild(left);

      if (isTokenPage) {
        const tokSpan = document.createElement('span');
        tokSpan.className = 'pct tok';
        tokSpan.textContent = `${formatTokens(item.totalTokens)} tok`;
        row.appendChild(tokSpan);
      } else if (Array.isArray(item.buckets) && item.buckets[0] && item.buckets[0].remainingFraction !== null) {
        const frac = item.buckets[0].remainingFraction;
        const pct = document.createElement('span');
        pct.className = `pct ${levelClassForRemaining(frac)}`;
        pct.textContent = `${Math.round(frac * 100)}%`;
        row.appendChild(pct);
      }

      list.appendChild(row);
    }
    bodyEl.appendChild(list);

    const jsonNote = document.createElement('div');
    jsonNote.className = 'json-note';
    const turns = (state.history.totals && state.history.totals.turns) || state.history.events.length || 0;
    const allTok = (state.history.totals && state.history.totals.totalTokens) || 0;
    jsonNote.textContent = zh
      ? `JSON 长期记录: ${turns} 轮 · ${formatTokens(allTok)} tok (usage-history.json)`
      : `JSON Log: ${turns} turns · ${formatTokens(allTok)} tok`;
    jsonNote.title = '~/.gemini/config/plugins/antigravity-usage-dashboard/runtime/usage-history.json';
    bodyEl.appendChild(jsonNote);
  }

  function renderQuotaPoolsList(listEl, visiblePools, nowMs, zh) {
    for (const pool of visiblePools) {
      const box = document.createElement('div');
      box.className = 'pool-box';
      if (pool.includedModels && pool.includedModels.length > 0) {
        box.title = `${pool.name}\n${zh ? '共享模型' : 'Models'}: ${pool.includedModels.join(', ')}`;
      }

      const titleRow = document.createElement('div');
      titleRow.className = 'pool-title';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = formatPoolTitle(pool.name, zh);
      titleRow.appendChild(titleSpan);
      if (pool.includedModels && pool.includedModels.length > 1) {
        const sub = document.createElement('span');
        sub.className = 'pool-sub';
        sub.textContent = zh ? `${pool.includedModels.length} 模型共享` : `${pool.includedModels.length} models`;
        titleRow.appendChild(sub);
      }
      box.appendChild(titleRow);

      for (const b of pool.buckets) {
        const row = document.createElement('div');
        row.className = 'row';
        const winLabel = formatWindowLabel(b.displayName, b.window, pool.name, zh);
        const tips = [`${pool.name} · ${winLabel}`];
        if (b.remainingFraction !== null) {
          tips.push(`${zh ? '剩余' : 'Left'}: ${Math.round(b.remainingFraction * 100)}%`);
        }
        if (b.resetMs) {
          tips.push(`${zh ? '重置' : 'Resets'}: ${formatLocalDateTime(b.resetMs)}`);
        }
        row.title = tips.join(' · ');

        const rowTop = document.createElement('div');
        rowTop.className = 'row-top';
        const labelEl = document.createElement('span');
        labelEl.className = 'win-label';
        labelEl.textContent = winLabel;
        rowTop.appendChild(labelEl);

        const rowMeta = document.createElement('div');
        rowMeta.className = 'row-meta';
        const resetStr = formatResetCountdown(b.resetMs, nowMs, zh);
        if (resetStr) {
          const rTag = document.createElement('span');
          rTag.className = 'reset-tag';
          rTag.textContent = resetStr;
          rowMeta.appendChild(rTag);
        }
        const pctEl = document.createElement('span');
        const lvl = levelClassForRemaining(b.remainingFraction);
        pctEl.className = `pct ${lvl}`;
        pctEl.textContent = b.remainingFraction !== null ? `${Math.round(b.remainingFraction * 100)}%` : '--';
        rowMeta.appendChild(pctEl);
        rowTop.appendChild(rowMeta);
        row.appendChild(rowTop);

        const track = document.createElement('div');
        track.className = 'bar-track';
        const fill = document.createElement('div');
        fill.className = `bar-fill ${lvl === 'good' ? '' : lvl}`.trim();
        const barPct = b.remainingFraction !== null ? Math.round(b.remainingFraction * 100) : 0;
        fill.style.width = `${Math.max(0, Math.min(100, barPct))}%`;
        track.appendChild(fill);
        row.appendChild(track);

        box.appendChild(row);
      }

      listEl.appendChild(box);
    }
  }

  function renderTokenModelsList(listEl, visibleModels, zh) {
    let maxTok = 0;
    for (const m of visibleModels) {
      if (m.totalTokens > maxTok) maxTok = m.totalTokens;
    }

    for (const m of visibleModels) {
      const row = document.createElement('div');
      row.className = 'row';
      const tips = [
        m.name,
        `${zh ? '累计消耗' : 'Used'}: ${formatTokens(m.totalTokens)} tok`,
        `${zh ? '输入' : 'In'} ${formatTokens(m.inputTokens)} / ${zh ? '输出' : 'Out'} ${formatTokens(
          m.outputTokens
        )}`,
      ];
      if (m.cacheReadTokens > 0) {
        tips.push(`${zh ? '缓存' : 'Cache'} ${formatTokens(m.cacheReadTokens)}`);
      }
      if (m.remainingFraction !== null) {
        tips.push(`${zh ? '池剩余' : 'Pool Left'} ${Math.round(m.remainingFraction * 100)}%`);
      }
      row.title = tips.join(' · ');

      const rowTop = document.createElement('div');
      rowTop.className = 'row-top';
      const nameEl = document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = m.name;
      rowTop.appendChild(nameEl);

      const rowMeta = document.createElement('div');
      rowMeta.className = 'row-meta';
      const tokEl = document.createElement('span');
      tokEl.className = 'pct tok';
      tokEl.textContent = `${formatTokens(m.totalTokens)} tok`;
      rowMeta.appendChild(tokEl);
      rowTop.appendChild(rowMeta);
      row.appendChild(rowTop);

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      const pct = maxTok > 0 ? Math.round((m.totalTokens / maxTok) * 100) : 0;
      fill.style.width = `${Math.max(m.totalTokens > 0 ? 4 : 0, Math.min(100, pct))}%`;
      track.appendChild(fill);
      row.appendChild(track);

      listEl.appendChild(row);
    }
  }

  let lastRenderedViewKey = '';

  function render() {
    if (isResizing || !ensureDomMounted()) return;

    const geom = lastGeometry;
    if (!geom || !geom.visible) {
      hostEl.style.display = 'none';
      return;
    }

    const viewKey = `${state.settingsOpen ? 'S' : 'M'}:${state.prefs.showUsed ? 'T' : 'Q'}`;
    const prevListEl =
      !state.prefs.collapsed && viewKey === lastRenderedViewKey && cardEl.querySelector
        ? cardEl.querySelector('.list')
        : null;
    const prevScrollTop = prevListEl ? prevListEl.scrollTop : 0;
    lastRenderedViewKey = viewKey;

    hostEl.style.display = 'block';
    hostEl.style.left = `${geom.left}px`;
    hostEl.style.width = `${geom.width}px`;
    hostEl.style.bottom = `${geom.bottom}px`;

    state.isDark = detectThemeIsDark();
    state.isZh = detectIsZh(geom.settingsText);
    const zh = state.isZh;

    cardEl.className = `card ${state.isDark ? 'dark' : 'light'}`;
    cardEl.textContent = '';

    if (state.prefs.collapsed) {
      cardEl.style.height = 'auto';
      cardEl.style.maxHeight = 'none';
    } else {
      const effH = computeEffectiveHeight(geom);
      cardEl.style.height = `${effH}px`;
      cardEl.style.maxHeight = `${geom.safeMaxHeight}px`;
    }

    const data = state.normalized;
    const isTokenPage = state.prefs.showUsed;
    const visiblePools = filterVisibleEntries(data.quotaPools, state.prefs.hiddenPools);
    const visibleModels = filterVisibleEntries(data.tokenModels, state.prefs.hiddenModels);
    const nowMs = Date.now();

    let minRemaining = null;
    for (const pool of visiblePools) {
      for (const b of pool.buckets) {
        if (typeof b.remainingFraction === 'number') {
          if (minRemaining === null || b.remainingFraction < minRemaining) {
            minRemaining = b.remainingFraction;
          }
        }
      }
    }

    if (!state.prefs.collapsed) {
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.title = zh ? '上下拖拽调整面板高度' : 'Drag to resize height';
      attachResizeDrag(handle, geom);
      cardEl.appendChild(handle);
    }

    // Header
    const header = document.createElement('div');
    header.className = 'header';
    header.addEventListener('click', () => {
      state.prefs.collapsed = !state.prefs.collapsed;
      savePrefs(state.prefs);
      render();
    });

    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';

    const dot = document.createElement('span');
    const dotCls =
      minRemaining === null
        ? 'idle'
        : minRemaining >= 0.5
        ? ''
        : minRemaining >= 0.2
        ? 'warn'
        : 'crit';
    dot.className = `dot ${dotCls}`.trim();
    titleWrap.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = state.settingsOpen
      ? zh
        ? isTokenPage
          ? '筛选消耗模型'
          : '筛选额度池'
        : 'Filter'
      : isTokenPage
      ? zh
        ? '模型 Token 消耗'
        : 'Token Usage'
      : zh
      ? '模型 Usage'
      : 'Model Usage';
    titleWrap.appendChild(title);

    if (state.prefs.collapsed) {
      const sm = data.sessionMetrics;
      const parts = [];
      if (minRemaining !== null) parts.push(`${Math.round(minRemaining * 100)}%`);
      if (sm.sessionCalls > 0) parts.push(`${formatTokens(sm.sessionTokens)} tok`);
      if (parts.length > 0) {
        const pill = document.createElement('span');
        pill.className = 'badge';
        pill.textContent = parts.join(' · ');
        titleWrap.appendChild(pill);
      }
    } else if (data.planName) {
      const planBadge = document.createElement('span');
      planBadge.className = 'badge';
      planBadge.textContent = data.planName;
      titleWrap.appendChild(planBadge);
    }

    header.appendChild(titleWrap);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'icon-btn';
    refreshBtn.type = 'button';
    refreshBtn.title = zh ? '刷新模型 Usage' : 'Refresh Model Usage';
    refreshBtn.appendChild(createSvgIcon('refresh', state.loading));
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshAllUsage(true);
    });
    actions.appendChild(refreshBtn);

    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'icon-btn';
    collapseBtn.type = 'button';
    collapseBtn.title = state.prefs.collapsed ? (zh ? '展开' : 'Expand') : (zh ? '收起' : 'Collapse');
    collapseBtn.appendChild(createSvgIcon(state.prefs.collapsed ? 'chevron-up' : 'chevron-down', false));
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.prefs.collapsed = !state.prefs.collapsed;
      savePrefs(state.prefs);
      render();
    });
    actions.appendChild(collapseBtn);

    header.appendChild(actions);
    cardEl.appendChild(header);

    if (state.prefs.collapsed) {
      return;
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'body';

    if (state.settingsOpen) {
      renderSettingsPanel(bodyEl, data, geom, zh);
    } else {
      renderMiniDash(bodyEl, data.sessionMetrics, zh);

      if (data.credits.length > 0) {
        const creditsRow = document.createElement('div');
        creditsRow.className = 'credits-row';
        for (const c of data.credits) {
          const chip = document.createElement('span');
          chip.className = 'credit-chip';
          chip.appendChild(document.createTextNode(`${c.label}: `));
          const val = document.createElement('b');
          val.textContent = c.total !== null ? `${c.remaining}/${c.total}` : `${c.used}`;
          chip.appendChild(val);
          creditsRow.appendChild(chip);
        }
        bodyEl.appendChild(creditsRow);
      }

      const listEl = document.createElement('div');
      listEl.className = 'list';

      if (isTokenPage) {
        if (visibleModels.length > 0) {
          renderTokenModelsList(listEl, visibleModels, zh);
        } else if (data.tokenModels.length > 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = zh ? '已隐藏全部模型，点击“设置”勾选' : 'All models hidden';
          listEl.appendChild(empty);
        } else {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = zh ? '暂无 Token 消耗记录' : 'No token records yet';
          listEl.appendChild(empty);
        }
      } else {
        if (visiblePools.length > 0) {
          renderQuotaPoolsList(listEl, visiblePools, nowMs, zh);
        } else if (data.quotaPools.length > 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = zh ? '已隐藏全部额度池，点击“设置”勾选' : 'All pools hidden';
          listEl.appendChild(empty);
        } else {
          const empty = document.createElement('div');
          empty.className = 'empty';
          if (state.loading) {
            empty.textContent = zh ? '正在获取模型配额...' : 'Loading quota...';
          } else if (state.waitingAuth) {
            empty.textContent = zh
              ? '等待会话鉴权同步（切换页面或打开对话即可同步）'
              : 'Waiting for session token...';
          } else if (state.error) {
            empty.textContent = zh ? `暂无法获取 (${state.error})` : `Unavailable (${state.error})`;
          } else {
            empty.textContent = zh ? '暂无模型配额数据' : 'No quota data yet';
          }
          listEl.appendChild(empty);
        }
      }

      bodyEl.appendChild(listEl);
    }

    // Footer: 更新时间 | ⚙ 设置 | 显示: 剩余 / 消耗
    const footer = document.createElement('div');
    footer.className = 'footer';

    const syncLabel = document.createElement('span');
    if (state.lastUpdatedAt) {
      const clk = formatLocalClock(state.lastUpdatedAt);
      syncLabel.textContent = zh ? `${clk} 更新` : `${clk}`;
    } else {
      syncLabel.textContent = zh ? '等待同步' : 'Syncing';
    }
    footer.appendChild(syncLabel);

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = `footer-btn ${state.settingsOpen ? 'active' : ''}`.trim();
    settingsBtn.title = zh ? '筛选显示项与调整高度' : 'Filter & Height Settings';
    settingsBtn.appendChild(createSvgIcon('gear', false));
    const totalCount = isTokenPage ? data.tokenModels.length : data.quotaPools.length;
    const shownCount = isTokenPage
      ? filterVisibleEntries(data.tokenModels, state.prefs.hiddenModels).length
      : filterVisibleEntries(data.quotaPools, state.prefs.hiddenPools).length;
    const hasFilter = totalCount > 0 && shownCount < totalCount;
    settingsBtn.appendChild(
      document.createTextNode(
        hasFilter ? `${zh ? '设置' : 'Filter'} (${shownCount}/${totalCount})` : zh ? '设置' : 'Filter'
      )
    );
    settingsBtn.addEventListener('click', () => {
      state.settingsOpen = !state.settingsOpen;
      render();
    });
    footer.appendChild(settingsBtn);

    const modeToggle = document.createElement('button');
    modeToggle.type = 'button';
    modeToggle.className = 'footer-btn';
    modeToggle.textContent = isTokenPage
      ? zh
        ? '页: 消耗'
        : 'Page: Token'
      : zh
      ? '页: 剩余'
      : 'Page: Quota';
    modeToggle.title = zh
      ? '点击切换 剩余额度(合并池) / 消耗额度(逐模型 Token)'
      : 'Switch Quota Pools / Model Token Consumption';
    modeToggle.addEventListener('click', () => {
      state.prefs.showUsed = !state.prefs.showUsed;
      savePrefs(state.prefs);
      render();
    });
    footer.appendChild(modeToggle);

    bodyEl.appendChild(footer);
    cardEl.appendChild(bodyEl);
    if (prevScrollTop > 0 && cardEl.querySelector) {
      const nextListEl = cardEl.querySelector('.list');
      if (nextListEl) nextListEl.scrollTop = prevScrollTop;
    }
  }

  function recomputeAndRender() {
    state.normalized = normalizeUsageData(state.rawSources, state.history);
    render();
  }

  // ==================== 调度与生命周期 ====================

  let layoutRaf = null;
  function scheduleLayoutCheck() {
    if (layoutRaf !== null) return;
    layoutRaf = window.requestAnimationFrame(() => {
      layoutRaf = null;
      const nextGeom = locateSidebarGeometry(document, window);
      const changed =
        nextGeom.visible !== lastGeometry.visible ||
        nextGeom.left !== lastGeometry.left ||
        nextGeom.width !== lastGeometry.width ||
        nextGeom.bottom !== lastGeometry.bottom ||
        nextGeom.safeMaxHeight !== lastGeometry.safeMaxHeight ||
        nextGeom.settingsText !== lastGeometry.settingsText;
      if (changed) {
        lastGeometry = nextGeom;
        render();
      }
    });
  }

  function start() {
    bootstrapFromEarlyTap();
    installFallbackHooks();
    scheduleLayoutCheck();

    if (typeof MutationObserver === 'function' && document.body) {
      const obs = new MutationObserver(() => scheduleLayoutCheck());
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-expanded', 'hidden'],
      });
    }

    if (typeof ResizeObserver === 'function' && document.body) {
      const rObs = new ResizeObserver(() => scheduleLayoutCheck());
      rObs.observe(document.body);
    }

    window.addEventListener('resize', scheduleLayoutCheck, { passive: true });
    window.addEventListener('click', () => setTimeout(scheduleLayoutCheck, 80), { passive: true });

    setTimeout(() => refreshAllUsage(false), 300);
    setTimeout(() => {
      if (!state.lastUpdatedAt || state.normalized.quotaPools.length === 0) refreshAllUsage(false);
    }, 2000);
    setTimeout(() => {
      if (!state.lastUpdatedAt || state.normalized.quotaPools.length === 0) refreshAllUsage(false);
    }, 5500);

    setInterval(() => {
      if (!document.hidden) {
        refreshAllUsage(false);
      }
    }, AUTO_REFRESH_MS);

    setInterval(() => {
      if (!document.hidden) {
        refreshSessionMetricsOnly();
      }
    }, ACTIVE_SESSION_POLL_MS);

    setInterval(() => {
      if (!document.hidden && lastGeometry.visible && !state.prefs.collapsed) {
        render();
      }
    }, COUNTDOWN_TICK_MS);
  }

  window.__AGY_USAGE_DASHBOARD_TEST_HOOK__ = {
    meta,
    normalizeUsageData,
    computeGeneratorMetrics,
    recordEventsToHistory,
    formatResetCountdown,
    formatTokens,
    formatTps,
    parseProtoDurationSec,
    extractQuotaInfo,
    locateSidebarGeometry,
    getPoolPriority,
    filterVisibleEntries,
    mergeCapturedHeaders,
    buildRpcHeaders,
    callLsRpc,
    refreshAllUsage,
    pickActiveCascadeId,
    state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
