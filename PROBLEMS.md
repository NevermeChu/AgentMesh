# AgentMesh 有价值问题与解决方法

本文档根据 `v0.1.0` 开发会话中的代码审查、修复过程和真实多 Agent 调用重新整理。只记录本次会话中实际发现、实际复现或已经明确确认的问题；每项统一使用“问题、根因、解决方法、状态”四段结构。

## P-001 Orchestrator 与 AgentMesh CLI 的职责不清

**问题**：原来的使用方式容易让人认为必须通过 `agentmesh run` 手动启动工作流，也不清楚 Orchestrator 是否应该直接调用 Worker、Reviewer 和 Tester。

**根因**：CLI 同时承担管理入口和直接任务执行入口，文档也没有明确区分“谁决定工作流”和“谁负责启动底层 Agent”。

**解决方法**：采用 Orchestrator-first 设计。Orchestrator 通过 AgentMesh MCP Tools 决定任务拆分和调用顺序；AgentMesh 负责角色解析、会话、上下文交接和按需启动底层 CLI；顶层 CLI 只负责 MCP Server、配置、Agent 可用性和 Session 管理，直接执行命令移入 `agentmesh debug`。

**状态**：已解决。CLI 帮助信息、README 和真实 MCP 调用均按该职责边界运行；不需要预先手动开启所有底层 CLI。

## P-002 角色无法按项目自由分配

**问题**：Worker、Reviewer 和 Tester 原本需要在每次调用时显式指定 Agent，无法让同一个 Agent 承担多个角色，也不方便让同一 Agent 的不同会话分别承担不同角色。

**根因**：角色只是单次调用参数，没有项目级角色到 Agent 的配置解析层。

**解决方法**：增加项目级 `.agentmesh/config.json`，支持分别配置 Orchestrator、Worker、Reviewer 和 Tester；角色可以指向同一个 Agent，也可以指向不同 Agent；每次新任务仍创建独立 Bridge Session；显式 MCP `agent` 参数覆盖项目配置。

**状态**：已解决。配置解析测试通过；真实测试在没有显式传入 Agent 的情况下，成功解析出 Codex Worker、Antigravity Reviewer 和 Antigravity Tester。

## P-003 CLI 结构化输出没有被可靠解析

**问题**：底层 CLI 的 JSON 或 JSONL 输出可能被当作普通文本，导致最终回答、错误状态和原生 Session ID 提取不准确。

**根因**：不同 CLI 的事件格式不同，通用的标准输出处理无法区分过程事件、最终回答、会话标识和语义错误。

**解决方法**：分别为 Codex、Claude、OpenCode 和 Antigravity 增加结构化输出解析，将 `nativeSessionId`、`finalAnswer` 和错误状态归一化到 AgentMesh 的结果及 Bridge Session 中。

**状态**：已解决。适配器解析测试通过；真实 Codex 和 Antigravity 调用都成功提取了原生 Session ID 和完整最终回答。

## P-004 Bridge Session 可能被错误复用

**问题**：不存在的 Session ID、不同 Agent、不同工作目录或不同角色之间如果直接复用会话，可能造成原生会话串线和上下文污染。

**根因**：Bridge Session 与 Agent、`cwd`、角色之间缺少严格绑定，跨 Agent 交接和继续同一原生会话也没有被区分。

**解决方法**：不存在的 Session ID 立即返回失败；继续会话时校验 Agent、工作目录和角色；继续同一 Agent 会话使用 `sessionId`，跨角色或跨 Agent 共享结果使用独立的 `contextSessionId`，不复用对方的原生会话。

**状态**：已解决。Runner 测试覆盖不存在会话和绑定不一致；真实 Worker、Reviewer、Tester 分别拥有独立 Bridge Session 和原生 Session。

## P-005 跨角色上下文不足导致重复检查

**问题**：Reviewer 和 Tester 如果只收到新任务描述，就会重复 Worker 已完成的文件定位、失败命令尝试和实现分析，增加耗时与额度消耗。

**根因**：不同 Agent 的原生会话不能直接共享，AgentMesh 之前也没有生成适合跨 Agent 传递的规范化历史。

**解决方法**：通过 `contextSessionId` 将前序会话最近若干轮的 task、summary、`finalAnswer` 和 findings 注入新会话，并明确要求后续角色复用仍然有效的结果，在仓库状态变化或证据冲突时再重新验证。

**状态**：受限可用。真实测试中 Reviewer 没有重试 Worker 已确认会失败的命令；Tester 复用了 Reviewer 的静态结论，没有再次审查源码。但当前上下文缺少 commit、diff、文件和命令结果的版本指纹，Reviewer 仍需重新读取关键文件并重跑关键测试。

