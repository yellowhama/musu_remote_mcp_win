# Windows acceptance evidence — 2026-09-14

## Evidence status

| Gate | Status | Evidence |
|---|---|---|
| Root npm workspace and clean build | Pass | Typecheck/build succeeds after both generated `dist` trees are removed |
| Separate gateway and worker processes | Pass | Native smoke completes DCR, PKCE, token issuance, signed proxying, MCP initialize, and owner-bound job submission |
| Unsigned/replayed/altered internal request | Pass | Worker returns 401; unit tests bind client, timestamp, nonce, and body hash |
| Windows Job Object descendant cleanup | Pass | Real PowerShell child/grandchild termination test |
| Service install, restart, injected upgrade rollback, uninstall | Pass | [GitHub Actions run 34769642484](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34769642484) installed both WinSW services, validated deny ACLs, restarted them, reached the intended failure-injection checkpoint, restored health, and uninstalled them |
| Reboot persistence | Harness ready; execution pending | `Test-RebootPersistence.ps1` records boot identity, installs a one-time SYSTEM verifier, and checks health, automatic services, ACLs, and events after reboot |
| Real ChatGPT OAuth and tool call | Pass | ChatGPT completed approval, `server/discover`, `tools/list`, and a read-only system/root-listing request through the split gateway and worker |
| CIMD versus DCR measurement | Pass for current ChatGPT; wider window pending | capture selected CIMD: 1 success/0 failure; DCR: 0/0; MCP 2xx delta: 8 |

The current harness run completed 53 vendor tests with one platform-specific skip, 69 adapter/native tests, dependency audit with zero known vulnerabilities, and the clean-VM service lifecycle. [Run 34770818016](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34770818016) includes the route-scoped metrics key and both acceptance-script tests. Its logs contain zero unsupported WinSW `refresh` calls and contain the expected injected-failure marker.

The final interoperability fixes are covered by [run 34802859266](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34802859266). A real ChatGPT session then passed the compatibility capture with `selectedMethod: cimd` and eight successful MCP requests. See [the preserved acceptance summary](CHATGPT_COMPATIBILITY_EVIDENCE_20260914.md).

## Current workstation constraint

The active workstation process is not an administrator and the Hyper-V PowerShell module is absent. It can validate two real Node processes and Job Objects, but it cannot create a VM, install Windows services, or reboot the host. These are environment constraints, not passing evidence.

## Real ChatGPT capture procedure

1. Run `pwsh -File windows\Capture-ChatGPTCompatibility.ps1 -Phase Begin`.
2. Create a fresh ChatGPT custom MCP app against the fixed `/mcp` URL and complete approval.
3. Scan tools and make at least one MCP tool call.
4. Run the capture script with `-Phase End`.
5. Accept the result only when a CIMD/DCR success delta and an MCP 2xx delta are both present. Preserve `compatibility-result.json` with the release evidence.

This procedure passed on 2026-09-14. Repeat it after changing the public hostname, OAuth implementation, proxy header policy, or MCP protocol generation.
