import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

function runPwsh(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', ...arguments_], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => stderr += data.toString());
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function metrics({ cimd = 0, dcr = 0, mcp = 0, oauth = 0 }) {
  return [
    `musu_oauth_client_resolution_total{method="cimd",outcome="success"} ${cimd}`,
    'musu_oauth_client_resolution_total{method="cimd",outcome="failure"} 0',
    `musu_oauth_client_resolution_total{method="dcr",outcome="success"} ${dcr}`,
    'musu_oauth_client_resolution_total{method="dcr",outcome="failure"} 0',
    `musu_http_requests_total{route="mcp",status_class="2xx"} ${mcp}`,
    `musu_http_requests_total{route="oauth",status_class="2xx"} ${oauth}`,
    '',
  ].join('\n');
}

test('ChatGPT compatibility capture compares authenticated before/after metrics', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'musu-chatgpt-capture-'));
  const stateRoot = path.join(temporary, 'state');
  await fs.mkdir(stateRoot);
  await fs.writeFile(path.join(stateRoot, 'metrics-key.txt'), 'test-metrics-key-with-at-least-32-characters');
  let requests = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-metrics-key-with-at-least-32-characters');
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(requests === 1 ? metrics({}) : metrics({ cimd: 1, mcp: 2, oauth: 3 }));
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
  const script = path.join(projectRoot, 'windows', 'Capture-ChatGPTCompatibility.ps1');
  const begin = await runPwsh(['-File', script, '-Phase', 'Begin', '-GatewayUrl', gatewayUrl, '-StateRoot', stateRoot]);
  assert.equal(begin.code, 0, begin.stderr);
  const end = await runPwsh(['-File', script, '-Phase', 'End', '-GatewayUrl', gatewayUrl, '-StateRoot', stateRoot]);
  assert.equal(end.code, 0, end.stderr);
  const result = JSON.parse(await fs.readFile(path.join(stateRoot, 'acceptance', 'chatgpt', 'compatibility-result.json')));
  assert.equal(result.passed, true);
  assert.equal(result.selectedMethod, 'cimd');
  assert.equal(result.delta.cimdSuccess, 1);
  assert.equal(result.delta.mcp2xx, 2);
});

test('reboot acceptance status reads persisted evidence without elevation', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'musu-reboot-status-'));
  try {
    await fs.writeFile(path.join(temporary, 'reboot-result.json'), JSON.stringify({ schemaVersion: 1, passed: true }));
    const script = path.join(projectRoot, 'windows', 'Test-RebootPersistence.ps1');
    const status = await runPwsh(['-File', script, '-Phase', 'Status', '-EvidenceDirectory', temporary]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).passed, true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
