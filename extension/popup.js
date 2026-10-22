let currentTab;

async function refresh() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({ type: 'popup_status', tab_id: currentTab.id });
  if (result.error) throw new Error(result.error);
  document.querySelector('#page').textContent = currentTab.title || currentTab.url;
  document.querySelector('#connection').textContent = result.native_connected ? '本机服务已连接' : '本机服务未连接';
  document.querySelector('#status').textContent = result.shared
    ? `已共享至 ${new Date(result.grant.expires_at).toLocaleTimeString()}`
    : '当前标签未共享';
  document.querySelector('#share').hidden = result.shared;
  document.querySelector('#revoke').hidden = !result.shared;
}

document.querySelector('#share').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'share_tab', tab_id: currentTab.id });
  if (result.error) throw new Error(result.error);
  await refresh();
};

document.querySelector('#revoke').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'revoke_tab', tab_id: currentTab.id });
  if (result.error) throw new Error(result.error);
  await refresh();
};

refresh().catch(error => {
  document.querySelector('#status').textContent = error.message;
  document.querySelector('#share').hidden = true;
  document.querySelector('#revoke').hidden = true;
});
