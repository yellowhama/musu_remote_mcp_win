# Optimization and maturity review

Date: 2026-09-13  
Target: `yellowhama/musu_remote_mcp_win` at `6f9516a`

## Executive verdict

The server is a strong controlled-use beta for one trusted developer. Its Windows path handling, byte-exact checkpointing, OAuth token audience checks, durable jobs, bounded queues, UTF-8 handling, and Windows CI are materially better than a typical experimental MCP wrapper.

It is not yet a production-grade Windows service or a current-generation MCP implementation. The highest-value work is protocol compliance and abuse resistance first, checkpoint latency and retention second, and architecture simplification third.

| Dimension | Score | Assessment |
|---|---:|---|
| Correctness and recovery | 8.3/10 | Strong failure-closed mutation path and useful regression suite; restore is a library primitive rather than an operator workflow |
| Security for one trusted operator | 7.4/10 | Loopback binding, OAuth, audience binding, Host checks, and ACLs are good; Origin validation, rate limits, and identity separation remain |
| Performance and scalability | 5.2/10 | Full pre-command scans and hashing dominate latency on large workspaces; retention is unbounded |
| Architecture and maintainability | 6.2/10 | Small adapter surface, but global prototype interception, duplicated checkpoint implementations, a dependency junction, and large vendor modules raise change risk |
| Windows operations | 6.5/10 | Foreground install is verified; service ACL failures are not consistently checked and the service/tunnel lifecycle lacks VM evidence |
| Test and release discipline | 8.2/10 | Clean Windows CI, 98 applicable tests, smoke tests, exact lockfile, and zero known production dependency vulnerabilities |
| Protocol longevity | 5.0/10 | Uses SDK v1.30 and the legacy 2025 request model while MCP 2026-07-28 and SDK v2 are current |

Overall maturity: **7.0/10 controlled-use beta**. Foreground use by one trusted developer is acceptable. Persistent internet-facing service use should wait for the P0 items below.

## Findings ordered by leverage

### P0 — required before a stable service label

1. **Add explicit Origin validation.** `entrypoint.mjs` derives an allow-list for Host validation, but `vendor/src/http-server.ts` has no Origin middleware. The current Streamable HTTP specification requires servers to validate every present Origin header and return 403 for an invalid value. Validate the canonical public origin and deliberate loopback origins before OAuth or MCP routing. Test absent, valid, malformed, `null`, and hostile origins.

2. **Migrate to MCP 2026-07-28 and TypeScript SDK v2 with legacy negotiation.** The repository pins `@modelcontextprotocol/sdk` 1.30.0. The current protocol removes the initialization/session model, requires per-request metadata plus `MCP-Protocol-Version`, `Mcp-Method`, and conditional `Mcp-Name` headers, and deprecates DCR in favor of Client ID Metadata Documents. Use the official staged v1-to-v2 migration and retain the legacy handler until ChatGPT interoperability is verified.

3. **Bound OAuth registration and approval traffic.** Dynamic registration can grow the in-memory and JSON-file client map without a repository-defined cap. The approval-key endpoint has no local attempt budget. Add per-IP and per-client token buckets at the application boundary, a global state-record limit, request timeouts, maximum metadata lengths/counts, and Cloudflare rate-limit guidance. Reject supplied server-managed client identifiers explicitly in the store boundary.

4. **Make Windows service installation fail closed and transactional.** `windows/Install.ps1` checks the first state ACL command but does not check the exit status of the four LocalService ACL grants. It also does not verify service stop, start health, effective ACLs, or roll back a partial install. Wrap every external command, stage configuration, verify `/health`, and restore the prior service/configuration on failure.

5. **Add backup, job, and log retention with disk watermarks.** Content objects, manifests, WinSW logs, and job records accumulate. `maxRecords=2000` eventually blocks new jobs, while backup objects have no mark-and-sweep lifecycle. Add operator-selected retention, manifest reachability GC, archival, dry-run output, minimum-free-space gates, and corruption-safe two-phase deletion. Never delete an object reachable from a retained manifest.

### P1 — largest speed and reliability gains

1. **Replace full scans with a persistent checkpoint index plus NTFS USN journal deltas.** Build one verified baseline mapping `(volume/file identity, path, size, timestamps, hash)` to content objects. Store the USN journal ID and cursor. Before a job, apply changed records and produce a delta manifest referencing unchanged objects. Fall back to a full scan when the journal ID changes, the cursor wraps, the volume is unsupported, or any invariant is unclear. Read journal changes again after hashing until a stable boundary is reached. Microsoft documents the USN journal as more efficient than repeated timestamp checks.

2. **Offer explicit execution safety profiles.** Keep the full-checkpoint profile as the default. Add a declared-write-set job that snapshots specific targets, and a read-only profile executed under an OS identity without workspace write permission. Arbitrary shell text cannot be safely classified as read-only by string inspection.

