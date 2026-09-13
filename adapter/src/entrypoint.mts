import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateRoot = path.resolve(process.env.MCP_STATE_ROOT || path.join(projectRoot, 'state'));
const settings = JSON.parse(await fs.readFile(path.join(stateRoot, 'runtime.json'), 'utf8'));
process.env.MCP_PUBLIC_URL = settings.publicUrl;
process.env.MCP_ALLOWED_HOSTS = `${new URL(settings.publicUrl).hostname},localhost,127.0.0.1,mcp`;
process.env.MCP_ALLOWED_ORIGINS = new URL(settings.publicUrl).origin;
process.env.MCP_OAUTH_APPROVAL_KEY = (await fs.readFile(path.join(stateRoot, 'approval-key.txt'), 'utf8')).trim();
process.env.MCP_METRICS_TOKEN = (await fs.readFile(path.join(stateRoot, 'metrics-key.txt'), 'utf8')).trim();
delete process.env.MCP_AUTH_TOKEN;
await import('./guard.mjs');
const upstreamServerUrl = new URL('../../vendor/dist/src/server.js', import.meta.url);
await import(upstreamServerUrl.href);
