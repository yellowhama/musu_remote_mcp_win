import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.resolve(process.argv[2] || path.join(projectRoot, 'config', 'windows.json'));
const role = process.argv[3] || 'combined';
if (!['combined', 'gateway', 'worker'].includes(role)) throw new Error('Role must be combined, gateway, or worker');
const raw = await fs.readFile(configPath);
const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
const allowed = new Set(['version', 'publicUrl', 'editableRoots', 'defaultCwd', 'stateRoot', 'workerStateRoot', 'brokerRoot', 'backupRoot', 'port', 'workerPort', 'defaultShell', 'retention']);
for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unknown Windows configuration field: ${key}`);
if (config.version !== 1) throw new Error('Windows configuration version must be 1');
if (!Array.isArray(config.editableRoots) || config.editableRoots.length === 0) throw new Error('editableRoots must be a non-empty array');
if (config.retention !== undefined) {
  const fields = new Set(['manifestDays', 'jobDays', 'archiveDays', 'logDays', 'minFreeBytes']);
  if (!config.retention || Array.isArray(config.retention) || typeof config.retention !== 'object') throw new Error('retention must be an object');
  for (const [key, value] of Object.entries(config.retention)) {
    if (!fields.has(key)) throw new Error(`Unknown retention field: ${key}`);
    if (key === 'minFreeBytes') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('minFreeBytes must be a non-negative safe integer');
    } else if (!Number.isSafeInteger(value) || value < 1 || value > 3650) throw new Error(`${key} must be an integer between 1 and 3650`);
  }
}

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
const workerStateRoot = absolute(config.workerStateRoot || `${stateRoot}-worker`, 'workerStateRoot');
const brokerRoot = absolute(config.brokerRoot || `${stateRoot}-broker`, 'brokerRoot');
const backupRoot = absolute(config.backupRoot, 'backupRoot');
const configuredDefaultCwd = absolute(config.defaultCwd || roots[0], 'defaultCwd');
const defaultCwd = await fs.realpath(configuredDefaultCwd);
if (!roots.some(root => relativeInside(root, defaultCwd))) throw new Error('defaultCwd must be inside an editable root');
if (!(await fs.stat(defaultCwd)).isDirectory()) throw new Error('defaultCwd must be an existing directory');
for (const protectedRoot of [stateRoot, workerStateRoot, brokerRoot, backupRoot]) {
  if (roots.some(root => relativeInside(root, protectedRoot) || relativeInside(protectedRoot, root))) {
    throw new Error('stateRoot and backupRoot must not overlap editable roots');
  }
}
if (relativeInside(stateRoot, backupRoot) || relativeInside(backupRoot, stateRoot)) throw new Error('stateRoot and backupRoot must not overlap');
const protectedRoots = [stateRoot, workerStateRoot, brokerRoot, backupRoot];
for (let index = 0; index < protectedRoots.length; index++) {
  for (let other = index + 1; other < protectedRoots.length; other++) {
    if (relativeInside(protectedRoots[index], protectedRoots[other]) || relativeInside(protectedRoots[other], protectedRoots[index])) {
      throw new Error('State, broker, and backup roots must not overlap');
    }
  }
}
const publicUrl = process.env.MCP_PUBLIC_URL_OVERRIDE || config.publicUrl;
const parsedUrl = new URL(publicUrl);
const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname);
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && loopback)) throw new Error('publicUrl must use HTTPS, except for loopback-only operation');
if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error('publicUrl must not contain credentials, a query, or a fragment');
const port = Number(config.port ?? 39391);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer between 1 and 65535');
const workerPort = Number(config.workerPort ?? port + 1);
if (!Number.isSafeInteger(workerPort) || workerPort < 1 || workerPort > 65535 || workerPort === port) throw new Error('workerPort must be a distinct integer between 1 and 65535');

if (role === 'combined') {
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });
  process.env.MCP_STATE_ROOT = stateRoot;
  await import('../adapter/dist/setup-state.mjs');
  const runtimeFile = path.join(stateRoot, 'runtime.json');
  const temporary = `${runtimeFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ publicUrl }), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, runtimeFile);
  Object.assign(process.env, {
    MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_TRUST_PROXY_HOPS: '1',
    MCP_ALLOW_NO_AUTH: 'false', MCP_OAUTH_ENABLED: 'true',
    MCP_OAUTH_STATE_FILE: path.join(stateRoot, 'oauth-state.json'),
    MCP_EDITABLE_ROOTS: roots.join(','), MCP_DEFAULT_CWD: defaultCwd,
    MCP_DEFAULT_SHELL: config.defaultShell || 'pwsh.exe', MCP_BACKUP_ROOT: backupRoot,
    MCP_JOBS_ROOT: path.join(stateRoot, 'jobs'),
    MCP_MIN_FREE_BYTES: String(config.retention?.minFreeBytes ?? 10 * 1024 ** 3),
    MCP_WINDOWS_JOB_RUNNER: path.join(projectRoot, 'windows', 'bin', 'MusuJobRunner.exe'),
    MCP_WINDOWS_EVENT_LOG_SOURCE: 'MusuRemoteMcp',
  });
  await import('../adapter/dist/entrypoint.mjs');
} else {
  const internalKey = (await fs.readFile(path.join(brokerRoot, 'internal-key.txt'), 'utf8')).trim();
  if (internalKey.length < 32) throw new Error('Internal gateway key is missing or invalid');
  if (role === 'gateway') {
    const approvalKey = (await fs.readFile(path.join(stateRoot, 'approval-key.txt'), 'utf8')).trim();
    Object.assign(process.env, {
      MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_TRUST_PROXY_HOPS: '1',
      MCP_ALLOW_NO_AUTH: 'false', MCP_OAUTH_ENABLED: 'true', MCP_OAUTH_APPROVAL_KEY: approvalKey,
      MCP_PUBLIC_URL: publicUrl, MCP_ALLOWED_HOSTS: `${parsedUrl.hostname},localhost,127.0.0.1`,
      MCP_ALLOWED_ORIGINS: parsedUrl.origin, MCP_OAUTH_STATE_FILE: path.join(stateRoot, 'oauth-state.sqlite'),
      MCP_DEFAULT_CWD: projectRoot, MCP_GATEWAY_WORKER_URL: `http://127.0.0.1:${workerPort}`,
      MCP_INTERNAL_AUTH_KEY: internalKey, MCP_WINDOWS_EVENT_LOG_SOURCE: 'MusuRemoteMcpGateway',
    });
    await import('../vendor/dist/src/server.js');
  } else {
    Object.assign(process.env, {
      MCP_HOST: '127.0.0.1', MCP_PORT: String(workerPort), MCP_TRUST_PROXY_HOPS: '0',
      MCP_ALLOW_NO_AUTH: 'false', MCP_OAUTH_ENABLED: 'false', MCP_AUTH_TOKEN: internalKey,
      MCP_INTERNAL_AUTH_KEY: internalKey, MCP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
      MCP_EDITABLE_ROOTS: roots.join(','), MCP_DEFAULT_CWD: defaultCwd,
      MCP_DEFAULT_SHELL: config.defaultShell || 'pwsh.exe', MCP_BACKUP_ROOT: backupRoot,
      MCP_JOBS_ROOT: path.join(workerStateRoot, 'jobs'),
      MCP_MIN_FREE_BYTES: String(config.retention?.minFreeBytes ?? 10 * 1024 ** 3),
      MCP_WINDOWS_JOB_RUNNER: path.join(projectRoot, 'windows', 'bin', 'MusuJobRunner.exe'),
      MCP_WINDOWS_EVENT_LOG_SOURCE: 'MusuRemoteMcpWorker',
    });
    await import('../adapter/dist/worker-entrypoint.mjs');
  }
}
