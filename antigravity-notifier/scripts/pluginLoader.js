"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachWebContents = attachWebContents;
exports.translateTrayItem = translateTrayItem;
exports.translateTrayItems = translateTrayItems;
exports.formatTrayAgentCount = formatTrayAgentCount;
exports.getActiveUiPlugins = getActiveUiPlugins;
exports.resolveSafePluginFile = resolveSafePluginFile;
exports.mergeUsageHistory = mergeUsageHistory;

const electron_1 = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

function stripJsonComments(text) {
    let out = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
                out += ch;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += ch;
            if (escaped) {
                escaped = false;
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
        }
        else if (ch === "/" && next === "/") {
            inLineComment = true;
            i++;
        }
        else if (ch === "/" && next === "*") {
            inBlockComment = true;
            i++;
        }
        else {
            out += ch;
        }
    }
    return out.replace(/,\s*([}\]])/g, "$1");
}

function readJsonSafe(filePath, isJsonc = false) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(isJsonc ? stripJsonComments(raw) : raw);
    }
    catch {
        return null;
    }
}

function writePluginLog(pluginPath, message) {
    try {
        const logPath = path.join(pluginPath, "runtime", "loader.log");
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > 65536) {
            fs.writeFileSync(logPath, "", "utf8");
        }
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
    }
    catch {
        // Ignore logging errors
    }
}

function resolveSafePluginFile(pluginPath, relPath) {
    if (typeof relPath !== "string" || !relPath.trim()) {
        return null;
    }
    const base = path.resolve(pluginPath);
    const target = path.resolve(base, relPath);
    if (target !== base && !target.startsWith(base + path.sep)) {
        return null;
    }
    return target;
}

function getActiveUiPlugins() {
    const geminiConfigDir = path.join(os.homedir(), ".gemini", "config");
    const pluginsRoot = path.join(geminiConfigDir, "plugins");
    if (!fs.existsSync(pluginsRoot)) {
        return [];
    }
    const config = readJsonSafe(path.join(geminiConfigDir, "config.json")) || {};
    const configPlugins = config && typeof config.plugins === "object" && config.plugins ? config.plugins : {};
    const result = [];
    let entries;
    try {
        entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const dirName = entry.name;
        const pluginPath = path.join(pluginsRoot, dirName);
        const manifest = readJsonSafe(path.join(pluginPath, "plugin.json"), true) || {};
        const userSetting = configPlugins[dirName] || (typeof manifest.name === "string" ? configPlugins[manifest.name] : undefined);
        const enabled = typeof userSetting?.enabled === "boolean"
            ? userSetting.enabled
            : manifest.disabled !== true;
        if (!enabled) {
            continue;
        }

        let dict = null;
        let engineCode = null;
        const enginePath = path.join(pluginPath, "runtime", "i18n-engine.js");
        const dictPath = path.join(pluginPath, "runtime", "zh-CN.json");
        if (fs.existsSync(enginePath) && fs.existsSync(dictPath)) {
            const loadedDict = readJsonSafe(dictPath, false);
            if (loadedDict) {
                try {
                    engineCode = fs.readFileSync(enginePath, "utf8");
                    dict = loadedDict;
                }
                catch {
                    // Skip unreadable i18n engine
                }
            }
        }

        const uiScriptPaths = [];
        if (Array.isArray(manifest.uiScripts)) {
            for (const rel of manifest.uiScripts) {
                const resolved = resolveSafePluginFile(pluginPath, rel);
                if (resolved) {
                    uiScriptPaths.push({ rel, fullPath: resolved });
                }
            }
        }
        else if (typeof manifest.uiEntry === "string") {
            const resolved = resolveSafePluginFile(pluginPath, manifest.uiEntry);
            if (resolved) {
                uiScriptPaths.push({ rel: manifest.uiEntry, fullPath: resolved });
            }
        }
        else {
            const defaultWidget = path.join(pluginPath, "runtime", "ui-widget.js");
            if (fs.existsSync(defaultWidget)) {
                uiScriptPaths.push({ rel: "runtime/ui-widget.js", fullPath: defaultWidget });
            }
        }

        const uiScripts = [];
        for (const item of uiScriptPaths) {
            if (!fs.existsSync(item.fullPath)) {
                continue;
            }
            try {
                uiScripts.push({
                    rel: item.rel,
                    code: fs.readFileSync(item.fullPath, "utf8"),
                });
            }
            catch {
                // Skip unreadable UI widget script
            }
        }

        if ((dict && engineCode) || uiScripts.length > 0) {
            result.push({ dirName, pluginPath, dict, engineCode, uiScripts });
        }
    }
    return result;
}

