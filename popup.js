/** 两个用量数据源，统一转换成卡片渲染所需的数据。 */
const providers = {
  opencode: {
    key: 'opencode',
    serverId: 'c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd',
    // 读取当前工作区并确认登录状态。
    async getConfig() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let workspaceId = tab?.url?.match(/https:\/\/opencode\.ai\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/)?.[1];
      if (workspaceId) await chrome.storage.local.set({ opencodeWorkspaceId: workspaceId });
      else ({ opencodeWorkspaceId: workspaceId } = await chrome.storage.local.get('opencodeWorkspaceId'));
      if (!workspaceId) throw Error('请先打开一次 OpenCode 工作区用量页');
      if (!await chrome.cookies.get({ url: 'https://opencode.ai/', name: 'auth' })) throw Error('未找到 OpenCode 登录信息');
      return { workspaceId };
    },
    // OpenCode 使用内部 server function 参数，响应为序列化文本。
    async loadUsage({ workspaceId }) {
      const args = { t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceId }], o: 0 }, f: 31, m: [] };
      const url = `https://opencode.ai/_server?id=${this.serverId}&args=${encodeURIComponent(JSON.stringify(args))}`;
      const response = await fetch(url, { credentials: 'include', headers: { 'x-server-instance': 'server-fn:3' } });
      if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? '登录状态已失效，请重新登录' : `请求失败（${response.status}）`);
      return parseOpenCode(await response.text());
    },
  },
  command: {
    key: 'command',
    // Command Code 不需要 workspaceId，只需检查会话 Cookie。
    async getConfig() {
      const session = await chrome.cookies.get({ url: 'https://api.commandcode.ai/', name: '__Secure-commandcode_prod_.session_token' });
      if (!session) throw Error('未找到 Command Code 登录信息，请先登录');
      return {};
    },
    // Command Code 返回标准 JSON，直接转换为窗口和积分数据。
    async loadUsage() {
      const response = await fetch('https://api.commandcode.ai/internal/billing/credits', { credentials: 'include', headers: { accept: '*/*' } });
      if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? '登录状态已失效，请重新登录' : `请求失败（${response.status}）`);
      return parseCommand(await response.json());
    },
  },
};

const refreshButton = document.querySelector('#refresh');
const WARN_THRESHOLD = 60;
const HIGH_THRESHOLD = 80;

/**
 * 根据用量百分比计算状态等级。
 * @param {number} percent 用量百分比
 * @returns {'ok'|'warn'|'high'} 状态等级
 */
function usageTone(percent) { return percent >= HIGH_THRESHOLD ? 'high' : percent >= WARN_THRESHOLD ? 'warn' : 'ok'; }

/**
 * 把剩余秒数转换为中文倒计时。
 * @param {number|string} seconds 剩余秒数
 * @returns {string} 中文倒计时文案
 */
function formatRemaining(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '重置时间未知';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.max(1, Math.floor((value % 3600) / 60));
  if (days) return `将在 ${days} 天 ${hours} 小时后重置`;
  if (hours) return `将在 ${hours} 小时 ${minutes} 分钟后重置`;
  return `将在 ${minutes} 分钟后重置`;
}

/**
 * 将毫秒时间戳转换为相对重置倒计时。
 * @param {number|string} timestamp 重置时间戳
 * @returns {string} 中文倒计时文案
 */
function formatResetAt(timestamp) { return formatRemaining((Number(timestamp) - Date.now()) / 1000); }

/**
 * 更新指定卡片的状态指示器。
 * @param {string} key provider 标识
 * @param {string} text 状态文案
 * @param {string} state CSS 状态类名
 * @returns {void}
 */
function setStatus(key, text, state) {
  const element = document.querySelector(`#status-${key}`);
  element.textContent = text;
  element.className = `status ${state}`;
}

/**
 * 渲染卡片；detailRight 用于显示窗口的数字用量。
 * @param {string} key provider 标识
 * @param {Array<Object>} items 用量项目
 * @returns {void}
 */
