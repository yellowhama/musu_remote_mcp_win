import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function selectTunnelUrl(state, logs) {
  if (!state.Running || !Number.isFinite(Date.parse(state.StartedAt))) throw new Error('Tunnel is not running');
  const matches = [...logs.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
  if (!matches.length) throw new Error('No URL in current tunnel startup logs; retry shortly');
  return matches.at(-1)[0];
}

export async function updateRuntime(file, publicUrl) {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.trycloudflare.com') || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid Quick Tunnel base URL');
  const previous = await fs.readFile(file, 'utf8');
  if (JSON.parse(previous).publicUrl === publicUrl) return false;
  const suffix = `${Date.now()}-${randomUUID()}`;
  await fs.copyFile(file, `${file}.${suffix}.backup`);
  const temporary = `${file}.${suffix}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ publicUrl }), { flag: 'wx' });
  await fs.rename(temporary, file);
  return true;
}
