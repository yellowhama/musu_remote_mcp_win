# MUSU workspace MCP switchover — 2026-09-14

## Result

The active ChatGPT endpoint now reaches the Windows-native split gateway and worker with these editable roots:

- `F:\workspace\musu-active\musu-bee` (default working directory)
- `F:\workspace\musu-active\llm-wiki`

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

The first write acceptance proved the mutation and checkpoint mechanism but targeted the preserved historical roots `F:\workspace\musu-bee` and `F:\workspace\llm-wiki`. That result did not prove that the server was attached to the current MUSU source of truth. Comparing `AGENT_HANDOFF_CURRENT.md`, `MUSU_ORGANIZATION_PRODUCT_BASELINE_20260913.md`, Git heads, and `F:\workspace\musu-active\AGENTS.md` exposed the path error.

The runtime configuration was corrected without moving or overwriting either historical directory. A fresh signed live MCP verification then called `write_file`, `read_file`, and `remove_path` against a unique probe in each active root. Both `F:\workspace\musu-active\musu-bee` and `F:\workspace\musu-active\llm-wiki` passed create/readback/delete, no probe remained, and four new checkpoint manifests named only the active roots. Gateway, worker, and the public endpoint returned HTTP 200 after restart.

These are separate acceptance claims:

1. **Mutation capability:** the MCP can create, read back, delete, and checkpoint a permitted file.
2. **Workspace identity:** the permitted roots resolve to the active MUSU code and wiki selected by the workspace's own authority files.

Both claims now pass for the `musu-active` roots. A cached ChatGPT tool description can still display an older path until the connector tools are refreshed, but runtime enforcement and the live `write_file` definition use the active roots.

The historical-root manifests remain valid evidence of the earlier capability test and are not evidence for the active workspace. They were retained for auditability.

## Persistent deployment next step

From an elevated PowerShell 7 session, install the checked-in split service using the same two editable roots, a dedicated F-drive state/backup location, and a fixed named-tunnel hostname. Re-run `Capture-ChatGPTCompatibility.ps1` and `Test-RebootPersistence.ps1` after the hostname migration.
