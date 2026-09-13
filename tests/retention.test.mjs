import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { planRetention, applyRetention } from '../retention.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('retention dry-run preserves files and apply archives jobs while retaining reachable objects', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'musu-retention-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backupRoot = path.join(root, 'backups');
  const jobsRoot = path.join(root, 'state', 'jobs');
  const logsRoot = path.join(root, 'logs');
  for (const dir of [path.join(backupRoot, 'objects'), path.join(backupRoot, 'manifests'), jobsRoot, logsRoot]) await fs.mkdir(dir, { recursive: true });
  const keptHash = hash('kept'), orphanHash = hash('orphan');
  await fs.writeFile(path.join(backupRoot, 'objects', `${keptHash}.backup`), 'kept');
  await fs.writeFile(path.join(backupRoot, 'objects', `${orphanHash}.backup`), 'orphan');
  const manifest = path.join(backupRoot, 'manifests', 'new.json');
  await fs.writeFile(manifest, JSON.stringify({ entries: { file: { sha256: keptHash } } }));
  const oldManifest = path.join(backupRoot, 'manifests', 'old.json');
  await fs.writeFile(oldManifest, JSON.stringify({ entries: {} }));
  const job = path.join(jobsRoot, '11111111-1111-1111-1111-111111111111.json');
  await fs.writeFile(job, JSON.stringify({ state: 'succeeded' }));
  const log = path.join(logsRoot, 'old.log');
  await fs.writeFile(log, 'old');
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  for (const file of [oldManifest, job, log]) await fs.utimes(file, old, old);
  const plan = await planRetention({ backupRoot, jobsRoot, logsRoot, manifestDays: 30, jobDays: 30, archiveDays: 180, logDays: 14 });
  assert.equal(plan.expiredManifests.length, 1);
  assert.equal(plan.orphanObjects.length, 1);
  assert.equal(plan.archivedJobs.length, 1);
  assert.equal(await fs.readFile(oldManifest, 'utf8'), JSON.stringify({ entries: {} }));
  const result = await applyRetention(plan);
  assert.equal(result.deleted, 3);
  assert.equal(result.archived, 1);
  assert.equal(await fs.readFile(path.join(backupRoot, 'objects', `${keptHash}.backup`), 'utf8'), 'kept');
  await assert.rejects(fs.stat(path.join(backupRoot, 'objects', `${orphanHash}.backup`)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'state', 'jobs-archive', path.basename(job)), 'utf8')).state, 'succeeded');
});

test('retention aborts when a retained manifest changes after planning', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'musu-retention-guard-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backupRoot = path.join(root, 'backups'), jobsRoot = path.join(root, 'jobs'), logsRoot = path.join(root, 'logs');
  for (const dir of [path.join(backupRoot, 'manifests'), jobsRoot, logsRoot]) await fs.mkdir(dir, { recursive: true });
  const manifest = path.join(backupRoot, 'manifests', 'only.json');
  await fs.writeFile(manifest, JSON.stringify({ entries: {} }));
  const plan = await planRetention({ backupRoot, jobsRoot, logsRoot });
  await fs.writeFile(manifest, JSON.stringify({ entries: { changed: { absent: true } } }));
  await assert.rejects(applyRetention(plan), /Retained manifest changed/);
});
