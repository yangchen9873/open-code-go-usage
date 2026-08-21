// OpenCode Go Usage 弹窗逻辑。
// 打开时自动识别当前标签页的工作区，读取 Token 用量并渲染进度条。

const providers = {
  opencodeGo: {
    id: 'opencode-go',
    name: 'OpenCode Go',
    usagePageUrl: 'https://opencode.ai/go',
    // OpenCode 内部 server-function 的注册 ID，用于定位后端要执行的函数
    serverId: 'c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd',

    // 从当前标签页识别工作区，失败则回退到本地缓存
    async getConfig() {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let workspaceId = tab?.url?.match(/https:\/\/opencode\.ai\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/)?.[1];
      if (workspaceId) {
        await chrome.storage.local.set({ opencodeWorkspaceId: workspaceId });
      } else {
        ({ opencodeWorkspaceId: workspaceId } = await chrome.storage.local.get('opencodeWorkspaceId'));
      }
      if (!workspaceId) throw new Error('请先打开一次 OpenCode 工作区用量页');

      const authCookie = await chrome.cookies.get({ url: 'https://opencode.ai/', name: 'auth' });
      if (!authCookie) throw new Error('未找到 OpenCode 登录信息，请先登录');

      return { workspaceId };
    },

    async loadUsage({ workspaceId }) {
      const response = await fetch(this.endpoint(workspaceId), {
        credentials: 'include',
        headers: { 'x-server-instance': 'server-fn:3' },
      });
      if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效，请重新登录');
      if (!response.ok) throw new Error(`请求失败（${response.status}）`);
      return parseUsage(await response.text());
    },

    endpoint(workspaceId) {
      const args = { t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceId }], o: 0 }, f: 31, m: [] };
      return `https://opencode.ai/_server?id=${this.serverId}&args=${encodeURIComponent(JSON.stringify(args))}`;
    },
  },
};

const activeProvider = providers.opencodeGo;

const elements = {
  refresh: document.querySelector('#refresh'),
  status: document.querySelector('#status'),
  usageList: document.querySelector('#usage-list'),
  updatedAt: document.querySelector('#updated-at'),
  error: document.querySelector('#error'),
  errorMessage: document.querySelector('#error-message'),
  errorLink: document.querySelector('#error-link'),
};

let refreshInProgress = false;

// 用量预警阈值
const WARN_THRESHOLD = 60;
const HIGH_THRESHOLD = 80;

// 根据用量百分比返回警示级别：>=80 高危，>=60 警示，否则正常
function usageTone(percent) {
  if (percent >= HIGH_THRESHOLD) return 'high';
  if (percent >= WARN_THRESHOLD) return 'warn';
  return 'ok';
}

// 将剩余秒数格式化为重置倒计时文案
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

// 更新状态指示与刷新按钮加载态
function setStatus(text, state) {
  elements.status.textContent = text;
  elements.status.className = `status ${state}`;
  elements.refresh.classList.toggle('is-loading', state === 'loading');
}

// 将用量数据渲染为进度条列表
function renderUsage(items) {
  elements.usageList.replaceChildren(
    ...items.map(({ label, usagePercent, resetInSec }) => {
      const percent = Math.max(0, Math.min(100, Number(usagePercent) || 0));
      const item = document.createElement('div');
      item.className = `usage-item tone-${usageTone(percent)}`;
      item.innerHTML = `
        <div class="usage-label"><span>${label}</span><strong>${percent.toFixed(percent % 1 ? 1 : 0)}%</strong></div>
        <div class="track"><div class="fill" style="width: ${percent}%"></div></div>
        <small>${formatRemaining(resetInSec)}</small>`;
      return item;
    }),
  );
}

// 从接口响应中解析三项用量。
// 响应对象可能被放进 $R[n] 引用中，需先解引用再取字段。
function parseUsage(responseText) {
  const results = [];
  const labels = { rollingUsage: '🔄 滚动用量', weeklyUsage: '📅 每周用量', monthlyUsage: '🗓️ 每月用量' };
  for (const [key, label] of Object.entries(labels)) {
    let section = new RegExp(`${key}:\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(responseText)?.[1];
    if (!section) {
      const reference = new RegExp(`${key}:\\s*\\$R\\[(\\d+)\\]`).exec(responseText)?.[1];
      if (reference) section = new RegExp(`\\$R\\[${reference}\\]\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(responseText)?.[1];
    }
    const usagePercent = /usagePercent:\s*([0-9.]+)/.exec(section || '')?.[1];
    const resetInSec = /resetInSec:\s*([0-9.]+)/.exec(section || '')?.[1];
    if (usagePercent === undefined || resetInSec === undefined) continue;
    results.push({ label, usagePercent, resetInSec });
  }
  if (results.length !== 3) throw new Error('接口返回格式异常');
  return results;
}

// 展示错误提示条并清空用量列表
function showError(message) {
  setStatus('失败', 'error');
  elements.usageList.replaceChildren();
  elements.errorMessage.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.hidden = true;
}

// 刷新用量：解析配置 -> 请求接口 -> 渲染结果。通过 refreshInProgress 防止并发。
async function refresh() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  elements.refresh.disabled = true;
  setStatus('加载中', 'loading');
  try {
    const config = await activeProvider.getConfig();
    clearError();
    elements.updatedAt.textContent = '';
    renderUsage(await activeProvider.loadUsage(config));
    setStatus('正常', 'ok');
    elements.updatedAt.textContent = new Date().toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (error) {
    showError(error.message || '加载失败');
  } finally {
    elements.refresh.disabled = false;
    refreshInProgress = false;
  }
}

// 初始化：绑定刷新事件、设置错误引导链接并立即加载一次
function initialize() {
  elements.refresh.addEventListener('click', refresh);
  elements.errorLink.href = activeProvider.usagePageUrl;
  refresh();
}

initialize();
