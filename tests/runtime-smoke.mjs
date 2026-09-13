import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.REMOTE_DEV_RUNTIME_SMOKE, '1', 'Runtime-smoke opt-in required');
await fs.writeFile('/state/runtime.json', JSON.stringify({ publicUrl: 'http://127.0.0.1:3000' }), { mode: 0o600 });
await fs.writeFile('/state/approval-key.txt', 'runtime-smoke-approval-key-1234567890', { mode: 0o600 });

const child=spawn(process.execPath,['/opt/mcp/entrypoint.mjs'],{
  stdio:['ignore','pipe','pipe'],
  env:{...process.env,MCP_OAUTH_ENABLED:'true',MCP_ALLOW_NO_AUTH:'false'},
});
let output='';
child.stdout.on('data',chunk=>{output+=chunk});
child.stderr.on('data',chunk=>{output+=chunk});

try{
  let health;
  for(let attempt=0;attempt<30;attempt++){
    try{health=await fetch('http://127.0.0.1:3000/health',{headers:{host:'127.0.0.1'}});if(health.ok)break;}catch{}
    await delay(200);
  }
  assert.equal(health?.status,200,`Health check failed: ${output}`);
  const unauthenticated=await fetch('http://127.0.0.1:3000/mcp',{
    method:'POST',
    headers:{host:'127.0.0.1','content-type':'application/json',connection:'close'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}}),
  });
  assert.equal(unauthenticated.status,401);
  console.log('runtime-smoke: health=200 unauthenticated-mcp=401');
}finally{
  child.kill('SIGTERM');
  await Promise.race([once(child,'exit'),delay(3000)]);
  if(child.exitCode===null)child.kill('SIGKILL');
}
