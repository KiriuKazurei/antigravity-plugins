/**
 * Antigravity 上下文洞察与诊断面板 (antigravity-context-doctor)
 * 灵感源自 bowenliang123/dsh-context，专为 Antigravity 2.0 桌面端打造。
 * 纯浏览器 DOM 环境执行，无任何 Node.js 内置模块依赖。
 */
(function () {
  'use strict';

  const meta = window.__AGY_PLUGIN_META__ || {};
  try {
    delete window.__AGY_PLUGIN_META__;
  } catch (_) {}

  if (window.__AGY_CONTEXT_DOCTOR_ACTIVE__) {
    return;
  }
  window.__AGY_CONTEXT_DOCTOR_ACTIVE__ = true;

  const HOST_ID = 'agy-context-doctor-host';
  const PREFS_KEY = 'agy_context_doctor_prefs_v2';
  const LS_SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
  const ACTIVE_POLL_MS = 5000;
  const GLOBAL_POLL_MS = 35000;
  const MAX_GLOBAL_SESSIONS = 18;

  const MODEL_WINDOW_PRESETS = [128000, 200000, 400000, 1000000, 2000000];

  const DEFAULT_PREFS = {
    open: false,
    activeTab: 'overview', // overview | hitters | fleet | insights | handoff
    sidebarWidth: 400,
    edgeTopPct: 38,
    showEdgeTab: false,
    warnThresholdPct: 75,
    criticalThresholdPct: 90,
    langMode: 'auto', // auto | zh | en
    customModelLimits: {}, // { [modelKey]: number }
    handoffOptions: {
      includeGoal: true,
      includeFiles: true,
      includeCommands: true,
      includeConclusions: true,
      includeDiagnostics: false,
    },
  };

  function clampNumber(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            open: Boolean(parsed.open),
            activeTab: ['overview', 'hitters', 'fleet', 'insights', 'handoff'].includes(parsed.activeTab)
              ? parsed.activeTab
              : DEFAULT_PREFS.activeTab,
            sidebarWidth: clampNumber(parsed.sidebarWidth, 320, 640, DEFAULT_PREFS.sidebarWidth),
            edgeTopPct: clampNumber(parsed.edgeTopPct, 8, 86, DEFAULT_PREFS.edgeTopPct),
            showEdgeTab: parsed.showEdgeTab === true,
            warnThresholdPct: clampNumber(parsed.warnThresholdPct, 40, 95, DEFAULT_PREFS.warnThresholdPct),
            criticalThresholdPct: clampNumber(
              parsed.criticalThresholdPct,
              50,
              99,
              DEFAULT_PREFS.criticalThresholdPct
            ),
            langMode: ['auto', 'zh', 'en'].includes(parsed.langMode) ? parsed.langMode : 'auto',
            customModelLimits:
              parsed.customModelLimits && typeof parsed.customModelLimits === 'object'
                ? { ...parsed.customModelLimits }
                : {},
            handoffOptions: {
              ...DEFAULT_PREFS.handoffOptions,
              ...(parsed.handoffOptions && typeof parsed.handoffOptions === 'object'
                ? parsed.handoffOptions
                : {}),
            },
          };
        }
      }
    } catch (_) {}
    return {
      ...DEFAULT_PREFS,
      customModelLimits: {},
      handoffOptions: { ...DEFAULT_PREFS.handoffOptions },
    };
  }

  function savePrefs(prefs) {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      }
    } catch (_) {}
  }

  // ==================== 纯逻辑与格式化 ====================

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
    if (typeof dur === 'number') return Number.isFinite(dur) && dur > 0 ? dur : 0;
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

  function formatBytes(chars) {
    const c = Math.max(0, Number(chars) || 0);
    if (c < 1024) return `${Math.round(c)} B`;
    if (c < 1048576) return `${(c / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
    return `${(c / 1048576).toFixed(2).replace(/\.?0+$/, '')} MB`;
  }

  function formatTps(tps) {
    if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return '--';
    return tps >= 100 ? `${Math.round(tps)} t/s` : `${tps.toFixed(1)} t/s`;
  }

  function formatPct(val, digits = 1) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return '0%';
    return `${val.toFixed(digits).replace(/\.0$/, '')}%`;
  }

  function formatRelativeTime(tsMs, nowMs, isZh) {
    if (!tsMs || !Number.isFinite(tsMs)) return '--';
    const diffSec = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
    if (diffSec < 60) return isZh ? '刚刚' : 'just now';
    const min = Math.floor(diffSec / 60);
    if (min < 60) return isZh ? `${min}m 前` : `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return isZh ? `${hr}h 前` : `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return isZh ? `${d}d 前` : `${d}d ago`;
  }

  function localDateKey(tsMs) {
    const d = new Date(tsMs);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function estimateTokensFromText(text) {
    if (!text) return 0;
    const str = String(text);
    if (!str) return 0;
    let cjk = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk += 1;
      }
    }
    const other = str.length - cjk;
    return Math.max(1, Math.round(cjk * 1.0 + other * 0.28));
  }

  function baseModelFamily(label) {
    return String(label || '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+(High|Medium|Low|Fast|Thinking)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveModelContextLimit(modelName, modelEnum, customLimits) {
    const keys = [String(modelName || '').trim(), String(modelEnum || '').trim()].filter(Boolean);
    if (customLimits && typeof customLimits === 'object') {
      for (const k of keys) {
        const custom = Number(customLimits[k]);
        if (Number.isFinite(custom) && custom >= 8192) {
          return custom;
        }
      }
      const fam = baseModelFamily(modelName);
      if (fam && Number.isFinite(Number(customLimits[fam])) && Number(customLimits[fam]) >= 8192) {
        return Number(customLimits[fam]);
      }
    }
    const combined = `${modelName || ''} ${modelEnum || ''}`.toLowerCase();
    if (/\b2m\b|\b2000k\b|gemini-1\.5-pro/i.test(combined)) return 2000000;
    if (/\b1m\b|\b1000k\b|gemini|hydrogen/i.test(combined)) return 1000000;
    if (/claude|sonnet|opus|haiku/i.test(combined)) return 200000;
    if (/gpt-5|gpt-4\.1/i.test(combined)) return /4\.1/i.test(combined) ? 1000000 : 400000;
    if (/gpt-4o|o1|o3|o4|deepseek|qwen/i.test(combined)) return 200000;
    return 1000000;
  }

  function buildEnumToLabelMap(rawSources) {
    const map = new Map();
    const sources = [
      rawSources && rawSources.userStatus && rawSources.userStatus.userStatus,
      rawSources && rawSources.userStatus,
      rawSources && rawSources.cascadeConfigs && rawSources.cascadeConfigs.cascadeModelConfigData,
      rawSources && rawSources.cascadeConfigs,
      rawSources && rawSources.availableModels,
    ];
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      const cc = src.cascadeModelConfigData || src;
      const list = Array.isArray(cc.clientModelConfigs)
        ? cc.clientModelConfigs
        : Array.isArray(cc.models)
          ? cc.models
          : [];
      for (const cfg of list) {
        if (!cfg || typeof cfg !== 'object') continue;
        const label = String(cfg.label || cfg.displayName || '').trim();
        const me = String(
          (cfg.modelOrAlias && (cfg.modelOrAlias.model || cfg.modelOrAlias.alias)) ||
            cfg.model ||
            cfg.modelId ||
            ''
        ).trim();
        if (label && me && !map.has(me)) {
          map.set(me, label);
        }
      }
    }
    return map;
  }

  function parseGeneratorCalls(generatorMetadataList, enumToLabelMap) {
    const list = Array.isArray(generatorMetadataList) ? generatorMetadataList : [];
    const calls = [];
    const byModel = new Map();
    let totalInput = 0;
    let totalOutput = 0;
    let totalThinking = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let streamSecSum = 0;
    let streamOutputSum = 0;
    let compactionCount = 0;
    let spikeCount = 0;

    let prevContextTokens = 0;

    for (let i = 0; i < list.length; i++) {
      const gm = list[i];
      if (!gm || typeof gm !== 'object') continue;
      const cm = gm.chatModel || gm.chat_model;
      if (!cm || typeof cm !== 'object') continue;
      const u = cm.usage;
      if (!u || typeof u !== 'object') continue;

      const inputTokens = parseNum(u.inputTokens ?? u.input_tokens);
      const thinkingTokens = parseNum(u.thinkingOutputTokens ?? u.thinking_output_tokens);
      const responseTokens = parseNum(u.responseOutputTokens ?? u.response_output_tokens);
      const rawOutput = parseNum(u.outputTokens ?? u.output_tokens);
      const outputTokens = rawOutput > 0 ? rawOutput : thinkingTokens + responseTokens;
      const cacheReadTokens = parseNum(u.cacheReadTokens ?? u.cache_read_tokens);
      const cacheWriteTokens = parseNum(u.cacheWriteTokens ?? u.cache_write_tokens);

      // 兼容两种计量口径：
      // 1) inputTokens 已包含 cacheReadTokens（如常见 Gemini/OpenAI 口径）
      // 2) inputTokens 仅计未命中部分（cacheReadTokens > inputTokens 时自动合并）
      const promptContextTokens =
        inputTokens >= cacheReadTokens ? inputTokens : inputTokens + cacheReadTokens;
      const cachedPart = Math.min(cacheReadTokens, promptContextTokens);
      const uncachedPart = Math.max(0, promptContextTokens - cachedPart);

      const streamSec = parseProtoDurationSec(cm.streamingDuration ?? cm.streaming_duration);
      const modelEnum = String(cm.model || u.model || '').trim();
      const modelLabel =
        (enumToLabelMap && modelEnum && enumToLabelMap.get(modelEnum)) ||
        modelEnum ||
        'Unknown';
      const tsRaw =
        (cm.chatStartMetadata && (cm.chatStartMetadata.startTime || cm.chatStartMetadata.start_time)) ||
        gm.timestamp ||
        '';
      const tsMs = parseTimestampMs(tsRaw);
      const executionId = String(gm.executionId || gm.execution_id || `call-${i + 1}`);
      const tps = streamSec > 0 && outputTokens > 0 ? outputTokens / streamSec : null;

      let delta = 0;
      let eventKind = 'normal';
      if (prevContextTokens > 0 && promptContextTokens > 0) {
        delta = promptContextTokens - prevContextTokens;
        if (delta < -8000 && Math.abs(delta) / prevContextTokens >= 0.25) {
          eventKind = 'compaction';
          compactionCount += 1;
        } else if (delta > 25000) {
          eventKind = 'spike';
          spikeCount += 1;
        }
      }
      if (promptContextTokens > 0) {
        prevContextTokens = promptContextTokens;
      }

      totalInput += promptContextTokens;
      totalOutput += outputTokens;
      totalThinking += thinkingTokens;
      totalCacheRead += cachedPart;
      totalCacheWrite += cacheWriteTokens;
      if (streamSec > 0 && outputTokens > 0) {
        streamSecSum += streamSec;
        streamOutputSum += outputTokens;
      }

      const fam = baseModelFamily(modelLabel) || modelLabel;
      const mEntry = byModel.get(fam) || {
        model: fam,
        modelEnum,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };
      mEntry.calls += 1;
      mEntry.inputTokens += promptContextTokens;
      mEntry.outputTokens += outputTokens;
      mEntry.thinkingTokens += thinkingTokens;
      mEntry.cacheReadTokens += cachedPart;
      mEntry.totalTokens += promptContextTokens + outputTokens;
      byModel.set(fam, mEntry);

      calls.push({
        index: i + 1,
        executionId,
        model: modelLabel,
        modelFamily: fam,
        modelEnum,
        ts: tsRaw ? String(tsRaw) : '',
        tsMs,
        promptContextTokens,
        cachedPart,
        uncachedPart,
        outputTokens,
        thinkingTokens,
        responseTokens: responseTokens || Math.max(0, outputTokens - thinkingTokens),
        cacheWriteTokens,
        totalTokens: promptContextTokens + outputTokens,
        streamSec,
        tps,
        delta,
        eventKind,
      });
    }

    const latestCall = calls.length > 0 ? calls[calls.length - 1] : null;
    const avgTps = streamSecSum > 0 && streamOutputSum > 0 ? streamOutputSum / streamSecSum : null;
    const cacheHitRate = totalInput > 0 ? (totalCacheRead / totalInput) * 100 : 0;

    return {
      calls,
      latestCall,
      callCount: calls.length,
      totalInput,
      totalOutput,
      totalThinking,
      totalCacheRead,
      totalCacheWrite,
      totalTokens: totalInput + totalOutput,
      avgTps,
      cacheHitRate,
      compactionCount,
      spikeCount,
      modelsUsed: Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    };
  }

  function extractStepsFromTrajectoryResponse(resp) {
    if (!resp || typeof resp !== 'object') return [];
    if (resp.trajectory && Array.isArray(resp.trajectory.steps)) return resp.trajectory.steps;
    if (Array.isArray(resp.steps)) return resp.steps;
    if (Array.isArray(resp.trajectorySteps)) return resp.trajectorySteps;
    if (Array.isArray(resp.trajectory_steps)) return resp.trajectory_steps;
    if (Array.isArray(resp.items)) return resp.items;
    return [];
  }

  function collectTextValues(obj, maxChars = 16000, depth = 0) {
    if (obj === null || obj === undefined || depth > 5) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
    if (Array.isArray(obj)) {
      const parts = [];
      let len = 0;
      for (const item of obj) {
        const s = collectTextValues(item, maxChars - len, depth + 1);
        if (s) {
          parts.push(s);
          len += s.length;
          if (len >= maxChars) break;
        }
      }
      return parts.join('\n');
    }
    if (typeof obj === 'object') {
      const parts = [];
      let len = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (
          k === 'metadata' ||
          k === 'generatorMetadata' ||
          k === 'rawBytes' ||
          k === 'base64Data'
        ) {
          continue;
        }
        const s = collectTextValues(v, maxChars - len, depth + 1);
        if (s) {
          parts.push(s);
          len += s.length;
          if (len >= maxChars) break;
        }
      }
      return parts.join('\n');
    }
    return '';
  }

  function extractFilePathFromObj(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const direct =
      obj.absolutePath ||
      obj.absolute_path ||
      obj.targetFile ||
      obj.target_file ||
      obj.filePath ||
      obj.file_path ||
      obj.path ||
      obj.searchPath ||
      obj.search_path ||
      obj.searchDirectory ||
      obj.directory ||
      obj.uri ||
      '';
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim().replace(/^file:\/\/\//i, '');
    }
    if (obj.metadata && typeof obj.metadata === 'object') {
      const nested = extractFilePathFromObj(obj.metadata);
      if (nested) return nested;
    }
    return '';
  }

  function normalizeStepTypeName(rawType, step) {
    let t = String(rawType || '').trim();
    t = t.replace(/^CORTEX_STEP_TYPE_/i, '');
    if (!t && step && typeof step === 'object') {
      if (step.userInput || step.user_input) t = 'USER_INPUT';
      else if (step.plannerResponse || step.planner_response) t = 'PLANNER_RESPONSE';
      else if (step.runCommand || step.run_command) t = 'RUN_COMMAND';
      else if (step.commandStatus || step.command_status) t = 'COMMAND_STATUS';
      else if (step.viewFile || step.view_file || step.readFile || step.read_file) t = 'VIEW_FILE';
      else if (step.codeAction || step.code_action || step.editFile || step.edit_file) t = 'CODE_ACTION';
      else if (step.writeToFile || step.write_to_file || step.writeFile) t = 'WRITE_TO_FILE';
      else if (step.grepSearch || step.grep_search) t = 'GREP_SEARCH';
      else if (step.findByName || step.find_by_name) t = 'FIND_BY_NAME';
      else if (step.invokeSubagent || step.invoke_subagent) t = 'INVOKE_SUBAGENT';
      else if (step.mcpTool || step.mcp_tool) t = 'MCP_TOOL';
    }
    return t.toUpperCase() || 'UNKNOWN';
  }

  function classifyStep(step, index) {
    const rawType = step && (step.type || step.stepType || step.step_type || '');
    const typeName = normalizeStepTypeName(rawType, step);
    const status = String((step && step.status) || '').replace(/^CORTEX_STEP_STATUS_/i, '');
    const isError = /ERROR|FAIL/i.test(status) || Boolean(step && step.error);

    let category = 'agent_tool';
    let badge = typeName.slice(0, 10);
    let title = '';
    let filePath = '';
    let fileOp = '';
    let commandStr = '';
    let contentText = '';
    let thinkingText = '';
    let subagentInfo = null;

    if (typeName === 'USER_INPUT' || typeName === 'USER_MESSAGE') {
      category = 'user';
      badge = 'USER';
      const ui = step.userInput || step.user_input || step;
      const items = ui && Array.isArray(ui.items) ? ui.items : null;
      const itemTexts = items
        ? items.map((it) => (typeof it === 'string' ? it : it.text || it.content || '')).filter(Boolean)
        : [];
      contentText =
        ui.userResponse ||
        ui.query ||
        ui.text ||
        ui.content ||
        itemTexts.join('\n') ||
        collectTextValues(ui, 8000);
      title = contentText.replace(/\s+/g, ' ').trim().slice(0, 90) || 'User Input';
    } else if (typeName === 'PLANNER_RESPONSE' || typeName === 'ASSISTANT_MESSAGE') {
      category = 'assistant';
      badge = 'AI';
      const pr = step.plannerResponse || step.planner_response || step;
      thinkingText = String(pr.thinking || pr.reasoning || pr.thought || '');
      const respText = String(
        pr.response || pr.modifiedResponse || pr.text || pr.content || ''
      );
      const toolCallText = pr.toolCalls ? JSON.stringify(pr.toolCalls) : '';
      contentText = [respText, thinkingText, toolCallText].filter(Boolean).join('\n');
      title =
        respText.replace(/\s+/g, ' ').trim().slice(0, 90) ||
        (thinkingText ? `[Thinking] ${thinkingText.replace(/\s+/g, ' ').trim().slice(0, 72)}` : 'Planner Response');
    } else if (
      /VIEW_FILE|READ_FILE|VIEW_CODE|VIEW_FILE_OUTLINE|GREP|FIND_BY_NAME|LIST_DIR|SEARCH_WEB/i.test(typeName)
    ) {
      category = 'file_read';
      const payload =
        step.viewFile ||
        step.view_file ||
        step.readFile ||
        step.read_file ||
        step.grepSearch ||
        step.grep_search ||
        step.findByName ||
        step.find_by_name ||
        step.listDir ||
        step.searchWeb ||
        step;
      filePath = extractFilePathFromObj(payload) || extractFilePathFromObj(step);
      fileOp = /GREP|FIND|SEARCH/i.test(typeName) ? 'search' : 'read';
      badge = fileOp === 'search' ? 'SEARCH' : 'READ';
      contentText = collectTextValues(payload, 24000) || collectTextValues(step, 24000);
      title = filePath || (payload && (payload.query || payload.pattern)) || typeName;
    } else if (/RUN_COMMAND|COMMAND_STATUS|SEND_COMMAND_INPUT/i.test(typeName)) {
      category = 'command';
      badge = 'CMD';
      const payload =
        step.runCommand ||
        step.run_command ||
        step.commandStatus ||
        step.command_status ||
        step.sendCommandInput ||
        step;
      commandStr = String(
        (payload && (payload.commandLine || payload.command || payload.cmd)) || ''
      ).trim();
      const out = String(
        (payload && (payload.combinedOutput?.full || payload.output || payload.stdout || payload.stderr)) ||
          ''
      );
      contentText = [commandStr, out, collectTextValues(payload, 24000)].filter(Boolean).join('\n');
      title = commandStr || typeName;
    } else if (/CODE_ACTION|EDIT_FILE|WRITE_TO_FILE|WRITE_FILE|MULTI_REPLACE|REPLACE_FILE/i.test(typeName)) {
      category = 'file_edit';
      const payload =
        step.codeAction ||
        step.code_action ||
        step.editFile ||
        step.edit_file ||
        step.writeToFile ||
        step.write_to_file ||
        step.writeFile ||
        step;
      filePath = extractFilePathFromObj(payload) || extractFilePathFromObj(step);
      fileOp = /WRITE/i.test(typeName) ? 'write' : 'edit';
      badge = fileOp === 'write' ? 'WRITE' : 'EDIT';
      contentText = collectTextValues(payload, 24000) || collectTextValues(step, 24000);
      title = filePath || typeName;
    } else {
      category = 'agent_tool';
      if (/SUBAGENT|SWARM/i.test(typeName)) {
        badge = 'AGENT';
        const payload = step.invokeSubagent || step.invoke_subagent || step.swarm || step;
        subagentInfo = {
          role: String((payload && (payload.role || payload.Role || payload.name || payload.typeName)) || 'Subagent'),
          conversationId: String((payload && (payload.conversationId || payload.subagentId || '')) || ''),
          prompt: String((payload && (payload.prompt || payload.Prompt || payload.brief || '')) || '').slice(0, 180),
        };
        title = subagentInfo.role + (subagentInfo.prompt ? `: ${subagentInfo.prompt}` : '');
      } else if (/BROWSER/i.test(typeName)) {
        badge = 'BROWSER';
      } else if (/MCP/i.test(typeName)) {
        badge = 'MCP';
      }
      contentText = collectTextValues(step, 16000);
      if (!title) {
        title = extractFilePathFromObj(step) || typeName;
      }
    }

    const chars = contentText.length;
    const estTokens = estimateTokensFromText(contentText);
    const thinkingTokensEst = thinkingText ? estimateTokensFromText(thinkingText) : 0;

    return {
      index,
      typeName,
      category,
      badge,
      status,
      isError,
      title: String(title || typeName).slice(0, 140),
      filePath,
      fileOp,
      commandStr,
      subagentInfo,
      chars,
      estTokens,
      thinkingTokensEst,
      preview: contentText.slice(0, 1200),
      fullChars: chars,
    };
  }

  function analyzeTrajectorySteps(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const categories = {
      user: { key: 'user', count: 0, chars: 0, estTokens: 0 },
      assistant: { key: 'assistant', count: 0, chars: 0, estTokens: 0 },
      file_read: { key: 'file_read', count: 0, chars: 0, estTokens: 0 },
      command: { key: 'command', count: 0, chars: 0, estTokens: 0 },
      file_edit: { key: 'file_edit', count: 0, chars: 0, estTokens: 0 },
      agent_tool: { key: 'agent_tool', count: 0, chars: 0, estTokens: 0 },
    };

    const parsedSteps = [];
    const fileMap = new Map();
    const userGoals = [];
    const conclusions = [];
    const commands = [];
    const recentErrors = [];
    const subagentCalls = [];
    let totalStepTokens = 0;
    let totalStepChars = 0;

    for (let i = 0; i < list.length; i++) {
      const s = classifyStep(list[i], i + 1);
      parsedSteps.push(s);
      const bucket = categories[s.category] || categories.agent_tool;
      bucket.count += 1;
      bucket.chars += s.chars;
      bucket.estTokens += s.estTokens;
      totalStepTokens += s.estTokens;
      totalStepChars += s.chars;

      if (s.filePath) {
        const fRec = fileMap.get(s.filePath) || {
          path: s.filePath,
          reads: 0,
          edits: 0,
          writes: 0,
          searches: 0,
          totalOps: 0,
          chars: 0,
          estTokens: 0,
          lastStep: s.index,
        };
        if (s.fileOp === 'read') fRec.reads += 1;
        else if (s.fileOp === 'edit') fRec.edits += 1;
        else if (s.fileOp === 'write') fRec.writes += 1;
        else if (s.fileOp === 'search') fRec.searches += 1;
        fRec.totalOps += 1;
        fRec.chars += s.chars;
        fRec.estTokens += s.estTokens;
        fRec.lastStep = s.index;
        fileMap.set(s.filePath, fRec);
      }

      if (s.category === 'user' && s.preview) {
        userGoals.push(s.preview.replace(/\s+/g, ' ').trim().slice(0, 220));
      }
      if (s.category === 'assistant' && s.preview && !/^\[Thinking\]/i.test(s.title)) {
        const clean = s.preview.split('\n')[0].trim();
        if (clean) conclusions.push(clean.slice(0, 240));
      }
      if (s.category === 'command' && s.commandStr) {
        commands.push({
          step: s.index,
          command: s.commandStr.slice(0, 140),
          isError: s.isError,
          estTokens: s.estTokens,
        });
      }
      if (s.isError) {
        recentErrors.push({
          step: s.index,
          title: s.title,
          preview: s.preview.slice(0, 180),
        });
      }
      if (s.subagentInfo) {
        subagentCalls.push({ step: s.index, ...s.subagentInfo });
      }
    }

    for (const s of parsedSteps) {
      s.sharePct = totalStepTokens > 0 ? (s.estTokens / totalStepTokens) * 100 : 0;
    }

    for (const cat of Object.values(categories)) {
      cat.sharePct = totalStepTokens > 0 ? (cat.estTokens / totalStepTokens) * 100 : 0;
    }

    const heavyHitters = [...parsedSteps].sort((a, b) => b.estTokens - a.estTokens);
    const fileActivities = Array.from(fileMap.values()).sort(
      (a, b) => b.estTokens - a.estTokens || b.totalOps - a.totalOps
    );
    const repeatedReads = fileActivities.filter((f) => f.reads >= 3);

    return {
      stepCount: parsedSteps.length,
      totalStepTokens,
      totalStepChars,
      categories,
      steps: parsedSteps,
      heavyHitters,
      fileActivities,
      repeatedReads,
      userGoals,
      conclusions,
      commands,
      recentErrors,
      subagentCalls,
    };
  }

  function buildContextInsights(trajectoriesMap, generatorByCid, enumToLabelMap, customLimits, nowMs) {
    const now = nowMs || Date.now();
    const summaries = trajectoriesMap && typeof trajectoriesMap === 'object' ? trajectoriesMap : {};
    const sessions = [];
    const dailyMap = new Map();

    // 初始化最近 7 天桶
    for (let d = 6; d >= 0; d--) {
      const dayMs = now - d * 86400000;
      const key = localDateKey(dayMs);
      dailyMap.set(key, {
        date: key,
        label: key.slice(5),
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        calls: 0,
      });
    }

    let total7dTokens = 0;
    let total7dInput = 0;
    let total7dCacheRead = 0;

    for (const [cid, info] of Object.entries(summaries)) {
      if (!info || typeof info !== 'object') continue;
      const gmList = generatorByCid && generatorByCid.get ? generatorByCid.get(cid) : null;
      const genStats = parseGeneratorCalls(gmList || [], enumToLabelMap);

      const modMs = parseTimestampMs(info.lastModifiedTime || info.last_modified_time) || 0;
      const createdMs = parseTimestampMs(info.createdTime || info.created_time) || modMs;
      const latestModel =
        (genStats.latestCall && genStats.latestCall.model) ||
        (genStats.modelsUsed[0] && genStats.modelsUsed[0].model) ||
        String(info.model || info.modelName || '');
      const windowLimit = resolveModelContextLimit(
        latestModel,
        genStats.latestCall && genStats.latestCall.modelEnum,
        customLimits
      );
      const latestContextTokens = genStats.latestCall ? genStats.latestCall.promptContextTokens : 0;
      const occupancyPct =
        windowLimit > 0 && latestContextTokens > 0
          ? Math.min(100, (latestContextTokens / windowLimit) * 100)
          : 0;

      const parentCascadeId = String(
        info.parentCascadeId || info.parent_cascade_id || info.parentTrajectoryId || ''
      );
      const isSubtrajectory = Boolean(parentCascadeId || info.isSubtrajectory || info.is_subtrajectory);

      // 归入 7 天图表
      for (const c of genStats.calls) {
        const ts = c.tsMs || modMs;
        if (!ts) continue;
        const dk = localDateKey(ts);
        if (dailyMap.has(dk)) {
          const b = dailyMap.get(dk);
          b.totalTokens += c.totalTokens;
          b.inputTokens += c.promptContextTokens;
          b.outputTokens += c.outputTokens;
          b.cacheReadTokens += c.cachedPart;
          b.calls += 1;
          total7dTokens += c.totalTokens;
          total7dInput += c.promptContextTokens;
          total7dCacheRead += c.cachedPart;
        }
      }

      const rawSummary = String(
        info.summary || info.title || info.name || ''
      ).trim();

      sessions.push({
        cascadeId: cid,
        summary: rawSummary || `Session ${cid.slice(0, 8)}`,
        status: String(info.status || '').replace(/^CASCADE_RUN_STATUS_/i, ''),
        stepCount: parseNum(info.stepCount ?? info.step_count),
        lastModifiedMs: modMs,
        createdMs,
        model: baseModelFamily(latestModel) || latestModel || '--',
        windowLimit,
        latestContextTokens,
        occupancyPct,
        totalTokens: genStats.totalTokens,
        inputTokens: genStats.totalInput,
        outputTokens: genStats.totalOutput,
        cacheHitRate: genStats.cacheHitRate,
        callCount: genStats.callCount,
        compactionCount: genStats.compactionCount,
        avgTps: genStats.avgTps,
        parentCascadeId,
        isSubtrajectory,
      });
    }

    sessions.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    const topSession =
      sessions.length > 0
        ? [...sessions].sort((a, b) => b.totalTokens - a.totalTokens)[0]
        : null;

    return {
      daily7d: Array.from(dailyMap.values()),
      total7dTokens,
      avg7dCacheRate: total7dInput > 0 ? (total7dCacheRead / total7dInput) * 100 : 0,
      activeSessionsCount: sessions.filter((s) => !s.isSubtrajectory).length,
      heaviestSession: topSession,
      sessions,
    };
  }

  function diagnoseContextHealth(activeAnalysis, prefs, isZh) {
    const findings = [];
    if (!activeAnalysis) return findings;

    const warnPct = (prefs && prefs.warnThresholdPct) || 75;
    const critPct = (prefs && prefs.criticalThresholdPct) || 90;
    const occ = activeAnalysis.occupancyPct || 0;
    const gen = activeAnalysis.genStats;
    const stepStats = activeAnalysis.stepStats;

    if (occ >= critPct) {
      findings.push({
        level: 'critical',
        title: isZh ? `上下文窗口已达危急水位 (${formatPct(occ)})` : `Context window critical (${formatPct(occ)})`,
        detail: isZh
          ? '模型极易遗忘早期约束且每次请求重复输入成本高，强烈建议立即生成交接 Prompt 开启新会话。'
          : 'High risk of truncation/forgetting and costly input re-reads. Generate a handoff prompt now.',
      });
    } else if (occ >= warnPct) {
      findings.push({
        level: 'warning',
        title: isZh ? `上下文接近预警阈值 (${formatPct(occ)})` : `Context nearing threshold (${formatPct(occ)})`,
        detail: isZh
          ? `当前已超过 ${warnPct}% 警戒线，建议完成当前子任务后通过「交接」页无痛切到新对话。`
          : `Exceeded ${warnPct}% threshold. Consider wrapping up and handing off to a fresh session.`,
      });
    }

    if (gen && gen.compactionCount > 0) {
      findings.push({
        level: 'info',
        title: isZh
          ? `检测到 ${gen.compactionCount} 次上下文压缩 / 剪枝事件`
          : `Detected ${gen.compactionCount} compaction/pruning event(s)`,
        detail: isZh
          ? '系统已发生过历史消息截断，请留意早期对话里的隐性要求是否仍被模型记住。'
          : 'Context volume dropped sharply between calls; verify early requirements are still retained.',
      });
    }

    if (stepStats && stepStats.totalStepTokens > 0) {
      const cmdShare = stepStats.categories.command.sharePct;
      const readShare = stepStats.categories.file_read.sharePct;
      if (cmdShare >= 38) {
        findings.push({
          level: 'warning',
          title: isZh
            ? `终端命令日志占比过高 (${formatPct(cmdShare)})`
            : `Command output dominates context (${formatPct(cmdShare)})`,
          detail: isZh
            ? '大段命令行输出是主要上下文大户，建议后续命令配合 head / tail / Select-Object 过滤输出。'
            : 'Large terminal logs consume heavy context. Pipe future commands through head/tail filters.',
        });
      }
      if (readShare >= 50) {
        findings.push({
          level: 'info',
          title: isZh
            ? `文件读取占比 ${formatPct(readShare)}`
            : `File reads account for ${formatPct(readShare)}`,
          detail: isZh
            ? '可在「大户排行」检查是否有整文件读取了大体积日志或锁文件。'
            : 'Inspect Heavy Hitters to check if large lockfiles or logs were read in full.',
        });
      }
      if (stepStats.repeatedReads && stepStats.repeatedReads.length > 0) {
        const topRep = stepStats.repeatedReads[0];
        findings.push({
          level: 'info',
          title: isZh
            ? `存在重复读取文件 (${stepStats.repeatedReads.length} 个)`
            : `Repeated file reads (${stepStats.repeatedReads.length} file(s))`,
          detail: isZh
            ? `例如 ${topRep.path} 被读取了 ${topRep.reads} 次，造成额外上下文冗余。`
            : `e.g. ${topRep.path} was read ${topRep.reads} times.`,
        });
      }
    }

    if (gen && gen.latestCall && gen.latestCall.promptContextTokens > 30000 && gen.cacheHitRate < 25) {
      findings.push({
        level: 'info',
        title: isZh
          ? `Prompt Cache 命中率偏低 (${formatPct(gen.cacheHitRate)})`
          : `Low prompt cache hit rate (${formatPct(gen.cacheHitRate)})`,
        detail: isZh
          ? '频繁切换模型或修改前置规则会导致缓存失效，保持同模型连续对话可显著提速降本。'
          : 'Switching models or mutating system prefixes invalidates prompt caching.',
      });
    }

    if (findings.length === 0) {
      findings.push({
        level: 'good',
        title: isZh ? '上下文健康度良好' : 'Context health looks great',
        detail: isZh
          ? '当前窗口水位可控，结构分布均衡，暂无需清理或跨会话交接。'
          : 'Context occupancy is healthy and balanced. No handoff needed yet.',
      });
    }

    return findings;
  }

  function generateHandoffPrompt(activeAnalysis, options, isZh) {
    if (!activeAnalysis) return '';
    const opts = { ...DEFAULT_PREFS.handoffOptions, ...(options || {}) };
    const stepStats = activeAnalysis.stepStats || analyzeTrajectorySteps([]);
    const gen = activeAnalysis.genStats;
    const summaryTitle = activeAnalysis.summary || activeAnalysis.cascadeId || '';

    const lines = [];
    if (isZh) {
      lines.push(`# 跨会话任务交接（源自：${summaryTitle}）`);
      lines.push('');
      lines.push(
        `> 上下文快照：模型 \`${activeAnalysis.model || '--'}\` · 窗口占用 \`${formatTokens(
          activeAnalysis.latestContextTokens
        )} / ${formatTokens(activeAnalysis.windowLimit)}\` (${formatPct(
          activeAnalysis.occupancyPct
        )}) · 共 ${stepStats.stepCount} 步`
      );

      if (opts.includeGoal && stepStats.userGoals.length > 0) {
        lines.push('');
        lines.push('## 1. 任务目标与最新诉求');
        lines.push(`- 初始目标：${stepStats.userGoals[0]}`);
        if (stepStats.userGoals.length > 1) {
          lines.push(`- 最新指令：${stepStats.userGoals[stepStats.userGoals.length - 1]}`);
        }
      }

      if (opts.includeFiles) {
        const edited = stepStats.fileActivities.filter((f) => f.edits > 0 || f.writes > 0);
        const readOnly = stepStats.fileActivities.filter((f) => f.edits === 0 && f.writes === 0);
        if (edited.length > 0 || readOnly.length > 0) {
          lines.push('');
          lines.push('## 2. 涉及文件清单');
          for (const f of edited.slice(0, 12)) {
            lines.push(`- [已修改/新增] \`${f.path}\` (改 ${f.edits} / 写 ${f.writes} / 读 ${f.reads})`);
          }
          for (const f of readOnly.slice(0, 6)) {
            lines.push(`- [仅查阅] \`${f.path}\` (读 ${f.reads})`);
          }
        }
      }

      if (opts.includeCommands && stepStats.commands.length > 0) {
        lines.push('');
        lines.push('## 3. 关键命令与异常');
        for (const cmd of stepStats.commands.slice(-5)) {
          lines.push(`- \`${cmd.command}\`${cmd.isError ? ' **(执行异常)**' : ''}`);
        }
      }

      if (opts.includeConclusions && stepStats.conclusions.length > 0) {
        lines.push('');
        lines.push('## 4. 已达成结论 / 当前进度');
        for (const c of stepStats.conclusions.slice(-3)) {
          lines.push(`- ${c}`);
        }
      }

      if (opts.includeDiagnostics && stepStats.recentErrors.length > 0) {
        lines.push('');
        lines.push('## 5. 待排查问题');
        for (const er of stepStats.recentErrors.slice(-3)) {
          lines.push(`- Step #${er.step} (${er.title}): ${er.preview.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }

      lines.push('');
      lines.push('请基于以上交接上下文继续推进后续工作（先简要确认当前状态后再动手修改）。');
    } else {
      lines.push(`# Session Handoff (From: ${summaryTitle})`);
      lines.push('');
      lines.push(
        `> Context Snapshot: \`${activeAnalysis.model || '--'}\` · Window \`${formatTokens(
          activeAnalysis.latestContextTokens
        )} / ${formatTokens(activeAnalysis.windowLimit)}\` (${formatPct(
          activeAnalysis.occupancyPct
        )}) · ${stepStats.stepCount} steps`
      );

      if (opts.includeGoal && stepStats.userGoals.length > 0) {
        lines.push('');
        lines.push('## 1. Goals & Latest Request');
        lines.push(`- Initial goal: ${stepStats.userGoals[0]}`);
        if (stepStats.userGoals.length > 1) {
          lines.push(`- Latest request: ${stepStats.userGoals[stepStats.userGoals.length - 1]}`);
        }
      }

      if (opts.includeFiles) {
        const edited = stepStats.fileActivities.filter((f) => f.edits > 0 || f.writes > 0);
        const readOnly = stepStats.fileActivities.filter((f) => f.edits === 0 && f.writes === 0);
        if (edited.length > 0 || readOnly.length > 0) {
          lines.push('');
          lines.push('## 2. Touched Files');
          for (const f of edited.slice(0, 12)) {
            lines.push(`- [Modified] \`${f.path}\` (E:${f.edits} W:${f.writes} R:${f.reads})`);
          }
          for (const f of readOnly.slice(0, 6)) {
            lines.push(`- [Read] \`${f.path}\` (R:${f.reads})`);
          }
        }
      }

      if (opts.includeCommands && stepStats.commands.length > 0) {
        lines.push('');
        lines.push('## 3. Recent Commands');
        for (const cmd of stepStats.commands.slice(-5)) {
          lines.push(`- \`${cmd.command}\`${cmd.isError ? ' **(ERROR)**' : ''}`);
        }
      }

      if (opts.includeConclusions && stepStats.conclusions.length > 0) {
        lines.push('');
        lines.push('## 4. Key Findings / Progress');
        for (const c of stepStats.conclusions.slice(-3)) {
          lines.push(`- ${c}`);
        }
      }

      if (opts.includeDiagnostics && stepStats.recentErrors.length > 0) {
        lines.push('');
        lines.push('## 5. Open Errors');
        for (const er of stepStats.recentErrors.slice(-3)) {
          lines.push(`- Step #${er.step} (${er.title}): ${er.preview.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }

      lines.push('');
      lines.push('Please continue from this handoff context (briefly confirm status before editing).');
    }

    void gen;
    return lines.join('\n');
  }

  // ==================== 状态管理与 RPC 采集 ====================

  const state = {
    prefs: loadPrefs(),
    loading: false,
    error: null,
    waitingAuth: false,
    lastUpdatedAt: 0,
    capturedHeaders: {},
    capturedLsBaseUrl: '',
    activeCascadeId: '',
    inspectedCascadeId: '', // 为空时跟随 activeCascadeId
    rpcDiag: {
      traj: '',
      gen: '',
      steps: '',
      lastErr: '',
    },
    settingsOpen: false,
    hitterFilter: 'all',
    hitterQuery: '',
    hitterSort: 'size', // size | desc | asc
    expandedSteps: new Set(),
    insightsQuery: '',
    insightsSort: 'recent', // recent | tokens | steps
    handoffDraft: '',
    handoffDirty: false,
    tabOpen: false,
    openedInNativePane: false,
    lastAuxRect: null,
    toastMsg: '',
    toastTimer: null,
    rawSources: {
      userStatus: null,
      cascadeConfigs: null,
      availableModels: null,
      trajectories: null,
    },
    generatorCache: new Map(), // cid -> { stamp, list }
    stepsCache: new Map(), // cid -> { stamp, steps }
    computed: {
      activeAnalysis: null,
      diagnostics: [],
      insights: null,
      fleetChildren: [],
    },
    isDark: true,
    isZh: true,
  };

  function detectThemeAndLang() {
    let isDark = true;
    const hostTokens = {};
    try {
      const rootEl = document.documentElement || document.body;
      const rootCs = window.getComputedStyle(rootEl);
      const bodyCs = window.getComputedStyle(document.body || rootEl);
      const bg =
        (bodyCs && bodyCs.backgroundColor && bodyCs.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? bodyCs.backgroundColor
          : rootCs && rootCs.backgroundColor) || '';
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (m) {
        const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
        isDark = lum < 140;
      }
      if (rootCs && typeof rootCs.getPropertyValue === 'function') {
        const keys = [
          '--background',
          '--card',
          '--secondary',
          '--muted',
          '--foreground',
          '--muted-foreground',
          '--border',
          '--card-border',
          '--primary',
          '--primary-foreground',
          '--font-family',
          '--editor-font-family',
          '--vscode-sideBar-background',
          '--vscode-editor-background',
          '--vscode-foreground',
        ];
        for (const k of keys) {
          const v = rootCs.getPropertyValue(k);
          if (v && v.trim()) hostTokens[k] = v.trim();
        }
      }
    } catch (_) {}

    let isZh = true;
    if (state.prefs.langMode === 'zh') isZh = true;
    else if (state.prefs.langMode === 'en') isZh = false;
    else {
      isZh = Boolean(window.__AGY_I18N_ACTIVE__);
      try {
        if (!isZh && document.documentElement && /^zh/i.test(document.documentElement.lang || '')) {
          isZh = true;
        }
      } catch (_) {}
    }
    state.isDark = isDark;
    state.isZh = isZh;
    state.hostTokens = hostTokens;
  }

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

  function hasAuthTokenCaptured() {
    return Boolean(
      state.capturedHeaders['x-codeium-ui-token'] ||
        state.capturedHeaders['x-codeium-csrf-token'] ||
        state.capturedHeaders['authorization']
    );
  }

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

  function syncFromSiblingPlugins() {
    try {
      const ud = window.__AGY_USAGE_DASHBOARD_TEST_HOOK__;
      const udState = ud && ud.state;
      if (!udState || typeof udState !== 'object') return;
      if (udState.capturedHeaders) {
        mergeCapturedHeaders(udState.capturedHeaders);
      }
      if (udState.activeCascadeId && !state.activeCascadeId) {
        state.activeCascadeId = String(udState.activeCascadeId);
      }
      const rs = udState.rawSources;
      if (rs && typeof rs === 'object') {
        if (rs.userStatus && !state.rawSources.userStatus) {
          state.rawSources.userStatus = rs.userStatus;
        }
        if (rs.cascadeConfigs && !state.rawSources.cascadeConfigs) {
          state.rawSources.cascadeConfigs = rs.cascadeConfigs;
        }
        if (rs.availableModels && !state.rawSources.availableModels) {
          state.rawSources.availableModels = rs.availableModels;
        }
        if (rs.trajectories && !state.rawSources.trajectories) {
          state.rawSources.trajectories = rs.trajectories;
        }
        const activeCid = state.activeCascadeId || pickActiveCascadeId();
        if (
          activeCid &&
          rs.activeGeneratorMetadata &&
          !state.generatorCache.has(activeCid)
        ) {
          const list =
            rs.activeGeneratorMetadata.generatorMetadata ||
            rs.activeGeneratorMetadata.generator_metadata ||
            (Array.isArray(rs.activeGeneratorMetadata) ? rs.activeGeneratorMetadata : []);
          if (Array.isArray(list) && list.length > 0) {
            state.generatorCache.set(activeCid, { stamp: 'sibling', list });
          }
        }
      }
    } catch (_) {}
  }

  async function callLsRpc(method, payload) {
    syncFromSiblingPlugins();
    if (window.__AGY_CAPTURED_LS_HEADERS__) {
      mergeCapturedHeaders(window.__AGY_CAPTURED_LS_HEADERS__);
    }
    const headers = buildRpcHeaders(state.capturedHeaders);
    const url = (state.capturedLsBaseUrl || '') + LS_SERVICE_PREFIX + method;
    const resp = await window.fetch(url, {
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
      throw err;
    }
    return resp.json();
  }

  function pickActiveCascadeId() {
    const tapCid = window.__AGY_CAPTURED_CASCADE_ID__ ? String(window.__AGY_CAPTURED_CASCADE_ID__) : '';
    if (tapCid) {
      state.activeCascadeId = tapCid;
      return tapCid;
    }
    try {
      const urlPart = `${window.location.pathname || ''}${window.location.search || ''}`;
      const m = urlPart.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) {
        state.activeCascadeId = m[0];
        return m[0];
      }
    } catch (_) {}
    if (state.activeCascadeId) return state.activeCascadeId;
    const summaries = state.rawSources.trajectories && state.rawSources.trajectories.trajectorySummaries;
    if (summaries && typeof summaries === 'object') {
      let bestId = '';
      let bestScore = -1;
      for (const [cid, info] of Object.entries(summaries)) {
        if (!info || typeof info !== 'object') continue;
        if (info.parentCascadeId || info.isSubtrajectory) continue;
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

  async function fetchGeneratorCached(cid, stamp, forceRefresh) {
    if (!cid) return [];
    const cached = state.generatorCache.get(cid);
    if (!forceRefresh && cached && cached.list.length > 0 && stamp && cached.stamp === stamp) {
      return cached.list;
    }
    const resp = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId: cid,
      generatorMetadataOffset: 0,
      includeMessages: false,
    });
    const list = (resp && (resp.generatorMetadata || resp.generator_metadata)) || [];
    if (Array.isArray(list) && list.length > 0) {
      state.generatorCache.set(cid, { stamp: stamp || String(Date.now()), list });
    }
    return list;
  }

  async function fetchTrajectoryStepsCached(cid, stamp, forceRefresh) {
    if (!cid) return [];
    const cached = state.stepsCache.get(cid);
    if (!forceRefresh && cached && stamp && cached.stamp === stamp && cached.steps.length > 0) {
      return cached.steps;
    }
    let steps = [];
    let lastErr = '';
    try {
      const resp = await callLsRpc('GetCascadeTrajectory', { cascadeId: cid });
      steps = extractStepsFromTrajectoryResponse(resp);
    } catch (e) {
      lastErr = e && e.message ? e.message : 'GetCascadeTrajectory err';
    }
    if (steps.length === 0) {
      try {
        const resp2 = await callLsRpc('GetCascadeTrajectorySteps', {
          cascadeId: cid,
        });
        steps = extractStepsFromTrajectoryResponse(resp2);
      } catch (e2) {
        if (!lastErr) lastErr = e2 && e2.message ? e2.message : 'GetCascadeTrajectorySteps err';
      }
    }
    if (steps.length === 0) {
      try {
        const resp3 = await callLsRpc('GetCascadeTrajectorySteps', {
          cascadeId: cid,
          stepOffset: 0,
        });
        steps = extractStepsFromTrajectoryResponse(resp3);
      } catch (_) {}
    }
    if (steps.length > 0) {
      state.stepsCache.set(cid, { stamp: stamp || String(Date.now()), steps });
      state.rpcDiag.steps = `OK(${steps.length})`;
    } else {
      state.rpcDiag.steps = lastErr || 'empty(0)';
    }
    return steps;
  }

  function recomputeState() {
    detectThemeAndLang();
    const enumToLabelMap = buildEnumToLabelMap(state.rawSources);
    const summaries =
      (state.rawSources.trajectories &&
        (state.rawSources.trajectories.trajectorySummaries ||
          state.rawSources.trajectories.trajectory_summaries)) ||
      {};

    const activeCid = state.activeCascadeId || pickActiveCascadeId();
    const targetCid = state.inspectedCascadeId || activeCid;

    const genByCid = new Map();
    for (const [k, v] of state.generatorCache.entries()) {
      genByCid.set(k, v.list);
    }

    let activeAnalysis = null;
    if (targetCid) {
      const info = summaries[targetCid] || {};
      const genEntry = state.generatorCache.get(targetCid);
      const stepEntry = state.stepsCache.get(targetCid);
      const genStats = parseGeneratorCalls(genEntry ? genEntry.list : [], enumToLabelMap);
      const stepStats = analyzeTrajectorySteps(stepEntry ? stepEntry.steps : []);

      const model =
        (genStats.latestCall && genStats.latestCall.model) ||
        (genStats.modelsUsed[0] && genStats.modelsUsed[0].model) ||
        String(info.model || info.modelName || '--');
      const modelEnum = genStats.latestCall ? genStats.latestCall.modelEnum : '';
      const windowLimit = resolveModelContextLimit(
        model,
        modelEnum,
        state.prefs.customModelLimits
      );
      const latestContextTokens = genStats.latestCall ? genStats.latestCall.promptContextTokens : 0;
      const occupancyPct =
        windowLimit > 0 && latestContextTokens > 0
          ? Math.min(100, (latestContextTokens / windowLimit) * 100)
          : 0;

      activeAnalysis = {
        cascadeId: targetCid,
        isPinnedOther: Boolean(state.inspectedCascadeId && state.inspectedCascadeId !== activeCid),
        summary: String(info.summary || info.title || `Session ${targetCid.slice(0, 8)}`),
        status: String(info.status || '').replace(/^CASCADE_RUN_STATUS_/i, ''),
        model: baseModelFamily(model) || model,
        rawModelName: model,
        modelEnum,
        windowLimit,
        latestContextTokens,
        occupancyPct,
        genStats,
        stepStats,
      };
    }

    const insights = buildContextInsights(
      summaries,
      genByCid,
      enumToLabelMap,
      state.prefs.customModelLimits,
      Date.now()
    );

    const fleetChildren = insights.sessions.filter(
      (s) =>
        targetCid &&
        (s.parentCascadeId === targetCid ||
          (activeAnalysis &&
            activeAnalysis.stepStats.subagentCalls.some((sc) => sc.conversationId === s.cascadeId)))
    );

    const diagnostics = diagnoseContextHealth(activeAnalysis, state.prefs, state.isZh);

    state.computed = {
      activeAnalysis,
      diagnostics,
      insights,
      fleetChildren,
    };

    if (!state.handoffDirty && activeAnalysis) {
      state.handoffDraft = generateHandoffPrompt(
        activeAnalysis,
        state.prefs.handoffOptions,
        state.isZh
      );
    }
  }

  let activeRefreshInFlight = false;
  let pendingTargetRefresh = false;
  async function refreshTargetSession(forceRefresh) {
    if (activeRefreshInFlight) {
      pendingTargetRefresh = true;
      return;
    }
    activeRefreshInFlight = true;
    pendingTargetRefresh = false;
    state.loading = true;
    try {
      syncFromSiblingPlugins();
      let trajErr = '';
      let trajOk = false;
      const payloads = [
        { excludeSubtrajectories: false },
        { excludeSubtrajectories: true },
        {},
      ];
      for (const pl of payloads) {
        try {
          const traj = await callLsRpc('GetAllCascadeTrajectories', pl);
          if (traj && (traj.trajectorySummaries || traj.trajectory_summaries)) {
            state.rawSources.trajectories = traj;
            trajOk = true;
            state.rpcDiag.traj = `OK(${Object.keys(traj.trajectorySummaries || traj.trajectory_summaries || {}).length})`;
            break;
          }
        } catch (err) {
          trajErr = err && err.message ? err.message : 'RPC Error';
        }
      }
      if (!trajOk && trajErr) {
        state.rpcDiag.traj = trajErr;
        state.rpcDiag.lastErr = trajErr;
      }

      if (!state.rawSources.userStatus) {
        try {
          const us = await callLsRpc('GetUserStatus', {});
          if (us) state.rawSources.userStatus = us;
        } catch (_) {}
      }

      const activeCid = pickActiveCascadeId();
      const targetCid = state.inspectedCascadeId || activeCid;
      const summaries =
        (state.rawSources.trajectories &&
          (state.rawSources.trajectories.trajectorySummaries ||
            state.rawSources.trajectories.trajectory_summaries)) ||
        {};

      if (targetCid) {
        const info = summaries[targetCid];
        const stamp = info
          ? `${info.stepCount ?? info.step_count ?? 0}:${info.lastModifiedTime || ''}`
          : '';
        const [genRes, stepRes] = await Promise.allSettled([
          fetchGeneratorCached(targetCid, stamp, forceRefresh),
          fetchTrajectoryStepsCached(targetCid, stamp, forceRefresh),
        ]);
        if (genRes.status === 'fulfilled') {
          const cnt = Array.isArray(genRes.value) ? genRes.value.length : 0;
          state.rpcDiag.gen = `OK(${cnt})`;
        } else {
          const gErr = (genRes.reason && genRes.reason.message) || 'gen err';
          state.rpcDiag.gen = gErr;
          state.rpcDiag.lastErr = gErr;
        }
        if (stepRes.status === 'rejected') {
          state.rpcDiag.steps = (stepRes.reason && stepRes.reason.message) || 'steps err';
        }
      }

      if (trajOk || state.generatorCache.size > 0 || state.stepsCache.size > 0) {
        state.lastUpdatedAt = Date.now();
        state.error = null;
        state.waitingAuth = false;
      } else if (trajErr && !hasAuthTokenCaptured() && /401|403|csrf|token/i.test(trajErr)) {
        state.waitingAuth = true;
        state.error = null;
      } else if (trajErr) {
        state.error = trajErr;
      }
    } finally {
      state.loading = false;
      activeRefreshInFlight = false;
      recomputeState();
      renderAll({ fromPoll: !forceRefresh });
      if (pendingTargetRefresh) {
        pendingTargetRefresh = false;
        refreshTargetSession(true);
      }
    }
  }

  let globalRefreshInFlight = false;
  async function refreshGlobalInsights() {
    if (globalRefreshInFlight) return;
    globalRefreshInFlight = true;
    try {
      syncFromSiblingPlugins();
      if (!state.rawSources.userStatus) {
        try {
          state.rawSources.userStatus = await callLsRpc('GetUserStatus', {});
        } catch (_) {}
      }
      if (!state.rawSources.cascadeConfigs) {
        try {
          state.rawSources.cascadeConfigs = await callLsRpc('GetCascadeModelConfigData', {});
        } catch (_) {}
      }
      const summaries =
        (state.rawSources.trajectories &&
          (state.rawSources.trajectories.trajectorySummaries ||
            state.rawSources.trajectories.trajectory_summaries)) ||
        {};
      const sorted = Object.entries(summaries)
        .sort((a, b) => {
          const ta = parseTimestampMs(a[1] && a[1].lastModifiedTime) || 0;
          const tb = parseTimestampMs(b[1] && b[1].lastModifiedTime) || 0;
          return tb - ta;
        })
        .slice(0, MAX_GLOBAL_SESSIONS);

      for (let i = 0; i < sorted.length; i += 4) {
        const chunk = sorted.slice(i, i + 4);
        await Promise.allSettled(
          chunk.map(([cid, info]) => {
            const stamp = `${(info && (info.stepCount ?? info.step_count)) || 0}:${
              (info && info.lastModifiedTime) || ''
            }`;
            return fetchGeneratorCached(cid, stamp, false);
          })
        );
      }
      recomputeState();
      renderAll();
    } finally {
      globalRefreshInFlight = false;
    }
  }

  function handleRpcPayload(method, data, explicitCid) {
    if (!data || typeof data !== 'object') return;
    let touched = false;
    if (method === 'GetUserStatus') {
      state.rawSources.userStatus = data;
      touched = true;
    } else if (method === 'GetCascadeModelConfigData' || method === 'GetCascadeModelConfigs') {
      state.rawSources.cascadeConfigs = data;
      touched = true;
    } else if (method === 'GetAvailableModels') {
      state.rawSources.availableModels = data;
      touched = true;
    } else if (method === 'GetAllCascadeTrajectories') {
      state.rawSources.trajectories = data;
      touched = true;
    } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      if (!explicitCid) return;
      const list = data.generatorMetadata || data.generator_metadata;
      if (Array.isArray(list) && list.length > 0) {
        state.generatorCache.set(explicitCid, { stamp: String(Date.now()), list });
        touched = true;
      }
    } else if (method === 'GetCascadeTrajectory' || method === 'GetCascadeTrajectorySteps') {
      if (!explicitCid) return;
      const steps = extractStepsFromTrajectoryResponse(data);
      if (steps.length > 0) {
        state.stepsCache.set(explicitCid, { stamp: String(Date.now()), steps });
        touched = true;
      }
    }
    if (touched) {
      state.waitingAuth = false;
      recomputeState();
      renderAll();
    }
  }

  function installBaseUrlAndStepFetchTap() {
    if (window.__AGY_CD_FETCH_TAPPED__ || typeof window.fetch !== 'function') return;
    window.__AGY_CD_FETCH_TAPPED__ = true;
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
      let reqCid = '';
      if (idx !== -1) {
        const prefixBase = url.slice(0, idx);
        if (/^https?:\/\//i.test(prefixBase)) {
          state.capturedLsBaseUrl = prefixBase;
        }
        method = url.slice(idx + LS_SERVICE_PREFIX.length).split('?')[0];
        try {
          const hdrSrc = (init && init.headers) || (input && typeof input === 'object' && input.headers);
          if (hdrSrc) {
            const obj = {};
            if (typeof hdrSrc.forEach === 'function') hdrSrc.forEach((v, k) => { obj[k] = v; });
            else if (Array.isArray(hdrSrc)) hdrSrc.forEach((p) => { if (p && p.length >= 2) obj[p[0]] = p[1]; });
            else if (typeof hdrSrc === 'object') Object.assign(obj, hdrSrc);
            mergeCapturedHeaders(obj);
          }
          const bodyStr = init && typeof init.body === 'string' ? init.body : '';
          if (bodyStr && bodyStr.trim().startsWith('{')) {
            const parsed = JSON.parse(bodyStr);
            reqCid = String((parsed && (parsed.cascadeId || parsed.trajectoryId || parsed.conversationId)) || '');
          }
        } catch (_) {}
      }
      const p = origFetch.apply(this, arguments);
      if (
        (method === 'GetCascadeTrajectory' ||
          method === 'GetCascadeTrajectorySteps' ||
          method === 'GetAllCascadeTrajectories') &&
        p &&
        typeof p.then === 'function'
      ) {
        p.then((resp) => {
          if (!resp || !resp.ok || typeof resp.clone !== 'function') return null;
          const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
          if (!ct.includes('json')) return null;
          return resp.clone().json().then((data) => handleRpcPayload(method, data, reqCid));
        }).catch(() => {});
      }
      return p;
    };
  }

  function bootstrapRpcTap() {
    installBaseUrlAndStepFetchTap();
    syncFromSiblingPlugins();
    if (window.__AGY_CAPTURED_LS_HEADERS__) {
      mergeCapturedHeaders(window.__AGY_CAPTURED_LS_HEADERS__);
    }
    if (window.__AGY_CAPTURED_CASCADE_ID__) {
      state.activeCascadeId = String(window.__AGY_CAPTURED_CASCADE_ID__);
    }
    if (window.__AGY_CAPTURED_LS_CACHE__) {
      const cache = window.__AGY_CAPTURED_LS_CACHE__;
      for (const m of Object.keys(cache)) {
        handleRpcPayload(m, cache[m]);
      }
    }

    // 链式包装回调，确保与 usage-dashboard / notifier 共存互不覆盖
    const prevOnHeaders = window.__AGY_ON_RPC_HEADERS__;
    window.__AGY_ON_RPC_HEADERS__ = function (hdrs) {
      if (typeof prevOnHeaders === 'function') {
        try {
          prevOnHeaders(hdrs);
        } catch (_) {}
      }
      const changed = mergeCapturedHeaders(hdrs);
      if (changed) {
        refreshTargetSession(true).then(() => refreshGlobalInsights());
      }
    };

    const prevOnCascade = window.__AGY_ON_CASCADE_CHANGE__;
    window.__AGY_ON_CASCADE_CHANGE__ = function (cid, method) {
      if (typeof prevOnCascade === 'function') {
        try {
          prevOnCascade(cid, method);
        } catch (_) {}
      }
      if (cid && cid !== state.activeCascadeId) {
        state.activeCascadeId = cid;
        if (!state.inspectedCascadeId) {
          state.handoffDirty = false;
        }
        refreshTargetSession(true);
      } else if (cid) {
        setTimeout(() => refreshTargetSession(true), 600);
      }
    };

    const prevOnRpcData = window.__AGY_ON_RPC_DATA__;
    window.__AGY_ON_RPC_DATA__ = function (method, data) {
      if (typeof prevOnRpcData === 'function') {
        try {
          prevOnRpcData(method, data);
        } catch (_) {}
      }
      if (method !== 'GetCascadeTrajectoryGeneratorMetadata') {
        handleRpcPayload(method, data);
      }
    };

    if (!hasAuthTokenCaptured()) {
      state.waitingAuth = true;
    }
  }

  // ==================== 输入框注入与剪贴板 ====================

  function findChatComposer() {
    if (!document || !document.querySelectorAll) return null;
    const candidates = document.querySelectorAll(
      'textarea, div[contenteditable="true"], [role="textbox"][contenteditable="true"]'
    );
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (!el || typeof el.getBoundingClientRect !== 'function') continue;
      if (el.disabled || el.readOnly) continue;
      if (el.closest && el.closest(`#${HOST_ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 20) continue;
      const score = r.top * 2 + r.width;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function insertTextIntoComposer(text) {
    const el = findChatComposer();
    if (!el || !text) return false;
    const tag = (el.tagName || '').toLowerCase();
    try {
      el.focus();
      if (tag === 'textarea' || tag === 'input') {
        const setter = Object.getOwnPropertyDescriptor(
          tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        )?.set;
        const cur = el.value || '';
        const nextVal = cur.trim() ? `${cur}\n\n${text}` : text;
        if (setter) setter.call(el, nextVal);
        else el.value = nextVal;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        let inserted = false;
        try {
          if (typeof ClipboardEvent === 'function' && typeof DataTransfer === 'function') {
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const ev = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: dt,
            });
            el.dispatchEvent(ev);
            if ((el.textContent || '').includes(text.slice(0, 24))) {
              inserted = true;
            }
          }
        } catch (_) {}
        if (!inserted) {
          try {
            inserted = document.execCommand('insertText', false, text);
          } catch (_) {}
        }
        if (!inserted) {
          el.textContent = (el.textContent ? `${el.textContent}\n\n` : '') + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ==================== 原生右侧边栏 & 插件菜单集成 ====================

  function isOutsidePluginHosts(el) {
    if (!el || !el.closest) return true;
    return !el.closest(`#${HOST_ID}, #agy-usage-dashboard-host, #agy-snippets-host, #agy-notifier-host`);
  }

  function hasLeftSidebarAnchor(container) {
    if (!container || !container.querySelectorAll) return false;
    const btns = container.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!b || typeof b.getBoundingClientRect !== 'function') continue;
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')) || '';
      if (/^(Settings|设置)$/i.test(txt || aria.trim())) {
        const r = b.getBoundingClientRect();
        if (r.left >= 0 && r.left < 240 && r.bottom > (window.innerHeight || 800) - 140) {
          return true;
        }
      }
    }
    return false;
  }

  function locateNativeAuxTabStrip() {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return { found: false };
    }
    const innerW = window.innerWidth || 1280;
    const btns = document.querySelectorAll('button, [role="tab"], [role="button"]');
    let plusBtn = null;
    let tabAnchor = null;

    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isOutsidePluginHosts(b) || typeof b.getBoundingClientRect !== 'function') continue;
      if (b.getAttribute && b.getAttribute('data-agy-cd-tab') === '1') continue;
      const r = b.getBoundingClientRect();
      if (r.top < 0 || r.top > 48 || r.height < 16 || r.height > 44 || r.left < 28 || r.right > innerW - 60) {
        continue;
      }
      const txt = (b.textContent || '').trim();
      const aria = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
      const role = (b.getAttribute('role') || '').trim();

      if (
        txt === '+' ||
        /new\s*tab|add\s*tab|新建标签|添加标签|打开新标签/i.test(aria)
      ) {
        if (!plusBtn || r.left < plusBtn.getBoundingClientRect().left) {
          plusBtn = b;
        }
      } else if (
        role === 'tab' ||
        /^(审查确认|Review Changes?|Open File|终端|Terminal|浏览器|Browser|Swarm|Side Question|New Tab|新建标签页)$/i.test(
          txt
        )
      ) {
        if (!tabAnchor) tabAnchor = b;
      }
    }

    // 兜底：若 + 按钮仅含 SVG（无文字/aria），寻找紧邻 tabAnchor 右侧的紧凑按钮
    if (!plusBtn && tabAnchor && tabAnchor.parentElement) {
      const tr = tabAnchor.getBoundingClientRect();
      const pBtns = tabAnchor.parentElement.querySelectorAll('button, [role="button"]');
      for (let i = 0; i < pBtns.length; i++) {
        const pb = pBtns[i];
        if (pb === tabAnchor || (pb.getAttribute && pb.getAttribute('data-agy-cd-tab') === '1')) continue;
        const pr = pb.getBoundingClientRect();
        if (
          pr.left >= tr.right - 2 &&
          pr.right <= innerW - 60 &&
          pr.width >= 16 &&
          pr.width <= 38 &&
          Math.abs(pr.top - tr.top) <= 10
        ) {
          plusBtn = pb;
          break;
        }
      }
    }

    const refEl = plusBtn || tabAnchor;
    if (!refEl || !refEl.parentElement) {
      return { found: false };
    }
    let stripEl = refEl.parentElement;
    // 若 refEl 被单个 tooltip 容器包了一层，再往上找包含其他标签或 + 的行容器
    if (
      stripEl.children &&
      stripEl.children.length === 1 &&
      stripEl.parentElement &&
      stripEl.parentElement !== document.body
    ) {
      stripEl = stripEl.parentElement;
    }
    const rect = stripEl.getBoundingClientRect();
    return {
      found: true,
      stripEl,
      plusBtn,
      tabAnchor,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  function locateNativeAuxPane() {
    if (typeof document === 'undefined' || !document.querySelectorAll) {
      return { found: false };
    }
    const innerW = window.innerWidth || 1280;
    const innerH = window.innerHeight || 800;
    const composer = findChatComposer();
    const strip = locateNativeAuxTabStrip();

    // 1. 寻找右侧边栏内部特征元素（启动器、URL 搜索框、xterm、iframe、Diff/Code 编辑器、顶部标签栏）
    let anchor = null;
    const inputs = document.querySelectorAll('input[placeholder]');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (!isOutsidePluginHosts(inp)) continue;
      const ph = (inp.getAttribute('placeholder') || '').trim();
      if (/Search or enter a URL|搜索或输入网址|Enter URL/i.test(ph)) {
        const r = inp.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 20 && r.right > innerW * 0.4) {
          anchor = inp;
          break;
        }
      }
    }

    if (!anchor) {
      const candidates = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (!isOutsidePluginHosts(el) || typeof el.getBoundingClientRect !== 'function') continue;
        const txt = (el.textContent || '').trim();
        if (/^(Side Question|Open File|审查确认|Review Changes?|终端|Terminal|浏览器|Browser)$/i.test(txt)) {
          const r = el.getBoundingClientRect();
          if (r.width >= 80 && r.height >= 20 && r.right > innerW * 0.35 && r.top > 36 && r.top < innerH - 60) {
            anchor = el;
            break;
          }
        }
      }
    }

    if (!anchor) {
      const frames = document.querySelectorAll('iframe, webview, .xterm, .monaco-diff-editor, .monaco-editor');
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!isOutsidePluginHosts(f) || typeof f.getBoundingClientRect !== 'function') continue;
        if (composer && (f === composer || (f.contains && f.contains(composer)))) continue;
        const r = f.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 200 && r.right >= innerW - 40 && r.left >= 20) {
          anchor = f;
          break;
        }
      }
    }

    if (!anchor && strip.found) {
      anchor = strip.stripEl;
    }

    if (anchor) {
      let cur = anchor.parentElement || anchor;
      let best = null;
      for (let depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 14; depth++) {
        if (typeof cur.getBoundingClientRect === 'function') {
          const r = cur.getBoundingClientRect();
          const containsComposer = composer && cur.contains && cur.contains(composer);
          const containsLeftSettings = hasLeftSidebarAnchor(cur);
          if (containsComposer || containsLeftSettings) {
            break;
          }
          if (
            r.width >= 240 &&
            r.height >= innerH * 0.55 &&
            r.top >= 0 &&
            r.top <= 100 &&
            r.right >= innerW - 36
          ) {
            best = cur;
          }
        }
        cur = cur.parentElement;
      }
      if (best) {
        const r = best.getBoundingClientRect();
        let radius = 10;
        try {
          const br = parseFloat(window.getComputedStyle(best).borderRadius);
          if (Number.isFinite(br) && br >= 0 && br <= 20) radius = br;
        } catch (_) {}
        const stripBottom = strip.found ? strip.rect.bottom : 0;
        const contentTop = strip.found
          ? Math.max(Math.round(r.top), Math.round(stripBottom + 2))
          : Math.max(Math.round(r.top), 38);
        return {
          found: true,
          hasNativeTabStrip: strip.found,
          left: Math.round(r.left),
          top: contentTop,
          width: Math.round(r.width),
          height: Math.max(200, Math.round(r.bottom - contentTop)),
          radius,
          bgColor: (() => {
            try {
              const bg = window.getComputedStyle(best).backgroundColor;
              return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '';
            } catch (_) {
              return '';
            }
          })(),
        };
      }
    }

    return { found: false, hasNativeTabStrip: false };
  }

  function findRightPaneToggleButton() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return null;
    const innerW = window.innerWidth || 1280;
    const btns = document.querySelectorAll('button, [role="button"]');
    let best = null;
    let bestRight = -1;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (!isOutsidePluginHosts(b) || typeof b.getBoundingClientRect !== 'function') continue;
      const r = b.getBoundingClientRect();
      if (r.top >= 0 && r.top <= 42 && r.right >= innerW - 70 && r.width >= 18 && r.width <= 44 && r.height <= 40) {
        const lbl = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        if (/side|pane|panel|aux|侧边|面板|right/i.test(lbl)) {
          return b;
        }
        if (r.right > bestRight) {
          bestRight = r.right;
          best = b;
        }
      }
    }
    return best;
  }

  function dismissOpenMenus() {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch (_) {}
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch (_) {}
  }

  function openContextDoctorInPane(tryOpenNativePane) {
    const aux = locateNativeAuxPane();
    if (!aux.found && tryOpenNativePane) {
      const toggleBtn = findRightPaneToggleButton();
      if (toggleBtn && typeof toggleBtn.click === 'function') {
        try {
          toggleBtn.click();
        } catch (_) {}
        setTimeout(() => {
          const nextAux = locateNativeAuxPane();
          state.openedInNativePane = nextAux.found;
          state.lastAuxRect = nextAux.found ? nextAux : null;
          state.tabOpen = true;
          state.prefs.open = true;
          savePrefs(state.prefs);
          renderAll();
          refreshTargetSession(true);
          refreshGlobalInsights();
        }, 90);
        return;
      }
    }
    state.openedInNativePane = aux.found;
    state.lastAuxRect = aux.found ? aux : null;
    state.tabOpen = true;
    state.prefs.open = true;
    savePrefs(state.prefs);
    renderAll();
    refreshTargetSession(true);
    refreshGlobalInsights();
  }

  function switchAwayFromContextDoctor() {
    if (!state.prefs.open) return;
    state.prefs.open = false;
    savePrefs(state.prefs);
    renderAll();
  }

  function closeContextDoctor() {
    state.tabOpen = false;
    state.prefs.open = false;
    state.openedInNativePane = false;
    savePrefs(state.prefs);
    renderAll();
  }

  function ensureMenuInjectStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('agy-cd-menu-style')) return;
    const st = document.createElement('style');
    st.id = 'agy-cd-menu-style';
    st.textContent = `
      .agy-cd-menu-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 13px;
        line-height: 1.35;
        text-align: left;
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .agy-cd-menu-btn:hover {
        background: rgba(127, 127, 127, 0.16);
      }
      .agy-cd-menu-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .agy-cd-menu-badge {
        font-size: 11px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(127, 127, 127, 0.16);
        color: inherit;
        opacity: 0.78;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
      }
      .agy-cd-aux-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 7px 0 10px;
        margin: 0 2px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: transparent;
        color: inherit;
        opacity: 0.68;
        font-family: inherit;
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        user-select: none;
        transition: background 0.12s ease, opacity 0.12s ease, border-color 0.12s ease;
      }
      .agy-cd-aux-tab:hover {
        opacity: 0.95;
        background: rgba(127, 127, 127, 0.12);
      }
      .agy-cd-aux-tab[data-active="true"] {
        opacity: 1;
        background: rgba(127, 127, 127, 0.18);
        border-color: rgba(127, 127, 127, 0.22);
      }
      .agy-cd-aux-tab-pct {
        font-size: 11px;
        opacity: 0.72;
        font-variant-numeric: tabular-nums;
      }
      .agy-cd-aux-tab-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1;
        opacity: 0.6;
        transition: background 0.12s ease, opacity 0.12s ease;
      }
      .agy-cd-aux-tab-close:hover {
        opacity: 1;
        background: rgba(127, 127, 127, 0.24);
      }
      *:has(> [data-agy-cd-tab="1"][data-active="true"]) > button:not([data-agy-cd-tab="1"]),
      *:has(> [data-agy-cd-tab="1"][data-active="true"]) > [role="tab"]:not([data-agy-cd-tab="1"]) {
        opacity: 0.58 !important;
        background: transparent !important;
        border-color: transparent !important;
      }
    `;
    document.head.appendChild(st);
  }

  function applyMenuBadgeState(badge, analysis) {
    if (!badge) return;
    const pctText = analysis && analysis.latestContextTokens > 0 ? `${Math.round(analysis.occupancyPct)}%` : '--';
    badge.textContent = pctText;
    if (analysis && analysis.occupancyPct >= state.prefs.criticalThresholdPct) {
      badge.style.background = 'rgba(239,68,68,0.18)';
      badge.style.color = '#f87171';
    } else if (analysis && analysis.occupancyPct >= state.prefs.warnThresholdPct) {
      badge.style.background = 'rgba(245,158,11,0.18)';
      badge.style.color = '#fbbf24';
    } else {
      badge.style.background = '';
      badge.style.color = '';
    }
  }

  function createMenuItemElement(siblingBtn) {
    ensureMenuInjectStyles();
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-agy-cd-menu-item', '1');
    btn.setAttribute('role', 'menuitem');
    if (siblingBtn && siblingBtn.className && typeof siblingBtn.className === 'string') {
      btn.className = `${siblingBtn.className} agy-cd-menu-btn`.trim();
      // 保留原生布局类同时确保左右对齐
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'space-between';
      btn.style.width = '100%';
    } else {
      btn.className = 'agy-cd-menu-btn';
    }

    const left = document.createElement('span');
    left.className = 'agy-cd-menu-left';

    const icon = buildGaugeIconSvg(15);

    const label = document.createElement('span');
    label.textContent = isZh ? '上下文洞察' : 'Context Doctor';

    left.appendChild(icon);
    left.appendChild(label);

    const badge = document.createElement('span');
    badge.className = 'agy-cd-menu-badge';
    applyMenuBadgeState(badge, a);

    btn.appendChild(left);
    btn.appendChild(badge);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissOpenMenus();
      openContextDoctorInPane(false);
    });

    return btn;
  }

  function syncPluginsMenuInjection() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return false;
    const innerH = window.innerHeight || 800;

    // 更新已注入菜单项上的百分比徽章与状态色
    const existingItems = document.querySelectorAll('[data-agy-cd-menu-item="1"]');
    const a = state.computed.activeAnalysis;
    for (let i = 0; i < existingItems.length; i++) {
      const b = existingItems[i].querySelector('.agy-cd-menu-badge');
      applyMenuBadgeState(b, a);
    }

    // 寻找右侧边栏「插件 >」打开后的浮动子菜单（仅扫描顶层 Portal/弹窗子树及标准 menu 节点，避免全树遍历）
    const candidateSet = new Set();
    if (document.body && document.body.children) {
      const topEls = document.body.children;
      for (let i = 0; i < topEls.length; i++) {
        const top = topEls[i];
        if (!isOutsidePluginHosts(top)) continue;
        candidateSet.add(top);
        const lvl1 = top.children || [];
        for (let j = 0; j < lvl1.length && j < 12; j++) {
          candidateSet.add(lvl1[j]);
          const lvl2 = lvl1[j].children || [];
          for (let k = 0; k < lvl2.length && k < 12; k++) {
            candidateSet.add(lvl2[k]);
          }
        }
      }
    }
    const roleMenus = document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal]');
    for (let i = 0; i < roleMenus.length; i++) {
      candidateSet.add(roleMenus[i]);
    }
    const containers = Array.from(candidateSet);
    let injected = false;
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      if (!isOutsidePluginHosts(c) || typeof c.getBoundingClientRect !== 'function') continue;
      if (c.querySelector && c.querySelector('[data-agy-cd-menu-item="1"]')) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 110 || r.width > 380 || r.height < 40 || r.height > 420 || r.top < 20 || r.bottom > innerH) {
        continue;
      }

      // 判断是否为紧凑的「插件」子菜单弹窗：包含 Swarm 项，或第一行标题恰好是「插件」/「Plugins」
      let swarmBtn = null;
      let hasPluginHeader = false;
      const children = c.children || [];
      for (let j = 0; j < children.length; j++) {
        const ch = children[j];
        const txt = (ch.textContent || '').trim();
        if (/^(插件|Plugins)$/i.test(txt)) {
          hasPluginHeader = true;
        }
        if (/^Swarm$/i.test(txt) && (ch.tagName === 'BUTTON' || ch.getAttribute('role') === 'menuitem' || ch.querySelector?.('img, svg'))) {
          swarmBtn = ch;
        }
      }

      if (!swarmBtn && c.querySelectorAll) {
        const btns = c.querySelectorAll('button, [role="menuitem"], [role="button"]');
        for (let k = 0; k < btns.length; k++) {
          const bt = (btns[k].textContent || '').trim();
          if (/^Swarm$/i.test(bt)) {
            swarmBtn = btns[k];
            break;
          }
        }
      }

      if (swarmBtn || (hasPluginHeader && children.length <= 8)) {
        const targetParent = swarmBtn ? swarmBtn.parentElement : c;
        if (!targetParent || (targetParent.querySelector && targetParent.querySelector('[data-agy-cd-menu-item="1"]'))) {
          continue;
        }
        const item = createMenuItemElement(swarmBtn);
        if (swarmBtn && swarmBtn.nextSibling) {
          targetParent.insertBefore(item, swarmBtn.nextSibling);
        } else {
          targetParent.appendChild(item);
        }
        injected = true;
      }
    }
    return injected;
  }

  function buildGaugeIconSvg(size) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('width', String(size || 14));
    icon.setAttribute('height', String(size || 14));
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.5');
    icon.style.flexShrink = '0';
    icon.style.opacity = '0.88';
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('d', 'M2.5 11.5a6.2 6.2 0 1 1 11 0');
    arc.setAttribute('stroke-linecap', 'round');
    const needle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    needle.setAttribute('d', 'M8 9.2L10.8 6.2');
    needle.setAttribute('stroke-linecap', 'round');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', '8');
    dot.setAttribute('cy', '9.5');
    dot.setAttribute('r', '1.1');
    dot.setAttribute('fill', 'currentColor');
    icon.appendChild(arc);
    icon.appendChild(needle);
    icon.appendChild(dot);
    return icon;
  }

  function removeAuxTabFromStrip() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const tabs = document.querySelectorAll('[data-agy-cd-tab="1"]');
    for (let i = 0; i < tabs.length; i++) {
      const node = tabs[i];
      if (node && node.parentNode && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(node);
      }
    }
  }

  function syncAuxTabInStrip() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return false;
    if (!state.tabOpen) {
      removeAuxTabFromStrip();
      return false;
    }

    ensureMenuInjectStyles();
    const strip = locateNativeAuxTabStrip();
    if (!strip.found || !strip.stripEl) {
      return false;
    }

    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    const pctText = a && a.latestContextTokens > 0 ? `${Math.round(a.occupancyPct)}%` : '';

    let tabEl = strip.stripEl.querySelector
      ? strip.stripEl.querySelector('[data-agy-cd-tab="1"]')
      : null;

    // 清理其它孤立残留标签
    const allTabs = document.querySelectorAll('[data-agy-cd-tab="1"]');
    for (let i = 0; i < allTabs.length; i++) {
      if (allTabs[i] !== tabEl && allTabs[i].parentNode && typeof allTabs[i].parentNode.removeChild === 'function') {
        allTabs[i].parentNode.removeChild(allTabs[i]);
      }
    }

    if (!tabEl) {
      tabEl = document.createElement('button');
      tabEl.type = 'button';
      tabEl.setAttribute('data-agy-cd-tab', '1');
      tabEl.setAttribute('role', 'tab');
      tabEl.className = 'agy-cd-aux-tab';

      const icon = buildGaugeIconSvg(14);
      const lbl = document.createElement('span');
      lbl.className = 'agy-cd-aux-tab-lbl';
      const pct = document.createElement('span');
      pct.className = 'agy-cd-aux-tab-pct';
      const closeX = document.createElement('span');
      closeX.className = 'agy-cd-aux-tab-close';
      closeX.textContent = '✕';
      closeX.title = isZh ? '关闭标签页' : 'Close tab';
      closeX.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeContextDoctor();
      });

      tabEl.appendChild(icon);
      tabEl.appendChild(lbl);
      tabEl.appendChild(pct);
      tabEl.appendChild(closeX);

      tabEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextDoctorInPane(false);
      });

      const insertRef = strip.plusBtn && strip.plusBtn.parentElement === strip.stripEl
        ? strip.plusBtn
        : null;
      if (insertRef) {
        strip.stripEl.insertBefore(tabEl, insertRef);
      } else {
        strip.stripEl.appendChild(tabEl);
      }
    }

    tabEl.setAttribute('data-active', state.prefs.open ? 'true' : 'false');
    tabEl.setAttribute('aria-selected', state.prefs.open ? 'true' : 'false');
    const lblNode = tabEl.querySelector ? tabEl.querySelector('.agy-cd-aux-tab-lbl') : null;
    if (lblNode) lblNode.textContent = isZh ? '上下文洞察' : 'Context Doctor';
    const pctNode = tabEl.querySelector ? tabEl.querySelector('.agy-cd-aux-tab-pct') : null;
    if (pctNode) {
      pctNode.textContent = pctText;
      pctNode.style.display = pctText ? '' : 'none';
    }
    return true;
  }

  let auxSyncScheduled = false;
  let auxSyncTimer = null;
  let auxSyncLastAt = 0;
  const AUX_SYNC_MIN_INTERVAL_MS = 120;

  function flushAuxSync() {
    auxSyncScheduled = false;
    auxSyncTimer = null;
    auxSyncLastAt = Date.now();
    syncPluginsMenuInjection();
    if (state.tabOpen) {
      syncAuxTabInStrip();
    }
    if (state.prefs.open) {
      const aux = locateNativeAuxPane();
      if (state.openedInNativePane && !aux.found) {
        // 用户关闭了原生右侧边栏，自动隐藏当前分页
        state.prefs.open = false;
        state.openedInNativePane = false;
        savePrefs(state.prefs);
        renderAll();
        return;
      }
      if (aux.found) {
        const prev = state.lastAuxRect;
        if (
          !prev ||
          prev.left !== aux.left ||
          prev.top !== aux.top ||
          prev.width !== aux.width ||
          prev.height !== aux.height ||
          prev.hasNativeTabStrip !== aux.hasNativeTabStrip
        ) {
          state.lastAuxRect = aux;
          applySidebarGeometry();
        }
      }
    }
  }

  function scheduleAuxSync() {
    if (auxSyncScheduled || auxSyncTimer) return;
    const elapsed = Date.now() - auxSyncLastAt;
    if (elapsed >= AUX_SYNC_MIN_INTERVAL_MS) {
      auxSyncScheduled = true;
      const raf =
        typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame : (fn) => setTimeout(fn, 16);
      raf(flushAuxSync);
    } else {
      auxSyncTimer = setTimeout(flushAuxSync, AUX_SYNC_MIN_INTERVAL_MS - elapsed);
    }
  }

  function installAuxPaneWatcher() {
    if (typeof MutationObserver === 'function' && document.body) {
      const obs = new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.target && !isOutsidePluginHosts(m.target)) continue;
          scheduleAuxSync();
          break;
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('resize', scheduleAuxSync);
    // 如果用户在打开洞察分页时点击了原生顶部标签栏中的其它分页/「+」或功能项，切换离开（但保留分页标签）
    document.addEventListener(
      'click',
      (e) => {
        if (!state.prefs.open || !e.target) return;
        const t = e.target;
        if (!isOutsidePluginHosts(t)) return;
        if (t.closest && t.closest('[data-agy-cd-tab="1"], [data-agy-cd-menu-item="1"]')) return;

        const strip = locateNativeAuxTabStrip();
        if (strip.found && strip.stripEl && strip.stripEl.contains && strip.stripEl.contains(t)) {
          const stripBtn = t.closest ? t.closest('button, [role="tab"], [role="button"], a') : null;
          if (stripBtn && strip.stripEl.contains(stripBtn)) {
            switchAwayFromContextDoctor();
          }
          return;
        }

        const btn = t.closest ? t.closest('button, [role="tab"], [role="menuitem"], [role="button"]') : null;
        if (!btn) return;
        const txt = (btn.textContent || '').trim();
        if (
          txt === '+' ||
          btn.getAttribute?.('role') === 'tab' ||
          /^(审查确认|Review Changes?|Open File|终端|Terminal|浏览器|Browser|Side Question|Swarm)$/i.test(txt)
        ) {
          switchAwayFromContextDoctor();
        }
      },
      true
    );
  }

  // ==================== DOM 构建与 Shadow DOM UI ====================

  let shadowRootRef = null;
  let refs = {};

  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'className') node.className = v;
        else if (k === 'textContent') node.textContent = v;
        else if (k === 'style' && typeof v === 'string') node.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    } else if (typeof children === 'string') {
      node.textContent = children;
    }
    return node;
  }

  function svgEl(tag, attrs, children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null) node.setAttribute(k, String(v));
      }
    }
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c) node.appendChild(c);
      }
    }
    return node;
  }

  function showToast(msg) {
    state.toastMsg = msg;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      state.toastMsg = '';
      renderToastOnly();
    }, 2400);
    renderToastOnly();
  }

  function renderToastOnly() {
    if (!refs.toast) return;
    if (state.toastMsg) {
      refs.toast.textContent = state.toastMsg;
      refs.toast.classList.add('show');
    } else {
      refs.toast.classList.remove('show');
    }
  }

  const STYLES = `
    :host {
      all: initial;
      font-family: var(--font-family, "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
    }
    * { box-sizing: border-box; }
    .root {
      --bg: var(--background, var(--vscode-sideBar-background, #141416));
      --bg-elev: var(--card, var(--bg));
      --bg-card: color-mix(in srgb, var(--fg) 4.5%, transparent);
      --bg-hover: color-mix(in srgb, var(--fg) 7.5%, transparent);
      --border: var(--border-token, color-mix(in srgb, var(--fg) 9%, transparent));
      --border-strong: color-mix(in srgb, var(--fg) 15%, transparent);
      --fg: var(--foreground, var(--vscode-foreground, #e8e8ec));
      --fg-muted: var(--muted-foreground, #8e8e98);
      --fg-dim: color-mix(in srgb, var(--fg-muted) 72%, transparent);
      --accent: var(--primary, #4d7cfe);
      --accent-fg: var(--primary-foreground, #ffffff);
      --accent-soft: color-mix(in srgb, var(--accent) 15%, transparent);
      --cyan: #56b6c2;
      --purple: #a78bfa;
      --green: #7aae66;
      --amber: #cab43e;
      --red: #d95c5c;
      --font: var(--font-family, "Google Sans Flex", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
      --mono: var(--editor-font-family, "Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
      --r-sm: 4px;
      --r-md: 6px;
      --r-lg: 8px;
      --pad-x: 16px;
      --col: 760px;
      --inline: max(var(--pad-x), calc((100% - var(--col)) / 2));
      --shadow: -8px 0 32px rgba(0, 0, 0, 0.45);
      color: var(--fg);
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .root.light {
      --bg: var(--background, #f7f7f8);
      --bg-elev: var(--card, #ffffff);
      --bg-card: color-mix(in srgb, var(--fg) 4%, transparent);
      --bg-hover: color-mix(in srgb, var(--fg) 7%, transparent);
      --border: var(--border-token, color-mix(in srgb, var(--fg) 9%, transparent));
      --border-strong: color-mix(in srgb, var(--fg) 15%, transparent);
      --fg: var(--foreground, #1d1f21);
      --fg-muted: var(--muted-foreground, #5d676f);
      --fg-dim: #9da5ab;
      --accent: var(--primary, #007acc);
      --accent-fg: var(--primary-foreground, #ffffff);
      --green: #63984f;
      --amber: #bca136;
      --red: #cb3d3d;
      --cyan: #0891b2;
      --purple: #7c3aed;
      --shadow: -6px 0 24px rgba(15, 23, 42, 0.12);
    }

    /* 右侧停靠标签（默认隐藏） */
    .edge-tab {
      position: fixed;
      right: 0;
      z-index: 2147482900;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 8px 6px;
      width: 32px;
      background: var(--bg-elev);
      color: var(--fg);
      border: 1px solid var(--border-strong);
      border-right: none;
      border-radius: 8px 0 0 8px;
      box-shadow: -3px 4px 16px rgba(0,0,0,0.28);
      cursor: pointer;
      user-select: none;
      transition: transform 0.15s ease, background 0.15s ease, width 0.15s ease;
    }
    .edge-tab:hover {
      width: 36px;
      background: var(--bg-card);
    }
    .edge-tab.hidden { display: none; }
    .edge-dot {
      width: 6px;
      height: 6px;
      border-radius: 99px;
      background: var(--green);
    }
    .edge-dot.warn { background: var(--amber); }
    .edge-dot.crit { background: var(--red); }
    .edge-lbl {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.4px;
      color: var(--fg-muted);
    }
    .edge-pct {
      font-size: 10px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .edge-bar-wrap {
      width: 4px;
      height: 28px;
      border-radius: 2px;
      background: var(--border);
      overflow: hidden;
      display: flex;
      align-items: flex-end;
    }
    .edge-bar-fill {
      width: 100%;
      background: var(--green);
      border-radius: 2px;
      transition: height 0.25s ease;
    }

    /* 停靠在原生右侧边栏内的主面板（遵循 Antigravity Aux Pane 标准结构） */
    .sidebar {
      position: fixed;
      top: 44px;
      right: 8px;
      bottom: 8px;
      z-index: 2147482950;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform 0.15s ease, opacity 0.14s ease;
    }
    .sidebar.docked-aux {
      box-shadow: none;
      border-color: transparent;
    }
    .sidebar.docked-aux .resize-handle {
      display: none;
    }
    .sidebar.closed {
      transform: translateY(4px);
      opacity: 0;
      pointer-events: none;
    }
    .resize-handle {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 5px;
      cursor: ew-resize;
      z-index: 10;
    }
    .resize-handle:hover {
      background: var(--accent);
      opacity: 0.45;
    }

    /* 顶部栏 + 下划线标签（贴合 Antigravity 原生 Aux Pane 设计规范） */
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px var(--inline) 4px;
      background: var(--bg);
      gap: 8px;
      flex-shrink: 0;
    }
    .hdr-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .hdr-title {
      font-weight: 600;
      font-size: 14px;
      line-height: 20px;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }
    .pill-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 9px;
      border-radius: var(--r-md);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--fg);
      font-family: var(--font);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .pill-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .pill-btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
      font-weight: 500;
    }
    .pill-btn.primary:hover { filter: brightness(1.08); }
    .icon-btn {
      width: 26px;
      height: 26px;
      border-radius: var(--r-md);
      border: 1px solid transparent;
      background: transparent;
      color: var(--fg-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .icon-btn:hover { background: var(--bg-hover); color: var(--fg); }
    .hdr-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

    /* 常驻水位条 */
    .gauge-box {
      padding: 6px var(--inline) 10px;
      background: var(--bg);
      flex-shrink: 0;
    }
    .gauge-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
    }
    .sess-name {
      font-weight: 500;
      font-size: 12.5px;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .model-tag {
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--fg-muted);
      white-space: nowrap;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .model-tag:hover { background: var(--bg-hover); color: var(--fg); }
    .gauge-nums {
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
      color: var(--fg-muted);
      margin-bottom: 5px;
      font-variant-numeric: tabular-nums;
    }
    .seg-bar {
      height: 6px;
      border-radius: 999px;
      background: var(--bg-card);
      overflow: hidden;
      display: flex;
    }
    .seg-cache { background: var(--cyan); height: 100%; transition: width 0.25s; }
    .seg-uncached { background: var(--accent); height: 100%; transition: width 0.25s; }
    .seg-output { background: var(--purple); height: 100%; transition: width 0.25s; }
    .warn-banner {
      margin-top: 8px;
      padding: 6px 10px;
      border-radius: var(--r-md);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      background: color-mix(in srgb, var(--amber) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--amber) 32%, transparent);
      color: var(--fg);
    }
    .warn-banner.crit {
      background: color-mix(in srgb, var(--red) 13%, transparent);
      border-color: color-mix(in srgb, var(--red) 36%, transparent);
    }

    /* 原生下划线风格 Tabs */
    .tabs {
      display: flex;
      padding: 0 var(--inline);
      gap: 18px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      position: relative;
      flex: none;
      display: inline-flex;
      align-items: center;
      height: 34px;
      padding: 0;
      font-family: var(--font);
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg-muted);
      border: none;
      background: transparent;
      cursor: pointer;
      white-space: nowrap;
      transition: color 0.12s ease;
    }
    .tab::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
      background: transparent;
      transition: background-color 0.12s ease;
    }
    .tab:hover { color: var(--fg); }
    .tab.active { color: var(--fg); }
    .tab.active::after { background: var(--fg); }

    /* 主内容滚动区（对齐 --inline 居中和薄滚动条） */
    .body {
      flex: 1;
      overflow-y: auto;
      padding: 12px var(--inline) 28px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--fg) 20%, transparent) transparent;
    }
    .body::-webkit-scrollbar { width: 8px; height: 8px; }
    .body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--fg) 18%, transparent);
      border: 2px solid transparent;
      background-clip: padding-box;
      border-radius: 8px;
    }
    .body::-webkit-scrollbar-track { background: transparent; }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 11px 12px;
    }
    .card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-muted);
      margin-bottom: 9px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .sidebar.wide .kpi-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .kpi {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 9px 10px;
    }
    .kpi-label { font-size: 11px; color: var(--fg-muted); }
    .kpi-val { font-size: 16px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .kpi-sub { font-size: 11px; color: var(--fg-dim); margin-top: 2px; }

    /* 构成条与图例 */
    .comp-bar {
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      background: color-mix(in srgb, var(--fg) 6%, transparent);
      margin-bottom: 9px;
    }
    .legend-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 12px;
    }
    .sidebar.wide .legend-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .legend-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      gap: 6px;
    }
    .legend-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .swatch { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .legend-val { color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

    /* 诊断列表 */
    .diag-item {
      padding: 8px 10px;
      border-radius: var(--r-md);
      border-left: 2.5px solid var(--fg-muted);
      background: color-mix(in srgb, var(--fg) 3.5%, transparent);
      margin-bottom: 6px;
    }
    .diag-item:last-child { margin-bottom: 0; }
    .diag-item.critical { border-left-color: var(--red); }
    .diag-item.warning { border-left-color: var(--amber); }
    .diag-item.good { border-left-color: var(--green); }
    .diag-t { font-weight: 600; font-size: 12px; }
    .diag-d { font-size: 11.5px; color: var(--fg-muted); margin-top: 2px; }

    /* 过滤条与列表（克制单色调，聚焦原生控件感） */
    .filter-row {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      align-items: center;
    }
    .chip {
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-muted);
      font-family: var(--font);
      font-size: 11.5px;
      cursor: pointer;
      transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }
    .chip:hover { background: var(--bg-hover); color: var(--fg); }
    .chip.active {
      background: var(--bg-hover);
      border-color: var(--border-strong);
      color: var(--fg);
      font-weight: 600;
    }
    .input {
      width: 100%;
      padding: 6px 10px;
      border-radius: var(--r-lg);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--fg);
      font-family: var(--font);
      font-size: 12px;
      outline: none;
      transition: border-color 0.12s ease;
    }
    .input:focus { border-color: var(--accent); }
    textarea.input {
      resize: vertical;
      min-height: 220px;
      font-family: var(--mono);
      font-size: 11.5px;
      line-height: 1.55;
    }

    .step-row {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 8px 10px;
      cursor: pointer;
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    .step-row:hover { border-color: var(--border-strong); background: var(--bg-hover); }
    .step-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 7px;
    }
    .badge {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: var(--r-sm);
      background: color-mix(in srgb, var(--fg) 7%, transparent);
      color: var(--fg-muted);
      flex-shrink: 0;
    }
    .step-title {
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .step-tok {
      font-family: var(--mono);
      font-size: 11.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mini-bar {
      height: 3px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--fg) 6%, transparent);
      margin-top: 6px;
      overflow: hidden;
    }
    .mini-bar > div { height: 100%; border-radius: 999px; }
    .step-preview {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: var(--r-md);
      background: color-mix(in srgb, var(--fg) 4%, transparent);
      font-family: var(--mono);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 190px;
      overflow-y: auto;
      color: var(--fg-muted);
    }

    .file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
    }
    .file-row:last-child { border-bottom: none; }
    .file-path {
      font-family: var(--mono);
      font-size: 11.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      cursor: pointer;
    }
    .file-path:hover { color: var(--accent); }
    .op-tags { display: flex; gap: 4px; flex-shrink: 0; font-size: 10.5px; font-family: var(--mono); }
    .op-tag { padding: 1px 5px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--fg) 7%, transparent); color: var(--fg-muted); }
    .op-tag.edit { color: var(--amber); }
    .op-tag.write { color: var(--green); }
    .op-tag.warn { color: var(--red); }

    .sess-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      padding: 9px 10px;
      cursor: pointer;
      transition: border-color 0.12s ease, background 0.12s ease;
    }
    .sess-card:hover { border-color: var(--border-strong); background: var(--bg-hover); }
    .sess-card.current { border-color: var(--accent); background: var(--accent-soft); }

    .settings-pop {
      position: absolute;
      top: 46px;
      right: var(--inline);
      width: min(360px, calc(100% - 24px));
      z-index: 30;
      background: var(--bg-elev);
      border: 1px solid var(--border-strong);
      border-radius: var(--r-lg);
      padding: 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.42);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }
    .toast {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: var(--bg-elev);
      color: var(--fg);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 500;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.16s, transform 0.16s;
      z-index: 50;
      border: 1px solid var(--border-strong);
      box-shadow: 0 6px 20px rgba(0,0,0,0.28);
      white-space: nowrap;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .empty {
      text-align: center;
      padding: 22px 10px;
      color: var(--fg-dim);
      font-size: 12px;
    }
  `;

  const CAT_COLORS = {
    user: 'var(--accent)',
    assistant: 'var(--purple)',
    file_read: 'var(--cyan)',
    command: 'var(--amber)',
    file_edit: 'var(--green)',
    agent_tool: '#d87093',
  };

  function getCatLabel(key, isZh) {
    const mapZh = {
      user: '用户提问',
      assistant: 'AI & Thinking',
      file_read: '文件读取/搜索',
      command: '终端命令日志',
      file_edit: '代码编辑/写入',
      agent_tool: 'Subagent/MCP',
    };
    const mapEn = {
      user: 'User Input',
      assistant: 'AI & Thinking',
      file_read: 'File Reads',
      command: 'Terminal Logs',
      file_edit: 'File Edits',
      agent_tool: 'Subagent/MCP',
    };
    return (isZh ? mapZh : mapEn)[key] || key;
  }

  function ensureShadowDom() {
    if (shadowRootRef && document.getElementById(HOST_ID)) {
      return shadowRootRef;
    }
    if (!document || !document.body) return null;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      document.body.appendChild(host);
    }
    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const styleNode = document.createElement('style');
    styleNode.textContent = STYLES;
    shadow.appendChild(styleNode);

    const root = h('div', { className: 'root' });
    shadow.appendChild(root);

    // Collapsed Edge Tab
    const edgeDot = h('div', { className: 'edge-dot' });
    const edgePct = h('div', { className: 'edge-pct', textContent: '--' });
    const edgeBarFill = h('div', { className: 'edge-bar-fill', style: 'height: 0%' });
    const edgeLbl = h('div', { className: 'edge-lbl', textContent: 'CTX' });
    const edgeTab = h(
      'div',
      {
        className: 'edge-tab',
        title: 'Antigravity Context Doctor (Alt+C)',
      },
      [edgeDot, edgePct, h('div', { className: 'edge-bar-wrap' }, [edgeBarFill]), edgeLbl]
    );

    // Drag vertically + click to open
    let edgeDragStartY = 0;
    let edgeStartTopPct = state.prefs.edgeTopPct;
    let edgeMoved = false;
    edgeTab.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      edgeDragStartY = e.clientY;
      edgeStartTopPct = state.prefs.edgeTopPct;
      edgeMoved = false;
      const onMove = (ev) => {
        const dy = ev.clientY - edgeDragStartY;
        if (Math.abs(dy) > 4) edgeMoved = true;
        const vh = window.innerHeight || 800;
        state.prefs.edgeTopPct = clampNumber(edgeStartTopPct + (dy / vh) * 100, 8, 86, 38);
        edgeTab.style.top = `${state.prefs.edgeTopPct}%`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (edgeMoved) {
          savePrefs(state.prefs);
        } else {
          state.prefs.open = true;
          savePrefs(state.prefs);
          renderAll();
          refreshTargetSession(true);
          refreshGlobalInsights();
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Right Sidebar
    const resizeHandle = h('div', { className: 'resize-handle' });
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = state.prefs.sidebarWidth;
      const onMove = (ev) => {
        state.prefs.sidebarWidth = clampNumber(startW + (startX - ev.clientX), 320, 640, 400);
        sidebar.style.width = `${state.prefs.sidebarWidth}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        savePrefs(state.prefs);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    const hdrTitle = h('span', { className: 'hdr-title', textContent: '上下文洞察' });
    const newTabPlusBtn = h('button', {
      className: 'icon-btn',
      textContent: '+',
      title: '新建右侧边栏分页 (打开启动器)',
      onClick: () => {
        switchAwayFromContextDoctor();
      },
    });
    const pinBtn = h('button', {
      className: 'pill-btn',
      style: 'display:none',
      onClick: () => {
        state.inspectedCascadeId = '';
        state.handoffDirty = false;
        refreshTargetSession(false);
      },
    });
    const refreshBtn = h('button', {
      className: 'icon-btn',
      textContent: '↻',
      title: '刷新上下文',
      onClick: () => {
        refreshTargetSession(true);
        refreshGlobalInsights();
      },
    });
    const settingsBtn = h('button', {
      className: 'icon-btn',
      textContent: '⚙',
      title: '设置',
      onClick: () => {
        state.settingsOpen = !state.settingsOpen;
        renderSettingsPopover();
      },
    });
    const closeBtn = h('button', {
      className: 'icon-btn',
      textContent: '✕',
      title: '关闭上下文洞察分页',
      onClick: () => {
        closeContextDoctor();
      },
    });

    const header = h('div', { className: 'hdr' }, [
      h('div', { className: 'hdr-left' }, [hdrTitle, newTabPlusBtn, pinBtn]),
      h('div', { className: 'hdr-actions' }, [refreshBtn, settingsBtn, closeBtn]),
    ]);

    const gaugeBox = h('div', { className: 'gauge-box' });
    const tabsBar = h('div', { className: 'tabs' });
    const body = h('div', { className: 'body' });
    const settingsPop = h('div', { className: 'settings-pop', style: 'display:none' });
    const toast = h('div', { className: 'toast' });

    const sidebar = h('div', { className: 'sidebar closed' }, [
      resizeHandle,
      header,
      gaugeBox,
      tabsBar,
      body,
      settingsPop,
      toast,
    ]);

    root.appendChild(edgeTab);
    root.appendChild(sidebar);

    refs = {
      root,
      edgeTab,
      edgeDot,
      edgePct,
      edgeBarFill,
      edgeLbl,
      sidebar,
      newTabPlusBtn,
      hdrTitle,
      pinBtn,
      gaugeBox,
      tabsBar,
      body,
      settingsPop,
      toast,
    };
    shadowRootRef = shadow;
    return shadow;
  }

  function renderGaugeBox() {
    if (!refs.gaugeBox) return;
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    refs.gaugeBox.textContent = '';

    if (!a) {
      refs.gaugeBox.appendChild(
        h('div', {
          className: 'empty',
          style: 'padding: 8px 0;',
          textContent: state.waitingAuth
            ? isZh
              ? '等待捕获会话认证头，在任意对话中操作一次即可实时接入…'
              : 'Waiting for session RPC headers…'
            : isZh
              ? '暂未检测到活动对话'
              : 'No active conversation detected',
        })
      );
      return;
    }

    const latest = a.genStats.latestCall;
    const limit = a.windowLimit || 1000000;
    const occPct = a.occupancyPct || 0;
    const cachePct = latest ? Math.min(100, (latest.cachedPart / limit) * 100) : 0;
    const uncachedPct = latest ? Math.min(100 - cachePct, (latest.uncachedPart / limit) * 100) : 0;
    const outputPct = latest
      ? Math.min(100 - cachePct - uncachedPct, (latest.outputTokens / limit) * 100)
      : 0;

    const modelBtn = h('span', {
      className: 'model-tag',
      title: isZh ? '点击切换该模型上下文窗口上限' : 'Click to cycle context window limit',
      textContent: `${a.model} · ${formatTokens(limit)} ▾`,
      onClick: () => {
        const idx = MODEL_WINDOW_PRESETS.indexOf(limit);
        const nextLimit = MODEL_WINDOW_PRESETS[(idx + 1) % MODEL_WINDOW_PRESETS.length];
        state.prefs.customModelLimits[a.rawModelName || a.model] = nextLimit;
        savePrefs(state.prefs);
        recomputeState();
        renderAll();
        showToast(isZh ? `窗口上限已设为 ${formatTokens(nextLimit)}` : `Window set to ${formatTokens(nextLimit)}`);
      },
    });

    refs.gaugeBox.appendChild(
      h('div', { className: 'gauge-top' }, [
        h('div', { className: 'sess-name', title: a.summary, textContent: a.summary }),
        modelBtn,
      ])
    );

    refs.gaugeBox.appendChild(
      h('div', { className: 'gauge-nums' }, [
        h('span', {
          textContent: isZh
            ? `窗口 ${formatTokens(a.latestContextTokens)} / ${formatTokens(limit)}`
            : `Window ${formatTokens(a.latestContextTokens)} / ${formatTokens(limit)}`,
        }),
        h('span', {
          style: `font-weight:700; color:${
            occPct >= state.prefs.criticalThresholdPct
              ? 'var(--red)'
              : occPct >= state.prefs.warnThresholdPct
                ? 'var(--amber)'
                : 'var(--green)'
          }`,
          textContent: formatPct(occPct),
        }),
      ])
    );

    refs.gaugeBox.appendChild(
      h('div', { className: 'seg-bar' }, [
        h('div', { className: 'seg-cache', style: `width:${cachePct.toFixed(2)}%`, title: 'Cache Read' }),
        h('div', { className: 'seg-uncached', style: `width:${uncachedPct.toFixed(2)}%`, title: 'New Input' }),
        h('div', { className: 'seg-output', style: `width:${outputPct.toFixed(2)}%`, title: 'Output / Thinking' }),
      ])
    );

    if (occPct >= state.prefs.warnThresholdPct) {
      const isCrit = occPct >= state.prefs.criticalThresholdPct;
      refs.gaugeBox.appendChild(
        h('div', { className: `warn-banner ${isCrit ? 'crit' : ''}` }, [
          h('span', {
            textContent: isCrit
              ? isZh
                ? '上下文已超危急水位，建议立即交接'
                : 'Critical context usage — handoff recommended'
              : isZh
                ? '上下文接近上限，可准备新会话交接'
                : 'Context getting full — prepare handoff',
          }),
          h('button', {
            className: 'pill-btn primary',
            textContent: isZh ? '去交接 →' : 'Handoff →',
            onClick: () => {
              state.prefs.activeTab = 'handoff';
              savePrefs(state.prefs);
              renderAll();
            },
          }),
        ])
      );
    }
  }

  function renderTabs() {
    if (!refs.tabsBar) return;
    const isZh = state.isZh;
    const defs = [
      { id: 'overview', label: isZh ? '总览' : 'Overview' },
      { id: 'hitters', label: isZh ? '大户' : 'Hitters' },
      { id: 'fleet', label: isZh ? '文件&编队' : 'Files/Fleet' },
      { id: 'insights', label: isZh ? '全局' : 'Insights' },
      { id: 'handoff', label: isZh ? '交接' : 'Handoff' },
    ];
    refs.tabsBar.textContent = '';
    for (const t of defs) {
      refs.tabsBar.appendChild(
        h('button', {
          className: `tab ${state.prefs.activeTab === t.id ? 'active' : ''}`,
          textContent: t.label,
          onClick: () => {
            state.prefs.activeTab = t.id;
            savePrefs(state.prefs);
            if (t.id === 'insights') refreshGlobalInsights();
            renderBody();
            renderTabs();
          },
        })
      );
    }
  }

  function renderEvolutionSvg(calls, isZh) {
    const W = 350;
    const H = 96;
    const padL = 6;
    const padR = 6;
    const padT = 12;
    const padB = 18;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: String(H),
      style: 'display:block; overflow:visible;',
    });

    if (!calls || calls.length === 0) return svg;

    const slice = calls.slice(-24);
    const maxTok = Math.max(1000, ...slice.map((c) => c.promptContextTokens));
    const stepX = slice.length > 1 ? innerW / (slice.length - 1) : 0;

    // 参考线
    svg.appendChild(
      svgEl('line', {
        x1: padL,
        y1: padT + innerH,
        x2: W - padR,
        y2: padT + innerH,
        stroke: 'rgba(148,163,184,0.22)',
        'stroke-width': 1,
      })
    );

    const points = slice.map((c, idx) => {
      const x = slice.length === 1 ? W / 2 : padL + idx * stepX;
      const y = padT + innerH - (c.promptContextTokens / maxTok) * innerH;
      return { x, y, c };
    });

    if (points.length > 1) {
      const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(
        1
      )} L${points[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
      svg.appendChild(
        svgEl('path', {
          d: areaPath,
          fill: 'var(--accent-soft)',
        })
      );
      svg.appendChild(
        svgEl('path', {
          d: linePath,
          fill: 'none',
          stroke: 'var(--accent)',
          'stroke-width': 1.8,
        })
      );
    }

    for (const p of points) {
      const fill =
        p.c.eventKind === 'compaction'
          ? 'var(--green)'
          : p.c.eventKind === 'spike'
            ? 'var(--amber)'
            : 'var(--accent)';
      const r = p.c.eventKind === 'normal' ? 2.4 : 4.2;
      const circle = svgEl('circle', {
        cx: p.x.toFixed(1),
        cy: p.y.toFixed(1),
        r,
        fill,
      });
      circle.appendChild(
        svgEl('title', {}, [
          document.createTextNode(
            `#${p.c.index} ${formatTokens(p.c.promptContextTokens)} (${
              p.c.eventKind === 'compaction'
                ? isZh
                  ? '压缩/剪枝'
                  : 'Compaction'
                : p.c.eventKind === 'spike'
                  ? isZh
                    ? '激增'
                    : 'Spike'
                  : 'Call'
            })`
          ),
        ])
      );
      svg.appendChild(circle);
    }

    const minLabel = svgEl(
      'text',
      { x: padL, y: H - 3, fill: '#94a3b8', 'font-size': 9 },
      [document.createTextNode(`#${slice[0].index}`)]
    );
    const maxLabel = svgEl(
      'text',
      { x: W - padR, y: H - 3, 'text-anchor': 'end', fill: '#94a3b8', 'font-size': 9 },
      [document.createTextNode(`${isZh ? '峰值' : 'Peak'} ${formatTokens(maxTok)} · #${slice[slice.length - 1].index}`)]
    );
    svg.appendChild(minLabel);
    svg.appendChild(maxLabel);
    return svg;
  }

  function renderDailyBarSvg(daily7d) {
    const W = 350;
    const H = 104;
    const padL = 8;
    const padR = 8;
    const padT = 14;
    const padB = 20;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: String(H),
      style: 'display:block;',
    });
    if (!daily7d || daily7d.length === 0) return svg;

    const maxTok = Math.max(1000, ...daily7d.map((d) => d.totalTokens));
    const slotW = innerW / daily7d.length;
    const barW = Math.min(28, slotW * 0.56);

    daily7d.forEach((d, idx) => {
      const barH = Math.max(2, (d.totalTokens / maxTok) * innerH);
      const x = padL + idx * slotW + (slotW - barW) / 2;
      const y = padT + innerH - barH;
      const rect = svgEl('rect', {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barW.toFixed(1),
        height: barH.toFixed(1),
        rx: 3,
        fill: d.totalTokens > 0 ? 'var(--accent)' : 'var(--border)',
      });
      rect.appendChild(
        svgEl('title', {}, [document.createTextNode(`${d.date}: ${formatTokens(d.totalTokens)} (${d.calls} calls)`)])
      );
      svg.appendChild(rect);

      if (d.totalTokens > 0) {
        svg.appendChild(
          svgEl(
            'text',
            {
              x: (x + barW / 2).toFixed(1),
              y: Math.max(9, y - 3).toFixed(1),
              'text-anchor': 'middle',
              fill: '#94a3b8',
              'font-size': 8.5,
            },
            [document.createTextNode(formatTokens(d.totalTokens))]
          )
        );
      }

      svg.appendChild(
        svgEl(
          'text',
          {
            x: (x + barW / 2).toFixed(1),
            y: H - 4,
            'text-anchor': 'middle',
            fill: '#94a3b8',
            'font-size': 9,
          },
          [document.createTextNode(d.label)]
        )
      );
    });
    return svg;
  }

  function renderOverviewTab(body) {
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    if (!a) {
      body.appendChild(h('div', { className: 'empty', textContent: isZh ? '暂无当前会话上下文数据' : 'No active session data' }));
      return;
    }
    const g = a.genStats;
    const s = a.stepStats;

    // 1. 4 KPIs
    body.appendChild(
      h('div', { className: 'kpi-grid' }, [
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? '最新单轮上下文' : 'Latest Context' }),
          h('div', { className: 'kpi-val', textContent: formatTokens(a.latestContextTokens) }),
          h('div', { className: 'kpi-sub', textContent: `${formatPct(a.occupancyPct)} · ${g.callCount} ${isZh ? '次调用' : 'calls'}` }),
        ]),
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? 'Prompt Cache 命中' : 'Cache Hit Rate' }),
          h('div', { className: 'kpi-val', textContent: formatPct(g.cacheHitRate) }),
          h('div', { className: 'kpi-sub', textContent: `${formatTokens(g.totalCacheRead)} cached` }),
        ]),
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? '累计 Token 消耗' : 'Session Total' }),
          h('div', { className: 'kpi-val', textContent: formatTokens(g.totalTokens) }),
          h('div', { className: 'kpi-sub', textContent: `In ${formatTokens(g.totalInput)} · Out ${formatTokens(g.totalOutput)}` }),
        ]),
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? '输出速度 & 压缩' : 'Speed & Compacts' }),
          h('div', { className: 'kpi-val', textContent: formatTps(g.avgTps) }),
          h('div', {
            className: 'kpi-sub',
            textContent: isZh
              ? `Thinking ${formatTokens(g.totalThinking)} · 压缩 ${g.compactionCount}`
              : `Think ${formatTokens(g.totalThinking)} · Compacts ${g.compactionCount}`,
          }),
        ]),
      ])
    );

    // 2. Context Composition Breakdown
    const compCard = h('div', { className: 'card' });
    compCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? '上下文内容构成 (按轨迹步骤估算)' : 'Context Composition (Estimated)' }),
        h('span', { textContent: s.stepCount > 0 ? `${s.stepCount} steps` : 'No steps' }),
      ])
    );

    if (s.totalStepTokens > 0) {
      const compBar = h('div', { className: 'comp-bar' });
      const legend = h('div', { className: 'legend-grid' });
      for (const cat of Object.values(s.categories)) {
        if (cat.estTokens <= 0) continue;
        const color = CAT_COLORS[cat.key] || '#64748b';
        compBar.appendChild(
          h('div', {
            style: `width:${Math.max(1.5, cat.sharePct).toFixed(2)}%; background:${color};`,
            title: `${getCatLabel(cat.key, isZh)}: ${formatTokens(cat.estTokens)} (${formatPct(cat.sharePct)})`,
          })
        );
        legend.appendChild(
          h('div', { className: 'legend-item' }, [
            h('div', { className: 'legend-left' }, [
              h('span', { className: 'swatch', style: `background:${color};` }),
              h('span', { textContent: getCatLabel(cat.key, isZh) }),
            ]),
            h('span', {
              className: 'legend-val',
              textContent: `${formatTokens(cat.estTokens)} (${formatPct(cat.sharePct, 0)})`,
            }),
          ])
        );
      }
      compCard.appendChild(compBar);
      compCard.appendChild(legend);
    } else {
      const diagHint =
        state.rpcDiag && (state.rpcDiag.traj || state.rpcDiag.steps || state.rpcDiag.lastErr)
          ? ` (${[
              state.rpcDiag.traj && `traj:${state.rpcDiag.traj}`,
              state.rpcDiag.gen && `gen:${state.rpcDiag.gen}`,
              state.rpcDiag.steps && `steps:${state.rpcDiag.steps}`,
            ]
              .filter(Boolean)
              .join(' · ')})`
          : '';
      compCard.appendChild(
        h('div', {
          className: 'empty',
          style: 'padding:8px 0;',
          textContent: isZh
            ? `当前轨迹尚未返回步骤明细（仍可查看 Token 与演进曲线）${diagHint}`
            : `No step payload returned yet (token stats remain active)${diagHint}`,
        })
      );
    }
    body.appendChild(compCard);

    // 3. Context Evolution SVG Chart
    const evoCard = h('div', { className: 'card' });
    evoCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? '上下文演进趋势 (近 24 轮)' : 'Context Evolution (Last 24 calls)' }),
        h('span', {
          textContent: isZh ? '绿点=压缩 · 橙点=激增' : 'Green=Compact · Amber=Spike',
        }),
      ])
    );
    if (g.calls.length > 0) {
      evoCard.appendChild(renderEvolutionSvg(g.calls, isZh));
    } else {
      evoCard.appendChild(h('div', { className: 'empty', style: 'padding:8px 0;', textContent: '--' }));
    }
    body.appendChild(evoCard);

    // 4. Diagnostics
    const diagCard = h('div', { className: 'card' });
    diagCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? '上下文健康诊断' : 'Context Health Diagnostics' }),
      ])
    );
    for (const f of state.computed.diagnostics) {
      diagCard.appendChild(
        h('div', { className: `diag-item ${f.level}` }, [
          h('div', { className: 'diag-t', textContent: f.title }),
          h('div', { className: 'diag-d', textContent: f.detail }),
        ])
      );
    }
    body.appendChild(diagCard);
  }

  function renderHeavyHittersTab(body) {
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    const steps = a && a.stepStats ? a.stepStats.steps : [];

    const filterDefs = [
      { id: 'all', label: isZh ? '全部' : 'All' },
      { id: 'file_read', label: isZh ? '读文件' : 'Reads' },
      { id: 'command', label: isZh ? '终端' : 'Cmd' },
      { id: 'file_edit', label: isZh ? '改写' : 'Edits' },
      { id: 'assistant', label: 'AI' },
      { id: 'user', label: isZh ? '提问' : 'User' },
      { id: 'error', label: isZh ? '报错' : 'Errors' },
    ];

    const filterRow = h('div', { className: 'filter-row' });
    for (const f of filterDefs) {
      filterRow.appendChild(
        h('button', {
          className: `chip ${state.hitterFilter === f.id ? 'active' : ''}`,
          textContent: f.label,
          onClick: () => {
            state.hitterFilter = f.id;
            renderBody();
          },
        })
      );
    }
    body.appendChild(filterRow);

    const listWrap = h('div', { style: 'display:flex; flex-direction:column; gap:8px;' });

    function renderHitterList() {
      const prevScrollTop = refs.body ? refs.body.scrollTop || 0 : 0;
      listWrap.textContent = '';

      const q = state.hitterQuery.trim().toLowerCase();
      let list = steps.filter((s) => {
        if (state.hitterFilter === 'error') {
          if (!s.isError) return false;
        } else if (state.hitterFilter !== 'all' && s.category !== state.hitterFilter) {
          return false;
        }
        if (q) {
          const hay = `${s.title} ${s.filePath} ${s.commandStr} ${s.badge} ${s.preview}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (state.hitterSort === 'size') list = [...list].sort((x, y) => y.estTokens - x.estTokens);
      else if (state.hitterSort === 'desc') list = [...list].sort((x, y) => y.index - x.index);
      else list = [...list].sort((x, y) => x.index - y.index);

      if (list.length === 0) {
        listWrap.appendChild(
          h('div', { className: 'empty', textContent: isZh ? '没有匹配的轨迹步骤' : 'No matching trajectory steps' })
        );
        if (refs.body) refs.body.scrollTop = prevScrollTop;
        return;
      }

      for (const s of list.slice(0, 60)) {
        const expanded = state.expandedSteps.has(s.index);
        const color = CAT_COLORS[s.category] || '#64748b';
        const row = h('div', {
          className: 'step-row',
          onClick: () => {
            if (state.expandedSteps.has(s.index)) state.expandedSteps.delete(s.index);
            else state.expandedSteps.add(s.index);
            renderHitterList();
          },
        });

        row.appendChild(
          h('div', { className: 'step-top' }, [
            h('span', { className: 'badge', textContent: `#${s.index} ${s.badge}` }),
            h('span', { className: 'step-title', title: s.title, textContent: s.title }),
            h('span', {
              className: 'step-tok',
              style: s.isError ? 'color:var(--red)' : '',
              textContent: `~${formatTokens(s.estTokens)}`,
            }),
          ])
        );

        row.appendChild(
          h('div', { className: 'mini-bar' }, [
            h('div', {
              style: `width:${Math.min(100, Math.max(2, s.sharePct)).toFixed(1)}%; background:${color};`,
            }),
          ])
        );

        if (expanded) {
          row.appendChild(
            h(
              'div',
              {
                style: 'display:flex; justify-content:space-between; align-items:center; margin-top:6px; font-size:10px; color:var(--fg-muted);',
              },
              [
                h('span', {
                  textContent: `${formatBytes(s.chars)} · ${formatPct(s.sharePct)} ${isZh ? '占比' : 'share'}${
                    s.isError ? ' · ERROR' : ''
                  }`,
                }),
                h('button', {
                  className: 'pill-btn',
                  textContent: isZh ? '复制内容' : 'Copy',
                  onClick: (ev) => {
                    ev.stopPropagation();
                    copyToClipboard(s.preview || s.title).then((ok) => {
                      if (ok) showToast(isZh ? '已复制步骤内容' : 'Copied step content');
                    });
                  },
                }),
              ]
            )
          );
          if (s.preview) {
            row.appendChild(h('div', { className: 'step-preview', textContent: s.preview }));
          }
        }
        listWrap.appendChild(row);
      }
      if (refs.body) refs.body.scrollTop = prevScrollTop;
    }

    const searchRow = h('div', { style: 'display:flex; gap:6px; align-items:center;' });
    const searchInput = h('input', {
      className: 'input',
      placeholder: isZh ? '筛选文件路径 / 命令 / 关键字…' : 'Filter path / command / text…',
      value: state.hitterQuery,
    });
    searchInput.addEventListener('input', (e) => {
      state.hitterQuery = e.target.value || '';
      renderHitterList();
    });
    const sortBtn = h('button', {
      className: 'pill-btn',
      textContent:
        state.hitterSort === 'size'
          ? isZh
            ? '体积↓'
            : 'Size↓'
          : state.hitterSort === 'desc'
            ? isZh
              ? '最新↓'
              : 'Newest'
            : isZh
              ? '顺序↑'
              : 'Order↑',
      onClick: () => {
        state.hitterSort =
          state.hitterSort === 'size' ? 'desc' : state.hitterSort === 'desc' ? 'asc' : 'size';
        renderBody();
      },
    });
    searchRow.appendChild(searchInput);
    searchRow.appendChild(sortBtn);
    body.appendChild(searchRow);
    body.appendChild(listWrap);
    renderHitterList();
  }

  function renderFleetTab(body) {
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    const files = a && a.stepStats ? a.stepStats.fileActivities : [];
    const fleet = state.computed.fleetChildren || [];
    const subCalls = a && a.stepStats ? a.stepStats.subagentCalls : [];

    // 1. File Activity
    const fileCard = h('div', { className: 'card' });
    fileCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? `文件活动追踪 (${files.length})` : `File Activity (${files.length})` }),
        h('span', { textContent: isZh ? '点击路径可复制' : 'Click path to copy' }),
      ])
    );

    if (files.length === 0) {
      fileCard.appendChild(
        h('div', {
          className: 'empty',
          style: 'padding:8px 0;',
          textContent: isZh ? '本会话暂未记录文件读写操作' : 'No file activity recorded in this session',
        })
      );
    } else {
      for (const f of files.slice(0, 35)) {
        const tags = h('div', { className: 'op-tags' });
        if (f.reads > 0) {
          tags.appendChild(
            h('span', {
              className: `op-tag ${f.reads >= 3 ? 'warn' : ''}`,
              title: f.reads >= 3 ? (isZh ? '多次重复读取' : 'Repeated reads') : '',
              textContent: `R${f.reads}`,
            })
          );
        }
        if (f.edits > 0) tags.appendChild(h('span', { className: 'op-tag edit', textContent: `E${f.edits}` }));
        if (f.writes > 0) tags.appendChild(h('span', { className: 'op-tag write', textContent: `W${f.writes}` }));
        if (f.searches > 0) tags.appendChild(h('span', { className: 'op-tag', textContent: `S${f.searches}` }));
        tags.appendChild(h('span', { className: 'op-tag', textContent: formatTokens(f.estTokens) }));

        fileCard.appendChild(
          h('div', { className: 'file-row' }, [
            h('span', {
              className: 'file-path',
              title: f.path,
              textContent: f.path,
              onClick: () => {
                copyToClipboard(f.path).then((ok) => {
                  if (ok) showToast(isZh ? '已复制文件路径' : 'Copied file path');
                });
              },
            }),
            tags,
          ])
        );
      }
    }
    body.appendChild(fileCard);

    // 2. Agent Fleet
    const fleetCard = h('div', { className: 'card' });
    fleetCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? 'Multi-Agent 编队网络' : 'Agent Fleet' }),
        h('span', { textContent: `${1 + fleet.length + subCalls.length} nodes` }),
      ])
    );

    if (a) {
      fleetCard.appendChild(
        h('div', { className: 'sess-card current', style: 'margin-bottom:6px; cursor:default;' }, [
          h('div', { style: 'display:flex; justify-content:space-between; font-weight:700;' }, [
            h('span', { textContent: isZh ? '主 Agent (当前会话)' : 'Primary Agent' }),
            h('span', { className: 'badge', textContent: a.status || 'ACTIVE' }),
          ]),
          h('div', {
            style: 'font-size:11px; color:var(--fg-muted); margin-top:3px;',
            textContent: `${a.model} · ${formatTokens(a.genStats.totalTokens)} total · ${a.stepStats.stepCount} steps`,
          }),
        ])
      );
    }

    for (const child of fleet) {
      fleetCard.appendChild(
        h('div', {
          className: 'sess-card',
          style: 'margin-bottom:6px;',
          onClick: () => {
            state.inspectedCascadeId = child.cascadeId;
            state.handoffDirty = false;
            state.prefs.activeTab = 'overview';
            savePrefs(state.prefs);
            refreshTargetSession(true);
          },
        }, [
          h('div', { style: 'display:flex; justify-content:space-between; font-weight:600;' }, [
            h('span', { textContent: child.summary }),
            h('span', { className: 'badge', textContent: child.status || 'SUBAGENT' }),
          ]),
          h('div', {
            style: 'font-size:10.5px; color:var(--fg-muted); margin-top:2px;',
            textContent: `${child.model} · ${formatTokens(child.totalTokens)} · ${child.stepCount} steps`,
          }),
        ])
      );
    }

    for (const sc of subCalls) {
      if (fleet.some((f) => f.cascadeId === sc.conversationId)) continue;
      fleetCard.appendChild(
        h('div', { className: 'diag-item', style: 'margin-bottom:6px;' }, [
          h('div', { className: 'diag-t', textContent: `Step #${sc.step} · ${sc.role}` }),
          sc.prompt ? h('div', { className: 'diag-d', textContent: sc.prompt }) : null,
        ])
      );
    }

    if (fleet.length === 0 && subCalls.length === 0) {
      fleetCard.appendChild(
        h('div', {
          style: 'font-size:11px; color:var(--fg-dim); padding-top:4px;',
          textContent: isZh ? '当前会话暂无 Subagent 子代理调用。' : 'No subagent delegations in this session.',
        })
      );
    }

    body.appendChild(fleetCard);
  }

  function renderInsightsTab(body) {
    const isZh = state.isZh;
    const ins = state.computed.insights;
    if (!ins) {
      body.appendChild(h('div', { className: 'empty', textContent: isZh ? '正在聚合跨会话数据…' : 'Aggregating insights…' }));
      return;
    }

    // 7-day KPI strip
    body.appendChild(
      h('div', { className: 'kpi-grid' }, [
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? '7 天累计 Token' : '7d Total Tokens' }),
          h('div', { className: 'kpi-val', textContent: formatTokens(ins.total7dTokens) }),
          h('div', { className: 'kpi-sub', textContent: `${ins.activeSessionsCount} ${isZh ? '个会话' : 'sessions'}` }),
        ]),
        h('div', { className: 'kpi' }, [
          h('div', { className: 'kpi-label', textContent: isZh ? '7 天 Cache 命中率' : '7d Cache Hit' }),
          h('div', { className: 'kpi-val', textContent: formatPct(ins.avg7dCacheRate) }),
          h('div', {
            className: 'kpi-sub',
            textContent: ins.heaviestSession
              ? `${isZh ? '最重' : 'Top'}: ${formatTokens(ins.heaviestSession.totalTokens)}`
              : '--',
          }),
        ]),
      ])
    );

    const chartCard = h('div', { className: 'card' });
    chartCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? '近 7 天上下文消耗分布' : '7-Day Token Usage' }),
      ])
    );
    chartCard.appendChild(renderDailyBarSvg(ins.daily7d));
    body.appendChild(chartCard);

    // Search & sort
    const listWrap = h('div', { style: 'display:flex; flex-direction:column; gap:8px;' });

    function renderSessionList() {
      const prevScrollTop = refs.body ? refs.body.scrollTop || 0 : 0;
      listWrap.textContent = '';

      const q = state.insightsQuery.trim().toLowerCase();
      let list = ins.sessions.filter((s) => {
        if (!q) return true;
        return `${s.summary} ${s.model} ${s.cascadeId}`.toLowerCase().includes(q);
      });
      if (state.insightsSort === 'tokens') list = [...list].sort((a, b) => b.totalTokens - a.totalTokens);
      else if (state.insightsSort === 'steps') list = [...list].sort((a, b) => b.stepCount - a.stepCount);

      const currentTargetCid =
        (state.computed.activeAnalysis && state.computed.activeAnalysis.cascadeId) || '';
      const now = Date.now();

      for (const s of list.slice(0, 30)) {
        const card = h(
          'div',
          {
            className: `sess-card ${s.cascadeId === currentTargetCid ? 'current' : ''}`,
            onClick: () => {
              state.inspectedCascadeId = s.cascadeId === state.activeCascadeId ? '' : s.cascadeId;
              state.handoffDirty = false;
              state.prefs.activeTab = 'overview';
              savePrefs(state.prefs);
              refreshTargetSession(true);
            },
          },
          [
            h('div', { style: 'display:flex; justify-content:space-between; gap:6px; align-items:center;' }, [
              h('span', {
                style: 'font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
                title: s.summary,
                textContent: (s.isSubtrajectory ? '↳ ' : '') + s.summary,
              }),
              h('span', { className: 'badge', textContent: formatTokens(s.totalTokens) }),
            ]),
            h('div', {
              style: 'display:flex; justify-content:space-between; font-size:10.5px; color:var(--fg-muted); margin-top:4px;',
              textContent: `${s.model} · ${s.stepCount} steps · ${formatPct(s.occupancyPct)} ctx · ${formatRelativeTime(
                s.lastModifiedMs,
                now,
                isZh
              )}`,
            }),
          ]
        );
        listWrap.appendChild(card);
      }
      if (refs.body) refs.body.scrollTop = prevScrollTop;
    }

    const row = h('div', { style: 'display:flex; gap:6px;' });
    const inp = h('input', {
      className: 'input',
      placeholder: isZh ? '搜索会话标题 / 模型…' : 'Search session title / model…',
      value: state.insightsQuery,
    });
    inp.addEventListener('input', (e) => {
      state.insightsQuery = e.target.value || '';
      renderSessionList();
    });
    const sortBtn = h('button', {
      className: 'pill-btn',
      textContent:
        state.insightsSort === 'recent'
          ? isZh
            ? '最近'
            : 'Recent'
          : state.insightsSort === 'tokens'
            ? 'Token↓'
            : isZh
              ? '步数↓'
              : 'Steps↓',
      onClick: () => {
        state.insightsSort =
          state.insightsSort === 'recent' ? 'tokens' : state.insightsSort === 'tokens' ? 'steps' : 'recent';
        renderBody();
      },
    });
    row.appendChild(inp);
    row.appendChild(sortBtn);
    body.appendChild(row);
    body.appendChild(listWrap);
    renderSessionList();
  }

  function renderHandoffTab(body) {
    const isZh = state.isZh;
    const a = state.computed.activeAnalysis;
    const opts = state.prefs.handoffOptions;

    const optCard = h('div', { className: 'card' });
    optCard.appendChild(
      h('div', { className: 'card-title' }, [
        h('span', { textContent: isZh ? '无痛交接 Prompt 提取项' : 'Handoff Prompt Sections' }),
        h('button', {
          className: 'pill-btn',
          textContent: isZh ? '重新提取' : 'Regenerate',
          onClick: () => {
            state.handoffDirty = false;
            state.handoffDraft = a ? generateHandoffPrompt(a, opts, isZh) : '';
            renderBody();
          },
        }),
      ])
    );

    const toggles = [
      { key: 'includeGoal', label: isZh ? '任务目标' : 'Goals' },
      { key: 'includeFiles', label: isZh ? '改动文件' : 'Files' },
      { key: 'includeCommands', label: isZh ? '关键命令' : 'Commands' },
      { key: 'includeConclusions', label: isZh ? '结论进度' : 'Conclusions' },
      { key: 'includeDiagnostics', label: isZh ? '异常排查' : 'Errors' },
    ];
    const chipRow = h('div', { className: 'filter-row' });
    for (const t of toggles) {
      chipRow.appendChild(
        h('button', {
          className: `chip ${opts[t.key] ? 'active' : ''}`,
          textContent: t.label,
          onClick: () => {
            opts[t.key] = !opts[t.key];
            state.handoffDirty = false;
            savePrefs(state.prefs);
            if (a) state.handoffDraft = generateHandoffPrompt(a, opts, isZh);
            renderBody();
          },
        })
      );
    }
    optCard.appendChild(chipRow);
    body.appendChild(optCard);

    const ta = h('textarea', {
      className: 'input',
      value: state.handoffDraft,
      placeholder: isZh ? '暂无可提取的会话内容…' : 'No session content to extract…',
    });
    ta.value = state.handoffDraft;
    ta.addEventListener('input', (e) => {
      state.handoffDraft = e.target.value;
      state.handoffDirty = true;
    });
    body.appendChild(ta);

    const actions = h('div', { style: 'display:flex; gap:7px; flex-wrap:wrap;' }, [
      h('button', {
        className: 'pill-btn primary',
        style: 'flex:1; justify-content:center; padding:7px 10px;',
        textContent: isZh ? '填入对话输入框' : 'Insert into Chat',
        onClick: () => {
          if (!state.handoffDraft.trim()) return;
          const ok = insertTextIntoComposer(state.handoffDraft);
          if (ok) {
            showToast(isZh ? '已填入当前输入框' : 'Inserted into chat input');
          } else {
            copyToClipboard(state.handoffDraft).then((copied) => {
              showToast(
                copied
                  ? isZh
                    ? '未定位到输入框，已复制到剪贴板'
                    : 'Composer not found; copied to clipboard'
                  : isZh
                    ? '填入失败，请手动复制'
                    : 'Insert failed'
              );
            });
          }
        },
      }),
      h('button', {
        className: 'pill-btn',
        style: 'padding:7px 10px;',
        textContent: isZh ? '复制 Prompt' : 'Copy',
        onClick: () => {
          copyToClipboard(state.handoffDraft).then((ok) => {
            if (ok) showToast(isZh ? '交接 Prompt 已复制' : 'Copied handoff prompt');
          });
        },
      }),
      h('button', {
        className: 'pill-btn',
        style: 'padding:7px 10px;',
        textContent: isZh ? '导出诊断 JSON' : 'Export JSON',
        onClick: () => {
          const snapshot = a
            ? {
                exportedAt: new Date().toISOString(),
                cascadeId: a.cascadeId,
                model: a.model,
                windowLimit: a.windowLimit,
                latestContextTokens: a.latestContextTokens,
                occupancyPct: Number(a.occupancyPct.toFixed(2)),
                categories: a.stepStats.categories,
                heavyHitters: a.stepStats.heavyHitters.slice(0, 15).map((x) => ({
                  index: x.index,
                  badge: x.badge,
                  title: x.title,
                  estTokens: x.estTokens,
                  sharePct: Number(x.sharePct.toFixed(2)),
                })),
                fileActivities: a.stepStats.fileActivities,
                diagnostics: state.computed.diagnostics,
              }
            : {};
          copyToClipboard(JSON.stringify(snapshot, null, 2)).then((ok) => {
            if (ok) showToast(isZh ? '已复制诊断 JSON 到剪贴板' : 'Copied diagnostic JSON');
          });
        },
      }),
    ]);
    body.appendChild(actions);
  }

  function renderBody() {
    if (!refs.body) return;
    const prevScrollTop = refs.body.scrollTop || 0;
    refs.body.textContent = '';
    const tab = state.prefs.activeTab;
    if (tab === 'overview') renderOverviewTab(refs.body);
    else if (tab === 'hitters') renderHeavyHittersTab(refs.body);
    else if (tab === 'fleet') renderFleetTab(refs.body);
    else if (tab === 'insights') renderInsightsTab(refs.body);
    else if (tab === 'handoff') renderHandoffTab(refs.body);
    refs.body.scrollTop = prevScrollTop;
  }

  function renderSettingsPopover() {
    if (!refs.settingsPop) return;
    if (!state.settingsOpen) {
      refs.settingsPop.style.display = 'none';
      return;
    }
    const isZh = state.isZh;
    refs.settingsPop.style.display = 'flex';
    refs.settingsPop.textContent = '';

    refs.settingsPop.appendChild(
      h('div', { style: 'display:flex; justify-content:space-between; align-items:center; font-weight:700;' }, [
        h('span', { textContent: isZh ? 'Context Doctor 设置' : 'Context Doctor Settings' }),
        h('button', {
          className: 'icon-btn',
          textContent: '✕',
          onClick: () => {
            state.settingsOpen = false;
            renderSettingsPopover();
          },
        }),
      ])
    );

    // 预警阈值
    const warnRow = h('div', { className: 'setting-row' }, [
      h('span', { textContent: isZh ? '上下文预警阈值' : 'Warning Threshold' }),
      h('div', { style: 'display:flex; gap:4px;' }, [
        ...[65, 75, 85].map((pct) =>
          h('button', {
            className: `chip ${state.prefs.warnThresholdPct === pct ? 'active' : ''}`,
            textContent: `${pct}%`,
            onClick: () => {
              state.prefs.warnThresholdPct = pct;
              savePrefs(state.prefs);
              recomputeState();
              renderAll();
            },
          })
        ),
      ]),
    ]);
    refs.settingsPop.appendChild(warnRow);

    // 界面语言
    const langRow = h('div', { className: 'setting-row' }, [
      h('span', { textContent: isZh ? '面板语言' : 'Language' }),
      h('div', { style: 'display:flex; gap:4px;' }, [
        ...[
          { id: 'auto', label: isZh ? '自动' : 'Auto' },
          { id: 'zh', label: '中文' },
          { id: 'en', label: 'EN' },
        ].map((item) =>
          h('button', {
            className: `chip ${state.prefs.langMode === item.id ? 'active' : ''}`,
            textContent: item.label,
            onClick: () => {
              state.prefs.langMode = item.id;
              state.handoffDirty = false;
              savePrefs(state.prefs);
              recomputeState();
              renderAll();
            },
          })
        ),
      ]),
    ]);
    refs.settingsPop.appendChild(langRow);

    // 右侧边缘标签开关（默认关闭，改由右侧栏「插件 > 上下文洞察」打开）
    const edgeRow = h('div', { className: 'setting-row' }, [
      h('span', { textContent: isZh ? '额外显示右侧边缘悬浮标签' : 'Show Floating Edge Tab' }),
      h('button', {
        className: `chip ${state.prefs.showEdgeTab ? 'active' : ''}`,
        textContent: state.prefs.showEdgeTab ? (isZh ? '已开启' : 'ON') : isZh ? '已关闭' : 'OFF',
        onClick: () => {
          state.prefs.showEdgeTab = !state.prefs.showEdgeTab;
          savePrefs(state.prefs);
          renderAll();
        },
      }),
    ]);
    refs.settingsPop.appendChild(edgeRow);

    refs.settingsPop.appendChild(
      h('div', { className: 'setting-row' }, [
        h('span', { style: 'color:var(--fg-dim);', textContent: isZh ? '快捷键：Alt+C 切换面板' : 'Shortcut: Alt+C' }),
        h('button', {
          className: 'pill-btn',
          textContent: isZh ? '重置窗口上限' : 'Reset Limits',
          onClick: () => {
            state.prefs.customModelLimits = {};
            savePrefs(state.prefs);
            recomputeState();
            renderAll();
            showToast(isZh ? '已恢复默认模型窗口上限' : 'Reset model limits');
          },
        }),
      ])
    );
  }

  function syncHostThemeToRoot(auxBgColor) {
    if (!refs.root || !refs.root.style || typeof refs.root.style.setProperty !== 'function') return;
    const tokens = state.hostTokens || {};
    for (const [k, v] of Object.entries(tokens)) {
      if (k === '--border') {
        refs.root.style.setProperty('--border-token', v);
      } else {
        refs.root.style.setProperty(k, v);
      }
    }
    if (auxBgColor) {
      refs.root.style.setProperty('--bg', auxBgColor);
      refs.root.style.setProperty('--bg-elev', auxBgColor);
    } else {
      refs.root.style.removeProperty('--bg');
      refs.root.style.removeProperty('--bg-elev');
    }
  }

  function applySidebarGeometry() {
    if (!refs.sidebar) return;
    const aux = state.prefs.open ? locateNativeAuxPane() : { found: false };
    const useAux = aux.found || (state.openedInNativePane && state.lastAuxRect);
    const rect = aux.found ? aux : useAux ? state.lastAuxRect : null;

    syncHostThemeToRoot(rect && rect.bgColor ? rect.bgColor : '');
    if (refs.newTabPlusBtn) {
      refs.newTabPlusBtn.style.display = rect && rect.hasNativeTabStrip ? 'none' : 'inline-flex';
    }

    if (rect) {
      refs.sidebar.style.left = `${rect.left}px`;
      refs.sidebar.style.top = `${rect.top}px`;
      refs.sidebar.style.width = `${rect.width}px`;
      refs.sidebar.style.height = `${rect.height}px`;
      refs.sidebar.style.right = 'auto';
      refs.sidebar.style.bottom = 'auto';
      refs.sidebar.style.borderRadius = `${rect.radius ?? 10}px`;
      const isWide = rect.width >= 560;
      refs.sidebar.className = `sidebar docked-aux ${isWide ? 'wide' : ''} ${state.prefs.open ? '' : 'closed'}`.trim();
    } else {
      refs.sidebar.style.left = 'auto';
      refs.sidebar.style.right = '8px';
      refs.sidebar.style.top = '44px';
      refs.sidebar.style.bottom = '8px';
      refs.sidebar.style.height = 'auto';
      refs.sidebar.style.width = `${state.prefs.sidebarWidth}px`;
      refs.sidebar.style.borderRadius = '10px';
      refs.sidebar.className = `sidebar ${state.prefs.open ? '' : 'closed'}`;
    }
  }

  function renderAll(opts) {
    if (!ensureShadowDom()) return;
    const isZh = state.isZh;
    refs.root.className = `root ${state.isDark ? '' : 'light'}`;

    const a = state.computed.activeAnalysis;
    const occ = a ? a.occupancyPct : 0;

    // Edge Tab (默认关闭)
    const showEdge = !state.prefs.open && state.prefs.showEdgeTab;
    refs.edgeTab.className = `edge-tab ${showEdge ? '' : 'hidden'}`;
    refs.edgeTab.style.top = `${state.prefs.edgeTopPct}%`;
    refs.edgePct.textContent = a && a.latestContextTokens > 0 ? `${Math.round(occ)}%` : '--';
    refs.edgeBarFill.style.height = `${Math.min(100, Math.max(4, occ)).toFixed(0)}%`;
    if (occ >= state.prefs.criticalThresholdPct) {
      refs.edgeDot.className = 'edge-dot crit';
      refs.edgeBarFill.style.background = 'var(--red)';
    } else if (occ >= state.prefs.warnThresholdPct) {
      refs.edgeDot.className = 'edge-dot warn';
      refs.edgeBarFill.style.background = 'var(--amber)';
    } else {
      refs.edgeDot.className = 'edge-dot';
      refs.edgeBarFill.style.background = 'var(--green)';
    }

    // Sidebar geometry & header
    applySidebarGeometry();
    refs.hdrTitle.textContent = isZh ? '上下文洞察' : 'Context Doctor';
    if (refs.newTabPlusBtn) {
      refs.newTabPlusBtn.title = isZh ? '新建其他分页（打开启动器）' : 'Open new tab launcher';
    }

    if (a && a.isPinnedOther) {
      refs.pinBtn.style.display = 'inline-flex';
      refs.pinBtn.textContent = isZh ? '← 回到当前会话' : '← Active';
    } else {
      refs.pinBtn.style.display = 'none';
    }

    renderGaugeBox();
    renderTabs();
    const activeEl = shadowRootRef && shadowRootRef.activeElement;
    const isEditingInBody = !!(
      opts &&
      opts.fromPoll &&
      activeEl &&
      refs.body &&
      refs.body.contains &&
      refs.body.contains(activeEl) &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')
    );
    if (!isEditingInBody) {
      renderBody();
    }
    renderSettingsPopover();
    renderToastOnly();
    syncPluginsMenuInjection();
    syncAuxTabInStrip();
  }

  function installGlobalShortcut() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault();
          if (state.prefs.open) {
            if (locateNativeAuxTabStrip().found) {
              switchAwayFromContextDoctor();
            } else {
              closeContextDoctor();
            }
          } else {
            openContextDoctorInPane(true);
          }
        }
      },
      true
    );
  }

  function boot() {
    bootstrapRpcTap();
    installGlobalShortcut();
    installAuxPaneWatcher();
    recomputeState();
    renderAll();

    setTimeout(() => {
      refreshTargetSession(true).then(() => refreshGlobalInsights());
    }, 250);
    setTimeout(() => {
      if (!state.lastUpdatedAt || state.generatorCache.size === 0) {
        refreshTargetSession(true);
      }
    }, 1600);
    setTimeout(() => {
      if (!state.lastUpdatedAt || state.generatorCache.size === 0) {
        refreshTargetSession(true).then(() => refreshGlobalInsights());
      }
    }, 4200);

    setInterval(() => {
      if (state.prefs.open || !state.lastUpdatedAt) {
        refreshTargetSession(false);
      }
    }, ACTIVE_POLL_MS);

    setInterval(() => {
      if (state.prefs.open && state.prefs.activeTab === 'insights') {
        refreshGlobalInsights();
      }
    }, GLOBAL_POLL_MS);
  }

  // 暴露单元测试 API
  window.__AGY_CONTEXT_DOCTOR_TEST_API__ = {
    resolveModelContextLimit,
    estimateTokensFromText,
    parseGeneratorCalls,
    extractStepsFromTrajectoryResponse,
    classifyStep,
    analyzeTrajectorySteps,
    buildContextInsights,
    diagnoseContextHealth,
    generateHandoffPrompt,
    formatTokens,
    formatBytes,
    locateNativeAuxTabStrip,
    locateNativeAuxPane,
    syncPluginsMenuInjection,
    syncAuxTabInStrip,
    openContextDoctorInPane,
    switchAwayFromContextDoctor,
    closeContextDoctor,
    getState: () => state,
    renderAll,
    recomputeState,
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
