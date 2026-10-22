const NATIVE_HOST = 'com.enterprise.browser_mcp';
const GRANT_TTL_MS = 15 * 60 * 1000;
const grants = new Map();
const claims = new Map();
let port;
let reconnectTimer;

function originOf(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Only credential-free HTTP(S) pages can be shared');
  }
  return parsed.origin;
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

async function revoke(tabId) {
  grants.delete(tabId);
  for (const [handle, claim] of claims) {
    if (claim.tab_id !== tabId) continue;
    try { await chrome.debugger.detach({ tabId }); } catch {}
    claims.delete(handle);
  }
  await persistGrants();
  await updateBadge();
}

async function cleanupGrants() {
  for (const [tabId, grant] of grants) {
    if (grant.expires_at <= Date.now()) {
      await revoke(tabId);
      continue;
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (originOf(tab.url) !== grant.origin) await revoke(tabId);
    } catch {
      await revoke(tabId);
    }
  }
}

async function shareCurrentTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  const grant = {
    grant_id: crypto.randomUUID(),
    tab_id: tabId,
    origin,
    created_at: Date.now(),
    expires_at: Date.now() + GRANT_TTL_MS,
    capabilities: ['read', 'read_same_origin'],
  };
  grants.set(tabId, grant);
  await persistGrants();
  await updateBadge();
  return { shared: true, grant, title: tab.title || '', url: tab.url };
}

async function listSharedTabs() {
  await cleanupGrants();
  const tabs = [];
  for (const grant of grants.values()) {
    try {
      const tab = await chrome.tabs.get(grant.tab_id);
      tabs.push({
        tab_id: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        origin: grant.origin,
        expires_at: new Date(grant.expires_at).toISOString(),
        capabilities: grant.capabilities,
      });
    } catch {}
  }
  return { tabs };
}

function claimFor(owner, handle) {
  const claim = claims.get(handle);
  if (!claim || claim.owner !== owner) throw new Error('Tab handle is stale or belongs to another MCP connection');
  const grant = grants.get(claim.tab_id);
  if (!grant || grant.expires_at <= Date.now()) throw new Error('Tab grant expired or was revoked');
  return { claim, grant };
}

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    if (!String(error.message).includes('already attached')) throw error;
  }
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
}

function extractionExpression(maxChars) {
  return `(() => {
    const limit = ${maxChars};
    const clean = value => String(value || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    const text = clean(document.body?.innerText || '').slice(0, limit);
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 5000).map(node => ({
      level: Number(node.tagName.slice(1)), text: clean(node.innerText || node.textContent).slice(0, 2000)
    })).filter(item => item.text);
    const links = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('a[href]')) {
      let href;
      try { href = new URL(node.getAttribute('href'), location.href).href; } catch { continue; }
      if (!/^https?:/.test(href)) continue;
      const normalized = href.split('#')[0];
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      links.push({ text: clean(node.innerText || node.textContent).slice(0, 500), href: normalized });
      if (links.length >= 10000) break;
    }
    const code_blocks = [];
    let codeChars = 0;
    for (const node of document.querySelectorAll('pre, code')) {
      const value = clean(node.innerText || node.textContent);
      if (!value || codeChars + value.length > Math.min(limit, 2000000)) continue;
      code_blocks.push(value);
      codeChars += value.length;
      if (code_blocks.length >= 5000) break;
    }
    return {
      title: document.title,
      url: location.href,
      origin: location.origin,
      lang: document.documentElement.lang || null,
      headings,
      links,
      code_blocks,
      text,
      truncated: text.length >= limit,
      extracted_at: new Date().toISOString()
    };
  })()`;
}

async function extractTab(tabId, maxChars) {
  const response = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: extractionExpression(maxChars),
    returnByValue: true,
    awaitPromise: true,
    userGesture: false,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Page extraction failed');
  if (!response.result?.value) throw new Error('Page extraction returned no value');
  return response.result.value;
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Temporary documentation tab did not load in time'));
    }, timeoutMs);
    const listener = (updatedId, changeInfo) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(reject);
  });
}

