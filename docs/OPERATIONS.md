# Windows operations

## Health and status

```powershell
Invoke-WebRequest http://127.0.0.1:39391/health
Get-Service MusuRemoteMcpGateway,MusuRemoteMcpWorker
Get-Service cloudflared
```

Expected local health is HTTP 200. An unauthenticated POST to `/mcp` must return 401. Inspect WinSW logs under `windows\service\logs` and Cloudflare's configured log path without copying secrets into support reports.

## Start, stop, and restart

```powershell
Start-Service MusuRemoteMcpWorker,MusuRemoteMcpGateway
Stop-Service MusuRemoteMcpGateway,MusuRemoteMcpWorker
Restart-Service MusuRemoteMcpWorker,MusuRemoteMcpGateway
```

For foreground diagnostics, stop the service and run `pwsh -File .\windows\Start-Local.ps1` from the repository.

## Configuration changes

Edit the ignored `config\windows.json`, validate that all roots are absolute, existing, canonical, unique, and non-overlapping, then restart the service. Changing `publicUrl` changes OAuth issuer/resource metadata and may require recreating the ChatGPT custom app.

Never move `stateRoot` by copying only selected files. Stop the service, preserve the complete directory byte-for-byte with ACLs, update the configuration, and perform an OAuth login test.

## Upgrade

1. Stop `MusuRemoteMcpGateway` and `MusuRemoteMcpWorker`.
2. Back up `config\windows.json`, the complete state root, and the WinSW XML.
3. Pull the reviewed source revision.
4. Run `npm ci`, `npm run build`, and `npm test` from the repository root.
5. Run `Install-SplitService.ps1` again; it stops the wrappers, updates configuration, restarts both services, and rolls back on a failed health gate.
6. Check local health, remote health, OAuth, tool count, a read, and a disposable write/readback.
7. Update cloudflared separately; Windows cloudflared does not auto-update.

## Restore drill

Use a selected manifest and restore only to a new empty directory outside every editable root. Verify object hashes and restored hashes before comparing with live content. The restore primitive does not reproduce NTFS ACLs, ownership, alternate data streams, symlinks, or junctions.

## Incident response

If an unexpected write occurs, stop both services, preserve state, backups, service logs, OAuth metadata, and the affected repository Git state. Revoke the affected OAuth grant, rotate the approval key offline, inspect checkpoint manifests, and restore into a new directory for comparison. Do not overwrite the live workspace during investigation.

## Retention maintenance

Run `pwsh -File windows\Maintain.ps1` for a dry-run. Review the counts and reclaimable bytes, stop both the Windows service and every foreground MCP process, then run `pwsh -File windows\Maintain.ps1 -Apply`. Apply mode refuses to run while the service or configured port is active. It always retains the newest manifest, derives the reachable object set from retained manifests, archives old terminal jobs, stages deletions under the backup maintenance directory, and writes prepared and committed plan records.

The `retention.minFreeBytes` setting is a pre-mutation disk watermark. A checkpoint fails before object writes when the available backup volume cannot hold the checkpoint's worst-case bytes while preserving this reserve. The installer default is 10 GiB.

## Uninstall

`windows\Uninstall-SplitService.ps1` removes only the gateway and worker service registrations. Remove Cloudflare service registration separately using Cloudflare's documented command. Source, configuration, state, backups, and ACLs remain for explicit review and recovery.

## Edge protection and OAuth compatibility

Keep application rate limits enabled even when Cloudflare is present. At the edge, apply stricter per-source limits to `/authorize` and `/register`, moderate limits to `/token` and `/revoke`, reject oversized bodies, and alert on sustained 401/403/429 responses. Exempt only a documented trusted source after measuring the normal ChatGPT flow; do not make the WAF the sole control.

The server advertises and supports CIMD while retaining DCR for existing clients. Capture whether each real ChatGPT connection presents an HTTPS CIMD client identifier or calls `/register`; keep DCR until a measured compatibility window records zero DCR-dependent clients. A CIMD lookup that resolves to any private or special-purpose address, redirects, exceeds 64 KiB, exceeds five seconds, or returns invalid public-client metadata fails closed.

OAuth state is SQLite WAL. Stop the server before offline copying, and preserve the database plus any `-wal` and `-shm` files and NTFS ACLs as one unit. Node.js 22.13 or newer is required.

## Metrics and Windows events

Scrape `https://your-host.example/metrics` with the dedicated key at `<stateRoot>\metrics-key.txt` or a valid OAuth access token. This key is accepted only on `/metrics` and does not grant MCP access. Alert on sustained authentication rejection, non-2xx MCP responses, checkpoint failures, queue saturation, declining free space, and retained process growth. Split service mode registers `MusuRemoteMcpGateway` and `MusuRemoteMcpWorker` in the Windows Application log; event IDs 900–903 cover start, normal stop, shutdown failure, and startup failure.

Use `Capture-ChatGPTCompatibility.ps1 -Phase Begin`, create and exercise a fresh ChatGPT app, and then run it with `-Phase End`. It records deltas for `musu_oauth_client_resolution_total` and successful MCP requests without storing either secret. Preserve the generated result before considering DCR removal.

## Reboot acceptance

On an elevated disposable VM with both split services healthy, run `Test-RebootPersistence.ps1 -Phase Prepare -RestartComputer`. It registers a one-time SYSTEM startup task, records the pre-reboot boot time, and after startup verifies that the boot time advanced, both services recovered, both health endpoints respond, deny ACLs remain, and lifecycle events exist. Read the result later with `Test-RebootPersistence.ps1 -Phase Status`.
