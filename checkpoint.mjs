import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ignored = new Set(['node_modules', 'target', '.next', '.git', '.cache', 'test-results', 'playwright-report']);
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid checkpoint policy: ${name} must be a positive safe integer`);
  return value;
}

// Operator-managed limits, not a retention policy. Missing config keeps the old
// defaults; invalid/unreadable config must never make a mutation unguarded.
async function loadLimits(defaults, limitsFile) {
  if (!limitsFile) return defaults;
  let handle;
  try {
    handle = await fs.open(limitsFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return defaults;
    throw new Error(`Cannot read checkpoint policy: ${limitsFile}`, { cause: error });
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular policy file');
    const buffer = Buffer.alloc(16385);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > 16384) throw new Error('Policy exceeds 16 KiB');
    const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
    const keys = new Set(['version', 'maxFiles', 'maxFileBytes', 'maxTotalBytes']);
    if (!policy || Array.isArray(policy) || typeof policy !== 'object' || policy.version !== 1) throw new Error('Expected policy version 1');
    for (const name of Object.keys(policy)) if (!keys.has(name)) throw new Error(`Unknown policy field: ${name}`);
    const limits = { ...defaults };
    for (const name of ['maxFiles', 'maxFileBytes', 'maxTotalBytes']) {
      if (Object.hasOwn(policy, name)) limits[name] = positiveInteger(name, policy[name]);
    }
    return limits;
  } catch (error) {
    throw new Error(`Invalid checkpoint policy: ${limitsFile}; mutation blocked`, { cause: error });
  } finally {
    await handle.close();
  }
}

// Metadata-only sizing for an operator before selecting bounded limits. This is
// not a coherent backup or permission to mutate; the real checkpoint still runs.
export async function inspectCheckpoint(root, { signal, maxEntries = 250000 } = {}) {
  positiveInteger('inventory maxEntries', maxEntries);
  const canonicalRoot = await fs.realpath(root);
  const result = { root, regularFiles: 0, symlinks: 0, totalBytes: 0, largestFileBytes: 0, largestFiles: [], byTopLevel: Object.create(null) };
  let visited = 0;
  async function walk(dir) {
    signal?.throwIfAborted();
    const relativeDir = path.relative(canonicalRoot, await fs.realpath(dir));
    if (relativeDir === '..' || relativeDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDir)) throw new Error('Source directory escaped workspace');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      signal?.throwIfAborted();
      if (++visited > maxEntries) throw new Error(`Checkpoint inventory entry limit exceeded: ${maxEntries}; no changes made`);
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) { result.symlinks++; continue; }
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported source entry: ${relative}`);
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error(`Source changed during inventory: ${relative}`);
      result.regularFiles++;
      result.totalBytes += stat.size;
      if (!Number.isSafeInteger(result.totalBytes)) throw new Error('Checkpoint inventory byte count overflow');
      result.largestFileBytes = Math.max(result.largestFileBytes, stat.size);
      result.largestFiles.push({ path: relative, bytes: stat.size });
      result.largestFiles.sort((a, b) => b.bytes - a.bytes);
      result.largestFiles.length = Math.min(result.largestFiles.length, 10);
      const category = relative.includes(path.sep) ? relative.split(path.sep)[0] : '(root files)';
      const group = result.byTopLevel[category] ??= { files: 0, bytes: 0 };
      group.files++;
      group.bytes += stat.size;
    }
  }
  await walk(root);
  return result;
}

