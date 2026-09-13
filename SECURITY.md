# Security policy

## Supported boundary

Musu Remote MCP for Windows is for one trusted operator on a development workstation. OAuth authenticates remote clients, editable roots constrain direct mutation tools, and checkpoints improve recovery. These controls do not turn unrestricted shell execution into a sandbox.

Every command receives the Windows service account's filesystem, process, registry, and network permissions. Native mode has no Docker mount namespace, capability drop, PID limit, memory limit, or container-only toolchain. The default Windows service identity is `LocalService`; it is lower privilege than `LocalSystem`, but it is shared by other Windows services.

The OAuth gateway and command worker run in one process and identity. An authenticated shell can read state and backup data accessible to that identity. Do not connect untrusted users or autonomous agents whose output you cannot supervise.

## Required deployment controls

- Bind the MCP origin to `127.0.0.1`; publish it only through an authenticated HTTPS tunnel.
- Use a fixed named tunnel for persistent OAuth metadata.
- Keep `stateRoot` and `backupRoot` outside editable roots.
- Restrict NTFS ACLs on the approval key, OAuth state, logs, tunnel credentials, and backups.
- Keep Node.js, PowerShell 7, Git, WinSW, and cloudflared patched.
- Review the service account's effective permissions before enabling write tools.
- Never commit `config/windows.json`, state, tunnel credentials, approval keys, or logs.
- Treat checkpoint success as recovery evidence rather than transaction rollback.

## Windows-specific residual risks

- Node.js does not expose `O_NOFOLLOW` on Windows. The adapter rejects symlinks and junctions and compares file identity around backup reads, but a local concurrent attacker can still create filesystem races.
- NTFS hard links are rejected for direct mutation paths. Unrestricted shell jobs can still operate on them.
- `chmod` cannot reproduce POSIX permission semantics on Windows. Restore verifies bytes but does not restore full ACLs, ownership, alternate data streams, or every file attribute.
- Process cancellation uses `taskkill.exe /T /F` to terminate a command tree. Processes that escape the tree or run through another service boundary may survive.
- `LocalService` is shared. Use a dedicated Windows account and custom service configuration when isolation from other local services is required.

## Reporting

Use GitHub private vulnerability reporting for security issues. Do not include secrets, approval keys, OAuth tokens, tunnel credentials, private source, or backup content in a report.
