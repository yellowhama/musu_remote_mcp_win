# Code audit — 2026-09-13

## Verdict

No critical correctness defect was found in the current foreground runtime. The audited build is appropriate for one trusted operator under supervision. It is not ready for untrusted callers because the HTTP gateway and arbitrary-command worker still share a Windows identity.

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

## Current security boundary

The server binds to loopback and expects a controlled HTTPS tunnel. Host and Origin are validated. OAuth uses PKCE, resource/audience binding, refresh rotation, grant revocation on replay, bounded registration, and hashed token identifiers. State and key ACLs remain part of the trust boundary.

The unrestricted command tools can read anything available to the service identity. A compromised authenticated session can therefore reach OAuth state, backups, and unrelated files granted to that identity. The required architectural fix is a low-privilege gateway plus an execution worker under a separate identity.

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
- `npm test`: **43 pass, 1 skipped**.
- OAuth/CIMD-focused tests: **9/9 pass**.
- Git diff whitespace check: pass; Git reports only expected CRLF-to-LF normalization warnings.
- GitHub Actions: green for Origin, installer, retention, SDK v2, USN, and SQLite commits (run 34762770787).

## Open release gates

1. Separate gateway and worker identities with an ACL-restricted local transport.
2. Complete a disposable-VM lifecycle test and measure whether a real ChatGPT connector selects CIMD or DCR.
4. Split the two largest modules and progressively strengthen the migrated adapter's public TypeScript interfaces.

## Rating

**8.3/10, B+ controlled-use beta.** Core correctness and recovery are strong. Privilege isolation, observability, and lifecycle evidence are the remaining production blockers.
