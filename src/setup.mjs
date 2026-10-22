import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, NATIVE_HOST_NAME, ROOT, VERSION, writeJson } from './config.mjs';

function extensionId(publicKeyBase64) {
  const hex = createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hex].map(char => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

function compileNativeHost(output) {
  const compiler = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ].find(existsSync);
  if (!compiler) throw new Error('Windows C# compiler is unavailable');
  const source = join(ROOT, 'native-host', 'Program.cs');
  const result = spawnSync(compiler, [
    '/nologo',
    '/target:exe',
    `/out:${output}`,
    '/reference:System.Web.Extensions.dll',
    source,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Native Host compilation failed:\n${result.stdout}\n${result.stderr}`);
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

export async function setup({ configPath = DEFAULT_CONFIG, extensionDir } = {}) {
  configPath = resolve(configPath);
  const dataDir = dirname(configPath);
  const distDir = join(dataDir, 'bin');
  extensionDir = resolve(extensionDir || join(ROOT, 'extension-dev'));
  await privateDirectory(dataDir);
  await mkdir(distDir, { recursive: true });

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
  const { createPublicKey } = await import('node:crypto');
  const publicKeyBase64 = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const id = extensionId(publicKeyBase64);
  const allowedOrigin = `chrome-extension://${id}/`;

  await cp(join(ROOT, 'extension'), extensionDir, { recursive: true, force: true });
  await privateDirectory(extensionDir);
  const manifestTemplate = JSON.parse(await readFile(join(extensionDir, 'manifest.template.json'), 'utf8'));
  manifestTemplate.key = publicKeyBase64;
  await writeJson(join(extensionDir, 'manifest.json'), manifestTemplate);

  const nativeHostExe = join(distDir, 'EnterpriseBrowserMcp.NativeHost.exe');
  compileNativeHost(nativeHostExe);
  let existingConfig;
  try {
    existingConfig = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const pipeName = existingConfig?.version === VERSION && typeof existingConfig.pipeName === 'string'
    ? existingConfig.pipeName
    : `\\\\.\\pipe\\EnterpriseBrowserMcp-${randomBytes(16).toString('hex')}`;
  const config = {
    version: VERSION,
    pipeName,
    allowedOrigin,
    extensionId: id,
    extensionDir,
    nodePath: process.execPath,
    brokerScript: join(ROOT, 'bin', 'enterprise-browser-mcp.mjs'),
    configPath,
  };
  await writeJson(configPath, config);

  const nativeManifestPath = join(dataDir, `${NATIVE_HOST_NAME}.json`);
  await writeJson(nativeManifestPath, {
    name: NATIVE_HOST_NAME,
    description: 'Enterprise Browser MCP Native Messaging Host',
    path: nativeHostExe,
    type: 'stdio',
    allowed_origins: [allowedOrigin],
  });

  const registryKey = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  const registry = spawnSync('reg.exe', [
    'ADD', registryKey, '/ve', '/t', 'REG_SZ', '/d', nativeManifestPath, '/f',
  ], { encoding: 'utf8', windowsHide: true });
  if (registry.status !== 0) throw new Error(`Native Host registration failed: ${registry.stderr || registry.stdout}`);

  return {
    version: VERSION,
    configPath,
    extensionDir,
    extensionId: id,
    nativeHost: nativeHostExe,
    nativeManifest: nativeManifestPath,
    next: 'Load extensionDir as an unpacked Edge extension, then click its toolbar icon and share the Ozon tab.',
  };
}
