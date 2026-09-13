import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { safePath, snapshotter, restoreToNewDirectory } from '../adapter/dist/snapshot-targets.mjs';

async function fixture(t, limits = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-dev-targets-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = [path.join(base, 'code'), path.join(base, 'wiki')];
  for (const root of roots) await fs.mkdir(root);
  const backupRoot = path.join(base, 'backups');
  return { base, roots, backupRoot, snapshot: snapshotter({ roots, backupRoot, ...limits }),
    manifest: async result => JSON.parse(await fs.readFile(path.join(backupRoot, 'manifests', result.id + '.json'), 'utf8')) };
}

test('editable paths include code and wiki, reject traversal and prefix siblings', async t => {
  const { base, roots } = await fixture(t);
  assert.equal(await safePath('new/file', roots[0], roots), path.join(roots[0], 'new/file'));
  assert.equal(await safePath(path.join(roots[1], 'page.md'), roots[0], roots), path.join(roots[1], 'page.md'));
  await assert.rejects(safePath('../outside', roots[0], roots), /outside/);
  await assert.rejects(safePath(path.join(base, 'code-extra/a'), roots[0], roots), /outside/);
});

test('targeted wiki edit does not scan unrelated code tree or oversized files', async t => {
  const f = await fixture(t, { maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4 });
  await fs.writeFile(path.join(f.roots[0], 'large'), 'unrelated large code file');
  const page = path.join(f.roots[1], 'page.md');
  await fs.writeFile(page, 'wiki');
  const result = await f.snapshot([page]);
  assert.equal(result.count, 1);
  assert.deepEqual(Object.keys((await f.manifest(result)).entries), [page]);
});

test('multilingual binary bytes deduplicate, verify detects source mutation', async t => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.from('한글 日本語 🐝\r\n'), Buffer.from([0, 255, 128])]);
  const a = path.join(f.roots[0], 'a'), b = path.join(f.roots[1], 'b');
  await fs.writeFile(a, bytes); await fs.writeFile(b, bytes);
  const result = await f.snapshot([a, b, a]);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(result.count, 2);
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'objects')), [sha + '.backup']);
  assert.deepEqual(await fs.readFile(path.join(f.backupRoot, 'objects', sha + '.backup')), bytes);
  await result.verify();
  await fs.writeFile(a, 'changed');
  await assert.rejects(result.verify(), /Source changed/);
});

test('absent target has tombstone and verify rejects intervening creation', async t => {
  const f = await fixture(t), file = path.join(f.roots[1], 'new.md');
  const result = await f.snapshot([file]);
  assert.deepEqual((await f.manifest(result)).entries[file], { absent: true });
  await result.verify();
  await fs.writeFile(file, 'another writer');
  await assert.rejects(result.verify(), /Source changed/);
});

test('existing corrupt backup blocks a second snapshot without success manifest', async t => {
  const f = await fixture(t), file = path.join(f.roots[0], 'a');
  await fs.writeFile(file, 'original');
  await f.snapshot([file]);
  const [object] = await fs.readdir(path.join(f.backupRoot, 'objects'));
  await fs.writeFile(path.join(f.backupRoot, 'objects', object), 'corrupt');
  await assert.rejects(f.snapshot([file]), /Corrupt backup/);
  assert.equal((await fs.readdir(path.join(f.backupRoot, 'manifests'))).length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'objects')), [object]);
});

test('full snapshot preserves local-build candidates and symlink metadata without following', async t => {
  const f = await fixture(t), root = f.roots[0];
  await fs.mkdir(path.join(root, '.local-build'));
  await fs.writeFile(path.join(root, '.local-build', 'candidate.ts'), 'candidate');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'cache'), 'excluded');
  await fs.symlink(f.roots[1], path.join(root, 'linked-wiki'), 'dir');
  await fs.writeFile(path.join(f.roots[1], 'outside.md'), 'not traversed');
  const result = await f.snapshot([root], { full: true });
  const m = await f.manifest(result);
  assert.equal(result.count, 1);
  assert.equal(m.entries[path.join(root, 'linked-wiki')].link, f.roots[1]);
  assert.ok(m.entries[path.join(root, '.local-build', 'candidate.ts')]);
  assert.equal(m.entries[path.join(root, 'node_modules')], undefined);
  const destination = path.join(f.base, 'link-restore');
  await restoreToNewDirectory(m, f.backupRoot, destination);
  assert.equal(await fs.readFile(path.join(destination, '0/.local-build/candidate.ts'), 'utf8'), 'candidate');
  await assert.rejects(fs.lstat(path.join(destination, '0/linked-wiki')), { code: 'ENOENT' });
  await assert.rejects(f.snapshot([root]), /Symlink/);
  await assert.rejects(f.snapshot([path.join(root, 'linked-wiki', 'outside.md')]), /Symlink/);
});

