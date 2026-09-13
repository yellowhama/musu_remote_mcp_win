import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.resolve(process.argv[2] || path.join(projectRoot, 'config', 'windows.json'));
const raw = await fs.readFile(configPath);
const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
const allowed = new Set(['version', 'publicUrl', 'editableRoots', 'defaultCwd', 'stateRoot', 'backupRoot', 'port', 'defaultShell']);
for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unknown Windows configuration field: ${key}`);
if (config.version !== 1) throw new Error('Windows configuration version must be 1');
if (!Array.isArray(config.editableRoots) || config.editableRoots.length === 0) throw new Error('editableRoots must be a non-empty array');

const absolute = (value, name) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute Windows path`);
  if (value.includes(',')) throw new Error(`${name} must not contain a comma`);
  return path.resolve(value);
};
const configuredRoots = config.editableRoots.map((value, index) => absolute(value, `editableRoots[${index}]`));
const roots = await Promise.all(configuredRoots.map(root => fs.realpath(root)));
const relativeInside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && relativeInside(root, other)))) {
  throw new Error('editableRoots must be unique and non-overlapping');
}
for (const root of roots) {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`Editable root is not a directory: ${root}`);
}

const stateRoot = absolute(config.stateRoot, 'stateRoot');
const backupRoot = absolute(config.backupRoot, 'backupRoot');
const configuredDefaultCwd = absolute(config.defaultCwd || roots[0], 'defaultCwd');
const defaultCwd = await fs.realpath(configuredDefaultCwd);
if (!roots.some(root => relativeInside(root, defaultCwd))) throw new Error('defaultCwd must be inside an editable root');
if (!(await fs.stat(defaultCwd)).isDirectory()) throw new Error('defaultCwd must be an existing directory');
for (const protectedRoot of [stateRoot, backupRoot]) {
  if (roots.some(root => relativeInside(root, protectedRoot) || relativeInside(protectedRoot, root))) {
    throw new Error('stateRoot and backupRoot must not overlap editable roots');
  }
}
if (relativeInside(stateRoot, backupRoot) || relativeInside(backupRoot, stateRoot)) throw new Error('stateRoot and backupRoot must not overlap');
const publicUrl = process.env.MCP_PUBLIC_URL_OVERRIDE || config.publicUrl;
const parsedUrl = new URL(publicUrl);
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname);
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && loopback)) throw new Error('publicUrl must use HTTPS, except for loopback-only operation');
if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error('publicUrl must not contain credentials, a query, or a fragment');
const port = Number(config.port ?? 39391);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');

await fs.mkdir(stateRoot, { recursive: true });
await fs.mkdir(backupRoot, { recursive: true });
process.env.MCP_STATE_ROOT = stateRoot;
await import('../setup-state.mjs');
const runtimeFile = path.join(stateRoot, 'runtime.json');
const temporary = `${runtimeFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, JSON.stringify({ publicUrl }), { flag: 'wx', mode: 0o600 });
await fs.rename(temporary, runtimeFile);

Object.assign(process.env, {
  MCP_HOST: '127.0.0.1',
  MCP_PORT: String(port),
  MCP_TRUST_PROXY_HOPS: '1',
  MCP_ALLOW_NO_AUTH: 'false',
  MCP_OAUTH_ENABLED: 'true',
  MCP_OAUTH_STATE_FILE: path.join(stateRoot, 'oauth-state.json'),
  MCP_EDITABLE_ROOTS: roots.join(','),
  MCP_DEFAULT_CWD: defaultCwd,
  MCP_DEFAULT_SHELL: config.defaultShell || 'pwsh.exe',
  MCP_BACKUP_ROOT: backupRoot,
  MCP_JOBS_ROOT: path.join(stateRoot, 'jobs'),
});

await import('../entrypoint.mjs');
