# Changelog

AgentMesh follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Typed ESLint, deterministic formatting, coverage thresholds, process integration tests, and published-package smoke tests.
- Node.js 22 and 24 CI coverage, dependency update automation, and npm provenance metadata.

### Changed

- Raised the supported Node.js baseline to 22.13 and aligned build output with Node.js 22.
- Made `package.json` the single source for CLI, library, and MCP server versions.
- Consolidated overlapping implementation-detail tests while retaining role security, session consistency, process, MCP, and package boundaries.

### Security

- Pinned the transitive `esbuild` resolution to a non-vulnerable release and normalized the lockfile to the official npm registry.

## 0.1.0 - 2026-08-20

- Published the first usable AgentMesh release with MCP orchestration, role configuration, adapter execution, and Bridge Session context transfer.
