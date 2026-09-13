import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/server";
import {
  InvalidClientMetadataError,
} from "@modelcontextprotocol/server-legacy/auth";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/server-legacy/auth";

export interface StoredToken {
  type: "access" | "refresh" | "used_refresh";
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
  grantId?: string;
}

export type RefreshResult =
  | { status: "invalid" }
  | { status: "invalid_scope" }
  | { status: "ok"; tokens: OAuthTokens };

interface LegacyState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, StoredToken>;
}

type ClientProblem = (value: unknown) => string | undefined;

interface TokenRow {
  type: StoredToken["type"];
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string;
  grant_id: string | null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<StoredToken>;
  return (
    (token.type === "access" || token.type === "refresh" || token.type === "used_refresh") &&
    typeof token.clientId === "string" &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === "string") &&
    typeof token.expiresAt === "number" &&
    typeof token.resource === "string" &&
    (token.grantId === undefined || typeof token.grantId === "string") &&
    (token.type !== "used_refresh" || typeof token.grantId === "string")
  );
}

function parseLegacyState(value: string, clientProblem: ClientProblem): LegacyState {
  const parsed = JSON.parse(value) as Partial<LegacyState>;
  if (
    parsed.version !== 1 ||
    !parsed.clients ||
    typeof parsed.clients !== "object" ||
    Array.isArray(parsed.clients) ||
    !Object.values(parsed.clients).every((client) => clientProblem(client) === undefined) ||
    !parsed.tokens ||
    typeof parsed.tokens !== "object" ||
    Array.isArray(parsed.tokens) ||
    !Object.values(parsed.tokens).every(isStoredToken)
  ) {
    throw new Error("Invalid legacy OAuth state file format");
  }
  return parsed as LegacyState;
}

function decodeToken(row: TokenRow | undefined): StoredToken | undefined {
  if (!row) return undefined;
  const scopes = JSON.parse(row.scopes_json) as unknown;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
    throw new Error("Invalid OAuth token scope data");
  }
  return {
    type: row.type,
    clientId: row.client_id,
    scopes,
    expiresAt: row.expires_at,
    resource: row.resource,
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
  };
}

