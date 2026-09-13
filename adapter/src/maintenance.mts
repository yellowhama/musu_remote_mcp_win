import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRetention, applyRetention } from './retention.mjs';

const configPath = path.resolve(process.argv[2] || path.join('config', 'windows.json'));
const apply = process.argv.includes('--apply');
const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(configPath)));
const policy = config.retention || {};
const policyFields = new Set(['manifestDays', 'jobDays', 'archiveDays', 'logDays', 'minFreeBytes']);
if (!policy || Array.isArray(policy) || typeof policy !== 'object') throw new Error('retention must be an object');
for (const key of Object.keys(policy)) if (!policyFields.has(key)) throw new Error(`Unknown retention field: ${key}`);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const plan = await planRetention({
  backupRoot: config.backupRoot,
  jobsRoot: path.join(config.stateRoot, 'jobs'),
  logsRoot: path.join(projectRoot, 'windows', 'service', 'logs'),
  manifestDays: policy.manifestDays,
  jobDays: policy.jobDays,
  archiveDays: policy.archiveDays,
  logDays: policy.logDays,
});
const summary = {
  apply,
  retainedManifests: plan.retainedManifests.length,
  expiredManifests: plan.expiredManifests.length,
  orphanObjects: plan.orphanObjects.length,
  archivedJobs: plan.archivedJobs.length,
  expiredJobArchives: plan.expiredJobArchives.length,
  expiredLogs: plan.expiredLogs.length,
  reclaimedBytes: plan.reclaimedBytes,
};
if (!apply) console.log(JSON.stringify(summary, null, 2));
else console.log(JSON.stringify({ ...summary, result: await applyRetention(plan) }, null, 2));
