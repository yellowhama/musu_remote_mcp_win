# Optimization and maturity review — 2026-09-13

## Decision

Musu Remote MCP for Windows is a strong **single-operator beta**. It is suitable for supervised development on a trusted personal workstation. It should not be presented as a hostile-code sandbox, multi-tenant service, or unattended enterprise execution plane.

The implementation moved materially during this audit: request Origin validation, bounded OAuth traffic and metadata, MCP SDK v2 dual-era serving, separate gateway/worker identities, transactional service installation, retention/GC/disk watermarks, an NTFS USN hash index, and SQLite WAL OAuth state are now implemented and tested.

## Qualitative scorecard

| Dimension | Score | Evidence and limit |
| --- | ---: | --- |
| Functional completeness | **9.2/10** | 23 tools, jobs, checkpoints, OAuth, modern and legacy MCP, native service scripts; live ChatGPT connector acceptance is still manual |
| Security for one trusted operator | **9.3/10** | separate gateway/worker virtual accounts, deny ACLs, body-bound replay-resistant internal HMAC, OAuth audience binding and PKCE; worker remains an unrestricted trusted-code executor |
| Recovery and operations | **9.3/10** | byte-exact objects, manifests, durable jobs, clean-VM-tested transactional upgrade rollback, dry-run reachable GC, retention, 10 GiB default watermark; reboot evidence remains |
| Performance and scalability | **7.8/10** | persistent hash index and NTFS USN deltas reduce unchanged snapshot time by about 67%; safe verification still enumerates and stats the workspace |
| Architecture and maintainability | **8.8/10** | typed SDK v2 boundary, explicit tool registry, OAuth/CIMD store split, TypeScript workspaces, focused file-content and process-output modules, and explicit gateway/worker roles |
| Protocol longevity | **9.3/10** | MCP 2026-07-28 and CIMD are supported, 2025-11-25 and DCR remain for compatibility; real ChatGPT negotiation evidence remains |
| Observability | **8.7/10** | route-scoped operator metrics key and tested compatibility capture cover HTTP/auth/process/queue/checkpoint/disk; Windows lifecycle failures reach Event Log; dashboards remain operator work |

Weighted overall maturity: **9.0/10 (A- beta)**. The remaining release evidence is a real ChatGPT connection and reboot persistence; neither can be proven by the current non-elevated workstation or a hosted runner that cannot reboot in place.

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

1. **Finish external lifecycle evidence.** [Windows CI run 34769642484](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34769642484) covers install, health, restart, the exact injected upgrade rollback checkpoint, and uninstall. Run the checked-in reboot harness on a reboot-capable VM and the checked-in compatibility capture around a real ChatGPT OAuth connection.

### P1 — maintainability and observability

1. Progressively replace inferred adapter types with explicit manifest, job, journal, and tool callback contracts.
3. Add operator dashboards and alerts for the implemented HTTP/auth/process/queue/checkpoint/disk metrics, then extend telemetry to retention and process-cancellation reasons.
4. Add Cloudflare WAF examples for `/authorize`, `/register`, `/token`, and `/revoke`; keep server-side limits authoritative.
5. Measure real ChatGPT CIMD/DCR negotiation during a compatibility window, then remove DCR only after the evidence shows it is unused.

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
- Vendor suite: **52 pass, 1 POSIX-only skip** on Windows.
- Adapter/native suite: **67/67 pass**, including real Job Object and two-process gateway/worker smoke tests.
- Production dependency audit: **0 known vulnerabilities**.
- Clean-VM service lifecycle: pass in [GitHub Actions run 34769642484](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34769642484).

## Primary references

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [Microsoft USN journal](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-usn)
