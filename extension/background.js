import { CONNECTION } from './config.generated.js';
import { createController } from './controller.js';
import { normalizeGrantMinutes } from './grant-policy.js';

const grants = new Map();
const bindings = new Map();
let socket;
let connecting = false;
let keepAlive;
let reconnect;
let connectionStatus = 'disconnected';

function httpUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only credential-free HTTP(S) tabs can be shared');
  }
  return parsed;
}

async function persistGrants() {
  await chrome.storage.session.set({ grants: [...grants.values()] });
}

async function restoreGrants() {
  const stored = await chrome.storage.session.get('grants');
  for (const grant of stored.grants || []) {
    if (grant.expires_at > Date.now()) grants.set(grant.tab_id, grant);
  }
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: grants.size ? String(grants.size) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#13755b' });
}

const controller = createController(chrome, event => {
  if (event.type === 'detached') bindings.delete(event.tab_id);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
});

async function releaseBinding(tabId) {
  const binding = bindings.get(tabId);
  if (!binding) return;
  try {
    await controller.execute(binding.owner, 'release_tab', {
      tab_id: tabId,
      tab_handle: binding.handle,
    });
  } catch {
    // A closed or already detached tab is already released.
  } finally {
    bindings.delete(tabId);
  }
}

async function revoke(tabId) {
  grants.delete(tabId);
  await persistGrants();
  await updateBadge();
  await releaseBinding(tabId);
}

async function cleanupGrants() {
  for (const [tabId, grant] of [...grants]) {
    if (grant.expires_at <= Date.now()) {
      await revoke(tabId);
      continue;
    }
    try {
      await chrome.tabs.get(tabId);
    } catch {
      await revoke(tabId);
    }
  }
}

async function shareCurrentTab(tabId, requestedMinutes) {
  const tab = await chrome.tabs.get(tabId);
  httpUrl(tab.url);
  const minutes = normalizeGrantMinutes(requestedMinutes);
  const grant = {
    grant_id: crypto.randomUUID(),
    tab_id: tabId,
    duration_minutes: minutes,
    created_at: Date.now(),
    expires_at: Date.now() + minutes * 60 * 1000,
    capabilities: [
      'read',
      'interact',
      'navigate',
      'evaluate',
      'logs',
      'files',
      'fetch',
    ],
  };
  grants.set(tabId, grant);
  await persistGrants();
  await updateBadge();
  return { shared: true, grant, title: tab.title || '', url: tab.url || '' };
}

function currentGrant(tabId) {
  const grant = grants.get(tabId);
  if (!grant || grant.expires_at <= Date.now()) {
    throw new Error('Tab share expired or was revoked');
  }
  return grant;
}

async function listSharedTabs() {
  await cleanupGrants();
  const tabs = [];
  for (const grant of grants.values()) {
    try {
      const tab = await chrome.tabs.get(grant.tab_id);
      const controllable = /^https?:\/\//.test(tab.url || '');
      tabs.push({
        tab_id: tab.id,
        window_id: tab.windowId,
        title: tab.title || '',
        url: tab.url || '',
        active: tab.active,
        group_id: tab.groupId,
        controllable,
        grant_id: grant.grant_id,
        expires_at: new Date(grant.expires_at).toISOString(),
        capabilities: grant.capabilities,
      });
    } catch {
      await revoke(grant.tab_id);
    }
  }
  return { tabs };
}

