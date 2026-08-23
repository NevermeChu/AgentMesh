# Changelog

AgentMesh follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Typed ESLint, deterministic formatting, coverage thresholds, process integration tests, and published-package smoke tests.
- Node.js 22 and 24 CI coverage, dependency update automation, and npm provenance metadata.
- Content-sensitive repository evidence and MCP progress notifications for reliable cross-role handoffs.
- Configurable Reviewer safety policy, protection reporting, and working-tree mutation detection.

### Changed

- Raised the supported Node.js baseline to 22.13 and aligned build output with Node.js 22.
- Made `package.json` the single source for CLI, library, and MCP server versions.
- Consolidated overlapping implementation-detail tests while retaining role security, session consistency, process, MCP, and package boundaries.
- Made explicit transport modes strict and normalized Codex summaries from the final agent message.
- Runs OpenCode reviews with its plan Agent and blocks Reviewer-specific extra CLI arguments.
- Preserves multibyte UTF-8 output across process chunks to keep diagnostics and repository fingerprints deterministic.

### Security

- Pinned the transitive `esbuild` resolution to a non-vulnerable release and normalized the lockfile to the official npm registry.
- Removed `cmd.exe` interpolation from supported Windows npm CLI shims and rejected unrecognized batch launchers.

## 0.1.0 - 2026-08-20

- Published the first usable AgentMesh release with MCP orchestration, role configuration, adapter execution, and Bridge Session context transfer.
