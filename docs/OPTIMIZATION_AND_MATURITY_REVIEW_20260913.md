# Optimization and maturity review — 2026-09-13

## Decision

Musu Remote MCP for Windows is a strong **single-operator beta**. It is suitable for supervised development on a trusted personal workstation. It should not be presented as a hostile-code sandbox, multi-tenant service, or unattended enterprise execution plane.

The implementation moved materially during this audit: request Origin validation, bounded OAuth traffic and metadata, MCP SDK v2 dual-era serving, transactional service installation, retention/GC/disk watermarks, an NTFS USN hash index, and SQLite WAL OAuth state are now implemented and tested.

## Qualitative scorecard

| Dimension | Score | Evidence and limit |
| --- | ---: | --- |
| Functional completeness | **9.2/10** | 23 tools, jobs, checkpoints, OAuth, modern and legacy MCP, native service scripts; live ChatGPT connector acceptance is still manual |
| Security for one trusted operator | **8.8/10** | loopback bind, Host/Origin checks, OAuth audience binding, PKCE, hashed tokens, bounded DCR and rate limits; gateway and command worker still share one identity |
| Recovery and operations | **8.9/10** | byte-exact objects, manifests, durable jobs, transactional install rollback, dry-run reachable GC, retention, 10 GiB default watermark; clean-VM reboot/upgrade evidence remains |
| Performance and scalability | **7.8/10** | persistent hash index and NTFS USN deltas reduce unchanged snapshot time by about 67%; safe verification still enumerates and stats the workspace |
| Architecture and maintainability | **7.4/10** | typed SDK v2 boundary, explicit tool registry, OAuth store split; root adapter remains compressed JavaScript, dependency junction remains, two modules exceed 680 lines |
| Protocol longevity | **8.9/10** | MCP 2026-07-28 is primary and 2025-11-25 remains for compatibility; CIMD migration and real ChatGPT negotiation evidence remain |
| Observability | **6.0/10** | health and service logs exist; Windows Event Log events, counters, latency histograms, and operator alerts do not |

Weighted overall maturity: **8.3/10 (B+, approaching A-)**. The ceiling is set by privilege separation and lifecycle evidence rather than core tool behavior.

## Performance evidence

An actual NTFS `F:` drive fixture with 10,001 files produced:

| Scenario | Snapshot only | Including final verify | Files hashed |
| --- | ---: | ---: | ---: |
| baseline | 10.94 s | 16.65 s | 10,001 |
| unchanged incremental | 3.58 s | 8.36 s | 0 |
| one changed file | 3.64 s | 9.91 s | 1 |

The optimization is safe by construction: it falls back to a full scan on non-NTFS volumes, journal reset/wrap/lost coverage, directory/link changes, or unstable start/end USN boundaries. Final verification intentionally stats all source paths. The next speed gain therefore comes from a native directory identity/index layer, not from skipping safety checks.

## Completed hardening

- Validates every present Origin against the public and deliberate loopback origins before OAuth/MCP routing.
- Serves MCP 2026-07-28 through SDK v2 and retains a tested 2025-11-25 legacy path.
- Uses an explicit typed tool registry; no `McpServer.prototype` interception remains.
- Caps OAuth clients, pending authorization state, body size, metadata fields, redirect URIs, and endpoint request rates.
- Stores OAuth clients and SHA-256 token identifiers in a constrained SQLite database using WAL and full synchronization; refresh replay revokes the grant transactionally.
- Migrates the prior JSON state with a recovery copy and refuses malformed legacy state.
- Installs the service with rollback and health verification.
- Implements manifest/job/log retention, reachable-object GC, dry-run plans, staged deletion, and pre-mutation free-space watermarks.
- Reuses checkpoint hashes through a persistent NTFS USN cursor and content index while preserving full-scan fallbacks.

## Remaining work, in order

### P0 — stable-service gate

1. **Split identities and processes.** Put OAuth/public HTTP under a low-privilege gateway identity with no workspace access. Put execution under a dedicated worker identity and use an ACL-restricted named pipe with a small authenticated schema.
2. **Replace `taskkill` with Windows Job Objects.** Assign every process tree at creation, set kill-on-job-close, and record assignment failures. This removes PID-reuse and detached-child ambiguity.
3. **Run lifecycle acceptance on a disposable VM.** Record install, health, ChatGPT OAuth, restart, reboot, forced failure recovery, upgrade rollback, retention apply, and uninstall.

### P1 — maintainability and observability

1. Convert the root `.mjs` adapter/checkpoint layer to TypeScript with explicit interfaces and emitted artifacts.
2. Make the repository root the npm workspace and remove the `node_modules` junction.
3. Split `file-service.ts` (695 lines) and `process-manager.ts` (682 lines) by storage, validation, execution, and lifecycle responsibility.
4. Emit structured Windows Event Log records and metrics for auth rejection, tool latency/error, queue depth, checkpoint bytes/duration/strategy, disk watermark, process cancellation, and retention.
5. Add Cloudflare WAF examples for `/authorize`, `/register`, `/token`, and `/revoke`; keep server-side limits authoritative.
6. Add Client ID Metadata Document support, retain DCR during a measured compatibility window, then remove it only after ChatGPT evidence.

### P2 — product finish

- Replace remaining upstream `cokacremote` names and version `0.1.0` with a stable Musu product/version contract.
- Add an operator-facing restore command that invokes the implemented restore-to-new-directory primitive.
- Benchmark 100k and 1M path workspaces and publish p50/p95 checkpoint and tool latency.

## Known limits

- `node:sqlite` is synchronous and may emit an experimental warning on Node 24.8. The bounded single-operator workload keeps blocking short, but a multi-user design should move state behind an asynchronous storage process.
- OAuth client metadata may contain secrets and the database is not encrypted; NTFS ACLs and the separate-identity design remain required.
- USN acceleration applies only to eligible NTFS roots and never replaces final mutation verification.
- The full-access command tool inherits the service account's rights. Editable roots are recovery and direct-tool boundaries, not a shell sandbox.

## Verification evidence

- TypeScript typecheck and build: pass.
- Vendor suite: **43 pass, 1 POSIX-only skip** on Windows.
- Checkpoint/adapter suite before SQLite change: **65/65 pass**, plus **42 pass and 1 POSIX-only skip** in the vendor suite at that checkpoint.
- GitHub Actions is green through the SQLite commit (run 34762770787).

## Primary references

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [Microsoft USN journal](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-usn)