test('full snapshot records a file removed after scanning as absent', async t => {
  const f = await fixture(t), file = path.join(f.roots[0], 'concurrent.md');
  await fs.writeFile(file, 'removed by an external editor');
  let removed = false;
  const result = await f.snapshot([f.roots[0]], { full: true, progress(update) {
    if (!removed && update.phase === 'scanning' && update.count >= 1) {
      fsSync.unlinkSync(file);
      removed = true;
    }
  } });
  assert.equal(removed, true);
  assert.deepEqual((await f.manifest(result)).entries[file], { absent: true });
});

test('file count, individual size, total size and cancellation fail closed', async t => {
  for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 3 }]) {
    const f = await fixture(t, limits);
    await fs.writeFile(path.join(f.roots[0], 'a'), '12');
    await fs.writeFile(path.join(f.roots[0], 'b'), '34');
    await assert.rejects(f.snapshot([f.roots[0]]), /limit exceeded/);
  }
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.snapshot([f.roots[0]], { signal: controller.signal }), { name: 'AbortError' });
  for (const limits of [{ workers: 65 }, { maxFiles: 0 }, { maxTotalBytes: NaN }])
    assert.throws(() => snapshotter({ roots: f.roots, backupRoot: f.backupRoot, ...limits }));
});

test('minimum free-space watermark fails before object writes', async t => {
  const f = await fixture(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const file = path.join(f.roots[0], 'small');
  await fs.writeFile(file, 'small');
  await assert.rejects(f.snapshot([file]), /Insufficient backup disk space/);
  assert.deepEqual(await fs.readdir(path.join(f.backupRoot, 'objects')), []);
});

test('restore reads back bytes for both roots and never overwrites originals or existing target', async t => {
  const f = await fixture(t), a = path.join(f.roots[0], 'a'), b = path.join(f.roots[1], 'b.md');
  await fs.writeFile(a, 'code'); await fs.writeFile(b, '한글 위키');
  const missing = path.join(f.roots[0], 'missing');
  const result = await f.snapshot([a, b, missing]), m = await f.manifest(result);
  await fs.writeFile(a, 'new live data');
  const destination = path.join(f.base, 'restored');
  await restoreToNewDirectory(m, f.backupRoot, destination);
  assert.equal(await fs.readFile(path.join(destination, '0/a'), 'utf8'), 'code');
  assert.equal(await fs.readFile(path.join(destination, '1/b.md'), 'utf8'), '한글 위키');
  assert.equal(await fs.readFile(a, 'utf8'), 'new live data');
  await assert.rejects(fs.stat(path.join(destination, '0/missing')), { code: 'ENOENT' });
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, destination), { code: 'EEXIST' });
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, path.join(f.roots[0], 'restore')), /outside source roots/);
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, f.base), /outside source roots/);
});

test('restore rejects corrupt data and forged paths without writing outside destination', async t => {
  const f = await fixture(t), file = path.join(f.roots[0], 'a');
  await fs.writeFile(file, 'original');
  const m = await f.manifest(await f.snapshot([file]));
  const object = path.join(f.backupRoot, 'objects', m.entries[file].sha256 + '.backup');
  await fs.writeFile(object, 'bad');
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, path.join(f.base, 'bad-restore')), /Corrupt restore/);
  const forged = { roots: f.roots, entries: { [path.join(f.base, 'escape')]: { directory: true } } };
  await assert.rejects(restoreToNewDirectory(forged, f.backupRoot, path.join(f.base, 'forged')), /Invalid manifest path/);
  await assert.rejects(fs.stat(path.join(f.base, 'escape')), { code: 'ENOENT' });
});

test('directory target verify rejects files introduced after the snapshot', async t => {
  const f = await fixture(t);
  const result = await f.snapshot([f.roots[0]]);
  await fs.writeFile(path.join(f.roots[0], 'late-file'), 'must not be silently unprotected');
  await assert.rejects(result.verify(), /Source changed/);
});

test('restore rejects a destination whose symlink ancestor resolves inside live sources', async t => {
  const f = await fixture(t), file = path.join(f.roots[0], 'original');
  await fs.writeFile(file, 'original');
  const m = await f.manifest(await f.snapshot([file]));
  const alias = path.join(f.base, 'alias');
  await fs.symlink(f.roots[0], alias, 'dir');
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, path.join(alias, 'restored')));
  await assert.rejects(fs.stat(path.join(f.roots[0], 'restored')), { code: 'ENOENT' });
});

test('symlink-only full trees are bounded and replaced symlinks invalidate verification', async t => {
  const bounded = await fixture(t, { maxFiles: 1 });
  for (let i = 0; i < 4; i++) await fs.symlink('missing', path.join(bounded.roots[0], 'link-' + i));
  await assert.rejects(bounded.snapshot([bounded.roots[0]], { full: true }), /entry limit exceeded/);
  const f = await fixture(t), link = path.join(f.roots[0], 'link');
  await fs.symlink('before', link);
  const result = await f.snapshot([f.roots[0]], { full: true });
  await result.verify();
  await fs.unlink(link); await fs.symlink('after', link);
  await assert.rejects(result.verify(), /Source changed/);
});