export class PersistentOAuthStore implements OAuthRegisteredClientsStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(
    private readonly stateFile: string,
    private readonly accessTokenTtlSeconds: number,
    private readonly refreshTokenTtlSeconds: number,
    private readonly maxRegisteredClients: number,
    private readonly clientProblem: ClientProblem,
  ) {
    mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const legacy = this.extractLegacyState();
    try {
      this.database = new DatabaseSync(stateFile, { timeout: 5000 });
      this.database.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS oauth_clients (
          client_id TEXT PRIMARY KEY,
          metadata_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          token_hash TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('access','refresh','used_refresh')),
          client_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          resource TEXT NOT NULL,
          grant_id TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires_at);
        CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);
      `);
      if (process.platform !== "win32") chmodSync(stateFile, 0o600);
      if (legacy) this.importLegacyState(legacy);
    } catch (error) {
      if (legacy) this.restoreLegacyState(legacy.file);
      else this.closeAfterInitializationFailure();
      throw error;
    }
  }

  private closeAfterInitializationFailure(): void {
    try {
      this.database?.close();
    } catch {}
  }

  private extractLegacyState(): { file: string; state: LegacyState } | undefined {
    if (!existsSync(this.stateFile)) return undefined;
    const bytes = readFileSync(this.stateFile);
    if (bytes.subarray(0, 16).toString("utf8").trimStart()[0] !== "{") return undefined;
    const state = parseLegacyState(bytes.toString("utf8"), this.clientProblem);
    const file = `${this.stateFile}.legacy-v1-${Date.now()}.json`;
    renameSync(this.stateFile, file);
    return { file, state };
  }

  private restoreLegacyState(file: string): void {
    try {
      this.database?.close();
    } catch {}
    rmSync(this.stateFile, { force: true });
    renameSync(file, this.stateFile);
  }

  private importLegacyState(legacy: { file: string; state: LegacyState }): void {
    this.transaction(() => {
      for (const client of Object.values(legacy.state.clients)) this.putClient(client);
      for (const [hash, token] of Object.entries(legacy.state.tokens)) this.putToken(hash, token);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.pruneExpired();
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private pruneExpired(): void {
    this.database.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(Date.now());
  }

  private putClient(client: OAuthClientInformationFull): void {
    this.database.prepare(`
      INSERT INTO oauth_clients(client_id, metadata_json) VALUES(?, ?)
      ON CONFLICT(client_id) DO UPDATE SET metadata_json=excluded.metadata_json
    `).run(client.client_id, JSON.stringify(client));
  }

  private putToken(hash: string, token: StoredToken): void {
    this.database.prepare(`
      INSERT INTO oauth_tokens(token_hash,type,client_id,scopes_json,expires_at,resource,grant_id)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(token_hash) DO UPDATE SET
        type=excluded.type, client_id=excluded.client_id, scopes_json=excluded.scopes_json,
        expires_at=excluded.expires_at, resource=excluded.resource, grant_id=excluded.grant_id
    `).run(hash, token.type, token.clientId, JSON.stringify(token.scopes), token.expiresAt, token.resource, token.grantId ?? null);
  }

  private getToken(hash: string): StoredToken | undefined {
    return decodeToken(this.database.prepare(`
      SELECT type,client_id,scopes_json,expires_at,resource,grant_id
      FROM oauth_tokens WHERE token_hash=?
    `).get(hash) as TokenRow | undefined);
  }

  private issueTokenPairWithoutCommit(
    clientId: string,
    scopes: string[],
    resource: string,
    grantId: string,
    issueRefreshToken = true,
  ): OAuthTokens {
    const accessToken = randomToken();
    const now = Date.now();
    this.putToken(tokenHash(accessToken), {
      type: "access", clientId, scopes,
      expiresAt: now + this.accessTokenTtlSeconds * 1000,
      resource, grantId,
    });
    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      scope: scopes.join(" "),
    };
    if (issueRefreshToken) {
      const refreshToken = randomToken();
      this.putToken(tokenHash(refreshToken), {
        type: "refresh", clientId, scopes,
        expiresAt: now + this.refreshTokenTtlSeconds * 1000,
        resource, grantId,
      });
      tokens.refresh_token = refreshToken;
    }
    return tokens;
  }

  private revokeGrant(grantId: string, preserveReplayEvidence = false): void {
    if (preserveReplayEvidence) {
      this.database.prepare("DELETE FROM oauth_tokens WHERE grant_id=? AND type<>'used_refresh'").run(grantId);
    } else {
      this.database.prepare("DELETE FROM oauth_tokens WHERE grant_id=?").run(grantId);
    }
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = this.database.prepare("SELECT metadata_json FROM oauth_clients WHERE client_id=?").get(clientId) as { metadata_json: string } | undefined;
    if (!row) return undefined;
    const client = JSON.parse(row.metadata_json) as OAuthClientInformationFull;
    return client.client_id === clientId && !this.clientProblem(client) ? client : undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const supplied = client as Partial<OAuthClientInformationFull>;
    const registered: OAuthClientInformationFull = {
      ...client,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "client_secret_post",
      grant_types: client.grant_types ?? ["authorization_code"],
      response_types: client.response_types ?? ["code"],
      client_id: supplied.client_id || randomUUID(),
      client_id_issued_at: supplied.client_id_issued_at || Math.floor(Date.now() / 1000),
    };
    const problem = this.clientProblem(registered);
    if (problem) throw new InvalidClientMetadataError(problem);
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT 1 AS found FROM oauth_clients WHERE client_id=?").get(registered.client_id);
      const count = this.database.prepare("SELECT COUNT(*) AS total FROM oauth_clients").get() as { total: number };
      if (!existing && count.total >= this.maxRegisteredClients) {
        throw new InvalidClientMetadataError(`Registered client limit reached: ${this.maxRegisteredClients}`);
      }
      this.putClient(registered);
      return registered;
    });
  }

  async issueTokenPair(clientId: string, scopes: string[], resource: string, issueRefreshToken = true): Promise<OAuthTokens> {
    return this.transaction(() => this.issueTokenPairWithoutCommit(clientId, scopes, resource, randomUUID(), issueRefreshToken));
  }

  async rotateRefreshToken(
    refreshToken: string,
    clientId: string,
    resource: string,
    requestedScopes: string[] | undefined,
  ): Promise<RefreshResult> {
    return this.transaction(() => {
      const hash = tokenHash(refreshToken);
      const current = this.getToken(hash);
      if (!current || current.clientId !== clientId || current.resource !== resource || current.expiresAt <= Date.now()) return { status: "invalid" };
      if (current.type === "used_refresh") {
        this.revokeGrant(current.grantId!, true);
        return { status: "invalid" };
      }
      if (current.type !== "refresh") return { status: "invalid" };
      const scopes = requestedScopes ?? current.scopes;
      if (!scopes.every((scope) => current.scopes.includes(scope))) return { status: "invalid_scope" };
      const grantId = current.grantId ?? randomUUID();
      this.putToken(hash, { ...current, type: "used_refresh", grantId });
      return { status: "ok", tokens: this.issueTokenPairWithoutCommit(clientId, scopes, resource, grantId) };
    });
  }

  async getAccessToken(token: string): Promise<StoredToken | undefined> {
    const stored = this.getToken(tokenHash(token));
    if (!stored || stored.type !== "access" || stored.expiresAt <= Date.now()) return undefined;
    return (await this.getClient(stored.clientId)) ? stored : undefined;
  }

  async revoke(token: string, clientId: string): Promise<void> {
    this.transaction(() => {
      const hash = tokenHash(token);
      const stored = this.getToken(hash);
      if (!stored || stored.clientId !== clientId) return;
      if (stored.grantId) this.revokeGrant(stored.grantId);
      else this.database.prepare("DELETE FROM oauth_tokens WHERE token_hash=?").run(hash);
    });
  }

  close(): void {
    if (this.closed) return;
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.closed = true;
      this.database.close();
    }
  }
}
