import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectTunnelUrl, updateRuntime } from '../adapter/dist/tunnel-runtime.mjs';
test('stopped tunnel and current startup without URL are rejected', () => {
  assert.throws(() => selectTunnelUrl({ Running: false }, 'https://old.trycloudflare.com'), /not running/);
  assert.throws(() => selectTunnelUrl({ Running: true, StartedAt: new Date().toISOString() }, 'starting'), /No URL/);
});
test('URL update preserves previous bytes and is idempotent', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-dev-tunnel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime.json');
  const old = '{"publicUrl":"http://127.0.0.1:39391"}\r\n';
  await fs.writeFile(file, old);
  assert.equal(await updateRuntime(file, 'https://new.trycloudflare.com'), true);
  const backup = (await fs.readdir(dir)).find(name => name.endsWith('.backup'));
  assert.equal(await fs.readFile(path.join(dir, backup), 'utf8'), old);
  assert.equal(await updateRuntime(file, 'https://new.trycloudflare.com'), false);
  await assert.rejects(updateRuntime(file, 'http://evil.example'), /Invalid/);
  assert.equal(JSON.parse(await fs.readFile(file)).publicUrl, 'https://new.trycloudflare.com');
});
