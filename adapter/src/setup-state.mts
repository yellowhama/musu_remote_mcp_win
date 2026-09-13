import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(process.env.MCP_STATE_ROOT || path.join(projectRoot, 'state'));
await fs.mkdir(dir, { recursive: true });
for (const name of ['approval-key.txt']) {
  try { await fs.writeFile(path.join(dir, name), randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
try { await fs.writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ publicUrl: 'http://127.0.0.1:39391' }), { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
console.log('Local authentication files are ready. Secrets are not printed.');
