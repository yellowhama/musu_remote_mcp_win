# Windows native architecture

## Runtime

`windows/native-runtime.mjs` loads a strict JSON configuration, validates Windows paths and the OAuth public URL, initializes state, sets the upstream environment, and imports `entrypoint.mjs`. The HTTP server binds only to loopback and validates Host and every present Origin. A separately managed Cloudflare named tunnel provides the fixed HTTPS origin used by ChatGPT and OAuth metadata.

The TypeScript SDK v2 handler serves MCP 2026-07-28. A separately routed legacy handler retains MCP 2025-11-25 compatibility. Tool registration passes through an explicit typed registry owned by the guard layer; no SDK prototype is modified.

The TypeScript application remains under the `vendor` npm workspace. The repository root owns the lockfile and dependency tree, so the safety adapter and application resolve one reproducible installation without a junction. No global npm packages are required.

## Service lifecycle

Foreground mode runs through `windows/Start-Local.ps1`. Service mode uses a checksum-pinned WinSW executable and an XML definition containing absolute executable and configuration paths, delayed automatic start, rolling logs, restart on failure, and a 15-second stop timeout. Secrets are read from `stateRoot` and never placed in service arguments or XML.

## Mutation boundary

`optimized-guard.mjs` intercepts tool registration. Direct mutations resolve against configured roots and receive target-only snapshots. Shell, script, patch, and broad tree mutations must be submitted as durable jobs and receive full-root snapshots before execution.

`snapshot-targets.mjs` uses `path.relative` containment so Windows drive letters and case-insensitive paths are handled by the platform path implementation. It rejects traversal, non-canonical roots, symlinks, junctions, and direct hard-linked file mutations. Backup objects are addressed by SHA-256; new objects and manifests are written through a temporary file and rename.

On eligible NTFS roots, a persistent hash index records the volume journal ID and USN cursor. Later checkpoints rehash changed file identities and reuse unchanged object hashes. Journal reset, wrap, missing coverage, directory/link changes, non-NTFS roots, or unstable boundaries force a full scan. Final verification still checks every path.

OAuth clients and token hashes live in a SQLite database configured for WAL, full synchronization, schema constraints, and expiry indexes. Refresh rotation and replay revocation are transactional. A legacy JSON state file is migrated with a timestamped recovery copy.

## Process model

PowerShell 7 is the default shell. Windows shell argument construction uses `-NoLogo -NoProfile -NonInteractive -Command`; `cmd.exe` uses `/d /s /c`. PowerShell scripts use `pwsh.exe -File`. Python defaults to `python.exe` on Windows.

Node's Windows signal emulation does not manage descendants. Process cancellation therefore launches `taskkill.exe /PID <pid> /T /F`. Session ownership remains bound to the authenticated OAuth client.

## Trust model

The network boundary is OAuth plus the HTTPS tunnel. The filesystem boundary is the Windows service account and NTFS ACLs. The adapter's editable-root checks are recovery and accident controls; unrestricted shell tools intentionally retain all permissions of the service identity.
