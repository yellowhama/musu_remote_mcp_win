import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

test('Windows native entrypoint serves health and protects MCP', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'musu-remote-mcp-win-'));
  const editable = path.join(temporary, 'editable');
  const stateRoot = path.join(temporary, 'state');
  const backupRoot = path.join(temporary, 'backups');
  await fs.mkdir(editable, { recursive: true });
  const port = await freePort();
  const configFile = path.join(temporary, 'windows.json');
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    publicUrl: `http://127.0.0.1:${port}`,
    editableRoots: [editable],
    defaultCwd: editable,
    stateRoot,
    backupRoot,
    port,
    defaultShell: process.env.ComSpec || 'cmd.exe',
  }));
  const child = spawn(process.execPath, [path.join(projectRoot, 'windows', 'native-runtime.mjs'), configFile], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  try {
    let response;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Host: 'localhost' } });
        if (response.ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200, stderr);
    const protectedResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(protectedResponse.status, 401);
    assert.ok((await fs.readFile(path.join(stateRoot, 'approval-key.txt'), 'utf8')).trim().length >= 32);
  } finally {
    if (child.exitCode === null) {
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise(resolve => child.once('close', resolve));
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
