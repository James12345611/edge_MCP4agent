import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, ROOT, VERSION, writeJson } from './config.mjs';

export const mcpSettings = (configPath = DEFAULT_CONFIG) => ({
  command: process.execPath,
  args: [join(ROOT, 'bin', 'enterprise-browser-mcp.mjs'), 'mcp', '--config', resolve(configPath)],
  env: { ENTERPRISE_BROWSER_MCP_HOME: dirname(resolve(configPath)) },
});

function extensionId(publicKeyBase64) {
  const hex = createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
    return;
  }
  const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = identity.stdout?.match(/S-1-[\d-]+/)?.[0];
  if (identity.status !== 0 || !sid) throw new Error('Cannot determine the current Windows SID');
  const acl = spawnSync('icacls.exe', [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
  ], { encoding: 'utf8', windowsHide: true });
  if (acl.status !== 0) throw new Error(`Cannot secure the MCP data directory: ${acl.stderr || acl.stdout}`);
}

export async function setup({ configPath = DEFAULT_CONFIG, extensionDir, port = 47832 } = {}) {
  configPath = resolve(configPath);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('port must be 1024..65535');
  }

  const dataDir = dirname(configPath);
  extensionDir = resolve(extensionDir || join(ROOT, 'extension-dev'));
  await privateDirectory(dataDir);

  const privateKeyPath = join(dataDir, 'dev-extension-private.pem');
  let privateKey;
  try {
    privateKey = await readFile(privateKeyPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(privateKeyPath, 0o600);
  }
  const publicKeyBase64 = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const id = extensionId(publicKeyBase64);

  await cp(join(ROOT, 'extension'), extensionDir, {
    recursive: true,
    force: true,
    filter: source => !source.endsWith('config.generated.js') && !source.endsWith('manifest.json'),
  });
  await privateDirectory(extensionDir);
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.template.json'), 'utf8'));
  manifest.key = publicKeyBase64;
  manifest.content_security_policy = {
    extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${port}`,
  };
  await writeJson(join(extensionDir, 'manifest.json'), manifest);

  let existing;
  try {
    existing = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = existing?.version === VERSION &&
    existing.extension_id === id &&
    existing.port === port &&
    typeof existing.token === 'string'
    ? existing
    : {
        version: VERSION,
        port,
        token: randomBytes(48).toString('base64url'),
        extension_id: id,
      };
  config.extension_dir = extensionDir;
  config.config_path = configPath;
  await writeJson(configPath, config);
  await writeFile(
    join(extensionDir, 'config.generated.js'),
    `// Machine-local pairing secret. Never publish.\nexport const CONNECTION = ${JSON.stringify({
      url: `ws://127.0.0.1:${port}/extension`,
      token: config.token,
    })};\n`,
    { mode: 0o600 },
  );

  return { config, configPath, extensionDir };
}