function getMergedTrayDict() {
    const active = getActiveUiPlugins();
    const merged = {};
    for (const plugin of active) {
        if (plugin.dict && typeof plugin.dict.tray === "object" && plugin.dict.tray) {
            Object.assign(merged, plugin.dict.tray);
        }
    }
    return Object.keys(merged).length > 0 ? merged : null;
}

function translateTrayItem(item, trayDict = null) {
    if (!item || typeof item !== "object") {
        return item;
    }
    const dict = trayDict ?? getMergedTrayDict();
    if (!dict) {
        return item;
    }
    const copy = { ...item };
    if (typeof copy.label === "string" && typeof dict[copy.label] === "string") {
        copy.label = dict[copy.label];
    }
    if (Array.isArray(copy.submenu)) {
        copy.submenu = copy.submenu.map((sub) => translateTrayItem(sub, dict));
    }
    return copy;
}

function translateTrayItems(items) {
    if (!Array.isArray(items)) {
        return items;
    }
    const dict = getMergedTrayDict();
    if (!dict) {
        return items;
    }
    return items.map((item) => translateTrayItem(item, dict));
}

function formatTrayAgentCount(count) {
    const dict = getMergedTrayDict();
    if (!dict) {
        return null;
    }
    if (count > 0 && typeof dict.agents_running === "string") {
        return dict.agents_running.replace("{count}", String(count));
    }
    if (count === 0 && typeof dict["No agents running"] === "string") {
        return dict["No agents running"];
    }
    return null;
}

function isHubUiUrl(url) {
    if (!url || typeof url !== "string") {
        return false;
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) {
        return true;
    }
    const devUrl = process.env.DEV_URL;
    if (devUrl && url.startsWith(devUrl)) {
        return true;
    }
    return false;
}