async function readUrl(owner, args) {
  const { grant } = claimFor(owner, args.tab_handle);
  const parsed = new URL(args.url);
  if (parsed.origin !== grant.origin || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('read_url is restricted to the user-shared origin');
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: parsed.href, active: false });
    await waitForLoad(tab.id);
    await attach(tab.id);
    await new Promise(resolve => setTimeout(resolve, 750));
    const current = await chrome.tabs.get(tab.id);
    if (originOf(current.url) !== grant.origin) throw new Error('Documentation URL redirected outside the shared origin');
    return await extractTab(tab.id, args.max_chars ?? 2000000);
  } finally {
    if (tab) {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

async function execute(owner, command, args) {
  if (command === 'list_shared_tabs') return await listSharedTabs();
  if (command === 'claim_tab') {
    await cleanupGrants();
    const grant = grants.get(args.tab_id);
    if (!grant) throw new Error('Tab is not shared by the user');
    if (args.expected_origin && args.expected_origin !== grant.origin) throw new Error('Shared tab origin changed');
    for (const claim of claims.values()) {
      if (claim.tab_id === args.tab_id && claim.owner !== owner) throw new Error('Tab is controlled by another MCP connection');
      if (claim.tab_id === args.tab_id && claim.owner === owner) return { tab_handle: claim.handle, tab_id: claim.tab_id, origin: grant.origin };
    }
    await attach(args.tab_id);
    const handle = crypto.randomUUID();
    claims.set(handle, { handle, owner, tab_id: args.tab_id });
    return { tab_handle: handle, tab_id: args.tab_id, origin: grant.origin, expires_at: new Date(grant.expires_at).toISOString() };
  }
  if (command === 'release_owner') {
    let released = 0;
    for (const [handle, claim] of [...claims]) {
      if (claim.owner !== owner) continue;
      try { await chrome.debugger.detach({ tabId: claim.tab_id }); } catch {}
      claims.delete(handle);
      released++;
    }
    return { released };
  }
  if (command === 'read_url') return await readUrl(owner, args);
  const { claim, grant } = claimFor(owner, args.tab_handle);
  const tab = await chrome.tabs.get(claim.tab_id);
  if (originOf(tab.url) !== grant.origin) {
    await revoke(claim.tab_id);
    throw new Error('Tab navigated outside the shared origin');
  }
  if (command === 'extract_page') return await extractTab(claim.tab_id, args.max_chars ?? 2000000);
  if (command === 'release_tab') {
    try { await chrome.debugger.detach({ tabId: claim.tab_id }); } finally { claims.delete(args.tab_handle); }
    return { released: true, tab_id: claim.tab_id };
  }
  throw new Error(`Unknown browser command: ${command}`);
}

function connectNative() {
  clearTimeout(reconnectTimer);
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
    port.postMessage({
      type: 'browser_hello',
      extension_id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
    });
    port.onMessage.addListener(async message => {
      if (message.type === 'connected') return;
      if (message.type !== 'command' || !message.id) return;
      try {
        const result = await execute(message.owner, message.command, message.arguments || {});
        port.postMessage({ type: 'response', id: message.id, result });
      } catch (error) {
        port.postMessage({ type: 'response', id: message.id, error: error.message || String(error) });
      }
    });
    port.onDisconnect.addListener(async () => {
      port = null;
      for (const claim of claims.values()) {
        try { await chrome.debugger.detach({ tabId: claim.tab_id }); } catch {}
      }
      claims.clear();
      reconnectTimer = setTimeout(connectNative, 2000);
    });
  } catch {
    reconnectTimer = setTimeout(connectNative, 2000);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    if (!port) connectNative();
    if (message.type === 'popup_status') {
      await cleanupGrants();
      const tab = await chrome.tabs.get(message.tab_id);
      return { shared: grants.has(tab.id), grant: grants.get(tab.id), title: tab.title, url: tab.url, native_connected: !!port };
    }
    if (message.type === 'share_tab') return await shareCurrentTab(message.tab_id);
    if (message.type === 'revoke_tab') {
      await revoke(message.tab_id);
      return { shared: false };
    }
    throw new Error('Unknown extension message');
  })().then(respond, error => respond({ error: error.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => revoke(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && grants.has(tabId)) {
    try {
      if (originOf(changeInfo.url) !== grants.get(tabId).origin) revoke(tabId);
    } catch {
      revoke(tabId);
    }
  }
});

connectNative();
void (async () => {
  try {
    await restoreGrants();
    await cleanupGrants();
    await updateBadge();
  } catch (error) {
    console.error('Enterprise Browser MCP initialization failed', error);
  }
})();
