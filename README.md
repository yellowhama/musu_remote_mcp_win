# Remote Dev MCP

A self-hosted remote development MCP server with OAuth, bounded pre-mutation backups, durable asynchronous jobs, and Docker isolation.

Remote Dev MCP builds on [kstost/cokacremote](https://github.com/kstost/cokacremote) and adds a safety adapter for AI-assisted development on a workstation or VPS. Direct file mutations back up the exact targets first. Shell, script, patch, and large tree operations create a full checkpoint and run as durable jobs.

## What it provides

- Streamable HTTP MCP with OAuth 2.1, DCR, PKCE, refresh, and revocation
- 23 tools: the 20 upstream development tools plus `submit_job`, `get_job`, and `cancel_job`
- Byte-exact content-addressed backups with SHA-256 manifests
- Target-only checkpoints for normal file edits
- Full checkpoints before shell, script, patch, and large tree mutations
- Durable job state, idempotent request keys, cancellation, and OAuth-client ownership
- Fail-closed limits for file count, file size, total bytes, queue depth, and history
- Symlink and path-escape rejection for direct mutations
- Cloudflare Quick Tunnel bootstrap for testing from remote MCP clients

## Security boundary

This project is intended for a trusted, supervised operator. The MCP container drops Linux capabilities, uses `no-new-privileges`, and mounts only configured paths. However, authenticated shell tools execute arbitrary commands inside the container. The OAuth gateway and execution worker currently share a UID, so shell commands can access mounted `/state` and `/backups` data.

Do not describe this configuration as a hostile-code sandbox or a multi-tenant security boundary. Read [SECURITY.md](SECURITY.md) before exposing it to users you do not fully trust.

## Requirements

- Docker Desktop or Docker Engine with Compose
- Node.js 22 or newer on the host for bootstrap scripts
- A host directory containing the editable subdirectories
- ChatGPT or another remote MCP client that supports OAuth MCP apps

## Quick start

```powershell
git clone https://github.com/yellowhama/remote_dev_mcp.git
Set-Location remote_dev_mcp
Copy-Item .env.example .env
```

Edit `.env` and set absolute host paths. The default container layout expects `code/` and `wiki/` under `WORKSPACE_HOST_PATH`:

```text
D:/dev/remote-workspace/
  code/
  wiki/
```

Build and start:

```powershell
docker compose build mcp
& '.\Start.ps1'
docker compose ps
```

`Start.ps1` creates local authentication files, starts the Quick Tunnel, records its current URL, and starts the MCP server. It prints the MCP endpoint but never prints the approval key.

On Linux or macOS, use the equivalent commands:

```bash
cp .env.example .env
# Edit .env and create the configured code/wiki directories first.
node setup-state.mjs
docker compose up -d tunnel
node set-public-url.mjs
docker compose up -d mcp
docker compose ps
```

If a running tunnel receives a new URL, run `node set-public-url.mjs` and restart the MCP service so it reloads the issuer URL.

The approval key remains only in:

```text
<repository>\state\approval-key.txt
```

Use that value only in the OAuth approval page. Never paste it into issues, logs, commits, or chat messages.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_HOST_PATH` | required | Host directory mounted at `/workspace` |
| `BACKUP_HOST_PATH` | `./backups` | Host location for objects, manifests, and restore drills |
| `MCP_EDITABLE_ROOTS` | `/workspace/code,/workspace/wiki` | Comma-separated absolute container paths allowed for direct mutations |
| `MCP_DEFAULT_CWD` | `/workspace/code` | Default command directory |
| `MCP_LOCAL_PORT` | `39391` | Loopback MCP port |
| `MCP_PREVIEW_PORT` | `39392` | Loopback browser-preview port |
| `MCP_MEMORY_LIMIT` | `1536m` | MCP container memory limit |
| `MCP_CPU_LIMIT` | `2` | MCP container CPU limit |
| `TZ` | `UTC` | Container timezone |

`MCP_EDITABLE_ROOTS` paths must be unique absolute paths located under the mounted workspace. Create them on the host before starting the server.

## Connect a client

1. Read `state/runtime.json` and append `/mcp` to `publicUrl`.
2. Create a custom MCP app in your client and choose OAuth.
3. Complete the DCR/PKCE flow and enter `state/approval-key.txt` only in the approval page.
4. Scan tools and confirm that 23 tools are available.
5. Start with a read-only request against a repository instruction file.

Quick Tunnel URLs can change after a tunnel restart. Reconnect the client if `state/runtime.json` changes. For long-running installations, replace the Quick Tunnel with a named tunnel and a fixed domain.

## Mutation model

Direct file tools create a target checkpoint, verify that the source did not change during backup, and then invoke the upstream tool. Direct roots, root deletion, path traversal, overlapping copy/move paths, and symlink mutation paths are rejected.

`exec_command`, `run_script`, and `apply_patch` return guidance to use `submit_job`. A submitted mutation performs a full checkpoint of every editable root before execution. Poll the returned ID with `get_job`. Reuse the same `requestKey` only for a network retry of the same payload.

```json
{
  "requestKey": "status-2026-09-13-001",
  "tool": "exec_command",
  "arguments": {
    "cmd": "git status --short",
    "workdir": "/workspace/code",
    "login": false
  }
}
```

Default full-checkpoint limits are 200,000 files, 256 MiB per file, 32 GiB total, and 64 workers. Target checkpoints use 2,000 files, 128 MiB per file, 512 MiB total, and 4 workers. The exact-name exclusions for a full scan are `node_modules`, `target`, `.next`, `.git`, `.cache`, `test-results`, and `playwright-report`.

## Verification

The Docker build runs:

- TypeScript compilation and the upstream Vitest suite
- Adapter checkpoint, snapshot, durable-job, and tunnel tests
- A disposable guard integration suite against `/workspace`, `/state`, and `/backups`
- A real entrypoint smoke that requires health 200 and unauthenticated MCP 401

```powershell
docker compose build mcp
docker compose up -d
docker compose ps
```

The current test baseline is 41 upstream tests, 51 adapter tests, and 5 guard integration tests.

## Backup and restore scope

Backup objects are stored as `/backups/objects/<sha256>.backup`; manifests are stored under `/backups/manifests`. Existing objects are rehashed before reuse. New objects are written from a second stable read, synced, and atomically renamed.

Snapshots are file-consistent, not filesystem-atomic. They do not provide database transaction consistency, complete ACL restoration, automatic retention, or garbage collection. `restoreToNewDirectory` restores only into a new directory outside the live roots and never recreates symlinks.

## Project layout

```text
vendor/                 upstream TypeScript MCP server
optimized-guard.mjs     tool wrapping and durable job orchestration
snapshot-targets.mjs    target/full snapshots and restore primitive
jobs.mjs                persisted job queue and idempotency
checkpoint.mjs          legacy checkpoint policy and regression coverage
tests/                  adapter and integration tests
compose.yaml            local MCP and Quick Tunnel services
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) for implementation and operating details.

## License and attribution

MIT. The upstream server is derived from `kstost/cokacremote`; its license and attribution are preserved in [LICENSE](LICENSE), [NOTICE](NOTICE), and `vendor/`.