const EARLY_RPC_TAP_CODE = `(function(){
try{
  if(window.__AGY_EARLY_RPC_TAP__) return;
  window.__AGY_EARLY_RPC_TAP__ = true;
  var H = window.__AGY_CAPTURED_LS_HEADERS__ = window.__AGY_CAPTURED_LS_HEADERS__ || {};
  var C = window.__AGY_CAPTURED_LS_CACHE__ = window.__AGY_CAPTURED_LS_CACHE__ || {};
  var PREFIX = '/exa.language_server_pb.LanguageServerService/';
  var METHODS = {
    GetUserStatus:1,
    RetrieveUserQuotaSummary:1,
    GetAvailableModels:1,
    GetCascadeModelConfigData:1,
    GetCascadeModelConfigs:1,
    GetUserAnalyticsSummary:1,
    GetAllCascadeTrajectories:1,
    GetCascadeTrajectoryGeneratorMetadata:1
  };
  var CASCADE_METHODS = {
    GetCascadeTrajectory:1,
    GetCascadeTrajectorySteps:1,
    GetCascadeTrajectoryGeneratorMetadata:1,
    GetCascadeTrajectoryExecutorMetadatas:1,
    GetTrajectoryTurns:1,
    SendUserCascadeMessage:1,
    StreamUserTrajectoryReactiveUpdates:1
  };
  function scanCascadeId(method, body){
    if(!method || !CASCADE_METHODS[method] || !body) return;
    try{
      var cid = '';
      if(typeof body === 'string'){
        var trimmed = body.trim();
        if(trimmed.charAt(0) === '{'){
          var obj = JSON.parse(trimmed);
          cid = (obj && (obj.cascadeId || obj.trajectoryId || obj.conversationId)) || '';
        }
        if(!cid){
          var m = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if(m) cid = m[0];
        }
      }else if(typeof Uint8Array !== 'undefined' && (body instanceof Uint8Array || ArrayBuffer.isView(body))){
        var view = new Uint8Array(body.buffer, body.byteOffset, Math.min(body.byteLength, 512));
        var txt = '';
        for(var i=0;i<view.length;i++){
          var ch = view[i];
          txt += (ch >= 32 && ch <= 126) ? String.fromCharCode(ch) : ' ';
        }
        var mb = txt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if(mb) cid = mb[0];
      }
      if(cid && window.__AGY_CAPTURED_CASCADE_ID__ !== cid){
        window.__AGY_CAPTURED_CASCADE_ID__ = cid;
        if(typeof window.__AGY_ON_CASCADE_CHANGE__ === 'function'){
          try{ window.__AGY_ON_CASCADE_CHANGE__(cid, method); }catch(_){}
        }
      }
    }catch(_){}
  }
  function keepHeader(k, v){
    if(!k || v === undefined || v === null) return;
    var l = String(k).toLowerCase();
    if(l === 'x-codeium-ui-token' || l === 'x-codeium-csrf-token' || l === 'authorization' || l === 'x-requested-with' || l === 'connect-protocol-version'){
      var changed = H[l] !== String(v);
      H[l] = String(v);
      if(changed && typeof window.__AGY_ON_RPC_HEADERS__ === 'function'){
        try{ window.__AGY_ON_RPC_HEADERS__(H); }catch(_){}
      }
    }
  }
  function scanHeaders(hdrs){
    if(!hdrs) return;
    try{
      if(typeof hdrs.forEach === 'function'){
        hdrs.forEach(function(v, k){ keepHeader(k, v); });
      }else if(Array.isArray(hdrs)){
        for(var i=0;i<hdrs.length;i++){
          if(Array.isArray(hdrs[i]) && hdrs[i].length>=2) keepHeader(hdrs[i][0], hdrs[i][1]);
        }
      }else if(typeof hdrs === 'object'){
        var ks = Object.keys(hdrs);
        for(var j=0;j<ks.length;j++) keepHeader(ks[j], hdrs[ks[j]]);
      }
    }catch(_){}
  }
  if(typeof window.fetch === 'function'){
    var origFetch = window.fetch;
    window.fetch = function(input, init){
      var url = '';
      try{ url = typeof input === 'string' ? input : (input && input.url) || ''; }catch(_){}
      var idx = url.indexOf(PREFIX);
      var method = idx !== -1 ? url.slice(idx + PREFIX.length).split('?')[0] : '';
      if(idx !== -1){
        if(input && typeof input === 'object' && input.headers) scanHeaders(input.headers);
        if(init && init.headers) scanHeaders(init.headers);
        if(init && init.body) scanCascadeId(method, init.body);
      }
      var p = origFetch.apply(this, arguments);
      if(method && METHODS[method] && p && typeof p.then === 'function'){
        p.then(function(resp){
          if(!resp || !resp.ok || typeof resp.clone !== 'function') return;
          var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
          if(ct.indexOf('json') === -1) return;
          return resp.clone().json().then(function(data){
            C[method] = data;
            if(typeof window.__AGY_ON_RPC_DATA__ === 'function'){
              try{ window.__AGY_ON_RPC_DATA__(method, data); }catch(_){}
            }
          });
        }).catch(function(){});
      }
      return p;
    };
  }
  if(typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype){
    var origOpen = window.XMLHttpRequest.prototype.open;
    var origSetHeader = window.XMLHttpRequest.prototype.setRequestHeader;
    var origSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function(m, u){
      try{ this.__agyUrl = typeof u === 'string' ? u : String(u || ''); }catch(_){}
      return origOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.setRequestHeader = function(k, v){
      try{
        if(this.__agyUrl && this.__agyUrl.indexOf(PREFIX) !== -1) keepHeader(k, v);
      }catch(_){}
      return origSetHeader.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function(body){
      try{
        var u = this.__agyUrl || '';
        var idx = u.indexOf(PREFIX);
        if(idx !== -1){
          var method = u.slice(idx + PREFIX.length).split('?')[0];
          if(body) scanCascadeId(method, body);
          if(METHODS[method] && typeof this.addEventListener === 'function'){
            this.addEventListener('load', function(){
              try{
                if(this.status >= 200 && this.status < 300 && typeof this.responseText === 'string'){
                  var ct = this.getResponseHeader && this.getResponseHeader('content-type') || '';
                  if(ct.indexOf('json') !== -1){
                    var data = JSON.parse(this.responseText);
                    C[method] = data;
                    if(typeof window.__AGY_ON_RPC_DATA__ === 'function'){
                      window.__AGY_ON_RPC_DATA__(method, data);
                    }
                  }
                }
              }catch(_){}
            });
          }
        }
      }catch(_){}
      return origSend.apply(this, arguments);
    };
  }
}catch(_){}
})();`;

