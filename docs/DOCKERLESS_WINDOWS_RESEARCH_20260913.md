# Dockerless Windows installation research

Date: 2026-09-13
Scope: native Windows support for Remote Dev MCP, with Linux and WSL compared as alternatives

## Decision

Docker is not a protocol or runtime requirement. The MCP server is a Node.js HTTP application, and Cloudflare distributes native Windows and Linux `cloudflared` binaries and documents service installation on both systems. The supported Windows design is:

```text
ChatGPT
  -> fixed HTTPS hostname
  -> cloudflared Windows service
  -> 127.0.0.1:39391
  -> Node.js MCP under WinSW
  -> explicitly ACL-granted workspace, state, and backup roots
```

Windows foreground mode is the development path. WinSW plus a Cloudflare named tunnel is the persistent path. WSL is an optional compatibility path rather than the Windows default. Quick Tunnel remains development-only.

## Primary-source findings

### MCP and ChatGPT connectivity

The MCP Streamable HTTP specification requires Origin validation, recommends loopback binding for local servers, and recommends authentication. The Windows runtime must therefore bind the origin to `127.0.0.1`, preserve allowed-host validation, and expose it through a controlled tunnel rather than listening on every interface. Source: [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

ChatGPT connects to remote MCP servers and cannot directly connect to a local server. OpenAI's current guidance says an on-premises or developer-machine server needs a secure MCP tunnel. It also documents OAuth tool scanning and refresh-token requirements. Source: [OpenAI developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta).

### Native tunnel support

Cloudflare explicitly supports `cloudflared` as a Windows or Linux system service and recommends service mode for boot startup and availability. Sources: [service overview](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/), [Windows service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/windows/), and [Linux service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/linux/).

Cloudflare publishes Windows MSI/EXE and Linux packages independently of Docker. Windows installations do not auto-update, which creates an explicit maintenance task. Source: [cloudflared downloads](https://developers.cloudflare.com/tunnel/downloads/).

Quick Tunnels are for tests and development, have no uptime guarantee, use a changing hostname, allow at most 200 in-flight requests, and do not support SSE. They are unsuitable for stable OAuth issuer metadata. Source: [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/).

### Node.js support and Windows differences

Node.js recommends Active LTS or Maintenance LTS for production. As of this research date, Node.js 24 and 22 are LTS lines. Source: [Node.js release status](https://nodejs.org/en/about/previous-releases).

Node documents that the default shell on Windows is `process.env.ComSpec`, while POSIX systems default to `/bin/sh`. It also documents that Windows has no POSIX signals and that termination signals are emulated as abrupt termination. Source: [Node.js child process API](https://nodejs.org/api/child_process.html).

Node's filesystem documentation states that Windows `chmod` can change only the write permission and does not implement owner/group/other distinctions. It also lists `O_NOFOLLOW` as unavailable on Windows. Native Windows therefore needs NTFS ACL tooling and cannot claim the same symlink race resistance or permission restore semantics as Linux. Source: [Node.js filesystem API](https://nodejs.org/api/fs.html).

Microsoft documents `icacls` for modifying DACLs on Windows 10/11 and Server. It also documents that each Windows service runs in a user account security context whose token governs access to securable objects. Sources: [icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls) and [service user accounts](https://learn.microsoft.com/en-us/windows/win32/services/service-user-accounts).

Windows junctions are NTFS reparse points and may target another local volume. Root-containment logic must reject junction traversal as well as symbolic links. Source: [Microsoft hard links and junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions).

Microsoft Job Objects provide the native primitive for containing a process tree, including kill-on-job-close. Node core does not expose Job Objects, so this edition compiles a small C# launcher that assigns itself to a nested kill-on-close Job Object before starting each command. Source: [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

### Service managers

Node is a console application rather than a Windows Service Control Manager implementation. WinSW is a maintained open-source wrapper that runs an arbitrary executable as a Windows service and supports automatic start, restart on failure, working directories, service accounts, and rolling logs. Source: [WinSW project](https://github.com/winsw/winsw) and [configuration reference](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md).

On Linux, systemd provides stronger native hardening than a plain user service: `NoNewPrivileges`, filesystem protection, explicit writable paths, and managed state directories. It also recommends `Restart=on-failure` for long-running services. Sources: [systemd execution environment](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml) and [systemd service behavior](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

WSL supports systemd, including current Ubuntu installed by `wsl --install`. This makes WSL a valid compatibility option, but it adds a VM/distribution lifecycle and Windows-to-Linux path translation. It does not improve the product enough to be the primary Windows experience. Source: [Microsoft WSL systemd guide](https://learn.microsoft.com/en-us/windows/wsl/systemd).

## Source audit before implementation

The Docker edition could not be advertised as native Windows without changes:

| Finding | Consequence | Windows action |
|---|---|---|
| `entrypoint.mjs` used `/state` and a flattened `/opt/mcp` build layout | Native startup could not find state or compiled server | Configurable state root and `vendor/dist` import |
| Root adapter imports expected Docker's root-level `node_modules` | `npm ci --prefix vendor` was insufficient | Root npm workspace and lockfile provide one dependency tree without a junction |
| Default shell and arguments were `/bin/bash -lc` | PowerShell/cmd commands failed | Platform-specific shell arguments and PowerShell 7 default |
| Script runtimes omitted PowerShell and used `python3` | Native scripts were incomplete | Added `powershell`; Windows Python default is `python.exe` |
| Windows termination called `child.kill()` only | Grandchildren could survive cancellation | Kill-on-close Windows Job Object launcher |
| Path containment used case-sensitive string prefixes | Drive-letter casing and prefix aliases could misclassify paths | `path.relative` containment and canonical-root checks |
| Direct mutations rejected symlinks only | Junction and hard-link escapes remained | Junction/symlink rejection and final-file hard-link rejection |
| Docker provided capabilities, mount, PID, CPU, and memory controls | Native account could see more of the host | Low-privilege service identity plus explicit ACL grants and residual-risk documentation |
| Tests and CI ran only inside Linux Docker | Windows behavior was unverified | `windows-latest` CI and a real native OAuth smoke test |

## Support matrix

| Mode | Status | Intended use | Isolation |
|---|---|---|---|
| Windows foreground, Node 24 + PowerShell 7 | Supported | Setup and diagnostics | Current interactive user permissions |
| Windows split WinSW + named Cloudflare tunnel | Beta with clean-VM CI gate | Persistent personal workstation | Separate gateway/worker virtual accounts plus deny ACLs |
| Linux systemd + named tunnel | Feasible next target | VPS or dedicated Linux host | Dedicated user plus systemd hardening |
| WSL2 + systemd | Compatibility option | Users needing POSIX tools | WSL VM boundary, Windows mounts remain sensitive |
| Cloudflare Quick Tunnel | Development only | Short-lived tests | Random URL; no availability guarantee |
| Native hostile multi-tenant use | Unsupported | None | Gateway/worker split and stronger sandbox required |

## Accepted limitations for v1

1. Foreground compatibility mode uses the current interactive identity; recommended service mode separates gateway and worker virtual accounts.
2. The internal boundary uses authenticated loopback HTTP; a named-pipe transport with an explicit pipe ACL remains a possible further reduction in local attack surface.
3. Every managed command tree is assigned to a kill-on-close Windows Job Object.
4. Backup restore verifies content bytes but does not restore NTFS ACLs, ownership, alternate data streams, symlinks, junctions, or every file attribute.
5. File-system race resistance is weaker than Linux because Node does not expose `O_NOFOLLOW` on Windows.

## Acceptance gates

- Clean Windows 11 VM with no Docker installed
- Node 24 LTS and PowerShell 7 detected; system-wide paths required for service mode
- Install, foreground start, service start, reboot start, restart-on-failure, upgrade, and uninstall
- Local health 200, unauthenticated MCP 401, OAuth DCR/PKCE/refresh/revocation, and 23-tool scan
- Direct edit checkpoint and durable shell job checkpoint with Korean and CRLF byte preservation
- Drive-letter case, traversal, symlink, junction, hard-link, overlapping-root, and comma-path rejection
- Child plus grandchild termination after timeout and explicit cancel
- Interrupted job becomes `interrupted_unknown` after restart and is not replayed
- Backup corruption detection and restore into a new directory
- State, backup, service, tunnel credential, and log ACL review
- GitHub Actions on `windows-latest` with the real native entrypoint smoke

## Next hardening steps

1. Sign the Job Object launcher and publish release provenance.
2. Add a dedicated local service-account option and ACL migration test.
3. Split OAuth gateway and execution worker identities so shell jobs cannot read OAuth state.
4. Add NTFS ACL metadata backup and restore as an explicit optional format version.
5. Add a signed installer and dependency manifest for Node, PowerShell, Git, WinSW, and cloudflared.
