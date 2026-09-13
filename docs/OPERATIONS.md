# Windows operations

## Health and status

```powershell
Invoke-WebRequest http://127.0.0.1:39391/health
Get-Service MusuRemoteMcp
Get-Service cloudflared
```

Expected local health is HTTP 200. An unauthenticated POST to `/mcp` must return 401. Inspect WinSW logs under `windows\service\logs` and Cloudflare's configured log path without copying secrets into support reports.

## Start, stop, and restart

```powershell
Start-Service MusuRemoteMcp
Stop-Service MusuRemoteMcp
Restart-Service MusuRemoteMcp
```

For foreground diagnostics, stop the service and run `pwsh -File .\windows\Start-Local.ps1` from the repository.

## Configuration changes

Edit the ignored `config\windows.json`, validate that all roots are absolute, existing, canonical, unique, and non-overlapping, then restart the service. Changing `publicUrl` changes OAuth issuer/resource metadata and may require recreating the ChatGPT custom app.

Never move `stateRoot` by copying only selected files. Stop the service, preserve the complete directory byte-for-byte with ACLs, update the configuration, and perform an OAuth login test.

## Upgrade

1. Stop `MusuRemoteMcp`.
2. Back up `config\windows.json`, the complete state root, and the WinSW XML.
3. Pull the reviewed source revision.
4. Run `npm ci`, `npm run build`, and `npm test` from the repository root.
5. Start the service and check local health, remote health, OAuth, tool count, a read, and a disposable write/readback.
6. Update cloudflared separately; Windows cloudflared does not auto-update.

## Restore drill

Use a selected manifest and restore only to a new empty directory outside every editable root. Verify object hashes and restored hashes before comparing with live content. The restore primitive does not reproduce NTFS ACLs, ownership, alternate data streams, symlinks, or junctions.

## Incident response

If an unexpected write occurs, stop both services, preserve state, backups, service logs, OAuth metadata, and the affected repository Git state. Revoke the affected OAuth grant, rotate the approval key offline, inspect checkpoint manifests, and restore into a new directory for comparison. Do not overwrite the live workspace during investigation.

## Retention maintenance

Run `pwsh -File windows\Maintain.ps1` for a dry-run. Review the counts and reclaimable bytes, stop both the Windows service and every foreground MCP process, then run `pwsh -File windows\Maintain.ps1 -Apply`. Apply mode refuses to run while the service or configured port is active. It always retains the newest manifest, derives the reachable object set from retained manifests, archives old terminal jobs, stages deletions under the backup maintenance directory, and writes prepared and committed plan records.

The `retention.minFreeBytes` setting is a pre-mutation disk watermark. A checkpoint fails before object writes when the available backup volume cannot hold the checkpoint's worst-case bytes while preserving this reserve. The installer default is 10 GiB.

## Uninstall

`windows\Uninstall-Service.ps1` removes only the MCP service registration. Remove Cloudflare service registration separately using Cloudflare's documented command. Source, configuration, state, backups, and ACLs remain for explicit review and recovery.

## Edge protection and OAuth compatibility

Keep application rate limits enabled even when Cloudflare is present. At the edge, apply stricter per-source limits to `/authorize` and `/register`, moderate limits to `/token` and `/revoke`, reject oversized bodies, and alert on sustained 401/403/429 responses. Exempt only a documented trusted source after measuring the normal ChatGPT flow; do not make the WAF the sole control.

The server currently supports DCR for existing clients. Client ID Metadata Documents are the target registration model for MCP 2026-07-28. Add CIMD alongside DCR, capture real ChatGPT negotiation evidence, and keep DCR until the compatibility window has measured zero required clients.

OAuth state is SQLite WAL. Stop the server before offline copying, and preserve the database plus any `-wal` and `-shm` files and NTFS ACLs as one unit. Node.js 22.13 or newer is required.
