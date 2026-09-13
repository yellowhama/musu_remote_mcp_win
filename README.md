# Musu Remote MCP for Windows

A Windows-native remote development MCP server for a trusted personal workstation. It runs on Node.js and PowerShell 7 without Docker, exposes OAuth 2.1 over Streamable HTTP, and protects mutations with byte-exact checkpoints and durable jobs.

This repository is the Windows edition of [remote_dev_mcp](https://github.com/yellowhama/remote_dev_mcp). It retains attribution to [kstost/cokacremote](https://github.com/kstost/cokacremote).

## Capabilities

- Native Windows 11 execution with Node.js 22.13+
- PowerShell 7 command and script execution with UTF-8 output preservation
- 23 MCP tools, OAuth DCR/PKCE/refresh/revocation, client-owned jobs
- Target checkpoints for direct edits and full checkpoints before shell/script/patch jobs
- Content-addressed backups, bounded queues, idempotency keys, restart recovery
- Windows path, drive-letter, junction/symlink, hard-link, and process-tree handling
- Kill-on-close Windows Job Object containment for every command tree
- Verified foreground operation and beta Windows service operation through pinned WinSW
- Cloudflare named tunnel guidance for a fixed HTTPS endpoint

## Security boundary

This server intentionally executes arbitrary commands. In native mode, those commands receive every permission of the Windows account running the MCP service. Docker mount and capability isolation are absent. Configure only the directories that the service account may edit, grant that account the minimum NTFS access it needs, and connect only trusted MCP clients.

The OAuth gateway, execution worker, state, and backups share one service identity. An authenticated shell job can therefore read anything that identity can read, including MCP state. This is suitable for one trusted operator on a personal development PC. It is not a hostile-code sandbox or multi-tenant boundary. Read [SECURITY.md](SECURITY.md).

## Requirements

- 64-bit Windows 11 or Windows Server 2022+
- [Node.js](https://nodejs.org/en/download) 22.13 or newer, installed system-wide for service mode
- PowerShell 7 or newer, installed system-wide for service mode
- Git available on `PATH` for patch operations
- Administrator access only when installing the Windows service or Cloudflare service
- A fixed HTTPS URL for ChatGPT; Cloudflare named tunnel is the documented path

Docker Desktop is not required.

## Install and run in the foreground

```powershell
git clone https://github.com/yellowhama/musu_remote_mcp_win.git
Set-Location musu_remote_mcp_win

pwsh -File .\windows\Install.ps1 `
  -EditableRoot 'F:\workspace\musu-bee','F:\workspace\llm-wiki' `
  -DefaultCwd 'F:\workspace\musu-bee' `
  -StateRoot 'F:\musu-remote-mcp-data\state' `
  -BackupRoot 'F:\musu-remote-mcp-data\backups' `
  -PublicUrl 'https://mcp.example.com'

pwsh -File .\windows\Start-Local.ps1
```

The installer uses `npm ci`, builds the vendored TypeScript server, creates `config\windows.json`, initializes the OAuth approval key, and restricts the state directory ACL. It never prints the key value.

The approval key full path is the configured `stateRoot` plus `approval-key.txt`, for example:

```text
F:\musu-remote-mcp-data\state\approval-key.txt
```

## Install as a Windows service (beta)

Open PowerShell 7 as Administrator and add `-Service`:

```powershell
pwsh -File .\windows\Install.ps1 `
  -EditableRoot 'F:\workspace\musu-bee','F:\workspace\llm-wiki' `
  -PublicUrl 'https://mcp.example.com' `
  -StateRoot 'F:\musu-remote-mcp-data\state' `
  -BackupRoot 'F:\musu-remote-mcp-data\backups' `
  -Service
```

Service mode downloads WinSW 2.12.0 and verifies this pinned SHA-256 before use:

```text
05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA
```

The service runs as `NT AUTHORITY\LocalService`. The installer grants that shared low-privilege identity read/execute access to the application and modify access to the configured editable, state, and backup roots. Review this choice if another local service should not share those directories.

To remove only the service registration while retaining source, state, and backups:

```powershell
pwsh -File .\windows\Uninstall-Service.ps1
```

## Cloudflare named tunnel

ChatGPT connects to a remote MCP endpoint, so local execution still needs a secure remote tunnel. Install `cloudflared`, create a named tunnel and fixed hostname, then point its ingress at `http://127.0.0.1:39391`.

Use [windows/cloudflared-config.yml.example](windows/cloudflared-config.yml.example) as the starting configuration. Cloudflare documents native Windows service installation with `cloudflared.exe service install`. Set the same fixed HTTPS hostname as `publicUrl` in `config\windows.json`.

Quick Tunnels are intended only for testing. Their hostname changes when restarted; they have no uptime guarantee, cap concurrent in-flight requests at 200, and do not support SSE. A named tunnel is required for the supported persistent configuration.

## Connect ChatGPT

1. Confirm `http://127.0.0.1:39391/health` returns HTTP 200 locally.
2. Confirm the named tunnel routes `https://your-host.example/health`.
3. In ChatGPT developer mode, create a custom MCP app at `https://your-host.example/mcp` and choose OAuth.
4. Enter the approval key only on this server's OAuth approval page.
5. Scan tools and confirm that 23 tools are present.
6. Start with a read-only request for the repository instruction file.

## Configuration

The installer creates the ignored file `config\windows.json`. The checked-in example documents every supported field.

| Field | Meaning |
|---|---|
| `publicUrl` | Fixed HTTPS origin used by OAuth metadata |
| `editableRoots` | Unique, non-overlapping absolute Windows paths |
| `defaultCwd` | Default working directory inside an editable root |
| `stateRoot` | OAuth state, job state, runtime metadata, and approval key |
| `backupRoot` | Content-addressed backup objects and manifests |
| `port` | Loopback port, default `39391` |
| `defaultShell` | PowerShell 7 executable; installer records its absolute path |

The native runtime rejects unknown fields, non-absolute paths, missing roots, overlapping roots, comma-containing roots, unsafe public URLs, and out-of-range ports before starting. It resolves Windows 8.3 aliases and other existing path aliases to canonical paths before applying containment checks.

## Mutation and recovery model

Direct file mutations snapshot exact targets before invoking the upstream tool. Shell, PowerShell, script, patch, move, copy, and remove jobs create a full checkpoint first. Job records are written durably and incomplete jobs found after restart become `interrupted_unknown`; they are never replayed automatically.

Snapshots are file-consistent rather than filesystem-atomic. They do not capture complete NTFS ACLs, alternate data streams, open database transactions, or every external effect of a command. Restore drills write to a new directory and never overwrite live roots.

## Verification

```powershell
npm ci
npm run build
npm test
```

Preview retention without changing files, then stop the MCP server and apply the reviewed plan:

```powershell
pwsh -File .\windows\Maintain.ps1
pwsh -File .\windows\Maintain.ps1 -Apply
```

Retention keeps the newest manifest even when it is older than the configured window, archives terminal jobs, removes only objects unreachable from retained manifests, and records a two-phase maintenance plan before deletion.
Before every direct or full checkpoint, the runtime also reserves the configured `retention.minFreeBytes` after accounting for the checkpoint's worst-case bytes. The installer defaults this watermark to 10 GiB.

GitHub Actions runs the same build and test flow on `windows-latest` with Node.js 24. The native smoke test starts the real OAuth server, checks health 200 and unauthenticated MCP 401, verifies key creation, and terminates the process tree.

See [the Dockerless research](docs/DOCKERLESS_WINDOWS_RESEARCH_20260913.md), [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), and [optimization and maturity review](docs/OPTIMIZATION_AND_MATURITY_REVIEW_20260913.md).

## License

MIT. Upstream license and attribution are preserved in [LICENSE](LICENSE), [NOTICE](NOTICE), and `vendor/`.
