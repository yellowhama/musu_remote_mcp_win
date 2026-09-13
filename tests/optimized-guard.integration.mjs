// Run only against the disposable roots created in this test process.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

const disposableRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'musu-guard-integration-')));
const codeRoot = path.join(disposableRoot, 'workspace', 'code');
const wikiRoot = path.join(disposableRoot, 'workspace', 'wiki');
const stateRoot = path.join(disposableRoot, 'state');
const backupRoot = path.join(disposableRoot, 'backups');
process.env.MCP_EDITABLE_ROOTS = `${codeRoot},${wikiRoot}`;
process.env.MCP_BACKUP_ROOT = backupRoot;
process.env.MCP_JOBS_ROOT = path.join(stateRoot, 'jobs');
await assert.rejects(fs.access(path.join(stateRoot, 'jobs')), { code: 'ENOENT' });
await fs.mkdir(codeRoot, { recursive: true });
await fs.mkdir(wikiRoot, { recursive: true });
await fs.writeFile(path.join(codeRoot, 'code.txt'), 'original code 한글');
await fs.writeFile(path.join(wikiRoot, 'page.md'), 'original wiki 한글');
after(async () => fs.rm(disposableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const captured = new Map();
McpServer.prototype.registerTool = function(name, config, callback) {
  captured.set(name, { config, callback });
  return {};
};
await import('../optimized-guard.mjs');
const server = new McpServer({ name: 'disposable-guard-test', version: '1.0.0' });
const respond = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const extra = clientId => ({ authInfo: { clientId }, signal: new AbortController().signal });
async function call(name, input, clientId = 'alice') {
  const { config, callback } = captured.get(name);
  return callback(z.object(config.inputSchema).parse(input), extra(clientId));
}
function register(name, inputSchema, callback, readOnlyHint = false) {
  server.registerTool(name, { description: name, inputSchema, annotations: { readOnlyHint } }, callback);
}
let execCalls = 0, stdinCalls = 0, terminateCalls = 0;
const sessions = new Map(), observedAfterSeq = [];
register('exec_command', { cmd: z.string(), workdir: z.string().optional(), yieldTimeMs: z.number().default(10000), maxOutputBytes: z.number().default(65536) }, async args => {
  execCalls++;
  assert.equal(args.yieldTimeMs, 0);
  const sessionId = `00000000-0000-4000-8000-${String(execCalls).padStart(12, '0')}`;
  sessions.set(sessionId, { interactive: args.cmd === 'interactive', input: false, running: true });
  return respond({ sessionId, running: true, nextSeq: 1, output: 'started\n' });
});
register('read_process', { sessionId: z.string().uuid(), afterSeq: z.number().default(0), waitMs: z.number().default(0), maxOutputBytes: z.number().default(65536) }, async args => {
  observedAfterSeq.push(args.afterSeq);
  const state = sessions.get(args.sessionId);
  assert.ok(state);
  await delay(5);
  if (state.interactive && !state.input && state.running) return respond({ sessionId: args.sessionId, running: true, nextSeq: args.afterSeq, output: '' });
  state.running = false;
  return respond({ sessionId: args.sessionId, running: false, nextSeq: args.afterSeq + 1, output: 'finished\n', exitCode: 0 });
}, true);
register('write_stdin', { sessionId: z.string().uuid(), chars: z.string().optional(), closeStdin: z.boolean().default(false) }, async args => {
  stdinCalls++;
  sessions.get(args.sessionId).input = true;
  return respond({ sessionId: args.sessionId, accepted: true });
});
register('terminate_process', { sessionId: z.string().uuid(), signal: z.string().default('SIGTERM'), graceMs: z.number().default(1000) }, async args => {
  terminateCalls++;
  sessions.get(args.sessionId).running = false;
  return respond({ sessionId: args.sessionId, running: false });
});
register('write_file', { path: z.string(), cwd: z.string().optional(), content: z.string() }, async args => {
  await fs.writeFile(path.resolve(args.cwd || codeRoot, args.path), args.content);
  return respond({ written: true });
});
register('remove_path', { path: z.string(), cwd: z.string().optional(), recursive: z.boolean().default(false) }, async args => {
  await fs.rm(path.resolve(args.cwd || codeRoot, args.path), { recursive: args.recursive });
  return respond({ removed: true });
});
async function until(jobId, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await call('get_job', { jobId });
    assert.equal(response.isError, undefined);
    if (predicate(response.structuredContent)) return response.structuredContent;
    await delay(10);
  }
  assert.fail('Job failed to reach expected state');
}
async function manifest(id) {
  const names = await fs.readdir(path.join(backupRoot, 'manifests'));
  const name = names.find(value => value.includes(id));
  assert.ok(name, `Missing manifest ${id}`);
  return JSON.parse(await fs.readFile(path.join(backupRoot, 'manifests', name), 'utf8'));
}

test('deferred commands return submit guidance without execution', async () => {
  const response = await call('exec_command', { cmd: 'not executed' });
  assert.equal(response.isError, true);
  assert.match(response.structuredContent.error, /submit_job/);
  assert.equal(execCalls, 0);
});

test('direct code and relative wiki edits create target checkpoints preserving original bytes', async () => {
  for (const [filename, oldText] of [['code.txt', 'original code 한글'], ['../wiki/page.md', 'original wiki 한글']]) {
    const response = await call('write_file', { path: filename, content: 'edited' });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.checkpoint.count, 1);
    const document = await manifest(response.structuredContent.checkpoint.id);
    assert.ok(Object.hasOwn(document.entries, path.resolve(codeRoot, filename)));
    const objectNames = await fs.readdir(path.join(backupRoot, 'objects'));
    const bodies = await Promise.all(objectNames.filter(name => !name.endsWith('.tmp')).map(name => fs.readFile(path.join(backupRoot, 'objects', name), 'utf8')));
    assert.ok(bodies.includes(oldText));
  }
});

