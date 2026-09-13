import { expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createBearerAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

test('verified OAuth principal is forwarded to SDK request auth', async () => {
  const config=loadConfig({MCP_OAUTH_ENABLED:'true',MCP_OAUTH_APPROVAL_KEY:'fixture-key',MCP_PUBLIC_URL:'https://fixture.example'});
  const auth={token:'fixture-token',clientId:'fixture-client',scopes:['mcp:tools'],expiresAt:Math.floor(Date.now()/1000)+60,resource:new URL(config.oauthResourceUrl!)};
  const request={header:()=> 'Bearer fixture-token'};
  const next=vi.fn();
  await createBearerAuth(config,{verifyAccessToken:async()=>auth})(request as unknown as Request,{} as Response,next);
  expect(next).toHaveBeenCalledOnce();
  expect((request as typeof request & {auth:typeof auth}).auth).toBe(auth);
});

test('invalid audience never attaches a principal or calls next', async () => {
  const config=loadConfig({MCP_OAUTH_ENABLED:'true',MCP_OAUTH_APPROVAL_KEY:'fixture-key',MCP_PUBLIC_URL:'https://fixture.example'});
  const request={header:()=> 'Bearer fixture-token'};
  const response={status:vi.fn().mockReturnThis(),set:vi.fn().mockReturnThis(),json:vi.fn()};
  const next=vi.fn();
  await createBearerAuth(config,{verifyAccessToken:async()=>({token:'fixture-token',clientId:'fixture-client',scopes:['mcp:tools'],expiresAt:Math.floor(Date.now()/1000)+60,resource:new URL('https://other.example/mcp')})})(request as unknown as Request,response as unknown as Response,next);
  expect(next).not.toHaveBeenCalled();expect(request).not.toHaveProperty('auth');expect(response.status).toHaveBeenCalledWith(401);
});
