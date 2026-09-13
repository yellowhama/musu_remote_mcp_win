# Contributing

Open an issue before a large architectural change. Keep changes focused and preserve the fail-closed mutation contract.

Before submitting a pull request:

1. Do not commit state, keys, tokens, workspace contents, backup objects, or `.env`.
2. Add behavior-focused regression tests for backup, authorization, concurrency, and recovery changes.
3. Run `docker compose build mcp`; the image build must pass all upstream and adapter suites.
4. Document security-boundary or public-tool changes in the README and architecture notes.
5. Preserve the upstream MIT license and NOTICE attribution.

Security reports belong in private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).