test('async jobs return and deduplicate, advance process sequence and persist terminal result', async () => {
  const args = { requestKey: 'exec-retry', tool: 'exec_command', arguments: { cmd: 'normal' } };
  const response = await call('submit_job', args);
  assert.equal(response.isError, undefined);
  const retry = await call('submit_job', args);
  assert.equal(retry.structuredContent.id, response.structuredContent.id);
  const job = await until(response.structuredContent.id, job => job.state === 'succeeded');
  assert.equal(execCalls, 1);
  assert.ok(observedAfterSeq.includes(1));
  assert.equal(observedAfterSeq.includes(0), false);
  assert.equal(job.result.output, 'started\nfinished\n');
  const jobFile = path.join(stateRoot, 'jobs', `${job.id}.json`);
  const persisted = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  // In-memory terminal state can precede atomic disk rename; wait for durable terminal.
  if (persisted.state !== 'succeeded') {
    await delay(50);
    assert.equal(JSON.parse(await fs.readFile(jobFile, 'utf8')).state, 'succeeded');
  }
  assert.equal((await call('get_job', { jobId: job.id }, 'bob')).isError, true);
  for (const tool of ['read_process', 'write_stdin', 'terminate_process']) {
    assert.equal((await call(tool, { sessionId: job.result.sessionId }, 'bob')).isError, true);
  }
  assert.equal(stdinCalls, 0);
  assert.equal(terminateCalls, 0);
});

test('relative wiki removal via job is covered by the full checkpoint', async () => {
  const response = await call('submit_job', { requestKey: 'remove-wiki', tool: 'remove_path', arguments: { path: '../wiki/page.md' } });
  const job = await until(response.structuredContent.id, job => job.state === 'succeeded');
  const document = await manifest(job.checkpoint.id);
  assert.ok(Object.hasOwn(document.entries, path.join(wikiRoot, 'page.md')));
  await assert.rejects(fs.access(path.join(wikiRoot, 'page.md')), { code: 'ENOENT' });
});

test('stdin control bypasses the serialized job queue and lets an interactive job finish', async () => {
  const response = await call('submit_job', { requestKey: 'interactive', tool: 'exec_command', arguments: { cmd: 'interactive' } });
  const running = await until(response.structuredContent.id, job => Boolean(job.process?.sessionId));
  const input = await call('write_stdin', { sessionId: running.process.sessionId, chars: 'continue\n' });
  assert.equal(input.isError, undefined);
  assert.equal(stdinCalls, 1);
  const done = await until(response.structuredContent.id, job => job.state === 'succeeded');
  assert.equal(done.result.running, false);
});
