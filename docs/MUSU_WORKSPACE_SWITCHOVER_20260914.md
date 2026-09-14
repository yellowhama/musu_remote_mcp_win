# MUSU workspace MCP switchover — 2026-09-14

## Result

The active ChatGPT endpoint now reaches the Windows-native split gateway and worker with these editable roots:

- `F:\workspace\musu-bee` (default working directory)
- `F:\workspace\llm-wiki`

The acceptance fixture is no longer an editable root. The worker uses `F:\workspace\musu-remote-mcp-production\worker-state` and `F:\workspace\musu-remote-mcp-production\backups`, with a 10 GiB pre-checkpoint free-space reserve. Existing OAuth state and the tested Quick Tunnel URL were retained so the already-approved ChatGPT connector could survive the transition.

## Previous server

The Docker Compose project at `C:\Users\empty\services\musu-dev-mcp` was stopped cleanly. Containers `musu-dev-mcp` and `musu-dev-mcp-tunnel` remain preserved in `Exited (0)` state; their 39391/39392 listeners are closed. No image, volume, source, state, or backup was deleted.

## Active runtime

- Source: `F:\workspace\musu_remote_mcp_win`
- Runtime configuration: `F:\workspace\musu-remote-mcp-production\windows.json`
- Foreground owner: `F:\workspace\musu-remote-mcp-production\run-split.mjs`
- Gateway/worker ports: 39491/39492, loopback only
- Current public endpoint: `https://choices-somewhere-editions-keno.trycloudflare.com/mcp`

The current endpoint is a Quick Tunnel and the runtime is a foreground diagnostic deployment. It is usable now but is not the reboot-persistent target. The supported persistent finish is the split WinSW service plus a fixed Cloudflare named tunnel.

## Runtime defect found during switchover

The HTTP listener was explicitly referenced, but the process-manager cleanup timer was unreferenced. On this workstation, the Event Log helper occupied the first three seconds and the server then exited normally when no referenced event-loop handle remained. The old two-second health assertion completed during that startup helper and produced a false pass.

Commit `25de8e7` keeps the existing cleanup timer referenced as the runtime lifetime anchor and moves native/split survival assertions to 4.5 seconds. Local native and split tests pass, the production runtime remains healthy beyond the former boundary, and [CI run 34805492711](https://github.com/yellowhama/musu_remote_mcp_win/actions/runs/34805492711) passes the complete Windows pipeline.

## Final acceptance

Ask the existing ChatGPT connector to report its default working directory and list only its top-level entries without mutation. Accept the switchover when it reports `F:\workspace\musu-bee`. Then perform a second read against `F:\workspace\llm-wiki` to prove both configured roots.

## Persistent deployment next step

From an elevated PowerShell 7 session, install the checked-in split service using the same two editable roots, a dedicated F-drive state/backup location, and a fixed named-tunnel hostname. Re-run `Capture-ChatGPTCompatibility.ps1` and `Test-RebootPersistence.ps1` after the hostname migration.
