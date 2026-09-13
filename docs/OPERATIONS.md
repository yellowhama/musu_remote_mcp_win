# Operations

## Start and stop

```powershell
& '.\Start.ps1'
& '.\Stop.ps1'
docker compose ps
```

The MCP service should report `healthy`; the tunnel should report `Up`. The current public base URL is stored in `state/runtime.json`.

## Client-side disabled errors

If a client reports that the app or tool is disabled and the server has no matching `mcp_request` log, the request was blocked before reaching this service. Re-select the app for the message, verify it under the client's enabled apps, refresh the tool/action inventory, and reconnect OAuth if needed.

## Logs

```powershell
docker compose logs --tail 200 mcp
docker compose logs --tail 200 tunnel
```

Do not paste logs publicly without checking for repository paths and user data. Approval keys and access tokens should never be logged by this project.

## Backup verification

Backup verification should stream each object, compare its digest to the filename, validate manifest references, and record the result. Perform restore drills into a new directory outside every editable root. Never overwrite live roots during a drill.

## Capacity

Monitor object-store size, manifest count, free disk space, full-checkpoint duration, queue age, and failed or interrupted jobs. This release has no automatic retention or garbage collection. Delete nothing until a retention policy, dry run, and successful restore drill have been reviewed.

## Production hardening backlog

1. Separate the OAuth gateway and execution worker by UID, process, and mounts.
2. Put backup writes behind a narrow broker that the shell worker cannot alter directly.
3. Add a versioned incremental checkpoint index with fail-closed full-hash fallback.
4. Add retention, mark-and-sweep garbage collection, and recovery tooling.
5. Replace Quick Tunnel with a named tunnel and fixed domain.
