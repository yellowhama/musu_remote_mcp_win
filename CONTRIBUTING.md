# Contributing

Open an issue before a large architectural change. Keep changes focused and preserve the fail-closed mutation contract.

Before submitting a pull request:

1. Do not commit state, keys, tokens, workspace contents, backup objects, or `config/windows.json`.
2. Add behavior-focused regression tests for backup, authorization, concurrency, and recovery changes.
3. Run the Windows build, upstream Vitest suite, and adapter/native smoke command documented in the README.
4. Document security-boundary or public-tool changes in the README and architecture notes.
5. Preserve the upstream MIT license and NOTICE attribution.

Security reports belong in private vulnerability reporting, as described in [SECURITY.md](SECURITY.md).
