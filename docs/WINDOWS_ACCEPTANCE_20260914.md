# Windows acceptance evidence — 2026-09-14

## Evidence status

| Gate | Status | Evidence |
|---|---|---|
| Root npm workspace and clean build | Pass | Typecheck/build succeeds after both generated `dist` trees are removed |
| Separate gateway and worker processes | Pass | Native smoke completes DCR, PKCE, token issuance, signed proxying, MCP initialize, and owner-bound job submission |
| Unsigned/replayed/altered internal request | Pass | Worker returns 401; unit tests bind client, timestamp, nonce, and body hash |
| Windows Job Object descendant cleanup | Pass | Real PowerShell child/grandchild termination test |
| Service install, restart, injected upgrade rollback, uninstall | Automated clean-VM gate | GitHub Actions `windows-latest` installs both WinSW services and validates deny ACLs and post-rollback health |
| Reboot persistence | Pending external VM | Current workstation session is not elevated and has no Hyper-V module; hosted Actions cannot reboot in place |
| Real ChatGPT OAuth | Pending external account/tunnel | Requires the operator's ChatGPT developer-mode session and fixed public tunnel |
| CIMD versus DCR measurement | Ready | `/metrics` exposes bounded success/failure counters by registration method |

## Current workstation constraint

The active workstation process is not an administrator and the Hyper-V PowerShell module is absent. It can validate two real Node processes and Job Objects, but it cannot create a VM, install Windows services, or reboot the host. These are environment constraints, not passing evidence.

## Real ChatGPT capture procedure

1. Record the four `musu_oauth_client_resolution_total` counters.
2. Create the ChatGPT custom MCP app against the fixed `/mcp` URL and complete approval.
3. Scan tools, submit a checkpoint job, and reconnect after token refresh.
4. Record the counters again and save gateway/worker Event Log entries and redacted service logs.
5. Mark CIMD compatible only if the CIMD success counter increases without a DCR success increase for that fresh client.
