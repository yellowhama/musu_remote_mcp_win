import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const dir = new URL('./state/', import.meta.url);
await fs.mkdir(dir, { recursive: true });
for (const name of ['approval-key.txt']) {
  try { await fs.writeFile(new URL(name, dir), randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
try { await fs.writeFile(new URL('runtime.json', dir), JSON.stringify({ publicUrl: 'http://127.0.0.1:39391' }), { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
console.log('Local authentication files are ready. Secrets are not printed.');