## P-006 Reviewer 的只读要求不能只依赖提示词

**问题**：仅把任务角色标记为 Reviewer，不能保证底层 Agent 不修改文件。

**根因**：角色和提示词是语义约束，不是操作系统或 CLI 运行时权限；不同 Agent 的沙箱能力也不一致。

**解决方法**：为适配器声明真实的沙箱机制；Codex Reviewer 使用原生只读沙箱，Codex Worker 使用工作区写入沙箱；无法强制只读的适配器明确标记为 `prompt-only`，避免把提示词约束描述成安全边界。

**状态**：受限可用。Codex 的 Worker/Reviewer 权限已经按角色强制区分；真实 Reviewer 调用前后工作树没有变化。Antigravity 在 Windows 上仍有 P-010 所述限制。

## P-007 进程退出码为 0 时仍可能发生语义失败

**问题**：真实 Codex Worker 的补丁被只读沙箱拒绝，但 CLI 以退出码 0 结束，AgentMesh 最初把任务错误地标记为成功。Reviewer 输出 `FAIL` 时也存在同类风险。

**根因**：成功判定只检查进程退出码，没有同时检查结构化错误事件、标准错误中的语义错误和 Reviewer 的明确结论。

**解决方法**：解析 CLI 结构化状态和错误事件；Codex 在没有有效最终回答时检查标准错误；Reviewer 必须得到可解析的 `PASS`，`FAIL` 或无法解析的结论均按失败传播。

**状态**：已解决。单元测试覆盖退出码为 0 的语义错误；真实补丁拒绝被正确识别为失败，修复权限后同一任务才被报告成功。

## P-008 Codex Worker 默认只读，无法完成实现任务

**问题**：真实 Codex Worker 首次执行异步缓存任务时不能写入源码。

**根因**：Codex Worker 调用没有显式设置写入沙箱，继承了只读执行环境。

**解决方法**：Codex Worker 和 Worker 的继续会话显式设置 `sandbox_mode="workspace-write"`；Reviewer 继续使用 `sandbox_mode="read-only"`。

**状态**：已解决。修复后 Codex Worker 成功完成异步 TTL Cache，实现了并发合并、完成时 TTL、失败重试和清除 in-flight 防回填，并通过 5 个行为测试。

## P-009 Antigravity 无人值守调用停在权限确认

**问题**：真实 Antigravity Reviewer 在执行 `git status` 前返回 `user denied permission`，无法开始审查。

**根因**：AgentMesh 通过 MCP stdio 无人值守启动 Antigravity，没有用户可以响应 CLI 的交互式权限确认。

**解决方法**：无人值守 Antigravity 调用显式跳过交互式批准；Reviewer 使用 `plan` 模式，Worker 使用 `accept-edits` 模式，使执行意图仍与角色对应。

**状态**：已解决。真实 Reviewer 随后可以读取 diff、执行 Git 检查和运行测试；独立 Tester 会话也成功完成标准测试。

## P-010 Antigravity Windows 原生沙箱初始化失败

**问题**：在 Windows 上启用 Antigravity 原生沙箱后，真实 Reviewer 在审查开始前因无法授予受保护 Go 工具链目录访问权而失败。

**根因**：Antigravity 原生沙箱初始化会扫描或授权本机工具链路径，其中存在当前进程不能访问的受保护目录；调整 PATH 和 GOPATH 不能阻止该初始化行为。

**解决方法**：非 Windows 保留 Antigravity 原生沙箱；Windows 暂时省略原生沙箱并明确标记为 `prompt-only`，Reviewer 继续使用 `plan` 模式，同时由 Orchestrator 检查调用前后的工作树状态。后续应支持沙箱目录白名单，或在临时 worktree/独立受限进程中执行审查。

**状态**：受限可用。真实 Reviewer 和 Tester 已走通，但 Windows Reviewer 目前不是操作系统级强制只读。

## P-011 Agent 执行超时不能延长 MCP 请求超时

**问题**：角色配置已设置 `timeoutMs: 300000`，真实 Codex Worker 仍在约 60 秒被外层 MCP 请求取消。

**根因**：AgentMesh 的 `timeoutMs` 只控制底层 Agent 子进程；MCP SDK 的 request timeout 属于 Orchestrator 客户端，两者是独立的超时层级。

**解决方法**：当前由 Orchestrator 在 `callTool` 时显式设置大于 Agent 超时的请求超时。后续应提供统一的超时配置说明，并考虑 MCP Progress 或异步任务句柄，避免长任务长期占用同步请求。

**状态**：受限可用。将 MCP 请求超时提高到 360 秒后，约 169 秒的真实 Worker 调用成功完成；AgentMesh 目前无法替外部 Orchestrator 修改其客户端超时。

