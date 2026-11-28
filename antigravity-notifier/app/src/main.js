import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Antigravity Notifier', version: '2.0.0' }, {});

const state = {
  config: null,
  logs: [],
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
    const el = document.getElementById('nt-toast');
    if (el) el.classList.remove('show');
  }, 2400);
  const el = document.getElementById('nt-toast');
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

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  const c = state.config || {
    enabled: false,
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
  };
  const isTg = c.provider === 'telegram';

  root.innerHTML = `
    <div class="nt-shell">
      <div class="nt-top">
        <span class="nt-title">远程推送与任务通知</span>
        <span class="nt-status ${c.enabled ? 'on' : ''}">${c.enabled ? 'Webhook 已启用' : 'Webhook 未启用'}</span>
      </div>
      <div class="nt-body">
        <div class="nt-card">
          <div class="nt-card-title">Stop Hook 远程 Webhook 推送</div>
          <label class="nt-check"><input type="checkbox" id="nt-enabled" ${c.enabled ? 'checked' : ''} /> 启用远程 Webhook 推送</label>
          <div class="nt-field">
            <span class="nt-label">推送渠道</span>
            <select class="nt-select" id="nt-provider">
              <option value="feishu" ${c.provider === 'feishu' ? 'selected' : ''}>飞书机器人 (Feishu)</option>
              <option value="wecom" ${c.provider === 'wecom' ? 'selected' : ''}>企业微信机器人 (WeCom)</option>
              <option value="discord" ${c.provider === 'discord' ? 'selected' : ''}>Discord Webhook</option>
              <option value="telegram" ${c.provider === 'telegram' ? 'selected' : ''}>Telegram Bot</option>
              <option value="custom" ${c.provider === 'custom' ? 'selected' : ''}>自定义 JSON Webhook</option>
            </select>
          </div>
          ${
            isTg
              ? `<div class="nt-field"><span class="nt-label">Telegram Bot Token</span><input class="nt-input" id="nt-tg-token" value="${escapeHtml(c.telegramBotToken)}" placeholder="123456:ABC-DEF..." /></div>
                 <div class="nt-field"><span class="nt-label">Telegram Chat ID</span><input class="nt-input" id="nt-tg-chat" value="${escapeHtml(c.telegramChatId)}" placeholder="123456789" /></div>`
              : `<div class="nt-field"><span class="nt-label">Webhook URL</span><input class="nt-input" id="nt-url" value="${escapeHtml(c.webhookUrl)}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." /></div>
                 <div class="nt-field"><span class="nt-label">签名密钥 Secret（可选，飞书加签）</span><input class="nt-input" id="nt-secret" value="${escapeHtml(c.secret)}" placeholder="留空则不加签" /></div>`
          }
          <div class="nt-field">
            <span class="nt-label">消息标题前缀</span>
            <input class="nt-input" id="nt-prefix" value="${escapeHtml(c.titlePrefix || 'Antigravity')}" />
          </div>
          <div class="nt-checks">
            <label class="nt-check"><input type="checkbox" id="nt-on-done" ${c.notifyOnComplete ? 'checked' : ''} /> 任务完成时推送</label>
            <label class="nt-check"><input type="checkbox" id="nt-on-err" ${c.notifyOnError ? 'checked' : ''} /> 异常中断时推送</label>
            <label class="nt-check"><input type="checkbox" id="nt-on-limit" ${c.notifyOnMaxLimit ? 'checked' : ''} /> 达到上限时推送</label>
            <label class="nt-check"><input type="checkbox" id="nt-on-cancel" ${c.notifyOnCancel ? 'checked' : ''} /> 手动取消时推送</label>
          </div>
          <div class="nt-actions">
            <button type="button" class="nt-btn primary" id="nt-save-btn">保存配置</button>
            <button type="button" class="nt-btn" id="nt-test-btn">发送测试推送</button>
            <button type="button" class="nt-btn" id="nt-refresh-btn">刷新日志</button>
          </div>
        </div>
        <div class="nt-card">
          <div class="nt-card-title">最近推送日志 (${state.logs.length})</div>
          <div class="nt-log">${state.logs.length ? escapeHtml(state.logs.join('\n')) : '暂无推送记录。'}</div>
        </div>
      </div>
    </div>
    <div class="nt-toast ${state.toast ? 'show' : ''}" id="nt-toast">${escapeHtml(state.toast)}</div>
  `;

  document.getElementById('nt-provider').onchange = (e) => {
    state.config = { ...c, provider: e.target.value };
    render();
  };
  document.getElementById('nt-save-btn').onclick = async () => {
    const next = {
      ...c,
      enabled: Boolean(document.getElementById('nt-enabled')?.checked),
      provider: document.getElementById('nt-provider')?.value || 'feishu',
      webhookUrl: document.getElementById('nt-url')?.value ?? c.webhookUrl ?? '',
      secret: document.getElementById('nt-secret')?.value ?? c.secret ?? '',
      telegramBotToken: document.getElementById('nt-tg-token')?.value ?? c.telegramBotToken ?? '',
      telegramChatId: document.getElementById('nt-tg-chat')?.value ?? c.telegramChatId ?? '',
      titlePrefix: document.getElementById('nt-prefix')?.value || 'Antigravity',
      notifyOnComplete: Boolean(document.getElementById('nt-on-done')?.checked),
      notifyOnError: Boolean(document.getElementById('nt-on-err')?.checked),
      notifyOnMaxLimit: Boolean(document.getElementById('nt-on-limit')?.checked),
      notifyOnCancel: Boolean(document.getElementById('nt-on-cancel')?.checked),
    };
    try {
      const data = await callTool('app_save_config', { config: next });
      state.config = data.config;
      state.logs = data.logs || [];
      render();
      showToast('远程推送配置已保存');
    } catch (err) {
      showToast(err.message);
    }
  };
  document.getElementById('nt-test-btn').onclick = async () => {
    showToast('正在发送测试推送…');
    try {
      const data = await callTool('app_test_push', {});
      state.config = data.config || state.config;
      state.logs = data.logs || [];
      render();
      showToast(data.testResult?.message || '测试推送已触发');
    } catch (err) {
      showToast(err.message);
    }
  };
  document.getElementById('nt-refresh-btn').onclick = async () => {
    try {
      const data = await callTool('app_get_state', {});
      state.config = data.config;
      state.logs = data.logs || [];
      render();
    } catch (err) {
      showToast(err.message);
    }
  };
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
    state.config = res.structuredContent.config;
    state.logs = res.structuredContent.logs || [];
    render();
  }
};
app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function bootstrap() {
  render();
  try {
    await app.connect();
    applyTheme(app.getHostContext());
    if (!state.hasToolResult) {
      const data = await callTool('app_get_state', {});
      state.config = data.config;
      state.logs = data.logs || [];
      render();
    }
  } catch (err) {
    showToast(`连接宿主失败: ${err.message}`);
  }
}

bootstrap();
