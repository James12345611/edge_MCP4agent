import net from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_LINE = 16 * 1024 * 1024;
const ALLOWED_METHODS = new Set([
  'list_shared_tabs',
  'claim_tab',
  'extract_page',
  'read_url',
  'release_tab',
  'release_owner',
]);

function write(socket, value) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function lineReader(socket, onValue, onError) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) {
      onError(new Error('Broker message exceeds 16 MiB'));
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onValue(JSON.parse(line));
      } catch {
        onError(new Error('Invalid broker JSON message'));
        socket.destroy();
        return;
      }
    }
  });
}

export async function startBroker(config) {
  const clients = new Set();
  const pending = new Map();
  let extension = null;

  const server = net.createServer(socket => {
    const connection = {
      id: randomUUID(),
      role: null,
      socket,
    };
    const helloTimer = setTimeout(() => socket.destroy(new Error('Broker hello timeout')), 3000);

    lineReader(socket, message => {
      if (!connection.role) {
        if (message?.type !== 'hello' || !['extension', 'mcp'].includes(message.role)) {
          socket.destroy(new Error('Invalid broker hello'));
          return;
        }
        if (message.role === 'extension') {
          if (message.origin !== config.allowedOrigin) {
            socket.destroy(new Error('Extension origin is not allowed'));
            return;
          }
          if (extension) extension.socket.destroy(new Error('Extension replaced by a new native connection'));
          extension = connection;
        } else {
          clients.add(connection);
        }
        connection.role = message.role;
        clearTimeout(helloTimer);
        return;
      }

      if (connection.role === 'extension') {
        if (message.type === 'browser_hello') {
          write(socket, { type: 'connected', version: config.version });
          return;
        }
        if (message.type === 'response' && typeof message.id === 'string') {
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id);
          clearTimeout(item.timer);
          write(item.client.socket, 'error' in message
            ? { id: item.requestId, error: String(message.error) }
            : { id: item.requestId, result: message.result ?? {} });
        }
        return;
      }

      const requestId = message?.id;
      const method = message?.method;
      if ((typeof requestId !== 'string' && typeof requestId !== 'number') || !ALLOWED_METHODS.has(method)) {
        write(socket, { id: requestId ?? null, error: 'Unknown or invalid broker operation' });
        return;
      }
      if (!extension || extension.socket.destroyed) {
        write(socket, { id: requestId, error: 'Managed Edge extension is not connected' });
        return;
      }
      const bridgeId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(bridgeId);
        write(socket, { id: requestId, error: 'Browser operation timed out' });
      }, method === 'read_url' ? 45000 : 15000);
      pending.set(bridgeId, { client: connection, requestId, timer });
      write(extension.socket, {
        type: 'command',
        id: bridgeId,
        owner: connection.id,
        command: method,
        arguments: message.arguments || {},
      });
    }, () => {});

    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (connection.role === 'extension' && extension === connection) {
        extension = null;
        for (const [id, item] of pending) {
          clearTimeout(item.timer);
          write(item.client.socket, { id: item.requestId, error: 'Managed Edge extension disconnected' });
          pending.delete(id);
        }
      }
      if (connection.role === 'mcp') {
        clients.delete(connection);
        if (extension && !extension.socket.destroyed) {
          write(extension.socket, {
            type: 'command',
            id: randomUUID(),
            owner: connection.id,
            command: 'release_owner',
            arguments: {},
          });
        }
        for (const [id, item] of pending) {
          if (item.client !== connection) continue;
          clearTimeout(item.timer);
          pending.delete(id);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.pipeName, resolve);
  });

  return {
    server,
    async close() {
      for (const connection of clients) connection.socket.destroy();
      extension?.socket.destroy();
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
