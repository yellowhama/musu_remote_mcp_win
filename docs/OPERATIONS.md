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
4. Run `npm ci --prefix vendor`, `npm run build --prefix vendor`, and the test commands in the README.
5. Start the service and check local health, remote health, OAuth, tool count, a read, and a disposable write/readback.
6. Update cloudflared separately; Windows cloudflared does not auto-update.

## Restore drill

Use a selected manifest and restore only to a new empty directory outside every editable root. Verify object hashes and restored hashes before comparing with live content. The restore primitive does not reproduce NTFS ACLs, ownership, alternate data streams, symlinks, or junctions.

## Incident response

If an unexpected write occurs, stop both services, preserve state, backups, service logs, OAuth metadata, and the affected repository Git state. Revoke the affected OAuth grant, rotate the approval key offline, inspect checkpoint manifests, and restore into a new directory for comparison. Do not overwrite the live workspace during investigation.

## Uninstall

`windows\Uninstall-Service.ps1` removes only the MCP service registration. Remove Cloudflare service registration separately using Cloudflare's documented command. Source, configuration, state, backups, and ACLs remain for explicit review and recovery.
