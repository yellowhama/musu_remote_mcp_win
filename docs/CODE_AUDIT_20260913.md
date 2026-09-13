# Windows native code audit

Date: 2026-09-13
Target: `yellowhama/musu_remote_mcp_win`

## Verdict

The foreground Windows runtime is ready for controlled use by one trusted operator. The installer, TypeScript build, OAuth server startup, path validation, checkpoints, durable jobs, UTF-8 handling, and Windows process-tree cancellation have been exercised on Windows 11 without Docker.

Windows service mode is beta until an administrator-level clean-machine test covers install, reboot start, failure restart, upgrade, and uninstall. The Cloudflare named-tunnel configuration is based on official native service documentation but has not been connected to a live hostname in this repository verification.

Qualitative score: **8.5/10 for a trusted personal development PC; not suitable for hostile or multi-tenant execution.**

## Resolved findings

| Severity | Finding | Resolution | Evidence |
|---|---|---|---|
| High | Docker-only `/state`, `/workspace`, and flattened build paths prevented native startup | Strict Windows JSON configuration and native entrypoint | Real health 200 / MCP 401 smoke |
| High | POSIX shell flags were sent to Windows shells | PowerShell/cmd-specific argument construction | Full MCP tool integration suite |
| High | `child.kill()` could leave Windows grandchildren alive | `taskkill.exe /T /F` plus descendant test | Windows-only process-tree test |
| High | Windows lacks `O_NOFOLLOW`, allowing a backup object link to be followed | Explicit `lstat` link rejection and open-handle identity comparison | Regression test passes |
| High | Concurrent identical checkpoint objects collided because Windows rename does not replace an existing target | Verify the winning content-addressed object and remove the losing temporary file | 10,001-file duplicate-content test passes |
| Medium | String-prefix path checks did not model drive-letter case and Windows separators | `path.relative` containment and canonical-root validation | Windows adapter tests |
| Medium | Junctions and direct hard-linked files could bypass an edit-path assumption | Junction/symlink traversal and final-file hard-link rejection | Source audit and path regressions |
| Medium | Git could rewrite LF patches to CRLF under host `core.autocrlf` | Per-command `core.autocrlf=false` for patch application | Unified and three-way patch integration tests |
| Medium | POSIX mode tests produced false failures on NTFS | Windows ACL contract documented; POSIX-only assertions gated | 41 applicable upstream tests pass |
| Medium | State key relied on ineffective Windows `chmod` semantics | Installer restricts state DACL with `icacls` | Installer execution and ACL inspection |

## Remaining risks

### Shared execution identity — high by design

OAuth, shell execution, state, and backups share one Windows account. A successfully authenticated shell job can read anything this account can read. Editable roots prevent accidental direct-tool traversal; they do not sandbox shell commands.

Next control: split the OAuth gateway and execution worker into separate identities and communicate through a narrow authenticated local channel.

### LocalService is shared — medium

The default service account is lower privilege than LocalSystem, but other services may also run as LocalService. Granting it modify access to source makes that source reachable to those services.

Next control: add a dedicated local-account or virtual-service-account installer option with an automated ACL migration and removal test.

### Process containment — medium

`taskkill /T /F` terminates the normal visible process tree, but it is not equivalent to assigning descendants to a kill-on-close Windows Job Object. A process that escapes into another service boundary may survive.

Next control: a small signed native launcher using Job Objects.

### Filesystem metadata recovery — medium

Backups preserve and verify file bytes. They do not fully preserve NTFS DACLs, owners, alternate data streams, every attribute, junctions, or symlinks. Database and external command effects are not transactional.

Next control: versioned optional NTFS metadata capture and a documented database-aware pre-job hook.

### Service and tunnel lifecycle — medium, verification gap

The WinSW download is version- and SHA-256-pinned, XML contains no secret, and scripts parse. Administrator service registration and live named-tunnel OAuth have not been performed during this audit.

Next gate: a disposable Windows VM test with recorded service status, reboot, failure restart, fixed URL OAuth refresh, update, and uninstall evidence.

## Verification record

- Windows 11 Home 64-bit, Node.js 24.8.0, npm 11.12.0, PowerShell 7.5.3
- TypeScript build: pass
- npm production dependency audit: 0 known vulnerabilities
- Upstream Vitest: 41 pass, 1 POSIX-only permission test skipped on Windows
- Windows process-tree regression: included in the upstream total and passed
- Adapter/checkpoint/job/native tests: 57 pass
- Native real-server smoke: health 200, unauthenticated MCP 401, approval-key creation
- Installer without `-Service`: pass against disposable roots
- Generated state DACL: current user and SYSTEM only in foreground installation
- PowerShell parser: install/start/uninstall scripts pass
- `git diff --check`: pass
- Secret-pattern review: no generated key, OAuth token, tunnel credential, or private key tracked

## Release gates

1. GitHub `windows-latest` CI must pass from a clean checkout.
2. Confirm the repository contains no ignored generated configuration or service binary.
3. Enable private vulnerability reporting on GitHub.
4. Run a clean Windows VM service lifecycle test before labeling service mode stable.
5. Run a live named-tunnel OAuth round trip before publishing a production setup claim.
