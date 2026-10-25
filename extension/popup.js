import {
  DEFAULT_GRANT_MINUTES,
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
  normalizeGrantMinutes,
} from './grant-policy.js';

let currentTab;
let grantMinutes = DEFAULT_GRANT_MINUTES;

function showError(error) {
  const status = document.querySelector('#status');
  status.classList.add('error');
  status.textContent = error?.message || String(error);
}

function clearError() {
  document.querySelector('#status').classList.remove('error');
}

function updateDurationControl(value) {
  grantMinutes = normalizeGrantMinutes(value);
  document.querySelector('#duration-minutes').value = String(grantMinutes);
}

async function refresh() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!currentTab?.id) throw new Error('无法读取当前标签页');
  const result = await chrome.runtime.sendMessage({ type: 'popup_status', tab_id: currentTab.id });
  if (!result) throw new Error('扩展后台服务没有响应，请在扩展管理页重新加载后重试');
  if (result.error) throw new Error(result.error);
  clearError();
  document.querySelector('#page').textContent = currentTab.title || currentTab.url;
  document.querySelector('#connection').textContent = result.hub_connected
    ? '本机交互服务已连接'
    : `本机交互服务未连接：${result.connection_status || 'disconnected'}`;
  document.querySelector('#status').textContent = result.shared
    ? `已共享 ${result.grant.duration_minutes || grantMinutes} 分钟，至 ${new Date(result.grant.expires_at).toLocaleTimeString()}${result.controlled ? '；Agent 正在控制' : ''}`
    : '当前标签未共享';
  document.querySelector('#duration-minutes').disabled = result.shared;
  document.querySelector('#share').hidden = result.shared;
  document.querySelector('#revoke').hidden = !result.shared;
}

document.querySelector('#duration-minutes').onchange = async event => {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < MIN_GRANT_MINUTES || value > MAX_GRANT_MINUTES) {
    updateDurationControl(DEFAULT_GRANT_MINUTES);
  } else {
    updateDurationControl(value);
  }
  await chrome.storage.local.set({ grant_minutes: grantMinutes });
};

document.querySelector('#share').onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'share_tab',
      tab_id: currentTab.id,
      duration_minutes: grantMinutes,
    });
    if (!result) throw new Error('扩展后台服务没有响应，请在扩展管理页重新加载后重试');
    if (result.error) throw new Error(result.error);
    await refresh();
  } catch (error) {
    showError(error);
  }
};

document.querySelector('#revoke').onclick = async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'revoke_tab', tab_id: currentTab.id });
    if (!result) throw new Error('扩展后台服务没有响应，请在扩展管理页重新加载后重试');
    if (result.error) throw new Error(result.error);
    document.querySelector('#duration-minutes').disabled = false;
    await refresh();
  } catch (error) {
    showError(error);
  }
};

async function initialize() {
  const stored = await chrome.storage.local.get('grant_minutes');
  updateDurationControl(stored.grant_minutes);
  await refresh();
}

initialize().catch(error => {
  showError(error);
  document.querySelector('#share').hidden = true;
  document.querySelector('#revoke').hidden = true;
});
