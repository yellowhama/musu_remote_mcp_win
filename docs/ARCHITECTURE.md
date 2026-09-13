# Windows native architecture

## Runtime

`windows/native-runtime.mjs` is a small bootstrap that loads a strict JSON configuration, validates Windows paths and the OAuth public URL, initializes state, sets the upstream environment, and imports the compiled TypeScript adapter entrypoint. The HTTP server binds only to loopback and validates Host and every present Origin. A separately managed Cloudflare named tunnel provides the fixed HTTPS origin used by ChatGPT and OAuth metadata.

The TypeScript SDK v2 handler serves MCP 2026-07-28. A separately routed legacy handler retains MCP 2025-11-25 compatibility. Tool registration passes through an explicit typed registry owned by the guard layer; no SDK prototype is modified.

The safety/checkpoint layer lives in the `adapter` TypeScript workspace and emits `.mjs` artifacts to `adapter/dist`; the upstream application lives in the `vendor` TypeScript workspace. The repository root owns the lockfile and dependency tree, so both resolve one reproducible installation without a junction. No global npm packages are required.

File encoding/chunk validation lives in `file-content.ts`, while process UTF-8 stream framing lives in `process-output.ts`. `file-service.ts` and `process-manager.ts` retain filesystem orchestration and process lifecycle responsibilities respectively.

## Service lifecycle

Foreground mode runs through `windows/Start-Local.ps1`. Service mode uses a checksum-pinned WinSW executable and an XML definition containing absolute executable and configuration paths, delayed automatic start, rolling logs, restart on failure, and a 15-second stop timeout. Secrets are read from `stateRoot` and never placed in service arguments or XML.

## Mutation boundary

The compiled `adapter/dist/optimized-guard.mjs` intercepts tool registration. Direct mutations resolve against configured roots and receive target-only snapshots. Shell, script, patch, and broad tree mutations must be submitted as durable jobs and receive full-root snapshots before execution.

`snapshot-targets.mjs` uses `path.relative` containment so Windows drive letters and case-insensitive paths are handled by the platform path implementation. It rejects traversal, non-canonical roots, symlinks, junctions, and direct hard-linked file mutations. Backup objects are addressed by SHA-256; new objects and manifests are written through a temporary file and rename.

On eligible NTFS roots, a persistent hash index records the volume journal ID and USN cursor. Later checkpoints rehash changed file identities and reuse unchanged object hashes. Journal reset, wrap, missing coverage, directory/link changes, non-NTFS roots, or unstable boundaries force a full scan. Final verification still checks every path.

OAuth clients and token hashes live in a SQLite database configured for WAL, full synchronization, schema constraints, and expiry indexes. Refresh rotation and replay revocation are transactional. A legacy JSON state file is migrated with a timestamped recovery copy.

Client discovery supports both MCP 2026-07-28 Client ID Metadata Documents and legacy Dynamic Client Registration. DCR records remain in SQLite. CIMD resolution accepts only canonical HTTPS document identifiers, rejects private and special-purpose addresses, pins the DNS result for the TLS request, refuses redirects, limits response size and duration, validates public-client metadata, coalesces concurrent lookups, and keeps a bounded TTL cache. The approval page identifies both the client-document host and callback host.

## Process model

PowerShell 7 is the default shell. Windows shell argument construction uses `-NoLogo -NoProfile -NonInteractive -Command`; `cmd.exe` uses `/d /s /c`. PowerShell scripts use `pwsh.exe -File`. Python defaults to `python.exe` on Windows.

Node's Windows signal emulation does not manage descendants. Every Windows command therefore runs through `MusuJobRunner.exe`, which assigns itself to a nested Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before creating the command. Descendants inherit the job, and terminating the runner closes the last handle and ends the tree. Session ownership remains bound to the authenticated OAuth client.

## Trust model

The network boundary is OAuth plus the HTTPS tunnel. The filesystem boundary is the Windows service account and NTFS ACLs. The adapter's editable-root checks are recovery and accident controls; unrestricted shell tools intentionally retain all permissions of the service identity.

The authenticated `/metrics` endpoint uses fixed route, status, state, and outcome labels. Adapter telemetry crosses the workspace boundary through Node diagnostics channels, covering mutation queue and checkpoint results without coupling the safety adapter to the HTTP server. Service lifecycle and fatal startup/shutdown failures are also written to the Windows Application Event Log under `MusuRemoteMcp`.
