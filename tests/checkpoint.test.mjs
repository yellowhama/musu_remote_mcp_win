import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCheckpoint, createMutationGate } from '../checkpoint.mjs';
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-dev-checkpoint-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'work');
  const backupRoot = path.join(base, 'backup');
  await fs.mkdir(root);
  return { root, backupRoot, checkpoint: createCheckpoint({ root, backupRoot, ...options }) };
}
test('byte-exact multilingual backup, content deduplication and manifest', async t => {
  const { root, backupRoot, checkpoint } = await fixture(t);
  const bytes = Buffer.from('한글 日本語 🐝\r\nline\n');
  await fs.writeFile(path.join(root, 'a.txt'), bytes);
  await fs.writeFile(path.join(root, 'b.txt'), bytes);
  const result = await checkpoint('edit');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(await fs.readFile(path.join(backupRoot, 'objects', `${hash}.backup`)), bytes);
  assert.equal(result.count, 2);
  assert.equal((await fs.readdir(path.join(backupRoot, 'objects'))).length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(backupRoot, 'manifests', `${result.id}.json`)));
  assert.equal(manifest.files['a.txt'].sha256, hash);
});
test('corrupt existing object fails closed before mutation', async t => {
  const { root, backupRoot, checkpoint } = await fixture(t);
  await fs.writeFile(path.join(root, 'a'), 'original');
  await checkpoint('first');
  const [name] = await fs.readdir(path.join(backupRoot, 'objects'));
  await fs.writeFile(path.join(backupRoot, 'objects', name), 'corrupt');
  let called = false;
  await assert.rejects(createMutationGate(checkpoint)('edit', () => { called = true; }), /Corrupt/);
  assert.equal(called, false);
});
test('bounded file and total size refuse mutation', async t => {
  const a = await fixture(t, { maxFileBytes: 2 });
  await fs.writeFile(path.join(a.root, 'large'), '123');
  await assert.rejects(a.checkpoint('edit'), /too large/);
  const b = await fixture(t, { maxTotalBytes: 2 });
  await fs.writeFile(path.join(b.root, 'a'), '12');
  await fs.writeFile(path.join(b.root, 'b'), '12');
  await assert.rejects(b.checkpoint('edit'), /byte limit/);
});
test('dependency directories are excluded; symlinks are stored without reading targets', async t => {
  const { root, backupRoot, checkpoint } = await fixture(t);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored'), 'ignored');
  await fs.symlink('/does-not-exist', path.join(root, 'link'));
  const result = await checkpoint('edit');
  const manifest = JSON.parse(await fs.readFile(path.join(backupRoot, 'manifests', `${result.id}.json`)));
  assert.deepEqual(manifest.files, { link: { link: '/does-not-exist' } });
});
test('aborted client cannot execute mutation after checkpoint', async () => {
  const controller = new AbortController();
  let called = false;
  const gate = createMutationGate(async () => { controller.abort(); return {}; });
  await assert.rejects(gate('edit', () => { called = true; }, controller.signal), /abort/i);
  assert.equal(called, false);
});
test('queue stays serial and admits work after failure', async () => {
  const order = [];
  const gate = createMutationGate(async name => { order.push(name); if (name === 'bad') throw Error('bad'); return {}; });
  const first = gate('bad', () => order.push('forbidden'));
  const second = gate('good', () => order.push('written'));
  await assert.rejects(first, /bad/);
  await second;
  assert.deepEqual(order, ['bad', 'good', 'written']);
});
test('bounded pending queue prevents unbounded admission', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const gate = createMutationGate(async () => { await wait; return {}; }, 1);
  const first = gate('one', () => {});
  await assert.rejects(gate('two', () => {}), /queue full/);
  release();
  await first;
});

// Repair regressions: limits apply to a single source snapshot, not retained history.
async function policyFixture(t, options = {}, policy = { version: 1 }) {
  const f = await fixture(t, options);
  const limitsFile = path.join(path.dirname(f.root), 'checkpoint-limits.json');
  await fs.writeFile(limitsFile, JSON.stringify(policy));
  return {
    ...f,
    limitsFile,
    checkpoint: createCheckpoint({ root: f.root, backupRoot: f.backupRoot, ...options, limitsFile }),
  };
}

test('operator policy admits source beyond default 10000 without deleting or excluding candidates', async t => {
  const f = await policyFixture(t, {}, { version: 1, maxFiles: 11000 });
  const candidate = path.join(f.root, '.local-build', 'unmerged-candidate');
  await fs.mkdir(candidate, { recursive: true });
  // Actual 10001 files; repeated bytes exercise the real deduplicated object store.
  for (let batch = 0; batch < 10001; batch += 128) {
    await Promise.all(Array.from({ length: Math.min(128, 10001 - batch) }, (_, j) =>
      fs.writeFile(path.join(candidate, `${batch + j}.txt`), 'x')));
  }
  const result = await f.checkpoint('edit');
  assert.equal(result.count, 10001);
  assert.equal((await fs.readdir(candidate)).length, 10001);
  assert.equal((await fs.readdir(path.join(f.backupRoot, 'objects'))).length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(f.backupRoot, 'manifests', `${result.id}.json`)));
  assert.equal(Object.keys(manifest.files).length, 10001);
  assert.equal(manifest.files['.local-build/unmerged-candidate/10000.txt'].size, 1);
});