## P-012 Codex 短摘要可能选中过程消息

**问题**：真实 Worker 的完整 `finalAnswer` 正确，但短 summary 出现了 `Reading additional input from stdin...` 一类过程文本。

**根因**：摘要生成仍可能使用通用输出片段，没有只从最终 `agent_message` 或明确完成事件中取值，也没有过滤已知进度消息。

**解决方法**：当前在 MCP 结果和跨角色上下文中保留完整 `finalAnswer`，不依赖短 summary 作关键判断；后续应从最后一个有效 Agent 消息生成摘要并过滤过程事件。

**状态**：待解决。不阻塞任务交接和结果判断，但影响 Session 列表及快速诊断的可读性。

## P-013 Session 历史只能查询，不能主动通知

**问题**：`get_session` 和 CLI session 命令可以查询执行历史，但 Reviewer 失败或持久化异常不会主动通知外部系统。

**根因**：当前 Session 能力是持久化和按需查询，没有事件订阅、webhook 或通知通道；工作流是否继续仍由 Orchestrator 检查工具结果后决定。

**解决方法**：当前将失败作为 MCP 错误结果传播，并要求 Orchestrator 检查每次调用状态；Session 保存结构化历史供事后追溯。需要长期无人值守工作流时，再增加可选事件订阅、webhook 或结构化审计输出。

**状态**：待解决。同步编排链路可以正确获知失败，但尚不具备主动告警能力。

## P-014 真实测试中的命令在不同沙箱下表现不一致

**问题**：测试项目的标准 `npm test` 在 Codex Worker 沙箱中因创建子进程返回 `spawn EPERM`，但同一测试在 Antigravity Tester 中可以正常执行。

**根因**：不同底层 Agent 的沙箱和子进程策略不同；测试命令本身会再创建 Node 子进程，因此能读取和写入工作区不代表一定能启动测试子进程。

**解决方法**：Worker 在受限环境中使用不再派生隔离子进程的针对性 Node 测试命令，并把限制及替代命令写入交接上下文；Tester 在自身环境中仍执行项目标准 `npm test`，确保最终验证没有用替代命令掩盖正式测试入口问题。

**状态**：已解决。本次任务中 Worker 的 5 个针对性测试和 Tester 的标准 `npm test` 都通过；该经验仍需在以后跨沙箱测试中复用。

## P-015 本机 Node 版本与发布产物目标版本混淆

**问题**：本机运行 Node.js 24，但构建配置仍显示 `node18`，容易被理解为项目实际使用 Node.js 18 构建，也没有明确的受支持运行时范围。

**根因**：`tsup` 的 target 描述发布产物兼容的最低运行时，并不选择本机 Node.js；项目此前没有用 `engines`、CI 矩阵和文档共同声明运行时基线。

**解决方法**：将最低运行时统一为 Node.js 22.13，`tsup` target 调整为 `node22`，`package.json` 声明 `engines` 和 npm 版本，并在 CI 中同时验证 Node.js 22 与 24。

**状态**：已解决。本机 Node.js 24、Node.js 22 发布目标和 CI 支持矩阵的职责已明确分离。

## P-016 依赖来源、安装脚本和易受攻击传递依赖缺少约束

**问题**：lockfile 曾包含镜像站下载地址，传递依赖 `esbuild` 命中安全公告，依赖安装脚本也没有显式审查边界。

**根因**：用户级 npm registry 泄漏到 lockfile；构建工具的宽松传递依赖范围解析到存在问题的版本；npm 默认只提示而不阻止未经批准的 install script。

**解决方法**：项目级固定 npm 官方 registry 并重建 lockfile；将 `esbuild` 0.28.2 设为精确直接开发依赖并保留 override；启用 `strict-allow-scripts`，只批准精确版本的 `esbuild` 与 `fsevents`；增加 Dependabot 和定期审计。

**状态**：已解决。干净 `npm ci` 在严格脚本策略下通过，lockfile 使用官方 registry 且包含 integrity，`npm audit` 报告 0 个漏洞。

## P-017 会话锁清理异常可能覆盖真正的执行失败

**问题**：会话读写操作失败后，如果锁文件清理同时失败，调用方可能只看到清理异常而丢失最先发生的业务或持久化错误。

**根因**：锁释放逻辑在 `finally` 中直接抛错；JavaScript 会用 `finally` 的异常覆盖 `try` 中原有的异常。

**解决方法**：分别捕获操作结果和清理错误，优先传播原始操作异常，仅在操作成功时报告清理失败；所有重新包装的错误保留 `cause`。

**状态**：已解决。类型感知 ESLint 已将 `no-unsafe-finally` 和错误链保留纳入持续门禁，会话单元测试通过。
