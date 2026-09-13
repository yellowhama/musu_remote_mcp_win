# Security policy

## Supported version

Security fixes are applied to the latest commit on the default branch.

## Report a vulnerability

Do not open a public issue for secrets exposure, authentication bypass, path escape, arbitrary host access, backup corruption, or cross-client job access. Use GitHub's private vulnerability reporting for this repository. Include the affected commit, configuration, reproduction conditions, and impact. Do not include live tokens, approval keys, source data, or backup objects.

## Deployment assumptions

Remote Dev MCP assumes one trusted, supervised operator. OAuth authenticates clients and job/process ownership separates normal clients at the application layer. It does not make arbitrary shell execution safe for mutually untrusted users.

The current gateway and worker share a container UID. An authenticated command can read or modify mounted workspace, state, and backup data permitted to that UID. The Docker socket and host home should never be mounted. Use a dedicated host or VM for stronger isolation.

Quick Tunnels are suitable for development. Use a named tunnel, fixed domain, access policy, monitoring, and separate gateway/worker identities before production or multi-user use.

## Secret handling

The following paths must remain untracked:

- `state/approval-key.txt`
- `state/oauth-state.json`
- `state/runtime.json`
- `.env`
- backup objects and manifests

The repository ignore rules cover these paths. Run a secret scan before every public release.
