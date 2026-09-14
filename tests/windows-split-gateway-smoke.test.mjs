import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child, log) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`process exited early: ${log.value}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`health timeout: ${log.value}`);
}

test('separate gateway and worker processes complete OAuth and signed MCP proxying', { skip: process.platform !== 'win32' }, async t => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'musu-split-smoke-'));
  const workspace = path.join(base, 'workspace');
  const stateRoot = path.join(base, 'gateway-state');
  const workerStateRoot = path.join(base, 'worker-state');
  const brokerRoot = path.join(base, 'broker');
  const backupRoot = path.join(base, 'backups');
  await Promise.all([workspace, stateRoot, workerStateRoot, brokerRoot, backupRoot].map(directory => fs.mkdir(directory)));
  await fs.writeFile(path.join(stateRoot, 'approval-key.txt'), 'split-approval-key');
  await fs.writeFile(path.join(stateRoot, 'metrics-key.txt'), 'split-metrics-key-with-at-least-32-characters');
  await fs.writeFile(path.join(brokerRoot, 'internal-key.txt'), randomBytes(48).toString('base64url'));
  const port = await reservePort();
  const workerPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = {
    version: 1, publicUrl: baseUrl, editableRoots: [workspace], defaultCwd: workspace,
    stateRoot, workerStateRoot, brokerRoot, backupRoot, port, workerPort,
    defaultShell: 'pwsh.exe', retention: { minFreeBytes: 0 },
  };
  const configPath = path.join(base, 'windows.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  const processes = [];
  const start = role => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'windows', 'native-runtime.mjs'), configPath, role], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = { value: '' };
    child.stdout.on('data', data => { log.value += data; });
    child.stderr.on('data', data => { log.value += data; });
    processes.push(child);
    return { child, log };
  };
  t.after(async () => {
    for (const child of processes.reverse()) {
      if (child.exitCode === null) child.kill();
      await new Promise(resolve => child.once('exit', resolve)).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true });
  });

  const worker = start('worker');
  await waitForHealth(`http://127.0.0.1:${workerPort}/health`, worker.child, worker.log);
  const unsigned = await fetch(`http://127.0.0.1:${workerPort}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${await fs.readFile(path.join(brokerRoot, 'internal-key.txt'), 'utf8')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unsigned.status, 401);

  const gateway = start('gateway');
  await waitForHealth(`${baseUrl}/health`, gateway.child, gateway.log);
  const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
  const registration = await fetch(`${baseUrl}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const values = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${baseUrl}/mcp` };
  const approval = await fetch(`${baseUrl}/authorize`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...values, access_key: 'split-approval-key' }), redirect: 'manual',
  });
  assert.equal(approval.status, 303);
  const code = new URL(approval.headers.get('location')).searchParams.get('code');
  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: `${baseUrl}/mcp` }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  const discover = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'server/discover',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'split-smoke', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(discover.status, 200, `${await discover.text()}\n${gateway.log.value}\n${worker.log.value}`);
  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'split-smoke', version: '1' } } }),
  });
  assert.equal(initialize.status, 200, `${await initialize.text()}\n${gateway.log.value}\n${worker.log.value}`);
  const submit = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'submit_job',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'submit_job', arguments: { requestKey: 'split-owner-proof', tool: 'checkpoint', arguments: {} },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'split-smoke', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const submitBody = await submit.text();
  assert.equal(submit.status, 200, `${submitBody}\n${gateway.log.value}\n${worker.log.value}`);
  assert.doesNotMatch(submitBody, /Authenticated OAuth client required/);
  assert.match(submitBody, /queued|backing_up/);
  await new Promise(resolve => setTimeout(resolve, 250));
  const metrics = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(metrics.status, 200);
  const metricsBody = await metrics.text();
  assert.match(metricsBody, /musu_oauth_client_resolution_total/);
  assert.match(metricsBody, /musu_worker_checkpoints_total/);
  const operatorMetrics = await fetch(`${baseUrl}/metrics`, { headers: { authorization: 'Bearer split-metrics-key-with-at-least-32-characters' } });
  assert.equal(operatorMetrics.status, 200);
  const metricsKeyAtMcp = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer split-metrics-key-with-at-least-32-characters', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }),
  });
  assert.equal(metricsKeyAtMcp.status, 401);
  await new Promise(resolve => setTimeout(resolve, 4500));
  assert.equal(worker.child.exitCode, null, `worker exited after startup: ${worker.log.value}`);
  assert.equal(gateway.child.exitCode, null, `gateway exited after startup: ${gateway.log.value}`);
});
