import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../src/hub.mjs';
import { AttachClient } from '../src/client.mjs';
import { ROOT, VERSION, writeJson } from '../src/config.mjs';

async function fixture(t, options = {}) {
  const config = {
    version: VERSION,
    port: 47832,
    token: 'enterprise-test-secret-'.repeat(3),
    extension_id: 'a'.repeat(32),
  };
  const hub = await startHub(config, { port: 0, ...options });
  config.port = hub.port;
  const sockets = [];
  const clients = [];
  const requests = [];
  const releasedOwners = new Set();

  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const socket of sockets) socket.close();
    await hub.close();
  });

  const extension = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, {
    origin: `chrome-extension://${config.extension_id}`,
  });
  sockets.push(extension);
  await once(extension, 'open');
  const connected = once(extension, 'message');
  extension.send(JSON.stringify({
    type: 'hello',
    token: config.token,
    browser: {
      family: 'edge',
      instance_id: 'profile',
      run_id: 'run',
      profile_name: 'Edge',
      extension_version: VERSION,
    },
  }));
  await connected;
  extension.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (!request.id) return;
    requests.push(request);
    if (options.stall === request.command) return;
    let result = { ok: true };
    if (request.command === 'list_tabs') {
      result = {
        tabs: [{
          tab_id: 9,
          title: 'Shared Ozon docs',
          url: 'https://docs.ozon.ru/',
          expires_at: '2099-01-01T00:00:00.000Z',
        }],
      };
    }
    if (request.command === 'snapshot') result = { snapshot: '[s1:1] button "Try it"' };
    if (request.command === 'release_owner') releasedOwners.add(request.owner);
    extension.send(JSON.stringify({ id: request.id, result }));
  });

  function client() {
    const client = new AttachClient(config);
    clients.push(client);
    return client;
  }
  return { config, hub, client, requests, releasedOwners };
}

test('shared tabs return handles and attach automatically on the first operation', async t => {
  const f = await fixture(t);
  const client = f.client();
  const listed = await client.call('list_shared_tabs');
  assert.equal(listed.tabs.length, 1);
  assert.ok(listed.tabs[0].tab_handle);
  assert.equal(f.requests.filter(item => item.command === 'claim_tab').length, 0);

  const handle = listed.tabs[0].tab_handle;
  const snapshot = await client.call('snapshot', { tab_handle: handle });
  assert.match(snapshot.snapshot, /Try it/);
  assert.deepEqual(
    f.requests.filter(item => ['claim_tab', 'snapshot'].includes(item.command)).map(item => item.command),
    ['claim_tab', 'snapshot'],
  );
  assert.equal(f.requests.find(item => item.command === 'snapshot').arguments.tab_id, 9);
});

test('tab control is exclusive between clients and release permits a new controller', async t => {
  const f = await fixture(t);
  const first = f.client();
  const second = f.client();
  const firstHandle = (await first.call('list_shared_tabs')).tabs[0].tab_handle;
  const secondHandle = (await second.call('list_shared_tabs')).tabs[0].tab_handle;
  await first.call('snapshot', { tab_handle: firstHandle });
  await assert.rejects(
    second.call('snapshot', { tab_handle: secondHandle }),
    /another MCP session/,
  );
  await first.call('release_tab', { tab_handle: firstHandle });
  const result = await second.call('snapshot', { tab_handle: secondHandle });
  assert.match(result.snapshot, /Try it/);
});

test('operation timeout never replays and releases the connection owner', async t => {
  const f = await fixture(t, { operationTimeout: 80, stall: 'click' });
  const client = f.client();
  const handle = (await client.call('list_shared_tabs')).tabs[0].tab_handle;
  await assert.rejects(client.call('click', { tab_handle: handle }), /outcome may be unknown/);
  for (let index = 0; !f.releasedOwners.size && index < 40; index++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.requests.filter(item => item.command === 'click').length, 1);
  assert.equal(f.hub.claims.size, 0);
  assert.equal(f.releasedOwners.size, 1);
});

test('loopback endpoints and extension pairing reject unauthenticated peers', async t => {
  const f = await fixture(t);
  const url = `http://127.0.0.1:${f.config.port}`;
  assert.equal((await fetch(`${url}/health`)).status, 403);
  const response = await fetch(`${url}/health`, {
    headers: { Authorization: `Bearer ${f.config.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'enterprise-browser-mcp');

  const wrong = new WebSocket(`ws://127.0.0.1:${f.config.port}/extension`, {
    origin: 'chrome-extension://wrong',
  });
  await assert.rejects(once(wrong, 'open'), /403/);
});

test('stdio MCP exposes shared-tab discovery and the complete interactive tool surface', async t => {
  const f = await fixture(t);
  const temp = await mkdtemp(join(tmpdir(), 'enterprise-browser-mcp-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'config.json');
  await writeJson(configPath, f.config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin', 'enterprise-browser-mcp.mjs'), 'mcp', '--config', configPath],
    cwd: temp,
  });
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(transport);
  try {
    const tools = (await mcp.listTools()).tools;
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(tools.length, 21, [...names].join(', '));
    assert.ok(names.has('browser_list_shared_tabs'));
    assert.ok(names.has('browser_snapshot'));
    assert.ok(names.has('browser_click'));
    assert.ok(names.has('browser_fill'));
    assert.ok(names.has('browser_type'));
    assert.ok(names.has('browser_navigate'));
    assert.ok(names.has('browser_evaluate'));
    assert.ok(names.has('browser_logs'));
    assert.ok(names.has('browser_upload_file'));
    assert.ok(!names.has('browser_discover'));
    assert.ok(!names.has('browser_claim_tab'));

    const listed = await mcp.callTool({
      name: 'browser_list_shared_tabs',
      arguments: {},
    });
    const tab = JSON.parse(listed.content[0].text).tabs[0];
    assert.ok(tab.tab_handle);
    const snapshot = await mcp.callTool({
      name: 'browser_snapshot',
      arguments: { tab_handle: tab.tab_handle },
    });
    assert.match(JSON.parse(snapshot.content[0].text).snapshot, /Try it/);
  } finally {
    await mcp.close();
  }
});
