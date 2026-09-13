import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const terminalJobs = new Set(['succeeded', 'failed', 'cancelled', 'interrupted_unknown']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, value) => {
  const relative = path.relative(root, value);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

async function files(directory, suffix) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && (!suffix || entry.name.endsWith(suffix))).map(entry => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function record(file) {
  const stat = await fs.stat(file);
  return { file, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

function cutoff(now, days) {
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('Retention days must be positive integers');
  return now - days * DAY_MS;
}

export async function planRetention({
  backupRoot,
  jobsRoot,
  logsRoot,
  now = Date.now(),
  manifestDays = 30,
  jobDays = 30,
  archiveDays = 180,
  logDays = 14,
}) {
  backupRoot = path.resolve(backupRoot);
  jobsRoot = path.resolve(jobsRoot);
  logsRoot = path.resolve(logsRoot);
  const manifestRecords = await Promise.all((await files(path.join(backupRoot, 'manifests'), '.json')).map(record));
  manifestRecords.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const manifestCutoff = cutoff(now, manifestDays);
  const retainedManifests = manifestRecords.filter((item, index) => index === 0 || item.mtimeMs >= manifestCutoff);
  const expiredManifests = manifestRecords.filter(item => !retainedManifests.includes(item));
  const reachable = new Set();
  const guards = [];
  for (const item of retainedManifests) {
    const bytes = await fs.readFile(item.file);
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!manifest || typeof manifest !== 'object' || !manifest.entries || typeof manifest.entries !== 'object') {
      throw new Error(`Invalid retained manifest: ${item.file}`);
    }
    for (const entry of Object.values(manifest.entries)) {
      if (entry?.sha256 !== undefined) {
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
          throw new Error(`Invalid object hash in retained manifest: ${item.file}`);
        }
        reachable.add(entry.sha256);
      }
    }
    guards.push({ file: item.file, sha256: digest(bytes) });
  }
  const objectRecords = await Promise.all((await files(path.join(backupRoot, 'objects'), '.backup')).map(record));
  const orphanObjects = objectRecords.filter(item => {
    const hash = path.basename(item.file, '.backup');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Unexpected backup object name: ${item.file}`);
    return !reachable.has(hash);
  });
  const jobCutoff = cutoff(now, jobDays);
  const archivedJobs = [];
  for (const file of await files(jobsRoot, '.json')) {
    const item = await record(file);
    if (item.mtimeMs >= jobCutoff) continue;
    const job = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)));
    if (terminalJobs.has(job?.state)) archivedJobs.push(item);
  }
  const archiveRoot = path.join(path.dirname(jobsRoot), 'jobs-archive');
  const archiveCutoff = cutoff(now, archiveDays);
  const expiredJobArchives = (await Promise.all((await files(archiveRoot, '.json')).map(record)))
    .filter(item => item.mtimeMs < archiveCutoff);
  const logCutoff = cutoff(now, logDays);
  const expiredLogs = (await Promise.all((await files(logsRoot)).map(record)))
    .filter(item => item.mtimeMs < logCutoff);
  const deleted = [...expiredManifests, ...orphanObjects, ...expiredJobArchives, ...expiredLogs];
  return {
    version: 1,
    createdAt: new Date(now).toISOString(),
    roots: { backupRoot, jobsRoot, archiveRoot, logsRoot },
    policy: { manifestDays, jobDays, archiveDays, logDays },
    guards,
    retainedManifests,
    expiredManifests,
    orphanObjects,
    archivedJobs,
    expiredJobArchives,
    expiredLogs,
    reclaimedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
  };
}

export async function applyRetention(plan) {
  if (plan?.version !== 1) throw new Error('Unsupported retention plan');
  const { backupRoot, jobsRoot, archiveRoot, logsRoot } = plan.roots;
  for (const [root, values] of [
    [path.join(backupRoot, 'manifests'), plan.expiredManifests],
    [path.join(backupRoot, 'objects'), plan.orphanObjects],
    [archiveRoot, plan.expiredJobArchives],
    [logsRoot, plan.expiredLogs],
    [jobsRoot, plan.archivedJobs],
  ]) {
    for (const item of values) if (!inside(root, path.resolve(item.file))) throw new Error(`Retention path escaped: ${item.file}`);
  }
  for (const guard of plan.guards) {
    if (digest(await fs.readFile(guard.file)) !== guard.sha256) throw new Error(`Retained manifest changed: ${guard.file}`);
  }
  const maintenanceRoot = path.join(backupRoot, 'maintenance');
  const planRoot = path.join(maintenanceRoot, 'plans');
  const planId = `${Date.now()}-${randomUUID()}`;
  const trashRoot = path.join(maintenanceRoot, 'trash', planId);
  await fs.mkdir(planRoot, { recursive: true });
  await fs.mkdir(trashRoot, { recursive: true });
  const planFile = path.join(planRoot, `${planId}.json`);
  const toTrash = [...plan.expiredManifests, ...plan.orphanObjects, ...plan.expiredJobArchives, ...plan.expiredLogs];
  await fs.mkdir(archiveRoot, { recursive: true });
  const trash = toTrash.map((item, index) => ({ source: item.file, target: path.join(trashRoot, `${index}-${path.basename(item.file)}`) }));
  const archived = plan.archivedJobs.map(item => ({ source: item.file, target: path.join(archiveRoot, path.basename(item.file)) }));
  const moves = [...trash, ...archived];
  await fs.writeFile(planFile, JSON.stringify({ ...plan, moves, status: 'prepared' }), { flag: 'wx' });
  const completed = [];
  try {
    for (const move of moves) {
      await fs.rename(move.source, move.target);
      completed.push(move);
    }
  } catch (error) {
    for (const move of completed.reverse()) {
      try { await fs.rename(move.target, move.source); } catch {}
    }
    throw error;
  }
  await fs.writeFile(`${planFile}.committed`, JSON.stringify({ planFile, trash, archived, status: 'committed' }), { flag: 'wx' });
  for (const item of trash) await fs.rm(item.target, { force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
  return { planFile, deleted: trash.length, archived: archived.length, reclaimedBytes: plan.reclaimedBytes };
}
