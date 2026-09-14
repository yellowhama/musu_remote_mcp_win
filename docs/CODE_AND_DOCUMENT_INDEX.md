# Code and document index

## Runtime entry points

| Area | Entry point | Responsibility |
| --- | --- | --- |
| Native launcher | `windows/native-runtime.mjs` | Validates Windows configuration and starts combined, gateway, or worker role |
| Public gateway/server | `vendor/src/http-server.ts` | HTTP routing, OAuth boundary, Origin checks, MCP proxying, metrics |
| MCP composition | `vendor/src/mcp-server.ts` | Modern and legacy MCP handlers and tool registration |
| Execution worker | `adapter/src/worker-entrypoint.mts` | Loads guarded tools for the isolated worker role |
| Foreground guarded runtime | `adapter/src/entrypoint.mts` | Starts the local guarded server path |

## Security and OAuth

| Module | Responsibility |
| --- | --- |
| `vendor/src/oauth.ts` | OAuth authorization, token, refresh, revocation, and client resolution flow |
| `vendor/src/oauth-store.ts` | SQLite OAuth state and migration |
| `vendor/src/cimd-oauth-store.ts` | Bounded CIMD retrieval, validation, cache, and compatible auth-method selection |
| `vendor/src/auth.ts` | External OAuth and internal worker authentication selection |
| `vendor/src/internal-auth.ts` | Body-bound HMAC assertion generation and verification |
| `vendor/src/config.ts` | Fail-closed environment and network configuration |
| `vendor/src/windows-event-log.ts` | Windows service lifecycle event emission |

## Mutation, recovery, and jobs

| Module | Responsibility |
| --- | --- |
| `adapter/src/optimized-guard.mts` | Guarded tool registry and checkpoint policy |
| `adapter/src/checkpoint.mts` | Content-addressed objects and manifests |
| `adapter/src/snapshot-targets.mts` | Canonical containment, links, aliases, and target selection |
| `adapter/src/usn-journal.mts` | NTFS USN incremental hash index with conservative fallback |
| `adapter/src/jobs.mts` | Durable client-owned job lifecycle |
| `adapter/src/retention.mts` | Retention planning, reachability GC, and disk reserve |
| `adapter/src/maintenance.mts` | Reviewed two-phase maintenance execution |
| `windows/job-runner/MusuJobRunner.cs` | Windows Job Object ownership and descendant cleanup |

## File and process tools

| Module | Responsibility |
| --- | --- |
| `vendor/src/file-service.ts` / `file-tools.ts` | Filesystem operations and MCP schemas |
| `vendor/src/file-content.ts` | Encoding and chunk validation |
| `vendor/src/process-manager.ts` / `exec-tools.ts` | Process lifecycle and command tools |
| `vendor/src/process-output.ts` | UTF-8 stream framing |
| `vendor/src/script-runner.ts` | Shell and script invocation |
| `vendor/src/tool-registry.ts` / `tool-metadata.ts` | Explicit typed registry and tool metadata |

## Windows operations

| Script | Purpose |
| --- | --- |
| `windows/Install.ps1` | Foreground/legacy combined installation and configuration |
| `windows/Install-SplitService.ps1` | Recommended split WinSW service installation with ACLs and rollback |
| `windows/Start-Local.ps1` | Foreground diagnostics |
| `windows/Maintain.ps1` | Retention dry-run and reviewed apply |
| `windows/Capture-ChatGPTCompatibility.ps1` | Secret-free CIMD/DCR and MCP before/after measurement |
| `windows/Test-RebootPersistence.ps1` | One-time post-reboot service, ACL, event, and health acceptance |

## Verification entry points

- `vendor/test/`: OAuth, transport, security, storage, tool, and metrics tests.
- `tests/windows-split-gateway-smoke.test.mjs`: DCR/PKCE, signed proxying, modern `server/discover`, `tools/list`, and named `tools/call` across separate processes.
- `tests/windows-job-object.test.mjs`: real child/grandchild cleanup.
- `tests/windows-native-smoke.test.mjs`: native runtime and OAuth boundary.
- `tests/windows-acceptance-scripts.test.mjs`: lifecycle and compatibility-capture scripts.
- `.github/workflows/ci.yml`: clean Windows build/test/service lifecycle gate.

## Documentation

| Document | Purpose |
| --- | --- |
| [README](../README.md) | Installation, configuration, ChatGPT connection, and command overview |
| [Architecture](ARCHITECTURE.md) | Runtime, service, trust, checkpoint, OAuth, and process design |
| [Operations](OPERATIONS.md) | Health, upgrade, incident, retention, metrics, and reboot procedures |
| [Dockerless research](DOCKERLESS_WINDOWS_RESEARCH_20260913.md) | Native Windows design evidence and alternatives |
| [Code audit](CODE_AUDIT_20260913.md) | Closed findings, residual boundary, verification, and release gates |
| [Maturity review](OPTIMIZATION_AND_MATURITY_REVIEW_20260913.md) | Qualitative scores, performance evidence, and roadmap |
| [Windows acceptance](WINDOWS_ACCEPTANCE_20260914.md) | Clean-VM and external acceptance matrix |
| [ChatGPT evidence](CHATGPT_COMPATIBILITY_EVIDENCE_20260914.md) | Real CIMD OAuth, discovery, and tool-call evidence |
| [MUSU workspace switchover](MUSU_WORKSPACE_SWITCHOVER_20260914.md) | Old Docker retirement, active F-drive roots, runtime fix, and persistent finish |