export function createCheckpoint({ root, backupRoot, maxFiles = 10000, maxFileBytes = 64 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024, concurrency = 8, limitsFile }) {
  const defaults = { maxFiles, maxFileBytes, maxTotalBytes };
  for (const [name, value] of Object.entries(defaults)) positiveInteger(name, value);
  positiveInteger('concurrency', concurrency);
  return async function checkpoint(tool, signal) {
    signal?.throwIfAborted();
    const { maxFiles, maxFileBytes, maxTotalBytes } = await loadLimits(defaults, limitsFile);
    signal?.throwIfAborted();
    const canonicalRoot = await fs.realpath(root);
    const pending = [];
    const files = {};
    let totalBytes = 0;
    async function walk(dir) {
      signal?.throwIfAborted();
      const relativeDir = path.relative(canonicalRoot, await fs.realpath(dir));
      if (relativeDir === '..' || relativeDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDir)) throw new Error('Source directory escaped workspace');
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (ignored.has(entry.name)) continue;
        const file = path.join(dir, entry.name);
        const relative = path.relative(root, file);
        if (entry.isSymbolicLink()) { files[relative] = { link: await fs.readlink(file) }; continue; }
        if (entry.isDirectory()) { await walk(file); continue; }
        if (!entry.isFile()) throw new Error(`Unsupported source entry: ${relative}`);
        if (pending.length >= maxFiles) throw new Error(`Backup file limit exceeded; mutation blocked: sourceFilesAtLeast=${pending.length + 1}, maxFiles=${maxFiles}, root=${root}, at=${relative}. This is a per-checkpoint source limit, not retained backup count. Review inventory and checkpoint policy.`);
        pending.push({ file, relative });
      }
    }
    await walk(root);
    await fs.mkdir(path.join(backupRoot, 'objects'), { recursive: true });
    await fs.mkdir(path.join(backupRoot, 'manifests'), { recursive: true });
    let next = 0;
    let failed = false;
    async function worker() {
      while (!failed && next < pending.length) {
        signal?.throwIfAborted();
        const { file, relative } = pending[next++];
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes;
        let before;
        try {
          before = await handle.stat();
          if (!before.isFile() || before.size > maxFileBytes) throw new Error(`Backup file too large or non-regular: ${relative}; bytes=${before.size}, maxFileBytes=${maxFileBytes}`);
          totalBytes += before.size;
          if (totalBytes > maxTotalBytes) throw new Error(`Backup byte limit exceeded; mutation blocked: sourceBytesAtLeast=${totalBytes}, maxTotalBytes=${maxTotalBytes}, root=${root}`);
          const buffer = Buffer.alloc(before.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const result = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
          }
          const after = await handle.stat();
          if (offset !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error(`Source changed during backup: ${relative}`);
          bytes = buffer.subarray(0, offset);
        } finally { await handle.close(); }
        signal?.throwIfAborted();
        const hash = hashBytes(bytes);
        const target = path.join(backupRoot, 'objects', `${hash}.backup`);
        try {
          const existing = await fs.readFile(target);
          if (hashBytes(existing) !== hash) throw new Error(`Corrupt backup object: ${hash}; mutation blocked`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const temporary = `${target}.${randomUUID()}.tmp`;
          await fs.writeFile(temporary, bytes, { flag: 'wx' });
          await fs.rename(temporary, target);
        }
        files[relative] = { sha256: hash, size: bytes.length, mode: before.mode };
      }
    }
    // Drain all workers before rejecting. Otherwise the mutation queue can release
    // while previous checkpoint workers are still writing backup files.
    const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
      try { await worker(); } catch (error) { failed = true; throw error; }
    }));
    const rejected = outcomes.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    signal?.throwIfAborted();
    const id = `${Date.now()}-${randomUUID()}`;
    const manifest = path.join(backupRoot, 'manifests', id);
    await fs.writeFile(`${manifest}.tmp`, JSON.stringify({ tool, root, files }), { flag: 'wx' });
    await fs.rename(`${manifest}.tmp`, `${manifest}.json`);
    return { id, count: Object.keys(files).length, totalBytes };
  };
}

export function createMutationGate(checkpoint, maxPending = 8) {
  let queue = Promise.resolve();
  let pending = 0;
  return function guarded(tool, operation, signal) {
    if (pending >= maxPending) return Promise.reject(new Error('Mutation queue full; retry after current work completes'));
    pending++;
    const run = queue.then(async () => {
      signal?.throwIfAborted();
      const backup = await checkpoint(tool, signal);
      signal?.throwIfAborted();
      const result = await operation();
      console.log(JSON.stringify({ event: 'workspace_backup', tool, ...backup }));
      return result;
    }).finally(() => { pending--; });
    queue = run.catch(() => {});
    return run;
  };
}
