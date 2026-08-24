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
- Vendor model/reasoning configuration must be adapter-specific and backed by `.agentmesh/capabilities.json`; never spread generic options into a strict vendor MCP schema.
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

## Explicit real-test orchestration

仅当用户明确要求“真实测试”“真实调用 MCP”或等价表述时，才执行本节流程；不得因普通代码测试、单元测试或集成测试请求而自动消耗真实 Agent 配额。真实测试必须使用隔离的临时 Git 工作区，避免修改本项目源码、会话、凭据或默认测试/CI 状态；任务完成后保留可复核的测试产物和失败证据，但不要记录凭据、完整环境变量或无关的持久化会话内容。

### 固定角色与会话

- Orchestrator 由当前主 Agent 承担，负责设计复杂但边界清晰的小任务、拆分阶段、决定交接顺序和综合结论。
- Worker 固定使用 `codex`，角色为 `worker`。
- Reviewer 固定使用 `opencode`，角色为 `reviewer`；必须使用独立的 Bridge Session，不得复用 Worker 的 `sessionId` 或 native session。
- Tester 固定使用 `antigravity`，角色为 `tester`；不得继续 Reviewer 会话，不得将 Reviewer 会话伪装成 Tester 会话。Tester 应优先接收 Worker 与 Reviewer 的规范化上下文，并独立运行验证。
- 通过 AgentMesh MCP 工具调用，不绕过 MCP 直接拼接 vendor CLI 作为主流程。通常使用 `delegate_task`、`review_changes`、`continue_task`、`get_session`；需要多源交接时优先使用 `contextSessionIds`，而不是把上游原文手工粘贴进下游 task。

### 任务设计与执行要求

- 选择需要真实实现、独立评审和测试验证的复杂小任务，例如多模块功能、边界条件、错误处理、权限/安全约束或修复闭环；任务必须包含明确验收标准、至少一个容易出错的边界和可重复的验证命令。正式调用前先检查 SPEC 的示例与文字规则是否一致；发现歧义时，Orchestrator 必须在 task 中明确优先规则、记录决议，并要求 Worker、Reviewer、Tester 使用同一决议，不得各自猜测。
- Worker 负责实现并自检，但不得替 Reviewer 或 Tester 完成其职责；Reviewer 默认只读，必须报告实际的 sandbox 机制和任何平台降级；Tester 不得修改生产源码，若发现缺陷应报告并通过 `continue_task` 让 Worker 修复，再复测。
- 为每次交接记录发送的 `contextSessionIds`、目标 cwd、传输方式、session ID、状态、`finalAnswer`/summary/findings 是否持久化，以及 Session history 中实际记录的 `contextSources`。不得仅根据 agent 自述“已复用上下文”就认定交接成功。
- 真实测试发生超时、取消、vendor 诊断、部分成功或 transport fallback 时，保留 MCP 返回、Session history、exit code、duration 和执行证据；区分“业务失败”“vendor 辅助 stderr”“客户端取消”“AgentMesh 超时”和“Reviewer FAIL/UNKNOWN”。

### 交接质量分析与回答格式

真实测试完成后，必须回答以下问题，并把结论与证据写入项目根目录的 `real_test.md`（如文件已存在则追加，不得覆盖历史记录）：

1. **小任务是在做什么**：说明业务目标、输入输出、验收标准、Worker/Reviewer/Tester 各自负责的阶段。
2. **上下文是否损失及程度**：逐条比较上游 Session 的规范化 history 与下游实际注入内容；分别说明 task、summary、finalAnswer、findings、repository evidence、freshness 和 `contextSources` 是否保留。使用“无损、轻微截断、部分损失、严重损失、完全丢失”等明确等级，并说明能否有效传递信息。
3. **是否重复做无意义操作**：区分必要的独立复核、因 `STALE/UNKNOWN` 触发的合理重验、因上下文缺失导致的被迫重复，以及真正的无效重复检索/重试；引用步骤、耗时或命令证据，不凭主观印象判断。
4. **暴露的问题**：按问题、根因、影响、证据、建议修复记录 AgentMesh、vendor、平台和任务设计问题；不要把 vendor/platform 限制描述成 AgentMesh 已修复。
5. **资源与清理**：若进行了资源监控，记录采样方法、CPU、内存/RSS、进程树、超时/取消、vendor fallback、孤儿进程和监控局限；明确说明是否发现异常，不能把未采集的指标填成零。

最终回答先给结论，再给每个角色的交接和重复操作分析，最后列出问题与资源异常；必须如实报告失败、跳过、fallback、信息截断和测试未覆盖项。
