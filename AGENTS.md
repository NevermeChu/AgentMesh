# AGENTS

## Principles

- Prefer clarity and consistency over cleverness. Make the smallest complete change and match existing patterns.
- Keep functions focused; extract helpers when it improves ownership, testability, or error handling.
- Use TypeScript for product and test code. Tooling scripts may use ESM JavaScript when they must run before compilation.
- Avoid `any`. Prefer narrowing over casts, and isolate unavoidable boundary casts next to validation.
- Do not add `try/catch` unless the boundary can recover, normalize an external error, or add actionable context.
- Use named exports. Let the compiler infer return types unless an annotation documents a public contract.
- Use an options object for three or more parameters, optional flags, or ambiguous arguments.
- Debug from one to three explicit hypotheses and validate the most likely cause first.

## Code discovery

- When `.codegraph/` exists, use CodeGraph before grep or manual file traversal to understand symbols and call paths.
- Treat current source, schemas, tests, CLI help, and package scripts as implementation truth.

## Architecture

- The external Orchestrator owns workflow decisions. AgentMesh exposes MCP tools and manages role resolution, execution, sessions, and normalized handoffs.
- The top-level CLI is for server, configuration, availability, and session management. Direct execution remains under `agentmesh debug`.
- `sessionId` continues one Bridge Session and must preserve its Agent, role, and working-directory binding.
- `contextSessionId` shares normalized history across sessions. It must not impersonate or merge native vendor sessions.
- Worker, Reviewer, and Tester are execution roles. The project `orchestrator` assignment is metadata, not a fourth executable role.
- Keep MCP input schemas, runner parameter types, README tool documentation, and protocol tests synchronized.

## Agent adapters

- Preserve the vendor CLI or MCP contract exactly. Verify arguments against the installed CLI before changing them.
- Treat process exit status and structured semantic status as separate signals; either may indicate failure.
- Keep vendor logs separate from `finalAnswer`, and persist native session identifiers only when positively identified.
- Reviewer safety is runtime behavior, not a role label. Never describe `prompt-only` protection as a sandbox.
- Keep Windows `.cmd` execution, quoting, PATH lookup, and sandbox differences covered by tests.
- Never require real vendor credentials or consume Agent quota in the default test or CI workflow.

## TypeScript and imports

- Keep strict TypeScript and typed ESLint checks passing.
- Use relative NodeNext imports with explicit `.js` suffixes. Do not introduce `@/` aliases into the published Node library.
- Use `import type` when an import is type-only. Import Zod as a runtime value when constructing schemas.
- Do not weaken compiler, lint, or coverage settings to make a change pass without addressing the underlying issue.

## Environment and security

- Environment access belongs at process and adapter boundaries. System variables such as `PATH`, `PATHEXT`, `ComSpec`, and `LOCALAPPDATA` are legitimate platform inputs.
- Keep Agent binary overrides explicit and documented. Never log credentials, tokens, or the full environment.
- Pass task-scoped environment overrides through execution options rather than mutating global process state outside tests.
- Preserve Reviewer read-only enforcement and report platform fallbacks honestly.

## Documentation and project knowledge

- Read `README.md` before changing architecture, role configuration, MCP tools, CLI behavior, session semantics, or operational procedures.
- Update README in the same change when public behavior, parameters, compatibility, or safety boundaries change.
- Record significant, reusable development problems in Chinese in `PROBLEMS.md`.
- Each problem entry must contain exactly: `问题`, `根因`, `解决方法`, and `状态`.
- Do not record trivial formatting changes, temporary debugging artifacts, transient session IDs, or facts clearer from nearby code.
- Treat historical findings as context only; verify current behavior before relying on them.

## Formatting and linting

- Prettier owns formatting; ESLint owns code quality. Do not add competing stylistic rules.
- Use `npm run format` to update formatting and `npm run format:check` for read-only verification.
- Use `npm run lint` and `npm run lint:fix`; do not manually fight formatter output.
- Avoid unrelated reformatting after the repository formatting baseline.

## Tests

- `tests/**/*.test.ts` contains fast unit and in-process protocol tests.
- `tests/**/*.integ.ts` contains real process-boundary integration tests using local fake executables.
- Keep real paid/authenticated Agent calls opt-in and outside default CI.
- Prefer behavioral assertions over implementation-detail mocks. Mock only external or nondeterministic boundaries.
- Add regression coverage for every fixed parsing, session, permission, platform, or error-propagation defect.
- Keep the package installation smoke test passing whenever exports, bins, build output, or package metadata change.
- Preserve meaningful coverage thresholds; test deletion must not remove security, protocol, concurrency, or platform guarantees.

## Commands

- `npm run dev`: watch the build.
- `npm run build`: create ESM, CJS, CLI, and declaration output.
- `npm run format` / `npm run format:check`: write or verify formatting.
- `npm run lint` / `npm run lint:fix`: verify or fix lint findings.
- `npm run typecheck`: run strict TypeScript checks.
- `npm test`: run unit and in-process protocol tests.
- `npm run test:coverage`: run unit tests with coverage thresholds.
- `npm run test:integration`: run fake-CLI process integration tests.
- `npm run test:package`: build, pack, install, and smoke-test the published artifact.
- `npm run check`: run the complete local/CI quality gate.

## Releases and compatibility

- `package.json` is the only version source. Do not hardcode the package version elsewhere.
- Treat exported TypeScript symbols, MCP tool names and schemas, CLI commands, config schema, and persisted Session shape as compatibility surfaces.
- Use SemVer. Document breaking changes and do not move an already published version tag.
- Verify package contents and installation before publishing. Never include sessions, credentials, source-only fixtures, coverage, or local machine state.

## Git commits

- Use Conventional Commits: `type: short specific summary`.
- Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Add a `BREAKING CHANGE:` footer when compatibility is intentionally broken.
- Do not bypass formatting, lint, type, test, or package failures to create a commit.
