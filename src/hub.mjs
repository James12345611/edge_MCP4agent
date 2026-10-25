import { HUB_OPERATION_TIMEOUT_MS } from '../extension/limits.js';
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { VERSION } from './config.mjs';

const MAX_MESSAGE = 24 * 1024 * 1024;
const TAB_OPERATIONS = new Set([
  'release_tab',
  'activate_tab',
  'close_tab',
  'snapshot',
  'read_text',
  'type',
  'hover',
  'drag',
  'wait',
  'select_option',
  'click',
  'fill',
  'press_key',
  'batch',
  'scroll',
  'navigate',
  'screenshot',
  'handle_dialog',
  'upload_file',
  'evaluate',
  'logs',
]);
export const CAPABILITIES = [
  'shared_tabs',
  'fetch',
  'activate_tab',
  'close_tab',
  'ax_snapshot',
  'text',
  'type',
  'hover',
  'drag',
  'wait',
  'select_option',
  'click',
  'fill',
  'keyboard',
  'batch',
  'scroll',
  'navigate',
  'screenshot',
  'handle_dialog',
  'upload_file',
  'visual_indicator',
  'evaluate',
  'logs',
];

export class OperationTimeout extends Error {}

const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};

export async function startHub(config, {
  port = config.port,
  operationTimeout = HUB_OPERATION_TIMEOUT_MS,
} = {}) {
  const browsers = new Map();
  const clients = new Set();
  const claims = new Map();
  const tabClaims = new Map();
  const queues = new Map();

  const authorized = token => typeof token === 'string' &&
    Buffer.byteLength(token) === Buffer.byteLength(config.token) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(config.token));
  const bearer = request => authorized(request.headers.authorization?.replace(/^Bearer /, ''));
  const keyFor = (browser, tab) => JSON.stringify([browser, tab]);

  function forget(handle) {
    const claim = claims.get(handle);
    if (claim) tabClaims.delete(keyFor(claim.browser_id, claim.tab_id));
    claims.delete(handle);
  }

  function queued(key, action) {
    const result = (queues.get(key) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(key, result);
    const done = () => {
      if (queues.get(key) === result) queues.delete(key);
    };
    result.then(done, done);
    return result;
  }

  function requestBrowser(browser, owner, command, args) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        browser.pending.delete(id);
        reject(new OperationTimeout(
          'Browser operation timed out; outcome may be unknown. The connection will release its tabs. Observe before retrying.',
        ));
      }, operationTimeout);
      browser.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (browser.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        browser.pending.delete(id);
        reject(new Error('Browser disconnected'));
        return;
      }
      send(browser.ws, { id, owner, command, arguments: args });
    });
  }

  function observedByHandle(observed, handle) {
    for (const item of observed.values()) {
      if (item.tab_handle === handle) return item;
    }
    throw new Error('Tab handle is absent or stale. Call browser_list_shared_tabs again.');
  }

  async function ensureClaim(owner, observed, handle) {
    const item = observedByHandle(observed, handle);
    const key = keyFor(item.browser_id, item.tab_id);
    return await queued(key, async () => {
      const existingHandle = tabClaims.get(key);
      if (existingHandle) {
        const existing = claims.get(existingHandle);
        if (existing?.owner !== owner || existingHandle !== handle) {
          throw new Error('Shared tab is controlled by another MCP session');
        }
        return existing;
      }
      const browser = browsers.get(item.browser_id);
      if (!browser) throw new Error('Browser disconnected');
      const result = await requestBrowser(browser, owner, 'claim_tab', {
        tab_id: item.tab_id,
        tab_handle: handle,
      });
      if (browsers.get(item.browser_id) !== browser) {
        throw new Error('Browser disconnected while attaching the shared tab');
      }
      const claim = {
        owner,
        browser_id: item.browser_id,
        tab_id: item.tab_id,
        handle,
      };
      claims.set(handle, claim);
      tabClaims.set(key, handle);
      claim.attach_result = result;
      return claim;
    });
  }

  async function execute(owner, observed, method, args) {
    if (method === 'list_browsers') {
      return {
        browsers: [...browsers.values()].map(browser => ({
          browser_id: browser.id,
          ...browser.info,
          capabilities: CAPABILITIES,
        })),
      };
    }

    if (method === 'list_shared_tabs') {
      const tabs = [];
      for (const browser of browsers.values()) {
        const result = await requestBrowser(browser, owner, 'list_tabs', {});
        const currentKeys = new Set();
        for (const tab of result.tabs) {
          const key = keyFor(browser.id, tab.tab_id);
          currentKeys.add(key);
          const previous = observed.get(key);
          const tabHandle = previous?.tab_handle || randomUUID();
          const active = claims.get(tabClaims.get(key));
          const item = {
            ...tab,
            browser_id: browser.id,
            tab_handle: tabHandle,
            control: !active ? 'available' : active.owner === owner ? 'yours' : 'another_session',
          };
          observed.set(key, item);
          tabs.push(item);
        }
        for (const [key, item] of observed) {
          if (item.browser_id === browser.id && !currentKeys.has(key)) observed.delete(key);
        }
      }
      return {
        tabs,
        capabilities: CAPABILITIES,
        hint: tabs.length
          ? 'Use tab_handle directly. Control is attached automatically on the first operation.'
          : 'Share an HTTP(S) tab from the Enterprise Browser MCP extension.',
      };
    }

    if (method === 'fetch') {
      const handle = args.tab_handle;
      const claim = await ensureClaim(owner, observed, handle);
      return await queued(keyFor(claim.browser_id, claim.tab_id), async () => {
        const browser = browsers.get(claim.browser_id);
        if (!browser) throw new Error('Browser disconnected');
        const result = await requestBrowser(browser, owner, 'fetch', {
          ...args,
          tab_id: claim.tab_id,
          authorized_tab_id: claim.tab_id,
        });
        return { ...result, tab_handle: handle };
      });
    }

    if (!TAB_OPERATIONS.has(method)) throw new Error(`Unknown browser operation: ${method}`);
    const handle = args.tab_handle;
    const item = observedByHandle(observed, handle);

    if (method === 'release_tab' && !claims.has(handle)) {
      observed.delete(keyFor(item.browser_id, item.tab_id));
      return { released: true, tab_handle: handle, tab_id: item.tab_id };
    }

    const claim = await ensureClaim(owner, observed, handle);
    return await queued(keyFor(claim.browser_id, claim.tab_id), async () => {
      if (claims.get(handle) !== claim) {
        throw new Error('Tab control changed while this operation was waiting');
      }
      const browser = browsers.get(claim.browser_id);
      if (!browser) throw new Error('Browser disconnected');
      const result = await requestBrowser(browser, owner, method, {
        ...args,
        tab_id: claim.tab_id,
      });
      if (method === 'release_tab' || method === 'close_tab') {
        forget(handle);
        observed.delete(keyFor(claim.browser_id, claim.tab_id));
      }
      return { ...result, tab_handle: handle, tab_id: claim.tab_id };
    });
  }

  let closing;
  const server = http.createServer((request, response) => {
    if (request.headers.origin || !bearer(request)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health' && request.method === 'GET') {
      response.end(JSON.stringify({
        service: 'enterprise-browser-mcp',
        version: VERSION,
        browsers: browsers.size,
      }));
    } else if (request.url === '/shutdown' && request.method === 'POST') {
      response.end('{"stopping":true}');
      setImmediate(() => close());
    } else {
      response.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  server.on('upgrade', (request, socket, head) => {
    const extension = request.url === '/extension';
    const valid = extension
      ? request.headers.origin === `chrome-extension://${config.extension_id}`
      : request.url === '/client' && !request.headers.origin && bearer(request);
    if (!valid) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      if (extension) connectExtension(ws);
      else connectClient(ws);
    });
  });

  function connectExtension(ws) {
    let browser;
    const helloTimer = setTimeout(() => ws.close(1008, 'Pairing timeout'), 5000);
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (!browser) {
          const info = data.browser;
          if (data.type !== 'hello' ||
              !authorized(data.token) ||
              !info ||
              info.extension_version !== VERSION ||
              !['chrome', 'edge'].includes(info.family) ||
              !['instance_id', 'run_id', 'profile_name'].every(
                key => typeof info[key] === 'string' && info[key].length >= 1 && info[key].length <= 128,
              )) {
            throw new Error('Invalid pairing or browser identity');
          }
          const id = `${info.instance_id}:${info.run_id}`;
          if (browsers.has(id)) throw new Error('Browser instance is already connected');
          browser = { id, ws, info, pending: new Map() };
          browsers.set(id, browser);
          clearTimeout(helloTimer);
          send(ws, { type: 'connected', browser_id: id });
          return;
        }
        if (data.type === 'ping') send(ws, { type: 'pong' });
        else if (data.type === 'detached') forget(tabClaims.get(keyFor(browser.id, data.tab_id)));
        else if (browser.pending.has(data.id)) {
          const pending = browser.pending.get(data.id);
          browser.pending.delete(data.id);
          if ('error' in data) pending.reject(new Error(String(data.error)));
          else pending.resolve(data.result || {});
        }
      } catch {
        ws.close(1008, 'Invalid extension message');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!browser || browsers.get(browser.id) !== browser) return;
      browsers.delete(browser.id);
      for (const pending of browser.pending.values()) {
        pending.reject(new Error('Browser disconnected; observe again after reconnecting'));
      }
      browser.pending.clear();
      for (const [handle, claim] of claims) {
        if (claim.browser_id === browser.id) forget(handle);
      }
    });
  }

  function connectClient(ws) {
    clients.add(ws);
    const owner = randomUUID();
    const observed = new Map();
    let chain = Promise.resolve();
    let disconnected = false;
    ws.on('error', () => {});
    ws.on('message', raw => {
      chain = chain.then(async () => {
        if (disconnected) return;
        let data;
        try {
          data = JSON.parse(raw.toString());
          const result = await execute(owner, observed, data.method, data.arguments || {});
          send(ws, { id: data.id, result });
        } catch (error) {
          send(ws, { id: data?.id, error: error.message });
          if (error instanceof OperationTimeout) {
            disconnected = true;
            ws.close(1011, 'Operation timeout');
          }
        }
      });
    });
    ws.on('close', () => {
      disconnected = true;
      clients.delete(ws);
      chain.finally(async () => {
        await Promise.allSettled(
          [...browsers.values()].map(browser => requestBrowser(browser, owner, 'release_owner', {})),
        );
        for (const [handle, claim] of claims) {
          if (claim.owner === owner) forget(handle);
        }
      });
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'Hub stopped');
      const timer = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
      }, 1000);
      await new Promise(resolve => wss.close(resolve));
      clearTimeout(timer);
      await new Promise(resolve => server.close(resolve));
    })();
    return closing;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    clearInterval(heartbeat);
    wss.close();
    throw error;
  }
  return { server, close, port: server.address().port, claims, browsers };
}
