import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
export const NATIVE_HOST_NAME = 'com.enterprise.browser_mcp';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const configuredHome = process.env.ENTERPRISE_BROWSER_MCP_HOME;
if (configuredHome && !isAbsolute(configuredHome)) {
  throw new Error('ENTERPRISE_BROWSER_MCP_HOME must be absolute');
}
export const DATA_DIR = configuredHome
  ? resolve(configuredHome)
  : join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'EnterpriseBrowserMcp');
export const DEFAULT_CONFIG = join(DATA_DIR, 'config.json');

export async function loadConfig(path = DEFAULT_CONFIG) {
  let config;
  try {
    config = JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${resolve(path)}. Run enterprise-browser-mcp setup first.`, { cause: error });
  }
  if (config.version !== VERSION ||
      typeof config.pipeName !== 'string' ||
      typeof config.allowedOrigin !== 'string' ||
      typeof config.nodePath !== 'string' ||
      typeof config.brokerScript !== 'string') {
    throw new Error('Invalid or incompatible enterprise browser MCP config');
  }
  return config;
}

export async function writeJson(path, value) {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