test('symlinked backup objects are refused instead of following unrelated data', async t => {
  const f = await fixture(t), file = path.join(f.roots[0], 'a');
  await fs.writeFile(file, 'original');
  const m = await f.manifest(await f.snapshot([file]));
  const object = path.join(f.backupRoot, 'objects', m.entries[file].sha256 + '.backup');
  await fs.unlink(object); await fs.symlink(file, object);
  await assert.rejects(f.snapshot([file]), { code: 'ELOOP' });
  await assert.rejects(restoreToNewDirectory(m, f.backupRoot, path.join(f.base, 'symlink-object-restore')), { code: 'ELOOP' });
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
});

test('USN hash index reuses unchanged files and rehashes only changed file IDs', async t => {
  let nextUsn = 100;
  let records = [];
  const journal = {
    query: async () => ({ journalId: 'abc', firstUsn: '1', nextUsn: String(nextUsn) }),
    read: async startUsn => ({
      journalId: 'abc', firstUsn: '1', nextUsn: String(nextUsn),
      records: records.filter(record => BigInt(record.usn) >= BigInt(startUsn)),
    }),
  };
  const f = await fixture(t, { journal });
  const firstPath = path.join(f.roots[0], 'first.txt');
  const secondPath = path.join(f.roots[0], 'second.txt');
  await fs.writeFile(firstPath, 'first');
  await fs.writeFile(secondPath, 'second');

  const baseline = await f.snapshot(f.roots, { full: true });
  assert.equal(baseline.strategy, 'full-scan');
  assert.equal(baseline.hashedFiles, 2);

  const unchanged = await f.snapshot(f.roots, { full: true });
  assert.equal(unchanged.strategy, 'usn-incremental');
  assert.equal(unchanged.hashedFiles, 0);
  assert.equal(unchanged.reusedFiles, 2);

  const index = JSON.parse(await fs.readFile(path.join(f.backupRoot, 'indexes', 'full-snapshot.json'), 'utf8'));
  await fs.writeFile(secondPath, 'second changed');
  nextUsn += 10;
  records = [{ usn: '105', fileId: index.items[secondPath].fileId, parentId: index.items[f.roots[0]].fileId, directory: false }];
  const changed = await f.snapshot(f.roots, { full: true });
  assert.equal(changed.strategy, 'usn-incremental');
  assert.equal(changed.hashedFiles, 1);
  assert.equal(changed.reusedFiles, 1);
  assert.equal((await f.manifest(changed)).entries[secondPath].size, Buffer.byteLength('second changed'));
});

test('USN directory changes and journal resets fall back to a full hash scan', async t => {
  let journalId = 'abc';
  let records = [];
  const journal = {
    query: async () => ({ journalId, firstUsn: '1', nextUsn: '100' }),
    read: async startUsn => ({
      journalId, firstUsn: '1', nextUsn: '100',
      records: records.filter(record => BigInt(record.usn) >= BigInt(startUsn)),
    }),
  };
  const f = await fixture(t, { journal });
  const file = path.join(f.roots[0], 'source.txt');
  await fs.writeFile(file, 'source');
  await f.snapshot(f.roots, { full: true });
  const index = JSON.parse(await fs.readFile(path.join(f.backupRoot, 'indexes', 'full-snapshot.json'), 'utf8'));

  records = [{ usn: '100', fileId: index.items[f.roots[0]].fileId, parentId: index.items[f.roots[0]].fileId, directory: true }];
  const structural = await f.snapshot(f.roots, { full: true });
  assert.equal(structural.strategy, 'full-scan');
  assert.equal(structural.hashedFiles, 1);

  records = [];
  journalId = 'def';
  const reset = await f.snapshot(f.roots, { full: true });
  assert.equal(reset.strategy, 'full-scan');
  assert.equal(reset.hashedFiles, 1);
});

test('USN changes that arrive during snapshot verification discard the incremental attempt', async t => {
  let phase = 'baseline';
  let incrementalReads = 0;
  let ids;
  const journal = {
    query: async () => ({ journalId: 'abc', firstUsn: '1', nextUsn: phase === 'baseline' ? '100' : '110' }),
    read: async startUsn => {
      if (phase === 'baseline') return { journalId: 'abc', firstUsn: '1', nextUsn: '100', records: [] };
      incrementalReads += 1;
      const late = incrementalReads >= 2 && BigInt(startUsn) <= 100n;
      return {
        journalId: 'abc', firstUsn: '1', nextUsn: late ? '110' : '100',
        records: late ? [{ usn: '105', fileId: ids.file, parentId: ids.root, directory: false }] : [],
      };
    },
  };
  const f = await fixture(t, { journal });
  const file = path.join(f.roots[0], 'source.txt');
  await fs.writeFile(file, 'source');
  await f.snapshot(f.roots, { full: true });
  const index = JSON.parse(await fs.readFile(path.join(f.backupRoot, 'indexes', 'full-snapshot.json'), 'utf8'));
  ids = { file: index.items[file].fileId, root: index.items[f.roots[0]].fileId };
  phase = 'incremental';

  const result = await f.snapshot(f.roots, { full: true });
  assert.equal(result.strategy, 'full-scan');
  assert.equal(result.hashedFiles, 1);
});