test('file overflow reports source count and limit before any mutation', async t => {
  const f = await fixture(t, { maxFiles: 1 });
  await fs.writeFile(path.join(f.root, 'a'), 'a');
  await fs.writeFile(path.join(f.root, 'b'), 'b');
  let called = false;
  await assert.rejects(createMutationGate(f.checkpoint)('edit', () => { called = true; }), err => {
    assert.match(err.message, /sourceFilesAtLeast=2/);
    assert.match(err.message, /maxFiles=1/);
    assert.ok(err.message.includes(f.root));
    return true;
  });
  assert.equal(called, false);
});

test('policy total byte bound is configurable and still fails closed at the next byte', async t => {
  const f = await policyFixture(t, { maxTotalBytes: 2 }, { version: 1, maxTotalBytes: 4 });
  await fs.writeFile(path.join(f.root, 'a'), '1234');
  assert.equal((await f.checkpoint('within')).totalBytes, 4);
  await fs.writeFile(path.join(f.root, 'a'), '12345');
  let called = false;
  await assert.rejects(createMutationGate(f.checkpoint)('over', () => { called = true; }), /byte limit/);
  assert.equal(called, false);
});

test('policy file-byte bound is enforced independently', async t => {
  const f = await policyFixture(t, { maxFileBytes: 1 }, { version: 1, maxFileBytes: 3 });
  await fs.writeFile(path.join(f.root, 'a'), '123');
  assert.equal((await f.checkpoint('within')).totalBytes, 3);
  await fs.writeFile(path.join(f.root, 'a'), '1234');
  await assert.rejects(f.checkpoint('over'), /too large/);
});

test('policy is reread between calls without restarting the checkpoint closure', async t => {
  const f = await policyFixture(t, { maxFiles: 1 }, { version: 1, maxFiles: 1 });
  await fs.writeFile(path.join(f.root, 'a'), 'a');
  await f.checkpoint('first');
  await fs.writeFile(path.join(f.root, 'b'), 'b');
  await assert.rejects(f.checkpoint('blocked'), /file limit/);
  await fs.writeFile(f.limitsFile, JSON.stringify({ version: 1, maxFiles: 2 }));
  assert.equal((await f.checkpoint('next')).count, 2);
});

for (const [label, policy] of [
  ['zero', { version: 1, maxFiles: 0 }],
  ['negative', { version: 1, maxFiles: -1 }],
  ['fraction', { version: 1, maxFiles: 1.5 }],
  ['numeric string', { version: 1, maxFiles: '100000' }],
  ['unsafe integer', { version: 1, maxFiles: 1e20 }],
  ['unknown field', { version: 1, max_file: 20000 }],
  ['wrong version', { version: 2, maxFiles: 20000 }],
  ['invalid root type', []],
]) {
  test(`invalid policy (${label}) blocks mutation rather than disabling limits`, async t => {
    const f = await policyFixture(t, {}, policy);
    let called = false;
    await assert.rejects(createMutationGate(f.checkpoint)('edit', () => { called = true; }), /checkpoint policy/i);
    assert.equal(called, false);
  });
}

test('malformed and oversized policy files fail closed', async t => {
  const f = await policyFixture(t);
  await fs.writeFile(f.limitsFile, '{');
  await assert.rejects(f.checkpoint('edit'), /checkpoint policy/i);
  await fs.writeFile(f.limitsFile, ' '.repeat(16385));
  await assert.rejects(f.checkpoint('edit'), /checkpoint policy/i);
});

test('missing policy retains original conservative defaults', async t => {
  const f = await policyFixture(t, { maxFiles: 1 });
  await fs.unlink(f.limitsFile);
  await fs.writeFile(path.join(f.root, 'a'), 'a');
  await fs.writeFile(path.join(f.root, 'b'), 'b');
  await assert.rejects(f.checkpoint('edit'), /file limit/);
});

test('retained manifests do not consume the next source-file allowance', async t => {
  const f = await fixture(t, { maxFiles: 1 });
  await fs.writeFile(path.join(f.root, 'a'), 'a');
  for (let i = 0; i < 4; i++) assert.equal((await f.checkpoint(`edit-${i}`)).count, 1);
  assert.equal((await fs.readdir(path.join(f.backupRoot, 'manifests'))).length, 4);
});

test('inventory is read-only, preserves candidate coverage and uses the same excluded names', async t => {
  const module = await import('../checkpoint.mjs');
  assert.equal(typeof module.inspectCheckpoint, 'function', 'read-only inventory must be provided');
  const f = await fixture(t);
  const candidate = path.join(f.root, '.local-build', 'candidate');
  await fs.mkdir(path.join(candidate, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(candidate, 'source.rs'), 'abcd');
  await fs.writeFile(path.join(candidate, 'node_modules', 'ignored'), 'ignored');
  await fs.writeFile(path.join(f.root, 'notes.backup'), '123');
  await fs.symlink('/unavailable-file', path.join(f.root, 'link'));
  const result = await module.inspectCheckpoint(f.root);
  assert.equal(result.regularFiles, 2);
  assert.equal(result.symlinks, 1);
  assert.equal(result.totalBytes, 7);
  assert.equal(result.largestFileBytes, 4);
  assert.equal(result.byTopLevel['.local-build'].files, 1);
  await assert.rejects(fs.stat(f.backupRoot), { code: 'ENOENT' });
  await assert.rejects(module.inspectCheckpoint(f.root, { maxEntries: 1 }), /inventory.*limit/i);
});