async function execute(owner, command, args) {
  if (command === 'list_tabs') return await listSharedTabs();
  if (command === 'release_owner') {
    const result = await controller.execute(owner, command, args);
    for (const [tabId, binding] of [...bindings]) {
      if (binding.owner === owner) bindings.delete(tabId);
    }
    return result;
  }
  if (command === 'fetch') {
    currentGrant(args.authorized_tab_id);
    return await controller.execute(owner, command, args);
  }

  const tabId = args.tab_id;
  currentGrant(tabId);
  if (command === 'claim_tab') {
    const tab = await chrome.tabs.get(tabId);
    httpUrl(tab.url);
    const result = await controller.execute(owner, command, args);
    bindings.set(tabId, { owner, handle: args.tab_handle });
    return result;
  }

  const binding = bindings.get(tabId);
  if (!binding || binding.owner !== owner || binding.handle !== args.tab_handle) {
    throw new Error('Shared tab is not attached to this MCP connection');
  }
  const result = await controller.execute(owner, command, args);
  if (command === 'release_tab' || command === 'close_tab') bindings.delete(tabId);
  if (command === 'close_tab') {
    grants.delete(tabId);
    await persistGrants();
    await updateBadge();
  }
  return result;
}

async function getIdentity() {
  const local = await chrome.storage.local.get(['instanceId', 'profileName']);
  const session = await chrome.storage.session.get('runId');
  const instanceId = local.instanceId || crypto.randomUUID();
  const runId = session.runId || crypto.randomUUID();
  if (!local.instanceId) await chrome.storage.local.set({ instanceId });
  if (!session.runId) await chrome.storage.session.set({ runId });
  const family = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  return {
    instance_id: instanceId,
    run_id: runId,
    family,
    profile_name: local.profileName || (family === 'edge' ? 'Edge' : 'Chrome'),
    user_agent: navigator.userAgent,
    extension_id: chrome.runtime.id,
    extension_version: chrome.runtime.getManifest().version,
  };
}

async function connect() {
  if (connecting || socket?.readyState === WebSocket.OPEN) return;
  connecting = true;
  try {
    const identity = await getIdentity();
    const ws = new WebSocket(CONNECTION.url);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: CONNECTION.token, browser: identity }));
      keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
    };
    ws.onmessage = async event => {
      let request;
      try {
        request = JSON.parse(event.data);
        if (request.type === 'connected') {
          connectionStatus = 'connected';
          await updateBadge();
          return;
        }
        if (!request.id) return;
        const result = await execute(request.owner, request.command, request.arguments || {});
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: request.id, result }));
        }
      } catch (error) {
        if (request?.id && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: request.id, error: error.message || String(error) }));
        }
      }
    };
    ws.onclose = async () => {
      clearInterval(keepAlive);
      connectionStatus = 'disconnected';
      connecting = false;
      await controller.releaseAll();
      bindings.clear();
      await updateBadge();
      clearTimeout(reconnect);
      reconnect = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  } catch (error) {
    connecting = false;
    connectionStatus = error.message;
    clearTimeout(reconnect);
    reconnect = setTimeout(connect, 2000);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'popup_status') {
    Promise.all([cleanupGrants(), chrome.tabs.get(message.tab_id)])
      .then(([, tab]) => respond({
        shared: grants.has(tab.id),
        grant: grants.get(tab.id),
        title: tab.title,
        url: tab.url,
        hub_connected: connectionStatus === 'connected',
        connection_status: connectionStatus,
        controlled: bindings.has(tab.id),
      }))
      .catch(error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'share_tab') {
    shareCurrentTab(message.tab_id, message.duration_minutes)
      .then(respond)
      .catch(error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'revoke_tab') {
    revoke(message.tab_id)
      .then(() => respond({ shared: false }))
      .catch(error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'reconnect') {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    else connect();
    respond({ ok: true });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (grants.has(tabId)) void revoke(tabId);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'connect') connect();
  if (alarm.name === 'grant-cleanup') void cleanupGrants();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('connect', { periodInMinutes: 0.5 });
  await chrome.alarms.create('grant-cleanup', { periodInMinutes: 1 });
  connect();
});

async function initialize() {
  try {
    await restoreGrants();
    await cleanupGrants();
    await updateBadge();
    await chrome.alarms.create('connect', { periodInMinutes: 0.5 });
    await chrome.alarms.create('grant-cleanup', { periodInMinutes: 1 });
    connect();
  } catch (error) {
    connectionStatus = `初始化失败：${error.message || String(error)}`;
  }
}

void initialize();
