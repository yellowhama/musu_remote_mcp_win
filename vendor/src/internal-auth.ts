import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/server";

const INTERNAL_AUTH_WINDOW_MS = 30_000;
const MAX_NONCES = 4_096;

function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

function signature(key: string, timestamp: string, nonce: string, clientId: string, body: unknown): string {
  return createHmac("sha256", key)
    .update(`${timestamp}\n${nonce}\n${clientId}\n${bodyHash(body)}`)
    .digest("base64url");
}

export function createInternalHeaders(key: string, clientId: string, body: unknown): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  return {
    "x-musu-client-id": clientId,
    "x-musu-timestamp": timestamp,
    "x-musu-nonce": nonce,
    "x-musu-signature": signature(key, timestamp, nonce, clientId, body),
  };
}

export class InternalRequestVerifier {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly key: string) {}

  verify(headers: Record<string, string | string[] | undefined>, body: unknown): AuthInfo | undefined {
    const clientId = this.single(headers["x-musu-client-id"]);
    const timestamp = this.single(headers["x-musu-timestamp"]);
    const nonce = this.single(headers["x-musu-nonce"]);
    const supplied = this.single(headers["x-musu-signature"]);
    if (!clientId || clientId.length > 2_048 || !timestamp || !nonce || !supplied) return undefined;
    if (!/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^\d{13}$/.test(timestamp)) return undefined;
    const timestampMs = Number(timestamp);
    const now = Date.now();
    if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > INTERNAL_AUTH_WINDOW_MS) return undefined;
    this.prune(now);
    if (this.nonces.has(nonce)) return undefined;
    const expected = signature(this.key, timestamp, nonce, clientId, body);
    const actualBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
    if (this.nonces.size >= MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value!);
    this.nonces.set(nonce, timestampMs);
    return { token: "internal-gateway", clientId, scopes: ["mcp:tools"] };
  }

  private single(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private prune(now: number): void {
    for (const [nonce, timestamp] of this.nonces) {
      if (now - timestamp > INTERNAL_AUTH_WINDOW_MS) this.nonces.delete(nonce);
    }
  }
}
