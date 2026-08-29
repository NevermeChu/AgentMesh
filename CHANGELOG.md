# Changelog

AgentMesh follows [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **P5 unattended closed loop (T5.1-T5.5):**
  - Bounded rework loop on `review_changes` (`maxReworkRounds`, 0-3, default 0 = v0.1 behavior): a FAIL verdict injects the machine-parsed structured findings into the original worker session via `continue_task` (explicit `workerSessionId`, or the single worker-role context session; never guessed when ambiguous), then a fresh reviewer re-reviews, with the full per-round evidence chain returned as `result.rework`. The review prompt now carries a P0-P3 rubric (mapped onto the existing severity parsing: P0→critical, P1→high, P2→medium, P3→low; any P0/P1 forces FAIL) whenever the strict review contract is declared.
  - Checkpoint artifacts (T5.2): failed, cancelled, and watchdog-terminated background dispatches spill the captured output tail (≤32k chars) to `<agentmeshHome>/checkpoints/` with reason and usage. `continue_task` accepts `fromCheckpoint` to inject the salvaged partial output at the head of the continuation; checkpoints are one-shot recovery batons (consumed tombstone written fail-closed before success; a second consumption or an unknown id is rejected structurally).
  - Stalled watchdog second stage (T5.3): a background task silent for 30 minutes past its `stalled` notification is auto-terminated through its abort controller after the checkpoint is spilled, with the termination reason recorded in the terminal result. The startup orphan sweep now classifies before acting: dead-owner records are reaped, finished tasks are released, and unfinished registrations owned by a foreign live bridge are left untouched inside a 24h GC grace period (evictAfter-style) and reaped once the grace expires.
  - Budget water-level gate (T5.4): optional `budget: { perSessionTokenCap, onExceed: "warn" | "rejectNew" }` in `.agentmesh/config.json`. Session usage accumulates from vendor-reported usage now persisted on every history entry (completing T2.1 metering storage). At/above 80% responses carry a warning; at the cap under `rejectNew` new dispatches fail fast with `BUDGET_EXHAUSTED` plus an actionable hint, while in-flight work and polling are untouched. Rejected dispatches never register an idempotency key.
  - T5.5 design-only document: `docs/design/completion-notify-hook.md` (codex `notify` completion-aware channel reserved for the future long-lived mode; intentionally not implemented).
- Typed ESLint, deterministic formatting, coverage thresholds, process integration tests, and published-package smoke tests.
- Node.js 22 and 24 CI coverage, dependency update automation, and npm provenance metadata.
- Content-sensitive repository evidence and MCP progress notifications for reliable cross-role handoffs.
- Configurable Reviewer safety policy, protection reporting, and working-tree mutation detection.
- Default run timeout (`DEFAULT_RUN_TIMEOUT_MS`, 10 minutes) wired through `RunnerOptions.defaultTimeoutMs` and `sessionStoragePath`, so unconfigured CLI executions can no longer hang forever.
- Quarantining of corrupt session storage: an invalid `sessions.json` is renamed to `*.corrupt-<timestamp>` and replaced with an empty state instead of failing every command.
- End-to-end cancellation: MCP client timeouts, cancellations, and disconnects now abort the underlying agent process tree (`AbortSignal` threaded from tool handlers through the runner, adapters, executor, and MCP client), record the turn as failed history with full evidence, and never trigger the auto CLI fallback. `ExecutionResult` gains an optional `aborted` flag.
- MCP tool responses include a bounded `Raw Output` section (8000 chars) with vendor CLI stdout/stderr so remote failures remain diagnosable.
- Multi-source context injection: `contextSessionIds` (up to 4) on `delegate_task`, `review_changes`, and `continue_task` injects several sessions' normalized history first-hand with per-source `MATCHED`/`STALE`/`UNKNOWN` freshness, a global 24k character budget with explicit `[truncated]` markers, and a `contextSources` record on each history entry. `continue_task` now accepts context sources alongside the session's own native resume, and an explicit context source no longer suppresses the target session's own bridge history when it has no native session to resume.
- Session storage retention caps: at most 50 history turns per session and 200 sessions (LRU eviction), configurable via `SessionManagerOptions` (`0` disables a cap), so every history append no longer rewrites an unboundedly growing JSON file.
- POSIX process-group termination: agents spawn detached into their own process group so timeout/cancel signals reach vendor-forked background children; group SIGTERM escalates to SIGKILL with a root-process fallback.
- Shared-context attribution guidance: receivers are instructed to cite source session IDs they actually relied on and never claim reuse of information absent from the injected context.
- Graceful server-shutdown cancellation audit: stdio close, SIGINT, and SIGTERM abort in-flight executions through a runner-level controller registry (`abortAllInFlight`), wait (event-driven with a 10s cap) for each aborted run to record its terminal failed turn via the existing turn-recording pipeline, and only then close. A new `client_disconnect` cancel reason distinguishes disconnects from request-level cancels; SIGKILL-style termination remains a documented residual boundary.
- Pre-flight capability diagnostics: `delegateTask`/`continueTask` evaluate requested model/reasoning options against the predicted transport before dispatching (never blocking), merged with post-execution diagnostics under de-duplication; a conservative vendor-refusal classifier emits a structured diagnostic when an error text pairs the requested model id with 4xx/unsupported-model signals.
- codex MCP sandbox mitigation surfaced structurally: the built-in capability matrix carries operational notes for the codex MCP transport (transport-level `notes` field), and results whose MCP output matches the `spawn EPERM` signature automatically receive a warning pointing at the documented mitigation.
- Antigravity artifact-path detection: outputs matching the vendor's "not a valid artifact path" restriction attach a warning that claimed artifacts may be missing from the workspace, on both success and fatal-failure paths.

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
- Review verdict parsing trusts bare PASS/FAIL prefixes only near the top of reviewer output; deeper lines must be standalone words or carry a labeled form (`Verdict:`, `Status:`, ...) so quoted diff/test text cannot flip the outcome.
- Consolidated context-source validation, turn recording, and reviewer safety resolution shared by `delegateTask`/`continueTask`; reviewer continuations now fall back to the project config `roles.reviewer.safety` when the session metadata does not pin one.
- Reviewer-role replies outside the strict review contract are no longer fail-closed: an internal `reviewVerdictRequired` flag (set only by `review_changes`) keeps unparseable-verdict reviews failing closed, while general `delegate_task` reviewer-role conversations with a substantive answer now succeed with `reviewOutcome=UNKNOWN` and an explanatory warning; empty or garbage output still fails and explicit FAIL verdicts fail on every entry point.
- Auto-mode transport fallbacks are no longer silent: results carry structured `transportFallback` evidence (`from`/`to`/original error) plus a warning, persisted in session history.
- Validation errors aggregate instead of masking: when both a context-source problem and a role-resolution problem exist, `delegate_task` returns a single combined message; single-cause failures keep the precise reporting.

### Fixed

- Shell-injected `PWD`/`OLDPWD` are no longer inherited by spawned agents; vendor CLIs that trust `PWD` over the spawned cwd (observed with OpenCode) previously operated on the wrong repository.
- MCP `delegate_task` / `continue_task` mark inherited reviewer `FAIL` verdicts as tool errors.
- Explicit `shell: false` resolves Windows npm shims exactly like the default path, and signal-terminated processes report `128 + signum` exit codes.
- A child process exiting before draining stdin no longer crashes the AgentMesh server with an unhandled EPIPE error event on its stdin stream.
- The executor hard-settle fallback no longer fabricates exit code `124` for non-timeout terminations; unobservable exit codes are reported as absent.
- Codex CLI runs keep a substantive final answer when a trailing structured vendor error (e.g. teardown-time `context canceled`) arrives alongside a clean exit code, surfacing the error as a `warning` instead of failing the turn.

### Security

- Pinned the transitive `esbuild` resolution to a non-vulnerable release and normalized the lockfile to the official npm registry.
- Removed `cmd.exe` interpolation from supported Windows npm CLI shims and rejected unrecognized batch launchers.

## 0.1.0 - 2026-08-20

- Published the first usable AgentMesh release with MCP orchestration, role configuration, adapter execution, and Bridge Session context transfer.