function renderUsage(key, items) {
  const list = document.querySelector(`#usage-list-${key}`);
  list.replaceChildren(...items.map((item) => {
    const percent = Math.max(0, Math.min(100, Number(item.usagePercent) || 0));
    const detail = item.detail ?? (item.noBar ? '' : formatRemaining(item.resetInSec));
    const row = document.createElement('div');
    row.className = `usage-item tone-${usageTone(percent)}${item.noBar ? ' no-bar' : ''}`;
    row.innerHTML = `<div class="usage-label"><span>${item.label}</span><strong>${item.valueText || `${percent.toFixed(percent % 1 ? 1 : 0)}%`}</strong></div>${item.noBar ? '' : `<div class="track"><div class="fill" style="width:${percent}%"></div></div>`}${detail || item.detailRight ? `<div class="usage-meta">${detail ? `<small>${detail}</small>` : ''}${item.detailRight ? `<small>${item.detailRight}</small>` : ''}</div>` : ''}`;
    return row;
  }));
}

/**
 * 展示指定卡片的错误，并清空旧数据。
 * @param {string} key provider 标识
 * @param {string} message 错误信息
 * @returns {void}
 */
function showError(key, message) {
  setStatus(key, '失败', 'error');
  document.querySelector(`#usage-list-${key}`).replaceChildren();
  document.querySelector(`#error-message-${key}`).textContent = message;
  document.querySelector(`#error-${key}`).hidden = false;
}

/**
 * 解析 OpenCode 的序列化响应，兼容 $R[n] 引用。
 * @param {string} text 接口响应文本
 * @returns {Array<Object>} 用量项目
 */
function parseOpenCode(text) {
  const labels = { rollingUsage: '🔄 滚动用量', weeklyUsage: '📅 每周用量', monthlyUsage: '🗓️ 每月用量' };
  const result = [];
  for (const [key, label] of Object.entries(labels)) {
    let section = new RegExp(`${key}:\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(text)?.[1];
    if (!section) {
      const reference = new RegExp(`${key}:\\s*\\$R\\[(\\d+)\\]`).exec(text)?.[1];
      if (reference) section = new RegExp(`\\$R\\[${reference}\\]\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(text)?.[1];
    }
    const usagePercent = /usagePercent:\s*([0-9.]+)/.exec(section || '')?.[1];
    const resetInSec = /resetInSec:\s*([0-9.]+)/.exec(section || '')?.[1];
    if (usagePercent !== undefined && resetInSec !== undefined) result.push({ label, usagePercent, resetInSec });
  }
  if (result.length !== 3) throw Error('接口返回格式异常');
  return result;
}

/**
 * 解析 Command Code credits 接口响应。
 * @param {Object} data 接口返回对象
 * @returns {Array<Object>} 卡片用量项目
 */
function parseCommand(data) {
  const windows = data?.windowLimits;
  const credits = data?.credits;
  if (!windows?.fiveHour || !windows?.weekly || !credits) throw Error('接口返回格式异常');
  const fiveHourPercent = windows.fiveHour.used / windows.fiveHour.cap * 100;
  const weeklyPercent = windows.weekly.used / windows.weekly.cap * 100;
  return [
    { label: '⏱ 5 小时窗口', usagePercent: fiveHourPercent, valueText: `${fiveHourPercent.toFixed(1)}%`, detail: formatResetAt(windows.fiveHour.resetAt), detailRight: `${windows.fiveHour.used.toFixed(2)} / ${windows.fiveHour.cap}` },
    { label: '📅 每周窗口', usagePercent: weeklyPercent, valueText: `${weeklyPercent.toFixed(1)}%`, detail: formatResetAt(windows.weekly.resetAt), detailRight: `${windows.weekly.used.toFixed(2)} / ${windows.weekly.cap}` },
    { label: '✦ 月度积分余额', noBar: true, valueText: Number(credits.monthlyCredits).toFixed(2) },
  ];
}

/**
 * 加载并渲染单个 provider。
 * @param {Object} provider provider 配置
 * @returns {Promise<void>} 加载完成后的异步任务
 */
async function loadProvider(provider) {
  setStatus(provider.key, '加载中', 'loading');
  try {
    document.querySelector(`#error-${provider.key}`).hidden = true;
    renderUsage(provider.key, await provider.loadUsage(await provider.getConfig()));
    setStatus(provider.key, '正常', 'ok');
  } catch (error) {
    showError(provider.key, error.message || '加载失败');
  }
}

/** 统一刷新两张卡片，防止重复点击产生并发请求。 */
/**
 * 并行刷新所有 provider 卡片。
 * @returns {Promise<void>} 刷新完成后的异步任务
 */
async function refresh() {
  if (refreshButton.disabled) return;
  refreshButton.disabled = true;
  await Promise.all(Object.values(providers).map(loadProvider));
  document.querySelector('#updated-at').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  refreshButton.disabled = false;
}

refreshButton.addEventListener('click', refresh);
refresh();