function createEmptyUsageHistory() {
    return {
        version: 1,
        updatedAt: "",
        totals: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            turns: 0,
        },
        byModel: {},
        daily: {},
        sessions: {},
        events: [],
    };
}

function readUsageHistorySafe(pluginPath) {
    const filePath = path.join(pluginPath, "runtime", "usage-history.json");
    const parsed = readJsonSafe(filePath, false);
    if (!parsed || typeof parsed !== "object") {
        return createEmptyUsageHistory();
    }
    return {
        version: 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        totals: parsed.totals && typeof parsed.totals === "object" ? parsed.totals : createEmptyUsageHistory().totals,
        byModel: parsed.byModel && typeof parsed.byModel === "object" ? parsed.byModel : {},
        daily: parsed.daily && typeof parsed.daily === "object" ? parsed.daily : {},
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
        events: Array.isArray(parsed.events) ? parsed.events : [],
    };
}

function mergeUsageHistory(existing, batch) {
    const base = existing && typeof existing === "object" ? existing : createEmptyUsageHistory();
    const events = Array.isArray(base.events) ? [...base.events] : [];
    const byModel = base.byModel && typeof base.byModel === "object" ? { ...base.byModel } : {};
    const daily = base.daily && typeof base.daily === "object" ? { ...base.daily } : {};
    const sessions = base.sessions && typeof base.sessions === "object" ? { ...base.sessions } : {};
    const totals = base.totals && typeof base.totals === "object"
        ? { ...createEmptyUsageHistory().totals, ...base.totals }
        : createEmptyUsageHistory().totals;

    const indexByKey = new Map();
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev && ev.cascadeId && ev.executionId) {
            indexByKey.set(`${ev.cascadeId}::${ev.executionId}`, i);
        }
    }

    const incomingEvents = batch && Array.isArray(batch.events) ? batch.events : [];
    let changed = false;
    const applyDelta = (bucket, ev, sign) => {
        bucket.totalTokens = Math.max(0, (bucket.totalTokens || 0) + sign * (Number(ev.totalTokens) || 0));
        bucket.inputTokens = Math.max(0, (bucket.inputTokens || 0) + sign * (Number(ev.inputTokens) || 0));
        bucket.outputTokens = Math.max(0, (bucket.outputTokens || 0) + sign * (Number(ev.outputTokens) || 0));
        bucket.thinkingTokens = Math.max(0, (bucket.thinkingTokens || 0) + sign * (Number(ev.thinkingTokens) || 0));
        bucket.cacheReadTokens = Math.max(0, (bucket.cacheReadTokens || 0) + sign * (Number(ev.cacheReadTokens) || 0));
    };

    for (const rawEv of incomingEvents) {
        if (!rawEv || typeof rawEv !== "object" || !rawEv.cascadeId || !rawEv.executionId) {
            continue;
        }
        const ev = {
            ts: typeof rawEv.ts === "string" && rawEv.ts ? rawEv.ts : new Date().toISOString(),
            cascadeId: String(rawEv.cascadeId),
            executionId: String(rawEv.executionId),
            model: String(rawEv.model || "unknown"),
            modelEnum: String(rawEv.modelEnum || ""),
            inputTokens: Math.max(0, Number(rawEv.inputTokens) || 0),
            outputTokens: Math.max(0, Number(rawEv.outputTokens) || 0),
            thinkingTokens: Math.max(0, Number(rawEv.thinkingTokens) || 0),
            cacheReadTokens: Math.max(0, Number(rawEv.cacheReadTokens) || 0),
            totalTokens: Math.max(0, Number(rawEv.totalTokens) || 0),
            streamingSec: Math.max(0, Number(rawEv.streamingSec) || 0),
            tps: typeof rawEv.tps === "number" && Number.isFinite(rawEv.tps) ? Number(rawEv.tps.toFixed(2)) : null,
        };
        const key = `${ev.cascadeId}::${ev.executionId}`;
        const prevIdx = indexByKey.get(key);
        const dateKey = ev.ts.slice(0, 10);

        if (prevIdx !== undefined) {
            const prev = events[prevIdx];
            if (
                prev.totalTokens === ev.totalTokens &&
                prev.outputTokens === ev.outputTokens &&
                prev.tps === ev.tps &&
                prev.model === ev.model
            ) {
                continue;
            }
            applyDelta(totals, prev, -1);
            if (prev.model && byModel[prev.model]) {
                applyDelta(byModel[prev.model], prev, -1);
            }
            const prevDate = typeof prev.ts === "string" ? prev.ts.slice(0, 10) : dateKey;
            if (daily[prevDate]) {
                applyDelta(daily[prevDate], prev, -1);
            }
            events[prevIdx] = ev;
        }
        else {
            indexByKey.set(key, events.length);
            events.push(ev);
            totals.turns = (totals.turns || 0) + 1;
            if (!daily[dateKey]) {
                daily[dateKey] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, turns: 0 };
            }
            daily[dateKey].turns = (daily[dateKey].turns || 0) + 1;
        }

        applyDelta(totals, ev, 1);
        if (!byModel[ev.model]) {
            byModel[ev.model] = {
                modelEnum: ev.modelEnum,
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                thinkingTokens: 0,
                cacheReadTokens: 0,
                tpsSum: 0,
                tpsSamples: 0,
                avgTps: null,
                lastUsedAt: ev.ts,
            };
        }
        const mEntry = byModel[ev.model];
        if (ev.modelEnum && !mEntry.modelEnum) {
            mEntry.modelEnum = ev.modelEnum;
        }
        applyDelta(mEntry, ev, 1);
        mEntry.lastUsedAt = ev.ts;
        if (ev.tps !== null && ev.tps > 0 && prevIdx === undefined) {
            mEntry.tpsSum = (mEntry.tpsSum || 0) + ev.tps;
            mEntry.tpsSamples = (mEntry.tpsSamples || 0) + 1;
            mEntry.avgTps = Number((mEntry.tpsSum / mEntry.tpsSamples).toFixed(2));
        }

        if (!daily[dateKey]) {
            daily[dateKey] = { totalTokens: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, turns: 0 };
        }
        applyDelta(daily[dateKey], ev, 1);
        changed = true;
    }

    const incomingSessions = batch && batch.sessions && typeof batch.sessions === "object" ? batch.sessions : null;
    if (incomingSessions) {
        for (const [cid, snap] of Object.entries(incomingSessions)) {
            if (!cid || !snap || typeof snap !== "object") continue;
            const prev = sessions[cid];
            if (
                !prev ||
                prev.totalTokens !== snap.totalTokens ||
                prev.calls !== snap.calls ||
                prev.lastTps !== snap.lastTps
            ) {
                sessions[cid] = {
                    lastUpdatedAt: snap.lastUpdatedAt || new Date().toISOString(),
                    totalTokens: Number(snap.totalTokens) || 0,
                    inputTokens: Number(snap.inputTokens) || 0,
                    outputTokens: Number(snap.outputTokens) || 0,
                    calls: Number(snap.calls) || 0,
                    lastTurnTokens: Number(snap.lastTurnTokens) || 0,
                    lastTps: typeof snap.lastTps === "number" ? snap.lastTps : null,
                };
                changed = true;
            }
        }
    }

    if (!changed) {
        return null;
    }

    const MAX_EVENTS = 2000;
    const trimmedEvents = events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        totals,
        byModel,
        daily,
        sessions,
        events: trimmedEvents,
    };
}

