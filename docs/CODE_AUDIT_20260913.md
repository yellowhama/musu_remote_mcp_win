# Code audit — 2026-09-13

## Verdict

No critical correctness defect was found in the current foreground or split-process runtime. The audited build is appropriate for one trusted operator under supervision. The recommended service layout separates OAuth and arbitrary-command identities, while the worker itself remains an intentionally unrestricted trusted-code executor.

## Findings closed in this audit

| Severity | Finding | Resolution | Evidence |
| --- | --- | --- | --- |
| High | Present Origin headers were not validated | canonical public/loopback allow-list with 403 rejection | hostile and valid Origin integration tests |
| High | Legacy-only MCP transport and global prototype interception | SDK v2 2026-07-28 primary handler, explicit registry, 2025-11-25 compatibility handler | modern and raw legacy initialization tests |
| High | OAuth traffic and state growth were unbounded | endpoint rate limits, client/state caps, input limits | security boundary integration tests |
| High | Service install could leave partial state | transactional rollback and health gate | installer fault-path tests |
| High | Backup/job/log growth was unbounded | retention, mark/reachability GC, dry-run, staging, disk watermark | retention and low-space tests |
| Medium | Full hashing dominated large checkpoints | NTFS USN delta index with conservative fallback | 10,001-file benchmark and journal tests |
| Medium | Whole-file OAuth JSON rewrites | SQLite WAL, strict schema, transactions, expiry indexes, legacy migration | OAuth store/integration tests |
| Medium | OAuth module mixed presentation/provider/storage | storage extracted to `oauth-store.ts` | typecheck and suite |
| High | CIMD URL retrieval could expose an SSRF path | canonical HTTPS identifiers, public-address filtering, DNS pinning, no redirects, bounded fetch and cache | CIMD unit and OAuth integration tests |
| High | OAuth gateway and arbitrary-command execution shared one service identity | separate virtual service accounts, deny ACLs, loopback-only worker, body-bound HMAC assertions | two-process smoke test and clean-VM ACL gate |
| Medium | WinSW 2.12 upgrade path called unsupported `refresh`; the first rollback gate failed before its intended checkpoint | stop existing wrapper, rewrite XML/config while stopped, restart; CI now asserts the exact injected-failure marker | clean-VM run 34769642484, zero `refresh` errors |

## Current security boundary

The server binds to loopback and expects a controlled HTTPS tunnel. Host and Origin are validated. OAuth uses PKCE, resource/audience binding, refresh rotation, grant revocation on replay, bounded registration, and hashed token identifiers. State and key ACLs remain part of the trust boundary.

The recommended Windows service mode now separates OAuth and execution identities. The gateway has explicit deny ACLs on editable roots and backups; the worker has an explicit deny ACL on OAuth state. Loopback messages carry body-bound, replay-resistant HMAC assertions. Residual exposure is the worker account's deliberately broad command access and local administrator override.

## Code health

- `oauth.ts` fell from roughly 700 lines to 392 lines after storage extraction.
- `file-service.ts` (695) and `process-manager.ts` (682) remain the main change-risk concentrations.
- The former root JavaScript adapter is now an `adapter` TypeScript workspace; the repository uses a real root npm workspace and lockfile without a `node_modules` junction.
- File encoding/chunk logic and process output framing are extracted into focused modules; the former 695/682-line service modules are now 606/578 lines.
- Authenticated fixed-cardinality metrics cover HTTP, auth, process, queue, checkpoint, and disk signals; Windows service lifecycle failures reach the Application Event Log.
- SDK calls now fail at typed compile boundaries; the previous global monkey patch is gone.
- Shutdown now stops accepting HTTP connections before closing OAuth state and worker resources.

## Performance assessment

The USN index changes the dominant unchanged-workspace cost from hashing all files to enumerating/statting them. On 10,001 NTFS files, snapshot time fell from 10.94 s to 3.58 s unchanged and 3.64 s with one changed file. Hash operations fell from 10,001 to 0 and 1 respectively. The final verification path remains intentionally conservative.

## Verification

- `npm run typecheck`: pass.
- `npm run build`: pass.
- Vendor suite: **52 pass, 1 skipped**.
- Adapter/native suite: **67/67 pass**.
- OAuth/CIMD and internal-auth focused tests: **19/19 pass**.
- Production dependency audit: **0 known vulnerabilities**.
- Git diff whitespace check: pass; Git reports only expected CRLF-to-LF normalization warnings.
- GitHub Actions: [run 34769642484](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34769642484) passes build, all Windows tests, service install, ACL separation, restart, exact-point upgrade rollback, and uninstall.

## Open release gates

1. Validate service persistence across a real Windows reboot on a reboot-capable disposable VM.
2. Measure whether a real ChatGPT connector selects CIMD or DCR through a fixed HTTPS tunnel.
3. Split the two largest modules and progressively strengthen the migrated adapter's public TypeScript interfaces.

## Rating

**9.0/10, A- single-operator beta.** Core correctness, privilege separation, recovery, and clean-VM lifecycle evidence are strong. Reboot persistence and real ChatGPT protocol negotiation remain release evidence gaps.
