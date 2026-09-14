# Real ChatGPT compatibility evidence — 2026-09-14

## Result

A fresh ChatGPT custom MCP connection completed OAuth approval, server discovery, tool discovery, and a read-only tool call through the split Windows gateway and worker. The compatibility capture passed.

| Signal | Result |
| --- | --- |
| OAuth client resolution | CIMD selected; 1 success, 0 failures |
| Legacy DCR | 0 successes, 0 failures during this capture |
| MCP success delta | 8 HTTP 2xx requests |
| `server/discover` | HTTP 200 through gateway and worker |
| `tools/list` | HTTP 200 through gateway and worker |
| Read-only tool result | Windows system information and complete top-level listing returned |
| Workspace mutation | None requested or observed |

The tested worker root was `F:\workspace\musu-remote-mcp-acceptance\editable`. ChatGPT reported Windows 11, PowerShell 7.5.3, and the complete single-entry root listing. No credential or token is stored in this document.

## Defects found and closed

1. Node's HTTPS custom DNS lookup did not honor the `all: true` callback shape used during CIMD retrieval. The resolver now returns the required address array.
2. ChatGPT's transitional metadata advertised singular `private_key_jwt` together with a plural list containing `none`; method selection now uses the compatible public-client method.
3. Origin validation applied to the cross-origin OAuth approval form. It is now scoped to the MCP endpoint while hostile MCP origins remain rejected.
4. The gateway forwarded only `Mcp-Protocol-Version`, dropping ChatGPT's required `Mcp-Method` header. It now forwards MCP protocol headers in both directions; modern `server/discover` and `tools/call` are covered by the split-process smoke test.

## Verification

- Local focused OAuth and security tests: 10/10 pass.
- Split gateway/worker modern MCP smoke test: pass.
- Clean Windows GitHub Actions build, tests, service install, restart, rollback, and uninstall: [run 34802859266](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34802859266), pass.
- Compatibility capture artifact: `F:\workspace\musu-remote-mcp-acceptance\gateway-state\acceptance\chatgpt\compatibility-result.json` (`passed: true`, `selectedMethod: cimd`).

## Remaining release evidence

- Repeat against a fixed Cloudflare named tunnel; the acceptance run used a development Quick Tunnel URL.
- Complete the checked-in reboot-persistence harness on a reboot-capable disposable Windows VM.
- Keep DCR during a wider compatibility window. One successful CIMD session proves current ChatGPT compatibility, but it does not prove every supported client has stopped using DCR.
