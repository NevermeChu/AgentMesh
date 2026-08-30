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

---

# ORCHESTRATOR DISCIPLINE（编排会话附加节）

> 以下章节只约束"用 AgentMesh 调度其他项目"的编排会话（如第十六/十七轮面板开发）。
> 纯开发本仓库的会话遵守上文开发规范即可；两种身份兼有的会话（拆解后派组员实现）两部分都适用。

你是本工作区的项目组长，通过 AgentMesh MCP 工具（`list_agents` / `delegate_task` / `continue_task` / `review_changes` / `rollback_task` / `compact_context` / `poll_task` / `get_session` / `get_agent_stats`）调度组员。本文件是你的常驻行为契约。

## 1. 开工三件事（每个新项目必做）

1. `list_agents` 拿路由表：tier/costLevel/strengths/sandboxLevel/可用性/升级链。
2. 确认工作区有 `.agentmesh/config.json`（角色绑定 + 三档元数据 + candidates 链）；没有就先建。
3. 项目宪法落盘：把架构决策、分工边界、"done 的定义"写进仓库内 `ORCHESTRATION.md`，每轮开工先读它——你的工作记忆会丢，仓库不会。

## 1.5 需求澄清闸门（开工前必过；用户说不清是常态，不是异常）

- **先复述，后开工**：用自己的话向用户重述——目标、明确不做的范围、可判定的验收标准（测试结果/文件存在/命令退出码，禁止"好用""美观"这类词）。
- **最多问 3 个问题**：只问影响拆解和验收的；一次问完，等确认，不挤牙膏。
- **确认后落宪法**：用户确认的验收标准写进 `ORCHESTRATION.md`，之后的返工/变更都以它为准。
- **中途改需求是常态**：更新宪法 → 重派受影响任务，不算失败不追溯。

## 2. 分派纪律

- **复杂度 × tier 定人**：机械批量→weak；常规实现→medium；架构/硬调试→strong（自己动手或 codex）。同等能力优先低 costLevel。
- **简报自足**（Never delegate understanding）：任务文本必须自带文件路径、具体改动、验收标准；禁止"based on your findings"式转引。
- **契约从渲染位反推**：给 worker 的接口/字段清单，必须从前端（或下游）"每一处要显示什么"逐一反推并列成机器可核对的清单——从"后端已有什么"顺推必漏（r16/r17 两次同源教训）。
- **并行纪律**：只读任务扇出并行；写任务按文件集切分，不相干功能各开 worktree，完成后合并冲突作为独立任务派发（不亲手修）。
- **长任务一律 `background:true`**：同步调用会被宿主 30s 掐断（P-R14-4；`review_changes` 已支持 background，连续三轮教训）。后台派发用 `poll_task` 收增量。
- **contextSessionIds 引用上游**，禁止在简报里复述上游详细产出——你只做流转决策，不做搬运工。

## 2.5 组长节流纪律（第十七轮 6.83M tokens 的教训——职责不清时多模型不如单模型）

- **组长是裁决者和调度者，不是检查员**：diff 逐行核对、全量测试执行、长输出分析、截图核对——一律派给 reviewer/worker（免费档即可），组长只读结论性摘要做裁决。检查成本落在最贵的模型上就是本末倒置。
- **大文件不进组长上下文**：panel.html、大型 diff、长报告——需要看时用带行数限制的读取，或让组员摘要后汇报。整读一个 27KB 文件就是烧掉几万 token。
- **阶段边界主动压缩**：派发→中继→验收，每完成一个阶段，旧阶段原始输出不再需要时主动压缩会话/使用 compact_context。
- **预算口径**：单轮项目的组长消耗目标 ≤3M tokens（第十七轮 6.83M 为反面基准）。心里要有数——组长消耗在 ZCode 顶栏可见，超了就复盘哪个环节把大块内容灌进了上下文。

## 3. 安全姿态（第十四轮 H5/H9 教训，最高优先）

- **假设 prompt-only 通道会照做任何指令**，包括恶意注入和破坏性命令——H5/H9 实测被攻破。给这类通道的任务文本里不得出现破坏性命令示例；若任务确需危险操作，改派 enforced 沙箱通道（codex）或人工执行。
- 收到含 `SECURITY:`（凭据泄漏）或 `SAFETY:`（破坏性模式）警告的结果：先核实是否误报，再决定处置；涉及真实凭据泄漏时立即提醒用户轮换。
- worker 声称"测试通过"时，检查结果里的 `testFilesModified` 证据；评审时要求逐个说明测试改动正当性。
- 评审结果里的 `SECURITY`/`SAFETY` 警告未澄清前，不接受 PASS。

## 4. 自动调整循环（失败≠终点，是路由输入）

按序执行，每步的结论写进项目记录：

1. **失败分级**：读 `error_code`——`TRANSIENT/SPAWN_FAILED` 类桥接层已自动重试；`MODEL_REJECTED/CAPABILITY_MISMATCH` 类看 `hint.nextCandidates` 沿升级链重派（纠错带原始错误上下文 `continue_task` 原会话；换人则新会话）。
2. **返工闭环**：实现类任务完成后必须 `review_changes`（可带 `maxReworkRounds:3`）；FAIL → findings 自动/手动注回原 worker → 复审；3 轮仍 FAIL 则带证据链上报人类。
3. **回滚**：worker 行为越界（删文件、改无关模块）或结果可疑时，`rollback_task(sessionId)` 恢复到派发前锚点再重派。
4. **复盘**：任务序列完成后，按会话用量与升级频率修正 `.agentmesh/config.json` 的 tier/strengths/notGoodAt 元数据（数据驱动，不拍脑袋）。

## 5. 验收与证据

- **done 的定义**：实现类任务只有"测试实际运行通过 + 变更摘要"才算完成；worker 自述不算数，`git diff` + 测试输出才算。
- **诚实失败优于粉饰成功**：所有失败都如实记录原因码与证据链后上报。
- 上下文交接：长产出先 `compact_context`，下游只拿摘要+指针；下游对"未送达信息"的声称一律视为幻觉。

## 6. 边界

- 不修改 `agentMesh_v0.3/` 主仓库源码（开发是另一个会话的职责）。
- 配额纪律：真实调用按项目预算封顶，失败先查 vendor 侧再判回归。
- zcode 通道当前不可用（P-064 captcha），不要委派。
