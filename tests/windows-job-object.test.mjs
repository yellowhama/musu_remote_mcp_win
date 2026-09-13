import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const runner = path.join(projectRoot, 'windows', 'bin', 'MusuJobRunner.exe');

async function processExists(pid) {
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test('Windows Job Object closes a descendant tree when the runner exits', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async () => {
  await fs.access(runner);
  const script = [
    "$child = Start-Process pwsh.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300' -PassThru",
    'Write-Output $child.Id',
    '[Console]::Out.Flush()',
    'Start-Sleep -Seconds 300',
  ].join('; ');
  const wrapper = spawn(runner, [
    'pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const descendantPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for descendant PID')), 10_000);
    wrapper.once('error', reject);
    wrapper.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    wrapper.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/\b(\d+)\b/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  assert.equal(await processExists(descendantPid), true);
  wrapper.kill('SIGKILL');
  await new Promise((resolve) => wrapper.once('close', resolve));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await processExists(descendantPid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await processExists(descendantPid), false);
});
