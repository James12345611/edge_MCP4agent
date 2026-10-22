import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';

function probe(pipeName, timeout = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipeName);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function ensureBroker(configPath) {
  configPath = resolve(configPath);
  const config = await loadConfig(configPath);
  if (await probe(config.pipeName)) return config;
  await mkdir(dirname(configPath), { recursive: true });
  const log = await open(join(dirname(configPath), 'broker.log'), 'a', 0o600);
  const child = spawn(config.nodePath, [config.brokerScript, 'broker', '--config', configPath], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, ENTERPRISE_BROWSER_MCP_HOME: dirname(configPath) },
  });
  child.unref();
  await log.close();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await probe(config.pipeName)) return config;
  }
  throw new Error(`Broker failed to start. See ${join(dirname(configPath), 'broker.log')}`);
}

export class BrokerClient {
  constructor(config) {
    this.config = config;
    this.pending = new Map();
    this.counter = 0;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.socket = net.createConnection(this.config.pipeName);
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    this.socket.write(`${JSON.stringify({ type: 'hello', role: 'mcp', pid: process.pid, parent_pid: process.ppid })}\n`);
    let buffer = '';
    this.socket.setEncoding('utf8');
    this.socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.socket.destroy();
          continue;
        }
        const item = this.pending.get(String(message.id));
        if (!item) continue;
        this.pending.delete(String(message.id));
        clearTimeout(item.timer);
        if ('error' in message) item.reject(new Error(String(message.error)));
        else item.resolve(message.result);
      }
    });
    this.socket.on('close', () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Broker connection closed'));
      }
      this.pending.clear();
    });
  }

  async call(method, args = {}) {
    await this.connect();
    return await new Promise((resolve, reject) => {
      const id = String(++this.counter);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Broker response timed out'));
      }, method === 'read_url' ? 50000 : 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, arguments: args })}\n`);
    });
  }

  async close() {
    if (!this.socket || this.socket.destroyed) return;
    await new Promise(resolve => {
      this.socket.once('close', resolve);
      this.socket.end();
    });
  }
}
