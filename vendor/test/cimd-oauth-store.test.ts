import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  CimdOAuthStore,
  createPinnedLookup,
  isPublicCimdAddress,
  parseCimdClientId,
} from "../src/cimd-oauth-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function metadataProblem(value: unknown): string | undefined {
  const client = value as Partial<OAuthClientInformationFull>;
  if (!Array.isArray(client?.redirect_uris) || client.redirect_uris.length === 0) return "redirect required";
  return undefined;
}

async function createStore(resolver: (clientId: string) => Promise<OAuthClientInformationFull | undefined>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cimd-store-"));
  temporaryDirectories.push(directory);
  return new CimdOAuthStore(path.join(directory, "state.sqlite"), 3600, 7200, 4, metadataProblem, resolver);
}

describe("CIMD and DCR client resolution", () => {
  it("returns an address array when Node requests all lookup results", async () => {
    const pinnedLookup = createPinnedLookup([{ address: "203.0.113.10", family: 4 }]);
    const result = await new Promise<string | import("node:dns").LookupAddress[]>((resolve, reject) => {
      pinnedLookup("client.example", { all: true }, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    });
    expect(result).toEqual([{ address: "203.0.113.10", family: 4 }]);
  });

  it("accepts canonical HTTPS document URLs and rejects ambiguous identifiers", () => {
    expect(parseCimdClientId("https://client.example/oauth/metadata")?.href)
      .toBe("https://client.example/oauth/metadata");
    for (const invalid of [
      "http://client.example/oauth/metadata",
      "https://client.example/",
      "https://user@client.example/oauth/metadata",
      "https://client.example/oauth/metadata?version=1",
      "https://client.example/oauth/metadata#fragment",
      "https://CLIENT.example/oauth/metadata",
      "https://client.example/oauth/%2e%2e/metadata",
    ]) expect(parseCimdClientId(invalid)).toBeUndefined();
  });

  it("rejects private and special-purpose addresses", () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1",
      "100.64.0.1", "0.0.0.0", "224.0.0.1", "::", "::1", "fc00::1", "fe80::1",
      "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    ]) expect(isPublicCimdAddress(address), address).toBe(false);
    expect(isPublicCimdAddress("8.8.8.8")).toBe(true);
    expect(isPublicCimdAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("resolves CIMD once, caches it, and keeps DCR registration available", async () => {
    const clientId = "https://client.example/oauth/metadata";
    let calls = 0;
    const store = await createStore(async (requested) => {
      calls += 1;
      return {
        client_id: requested,
        redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "CIMD test client",
      };
    });
    try {
      const [first, second] = await Promise.all([store.getClient(clientId), store.getClient(clientId)]);
      expect(first?.client_id).toBe(clientId);
      expect(second?.client_id).toBe(clientId);
      expect(calls).toBe(1);

      const dcr = await store.registerClient({
        redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        token_endpoint_auth_method: "none",
      });
      expect((await store.getClient(dcr.client_id))?.client_id).toBe(dcr.client_id);
    } finally {
      store.close();
    }
  });

  it("selects none from ChatGPT's transitional authentication-method intersection", async () => {
    const clientId = "https://chatgpt.com/oauth/connection/client.json";
    const store = await createStore(async (requested) => ({
      client_id: requested,
      redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "ChatGPT",
    } as OAuthClientInformationFull));
    try {
      expect(await store.getClient(clientId)).toMatchObject({
        client_id: clientId,
        token_endpoint_auth_method: "none",
      });
    } finally {
      store.close();
    }
  });

  it("rejects mismatched, secret-bearing, or confidential CIMD documents", async () => {
    const variants: OAuthClientInformationFull[] = [
      { client_id: "https://other.example/oauth/client", redirect_uris: ["https://chatgpt.com/callback"], token_endpoint_auth_method: "none" },
      { client_id: "https://client.example/oauth/client", redirect_uris: ["https://chatgpt.com/callback"], token_endpoint_auth_method: "client_secret_post" },
      { client_id: "https://client.example/oauth/client", redirect_uris: ["https://chatgpt.com/callback"], token_endpoint_auth_method: "none", client_secret: "must-not-be-present" },
    ];
    for (const metadata of variants) {
      const store = await createStore(async () => metadata);
      try {
        expect(await store.getClient("https://client.example/oauth/client")).toBeUndefined();
      } finally {
        store.close();
      }
    }
  });
});