function writeUsageHistoryAtomic(pluginPath, data) {
    try {
        const runtimeDir = path.join(pluginPath, "runtime");
        fs.mkdirSync(runtimeDir, { recursive: true });
        const dst = path.join(runtimeDir, "usage-history.json");
        const tmp = `${dst}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
        if (fs.existsSync(dst)) {
            fs.unlinkSync(dst);
        }
        fs.renameSync(tmp, dst);
    }
    catch {
        // Ignore persistence write errors
    }
}

function attachWebContents(contents) {
    if (!contents || typeof contents.on !== "function") {
        return;
    }
    if (typeof contents.getType === "function" && contents.getType() !== "window") {
        return;
    }
    let usagePluginPath = null;
    let flushInFlight = false;
    const flushPendingHistory = () => {
        if (!usagePluginPath || flushInFlight || contents.isDestroyed?.()) {
            return;
        }
        flushInFlight = true;
        void Promise.resolve(
            contents.executeJavaScript(
                "(function(){return typeof window.__AGY_DRAIN_USAGE_HISTORY__==='function'?window.__AGY_DRAIN_USAGE_HISTORY__():null;})()",
                true
            )
        )
            .then((batch) => {
                if (batch && typeof batch === "object") {
                    const existing = readUsageHistorySafe(usagePluginPath);
                    const merged = mergeUsageHistory(existing, batch);
                    if (merged) {
                        writeUsageHistoryAtomic(usagePluginPath, merged);
                    }
                }
            })
            .catch(() => {})
            .finally(() => {
                flushInFlight = false;
            });
    };
    const flushTimer = setInterval(flushPendingHistory, 5000);
    if (flushTimer && typeof flushTimer.unref === "function") {
        flushTimer.unref();
    }
    contents.on("destroyed", () => {
        clearInterval(flushTimer);
    });
    contents.on("will-navigate", () => {
        flushPendingHistory();
    });
    contents.on("did-commit-load", (_event, url, _isInPlace, isMainFrame) => {
        if (isMainFrame === false || !isHubUiUrl(url)) {
            return;
        }
        const plugins = getActiveUiPlugins();
        if (plugins.some((p) => Array.isArray(p.uiScripts) && p.uiScripts.length > 0)) {
            void Promise.resolve(contents.executeJavaScript(EARLY_RPC_TAP_CODE, true)).catch(() => {});
        }
    });
    contents.on("dom-ready", () => {
        const url = typeof contents.getURL === "function" ? contents.getURL() : "";
        if (!isHubUiUrl(url)) {
            return;
        }
        const plugins = getActiveUiPlugins();
        if (plugins.length === 0) {
            return;
        }
        let appVersion = "unknown";
        try {
            if (electron_1 && electron_1.app && typeof electron_1.app.getVersion === "function") {
                appVersion = electron_1.app.getVersion();
            }
        }
        catch {
            // Ignore version lookup error
        }
        for (const p of plugins) {
            if (p.dict && p.engineCode) {
                const i18nCode = `(function(){\ntry{\nwindow.__AGY_PLUGIN_I18N_DICT__ = ${JSON.stringify(p.dict)};\n${p.engineCode}\n}catch(err){console.warn('[AgyPluginLoader]', err);}\n})();`;
                void Promise.resolve(contents.executeJavaScript(i18nCode, true))
                    .then(() => writePluginLog(p.pluginPath, `Injected ${p.dirName} (app v${appVersion}) into ${url}`))
                    .catch((err) => writePluginLog(p.pluginPath, `Inject error for ${p.dirName} (app v${appVersion}): ${err}`));
            }
            if (Array.isArray(p.uiScripts) && p.uiScripts.length > 0) {
                if (p.dirName === "antigravity-usage-dashboard") {
                    usagePluginPath = p.pluginPath;
                }
                const initHistory = p.dirName === "antigravity-usage-dashboard"
                    ? readUsageHistorySafe(p.pluginPath)
                    : null;
                for (const script of p.uiScripts) {
                    const meta = JSON.stringify({ id: p.dirName, rel: script.rel, appVersion });
                    const historyInitStmt = initHistory
                        ? `window.__AGY_USAGE_HISTORY_INIT__ = ${JSON.stringify(initHistory)};\n`
                        : "";
                    const widgetCode = `(function(){\ntry{\nwindow.__AGY_PLUGIN_META__ = ${meta};\n${historyInitStmt}${script.code}\n}catch(err){console.warn('[AgyPluginLoader]', err);}\n})();`;
                    void Promise.resolve(contents.executeJavaScript(widgetCode, true))
                        .then(() => writePluginLog(p.pluginPath, `Injected UI script ${p.dirName}:${script.rel} (app v${appVersion}) into ${url}`))
                        .catch((err) => writePluginLog(p.pluginPath, `Inject UI script error for ${p.dirName}:${script.rel} (app v${appVersion}): ${err}`));
                }
            }
        }
    });
}
