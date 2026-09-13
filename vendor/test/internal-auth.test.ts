import { describe, expect, it } from "vitest";

import { createInternalHeaders, InternalRequestVerifier } from "../src/internal-auth.js";

describe("gateway-to-worker request authentication", () => {
  it("binds client identity to the exact body and rejects replay", () => {
    const key = "a".repeat(64);
    const verifier = new InternalRequestVerifier(key);
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const headers = createInternalHeaders(key, "chatgpt-client", body);
    expect(verifier.verify(headers, body)).toMatchObject({
      clientId: "chatgpt-client",
      scopes: ["mcp:tools"],
    });
    expect(verifier.verify(headers, body)).toBeUndefined();
  });

  it("rejects body and signature tampering", () => {
    const key = "b".repeat(64);
    const body = { method: "tools/list" };
    const headers = createInternalHeaders(key, "client-one", body);
    expect(new InternalRequestVerifier(key).verify(headers, { method: "tools/call" })).toBeUndefined();
    expect(new InternalRequestVerifier("c".repeat(64)).verify(headers, body)).toBeUndefined();
  });
});
