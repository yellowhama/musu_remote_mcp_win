import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PersistentOAuthStore } from "../src/oauth-store.js";

describe("SQLite OAuth store", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("migrates legacy JSON atomically and serves it from a WAL database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "musu-oauth-store-"));
    temporaryDirectories.push(directory);
    const stateFile = path.join(directory, "oauth-state.json");
    const rawToken = "legacy-access-token";
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const client = {
      client_id: "legacy-client",
      client_id_issued_at: 1,
      redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
      token_endpoint_auth_method: "none" as const,
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
    await writeFile(stateFile, JSON.stringify({
      version: 1,
      clients: { [client.client_id]: client },
      tokens: {
        [tokenHash]: {
          type: "access",
          clientId: client.client_id,
          scopes: ["mcp:tools"],
          expiresAt: Date.now() + 60_000,
          resource: "https://mcp.example/mcp",
          grantId: "legacy-grant",
        },
      },
    }));

    const store = new PersistentOAuthStore(stateFile, 3600, 86400, 10, () => undefined);
    expect(await store.getClient(client.client_id)).toMatchObject(client);
    expect(await store.getAccessToken(rawToken)).toMatchObject({ clientId: client.client_id });
    store.close();

    const sqliteBytes = await readFile(stateFile);
    expect(sqliteBytes.subarray(0, 16).toString("utf8")).toContain("SQLite format 3");
    expect(sqliteBytes.indexOf(rawToken)).toBe(-1);
    const files = await readdir(directory);
    expect(files.some((name) => name.includes("legacy-v1"))).toBe(true);
    for (const name of files.filter((candidate) => candidate.startsWith("oauth-state.json") && !candidate.includes("legacy-v1"))) {
      expect((await readFile(path.join(directory, name))).includes(Buffer.from(rawToken))).toBe(false);
    }
    const database = new DatabaseSync(stateFile, { readOnly: true });
    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(database.prepare("SELECT COUNT(*) AS total FROM oauth_tokens").get()).toMatchObject({ total: 1 });
    database.close();
  });
});
