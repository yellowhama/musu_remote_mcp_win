# Security policy

## Supported boundary

Musu Remote MCP for Windows is for one trusted operator on a development workstation. OAuth authenticates remote clients, editable roots constrain direct mutation tools, and checkpoints improve recovery. These controls do not turn unrestricted shell execution into a sandbox.

Every command receives the execution worker account's filesystem, process, registry, and network permissions. Native mode has no Docker mount namespace, capability drop, memory limit, or container-only toolchain. Windows Job Objects contain command process trees but do not restrict filesystem or network access.

Recommended service mode runs OAuth and command execution in separate virtual service accounts. Explicit deny ACLs prevent the gateway from opening editable roots/backups and prevent the worker from opening OAuth state. Authenticated loopback requests bind client identity, timestamp, nonce, and JSON body with HMAC. Foreground compatibility mode still uses one interactive identity. Do not connect untrusted users or autonomous agents whose output you cannot supervise.

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
- Process cancellation closes a kill-on-close Job Object. Processes deliberately launched through another service, scheduled task, or privileged broker can cross that boundary.
- Local administrators can override NTFS ACLs and inspect both service processes. The split is a least-privilege service boundary, not protection from a compromised administrator.

## Reporting

Use GitHub private vulnerability reporting for security issues. Do not include secrets, approval keys, OAuth tokens, tunnel credentials, private source, or backup content in a report.