3. **Use Windows Job Objects for process containment.** `taskkill /T /F` is a practical fallback but cannot provide the resource accounting and kill-on-close lifecycle of a Job Object. A small native launcher should assign the process before user code starts, set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and optionally enforce memory, CPU, process-count, and wall-time limits.

4. **Separate the OAuth gateway from the execution worker.** Run the public-facing loopback gateway with no workspace access. Put command execution under a dedicated local or virtual service account and communicate over an ACL-restricted named pipe using a small authenticated request schema. This prevents a command from reading OAuth state merely because gateway and worker currently share an identity.

5. **Add performance budgets and reproducible benchmarks.** Record cold baseline, unchanged checkpoint, one-file delta, 10k/100k-file tree, 1/10 GiB tree, cancellation, and restore timings on SSD and HDD. Gate regressions for p50/p95 latency, bytes read, peak RSS, and temporary disk amplification. The existing 10,001 tiny-file checkpoint test took 11.7–19.5 seconds in local runs, demonstrating that metadata cost is already material.

### P2 — maintainability and product quality

1. Replace `McpServer.prototype.registerTool` monkey-patching with an explicit tool registry/decorator owned by the guard layer. SDK upgrades should fail at typed compile boundaries rather than at global runtime behavior.
2. Move adapter modules from compressed JavaScript to formatted TypeScript and enforce lint, format, typecheck, dependency review, and protocol conformance in CI.
3. Create a real root package/workspace and remove the root `node_modules` junction. Package the runtime so installation does not depend on the vendored dependency tree's physical layout.
4. Split `oauth.ts`, `file-service.ts`, and `process-manager.ts` into state storage, validation, protocol, rendering, process I/O, and lifecycle modules. Each is currently roughly 680 lines.
5. Replace whole-file OAuth JSON rewrites with a bounded transactional store. SQLite with WAL, schema constraints, expiry indexes, and migrations is a reasonable local default.
6. Add structured event schemas, log rotation verification, Windows Event Log integration, readiness distinct from liveness, disk/queue/checkpoint metrics, and redaction tests.
7. Complete product naming and semantic versioning. User-facing metadata, OAuth pages, health output, package identity, and logs still expose the upstream `cokacremote` name and version `0.1.0`.

## Code hygiene decision required

The following production-orphan candidates are covered by tests but are not wired into the Windows runtime:

- `createCheckpoint` and `inspectCheckpoint` in `checkpoint.mjs`; production imports only `createMutationGate` from that module.
- `restoreToNewDirectory` in `snapshot-targets.mjs`; operations documentation describes it, but no CLI or MCP operator tool invokes it.
- `tunnel-runtime.mjs`; it manages TryCloudflare URLs while the supported Windows path requires a named tunnel.

Choose one outcome for each: wire it into an explicit operator command with acceptance tests, or remove it and its dedicated tests. Keeping tested but unreachable recovery code creates false confidence.

## Recommended delivery sequence

| Slice | Deliverable | Exit evidence |
|---|---|---|
| 1 | Origin middleware, auth/DCR limits, installer external-command checks | hostile-origin 403 tests, abuse-limit tests, injected ACL failure rollback test |
| 2 | SDK v2 dual-era migration | official conformance suite plus live ChatGPT legacy and modern connection evidence |
| 3 | retention and disk guard | dry-run/execute GC tests, retained-manifest proof, low-space refusal test |
| 4 | checkpoint index and USN fast path | unchanged and one-file-delta benchmarks, journal-wrap full-scan fallback, crash recovery |
| 5 | dedicated worker identity and Job Object launcher | token/state denial from worker, process escape tests, kill-on-service-stop proof |
| 6 | service lifecycle and observability | clean VM install, reboot, restart, upgrade, uninstall, named-tunnel OAuth, operational dashboard |

## Evidence and limits

- Windows CI run 34758219782 passes from a clean checkout.
- Local TypeScript build passes; upstream tests report 41 pass and one POSIX-only skip; adapter/native tests report 57 pass.
- Production dependency audit reports zero known vulnerabilities across 94 production dependencies.
- The review exposed and fixed a durable-state race: terminal job state is now published in memory only after the atomic state-file write completes. The regression no longer uses a timing delay.
- Read-only recursive enumeration of the active F workspace did not complete within the audit sampling window. This is observational evidence of a large tree, not a controlled checkpoint benchmark.
- Administrator service registration, reboot behavior, failure restart, live named-tunnel OAuth, and clean-machine uninstall remain unverified.

Primary references:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP TypeScript SDK roadmap](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md)
- [MCP TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- [Microsoft USN journal](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-usn)
- [Microsoft Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
