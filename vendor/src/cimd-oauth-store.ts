import { lookup } from "node:dns/promises";
import { channel } from "node:diagnostics_channel";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";

import { PersistentOAuthStore } from "./oauth-store.js";

type ClientProblem = (value: unknown) => string | undefined;
type MetadataResolver = (clientId: string) => Promise<OAuthClientInformationFull | undefined>;

const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_RESPONSE_BYTES = 64 * 1024;
const CIMD_CACHE_TTL_MS = 10 * 60 * 1_000;
const telemetry = channel("musu.remote-mcp.telemetry");

interface CachedClient {
  client: OAuthClientInformationFull;
  expiresAt: number;
}

function parseIpv4(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : undefined;
}

const blockedIpv6 = new BlockList();
blockedIpv6.addAddress("::", "ipv6");
blockedIpv6.addAddress("::1", "ipv6");
blockedIpv6.addSubnet("::ffff:0.0.0.0", 96, "ipv6");
blockedIpv6.addSubnet("fc00::", 7, "ipv6");
blockedIpv6.addSubnet("fe80::", 10, "ipv6");
blockedIpv6.addSubnet("ff00::", 8, "ipv6");
blockedIpv6.addSubnet("2001:db8::", 32, "ipv6");
blockedIpv6.addSubnet("2001:2::", 48, "ipv6");
blockedIpv6.addSubnet("2001:10::", 28, "ipv6");
blockedIpv6.addSubnet("64:ff9b:1::", 48, "ipv6");

export function isPublicCimdAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a = 0, b = 0] = ipv4;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (ipv4[2] === 0 || ipv4[2] === 2)) ||
      (a === 192 && b === 88 && ipv4[2] === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && ipv4[2] === 100) ||
      (a === 203 && b === 0 && ipv4[2] === 113) ||
      a >= 224
    );
  }

  if (isIP(address) !== 6) return false;
  return !blockedIpv6.check(address, "ipv6");
}

export function parseCimdClientId(clientId: string): URL | undefined {
  if (clientId.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || url.pathname === "/"
  ) return undefined;
  if (url.href !== clientId) return undefined;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return url;
}

async function fetchCimdMetadata(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const url = parseCimdClientId(clientId);
  if (!url) return undefined;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicCimdAddress(address))) {
    return undefined;
  }
  const allowed = new Map(addresses.map((entry) => [entry.address, entry.family]));

  return await new Promise((resolve) => {
    const requestHandle = request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      timeout: CIMD_TIMEOUT_MS,
      lookup: (_hostname, _options, callback) => {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      },
    }, (response) => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume();
        resolve(undefined);
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
        response.resume();
        resolve(undefined);
        return;
      }
      const remoteAddress = response.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (!remoteAddress || !allowed.has(remoteAddress)) {
        response.destroy();
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > CIMD_MAX_RESPONSE_BYTES) response.destroy();
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (length > CIMD_MAX_RESPONSE_BYTES) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OAuthClientInformationFull);
        } catch {
          resolve(undefined);
        }
      });
      response.on("error", () => resolve(undefined));
    });
    requestHandle.once("timeout", () => requestHandle.destroy());
    requestHandle.once("error", () => resolve(undefined));
    requestHandle.end();
  });
}

export class CimdOAuthStore extends PersistentOAuthStore {
  private readonly cache = new Map<string, CachedClient>();
  private readonly pending = new Map<string, Promise<OAuthClientInformationFull | undefined>>();

  constructor(
    stateFile: string,
    accessTokenTtlSeconds: number,
    refreshTokenTtlSeconds: number,
    private readonly maxCimdClients: number,
    private readonly cimdClientProblem: ClientProblem,
    private readonly resolveMetadata: MetadataResolver = fetchCimdMetadata,
  ) {
    super(stateFile, accessTokenTtlSeconds, refreshTokenTtlSeconds, maxCimdClients, cimdClientProblem);
  }

  override async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const registered = await super.getClient(clientId);
    if (registered) return registered;
    if (!parseCimdClientId(clientId)) return undefined;
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;
    this.cache.delete(clientId);

    const current = this.pending.get(clientId);
    if (current) return current;
    const resolution = this.resolveAndValidate(clientId).finally(() => this.pending.delete(clientId));
    this.pending.set(clientId, resolution);
    return resolution;
  }

  override async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const registered = await super.registerClient(client);
    telemetry.publish({ type: "oauth_client_resolution", method: "dcr", outcome: "success" });
    return registered;
  }

  private async resolveAndValidate(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    let client: OAuthClientInformationFull | undefined;
    try {
      client = await this.resolveMetadata(clientId);
    } catch {
      telemetry.publish({ type: "oauth_client_resolution", method: "cimd", outcome: "failure" });
      return undefined;
    }
    if (
      !client || client.client_id !== clientId ||
      client.token_endpoint_auth_method !== "none" ||
      "client_secret" in client || this.cimdClientProblem(client)
    ) {
      telemetry.publish({ type: "oauth_client_resolution", method: "cimd", outcome: "failure" });
      return undefined;
    }
    while (this.cache.size >= this.maxCimdClients) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
    this.cache.set(clientId, { client, expiresAt: Date.now() + CIMD_CACHE_TTL_MS });
    telemetry.publish({ type: "oauth_client_resolution", method: "cimd", outcome: "success" });
    return client;
  }
}
