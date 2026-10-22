import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { startBroker } from '../src/broker.mjs';

function connect(pipeName, hello) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(hello)}\n`);
      let buffer = '';
      const messages = [];
      const waiters = [];
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          const waiter = waiters.shift();
          if (waiter) waiter(message);
          else messages.push(message);
        }
      });
      resolve({
        socket,
        send: value => socket.write(`${JSON.stringify(value)}\n`),
        receive: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(done => waiters.push(done)),
      });
    });
  });
}

test('broker accepts only the configured extension origin and routes connection-scoped requests', async t => {
  const suffix = randomBytes(8).toString('hex');
  const config = {
    version: '0.1.0',
    pipeName: `\\\\.\\pipe\\EnterpriseBrowserMcp-test-${suffix}`,
    allowedOrigin: 'chrome-extension://abcdefghijklmnop/',
  };
  const broker = await startBroker(config);
  t.after(() => broker.close());

  const bad = await connect(config.pipeName, { type: 'hello', role: 'extension', origin: 'chrome-extension://wrong/' });
  await new Promise(resolve => bad.socket.once('close', resolve));

  const extension = await connect(config.pipeName, { type: 'hello', role: 'extension', origin: config.allowedOrigin });
  const client = await connect(config.pipeName, { type: 'hello', role: 'mcp' });
  t.after(() => extension.socket.destroy());
  t.after(() => client.socket.destroy());

  client.send({ id: 'one', method: 'list_shared_tabs', arguments: {} });
  const command = await extension.receive();
  assert.equal(command.command, 'list_shared_tabs');
  assert.equal(typeof command.owner, 'string');
  extension.send({ type: 'response', id: command.id, result: { tabs: [] } });
  assert.deepEqual(await client.receive(), { id: 'one', result: { tabs: [] } });

  client.send({ id: 'two', method: 'evaluate', arguments: {} });
  assert.match((await client.receive()).error, /Unknown or invalid/);
});
