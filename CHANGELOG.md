# Changelog

AgentMesh follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Typed ESLint, deterministic formatting, coverage thresholds, process integration tests, and published-package smoke tests.
- Node.js 22 and 24 CI coverage, dependency update automation, and npm provenance metadata.
- Content-sensitive repository evidence and MCP progress notifications for reliable cross-role handoffs.
- Configurable Reviewer safety policy, protection reporting, and working-tree mutation detection.
- Default run timeout (`DEFAULT_RUN_TIMEOUT_MS`, 10 minutes) wired through `RunnerOptions.defaultTimeoutMs` and `sessionStoragePath`, so unconfigured CLI executions can no longer hang forever.
- Quarantining of corrupt session storage: an invalid `sessions.json` is renamed to `*.corrupt-<timestamp>` and replaced with an empty state instead of failing every command.
- End-to-end cancellation: MCP client timeouts, cancellations, and disconnects now abort the underlying agent process tree (`AbortSignal` threaded from tool handlers through the runner, adapters, executor, and MCP client), record the turn as failed history with full evidence, and never trigger the auto CLI fallback. `ExecutionResult` gains an optional `aborted` flag.
- MCP tool responses include a bounded `Raw Output` section (8000 chars) with vendor CLI stdout/stderr so remote failures remain diagnosable.

### Changed

- Raised the supported Node.js baseline to 22.13 and aligned build output with Node.js 22.
- Made `package.json` the single source for CLI, library, and MCP server versions.
- Consolidated overlapping implementation-detail tests while retaining role security, session consistency, process, MCP, and package boundaries.
- Made explicit transport modes strict and normalized Codex summaries from the final agent message.
- Runs OpenCode reviews with its plan Agent and blocks Reviewer-specific extra CLI arguments.
- Preserves multibyte UTF-8 output across process chunks to keep diagnostics and repository fingerprints deterministic.
- **BREAKING:** The Claude adapter is CLI-only because `claude mcp serve` now exposes Claude Code's raw toolset instead of a one-shot task tool; explicit `mode=mcp` returns a structured error.
- Codex MCP calls now match the vendor tool schemas exactly (`codex` with `prompt`/`cwd`/`sandbox`, `codex-reply` with `threadId`/`prompt`) instead of forwarding unrecognized keys, and the MCP client refuses to guess a tool when no recognizable task tool exists.
- Repository evidence caps per-path content fingerprints at 100 changed paths and full-content hashing at 500 untracked files, degrading to coarse evidence so captures stay bounded on large change sets.

### Fixed

- Shell-injected `PWD`/`OLDPWD` are no longer inherited by spawned agents; vendor CLIs that trust `PWD` over the spawned cwd (observed with OpenCode) previously operated on the wrong repository.
- MCP `delegate_task` / `continue_task` mark inherited reviewer `FAIL` verdicts as tool errors.
- Explicit `shell: false` resolves Windows npm shims exactly like the default path, and signal-terminated processes report `128 + signum` exit codes.

### Security

- Pinned the transitive `esbuild` resolution to a non-vulnerable release and normalized the lockfile to the official npm registry.
- Removed `cmd.exe` interpolation from supported Windows npm CLI shims and rejected unrecognized batch launchers.

## 0.1.0 - 2026-08-20

- Published the first usable AgentMesh release with MCP orchestration, role configuration, adapter execution, and Bridge Session context transfer.
