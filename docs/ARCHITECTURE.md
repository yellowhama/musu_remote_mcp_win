# Architecture

## Request flow

```text
Remote MCP client
  -> HTTPS tunnel
  -> OAuth 2.1 DCR/PKCE gateway
  -> Streamable HTTP MCP server
  -> optimized guard
     -> target checkpoint -> direct file tool
     -> durable job -> full checkpoint -> shell/script/patch/tree tool
  -> content-addressed backup store
```

The upstream server registers its tools through `McpServer.registerTool`. `optimized-guard.mjs` wraps registration before the compiled upstream server is imported. Read-only tools remain direct. Process-control calls require the OAuth client that owns the process. Mutating file tools pass through a serialized target checkpoint. Deferred tools are available through the durable job API.

## Snapshot integrity

`snapshot-targets.mjs` resolves configured roots to canonical absolute paths, rejects direct symlink traversal, streams SHA-256 hashes with bounded buffers, and stores immutable content-addressed objects. A new object is copied from a second stable read, synced, and atomically renamed. Existing objects are rehashed before reuse.

Each manifest maps original paths to object hashes, directory metadata, symlink metadata, or absent tombstones. A target checkpoint verifies path stamps again immediately before mutation. Full scans retry files that change during reading and fail closed when stability cannot be established.

## Durable jobs

`jobs.mjs` persists each state transition using write, sync, and atomic rename. Admission is serialized. An OAuth client owns each job and request key. Retrying an identical payload returns the original job; reusing a key for another payload is rejected. Incomplete jobs found after restart become `interrupted_unknown` and are never automatically replayed.

## Limits

All snapshot and queue limits are finite. Worker count is capped at 64. Job output is bounded. Queue and history overflow reject new work without deleting durable idempotency records.

## Trust boundary

Path checks protect direct file mutations, while authenticated shell commands intentionally remain open-world inside the container. A full checkpoint protects configured editable roots but cannot protect other mounts or external services reached by a command. See [../SECURITY.md](../SECURITY.md).
