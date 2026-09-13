await import('./guard.mjs');
const upstreamServerUrl = new URL('../../vendor/dist/src/server.js', import.meta.url);
await import(upstreamServerUrl.href);
