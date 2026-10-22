#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.mjs';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: DEFAULT_CONFIG },
      'extension-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const action = positionals[0] || 'mcp';
  if (values.help) {
    console.log('enterprise-browser-mcp [setup|broker|mcp|status] [--config PATH]');
  } else if (action === 'setup') {
    const { setup } = await import('../src/setup.mjs');
    const result = await setup({ configPath: values.config, extensionDir: values['extension-dir'] });
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'broker') {
    const { startBroker } = await import('../src/broker.mjs');
    const broker = await startBroker(await loadConfig(values.config));
    const stop = () => broker.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (action === 'mcp') {
    const { runMcp } = await import('../src/mcp.mjs');
    await runMcp(values.config);
  } else if (action === 'status') {
    const { BrokerClient, ensureBroker } = await import('../src/client.mjs');
    const config = await ensureBroker(values.config);
    const client = new BrokerClient(config);
    try {
      console.log(JSON.stringify(await client.call('list_shared_tabs'), null, 2));
    } finally {
      await client.close();
    }
  } else {
    throw new Error(`Unknown command: ${action}`);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
