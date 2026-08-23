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

**解决方法**：通过 `contextSessionId` 将前序会话最近若干轮的 task、summary、`finalAnswer` 和 findings 注入新会话；每轮同时记录执行前后的 Git HEAD、工作树内容指纹、变更文件、传输方式、退出码和耗时。交接时比较当前状态与来源会话最后状态，生成 `MATCHED`、`STALE` 或 `UNKNOWN` 新鲜度结论，只在匹配时直接复用结果。

**状态**：已解决。测试覆盖未变化仓库的 `MATCHED` 交接和文件变化后的 `STALE` 交接；旧 Session 保持兼容并在缺少证据时明确标记为 `UNKNOWN`。

## P-006 Reviewer 的只读要求不能只依赖提示词

**问题**：仅把任务角色标记为 Reviewer，不能保证底层 Agent 不修改文件。

**根因**：角色和提示词是语义约束，不是操作系统或 CLI 运行时权限；不同 Agent 的沙箱能力也不一致。

**解决方法**：为适配器声明真实的沙箱机制；Codex Reviewer 使用原生只读沙箱，Claude 使用读取工具白名单，OpenCode Reviewer 使用 `plan` Agent，无法强制只读的适配器明确标记为 `prompt-only`。项目配置支持默认的 `best-effort` 和可选的 `enforced`；后者拒绝 prompt-only Reviewer。所有 Reviewer 禁止额外 CLI 参数，并比较执行前后的仓库指纹，检测到变化时返回 `FAIL` 且不自动回滚。

**状态**：受限可用。原生沙箱和工具过滤可以强制执行；`best-effort` 允许 Windows Antigravity 等 prompt-only Agent 并明确警告和检测误写，但仍不等同于操作系统级只读。需要严格边界时可配置 `enforced` 或使用 Codex Reviewer。

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

**解决方法**：非 Windows 保留 Antigravity 原生沙箱；Windows 暂时省略原生沙箱并明确标记为 `prompt-only`，Reviewer 继续使用 `plan` 模式。Runner 自动检查调用前后的工作树内容指纹，误写时将 Review 标记为失败；配置 `safety: enforced` 可以直接拒绝该平台上的 Antigravity Reviewer。

**状态**：受限可用。真实 Reviewer 和 Tester 已走通，误写可以检测和阻断后续编排，但 Windows Reviewer 目前仍不是操作系统级强制只读。

## P-011 Agent 执行超时不能延长 MCP 请求超时

**问题**：角色配置已设置 `timeoutMs: 300000`，真实 Codex Worker 仍在约 60 秒被外层 MCP 请求取消。

**根因**：AgentMesh 的 `timeoutMs` 只控制底层 Agent 子进程；MCP SDK 的 request timeout 属于 Orchestrator 客户端，两者是独立的超时层级。

**解决方法**：AgentMesh 在任务开始、每 15 秒和完成时发送标准 MCP Progress 通知；MCP 客户端注册 `onprogress` 并启用 `resetTimeoutOnProgress`，同时以 `maxTotalTimeout` 保留总时间上限。底层 `timeoutMs` 仍独立控制 Agent 进程。

**状态**：已解决。协议测试确认任务会发送开始和完成通知；客户端仍需按文档请求 Progress，因为 AgentMesh 不能替外部 Orchestrator 修改本地请求选项。

## P-012 Codex 短摘要可能选中过程消息

**问题**：真实 Worker 的完整 `finalAnswer` 正确，但短 summary 出现了 `Reading additional input from stdin...` 一类过程文本。

**根因**：摘要生成仍可能使用通用输出片段，没有只从最终 `agent_message` 或明确完成事件中取值，也没有过滤已知进度消息。

**解决方法**：Codex JSON Lines 解析器只保留最后一个有效 `agent_message` 作为规范化最终回答；通用成功结果优先从 `finalAnswer` 生成摘要，不再从混杂的传输输出中选择过程文本。

**状态**：已解决。回归测试覆盖过程消息之后出现最终回答，以及传输输出与 `finalAnswer` 不一致的情况。

## P-013 Session 历史只能查询，不能主动通知

**问题**：`get_session` 和 CLI session 命令可以查询执行历史，但 Reviewer 失败或持久化异常不会主动通知外部系统。

**根因**：当前 Session 能力是持久化和按需查询，没有事件订阅、webhook 或通知通道；工作流是否继续仍由 Orchestrator 检查工具结果后决定。

**解决方法**：失败继续作为 MCP 错误结果传播，Session 保存结构化历史供追溯；同步执行期间通过标准 MCP Progress 发送开始、心跳和完成状态，使已订阅的 Orchestrator 能持续获知任务仍在运行。跨请求离线 webhook 明确不属于本地 stdio Bridge 的职责。

**状态**：已解决。同步 MCP 链路具备结构化结果和实时 Progress 通知；无人值守的跨系统告警应由外部 Orchestrator 或专门事件服务承担。

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

## P-018 显式传输模式被静默替换

**问题**：调用者为只支持 CLI 的 Agent 显式指定 `mode=mcp` 时，适配器仍然启动 CLI，并把实际传输报告为 `cli`。

**根因**：传输选择逻辑只判断是否进入 MCP 分支，其余情况统一落入 CLI 分支，没有先区分显式选择和允许自动降级的 `auto`。

**解决方法**：在任何进程启动前校验显式模式是否包含在适配器的 `supportedModes` 中；不支持时返回结构化失败，只有 `auto` 可以从首选 MCP 降级到 CLI。

**状态**：已解决。回归测试确认 CLI-only 适配器收到 `mode=mcp` 时不会尝试启动 CLI，也不会错误填写 `transportUsed`。

## P-019 Windows CMD shim 会破坏复杂 Prompt 参数

**问题**：Windows 上通过 npm `.cmd` shim 启动 Agent 时，多行 Prompt、引号和 `&`、`|`、`%` 等字符可能被 `cmd.exe` 二次解析，造成参数丢失、拆分或命令注入风险。

**根因**：执行器把命令及全部参数手工拼接为 `cmd.exe /d /s /c` 字符串；Windows CMD 的批处理展开和引号规则无法用普通反斜杠转义可靠覆盖。

**解决方法**：识别 npm 生成的 CLI shim，解析其 JavaScript入口或包内原生 `.exe` 入口，并通过进程参数数组直接传递；不再让 Agent Prompt 经过 CMD。无法识别的任意 `.cmd` 或 `.bat` 明确拒绝，要求改用原生可执行文件、PowerShell 脚本或标准 npm shim。

**状态**：已解决。Windows 真实子进程集成测试覆盖换行、双引号、百分号和 shell 元字符，并验证底层 Agent 收到完整的单一 Prompt 参数。

## P-020 工具脚本和 MCP Server 生命周期依赖隐式进程环境

**问题**：Windows 直接执行发布包验证脚本时，`spawnSync npm.cmd EINVAL` 导致失败；程序化重复启动并关闭 MCP Server 时，信号监听器不会移除。

**根因**：包验证仅在 `npm run` 提供 `npm_execpath` 时走 Node 入口，独立执行回退到直接 spawn `.cmd`；MCP Server 将 SIGINT/SIGTERM 监听器注册到全局进程，却没有把清理绑定到正常 `server.close()`。

**解决方法**：包验证从当前 Node 安装目录或 PATH 相邻目录解析 `npm-cli.js` 并用 Node 启动；MCP Server 的 `close()` 变为幂等清理入口，正常关闭和信号关闭都会移除监听器，并允许程序化调用通过 `handleSignals: false` 禁用全局处理。

**状态**：已解决。`npm run test:package` 与直接执行 `node scripts/verify-package.mjs` 均纳入验证，服务器关闭不再遗留进程监听器。

## P-021 子进程 UTF-8 分块解码导致仓库指纹假阳性

**问题**：Reviewer 没有修改文件，但执行前后的仓库内容指纹偶发不同，导致正常 Review 被错误标记为工作区发生变化。

**根因**：子进程执行器对每个 stdout/stderr Buffer 分块分别调用 `toString("utf8")`；中文等多字节字符被操作系统拆到两个数据块时会产生替换字符，导致同一份 `git diff` 文本出现不同解码结果和哈希。

**解决方法**：先保存原始 Buffer 分块，在进程结束或超时后通过 `Buffer.concat` 合并，再统一进行一次 UTF-8 解码；仓库指纹继续基于完整内容计算。

**状态**：已解决。回归测试强制把一个中文字符拆成两个进程输出块；连续六次仓库状态采集得到相同指纹，Reviewer 协议测试不再出现误报。

## P-022 Vendor MCP 工具 schema 严格拒绝适配器的猜测式参数

**问题**：通过 MCP 传输调用 Codex 或 Claude 时，适配器把 `prompt`、`task`、`role`、`sessionId` 等键一起发给自动发现的工具；真实服务端校验失败或调用了不相关的工具。

**根因**：适配器没有读取 vendor 工具的真实 schema。Codex 0.149 的 `codex` 工具是 `additionalProperties: false`（仅接受 `prompt`/`cwd`/`sandbox` 等字段，续接必须用 `codex-reply(threadId)`）；Claude 2.x 的 `claude mcp serve` 已改为暴露 Claude Code 原始工具集（Read/Edit/Agent 等），不再提供一次性任务入口。MCP 客户端在没有匹配到已知工具名时还会盲选第一个工具。

**解决方法**：用 SDK 探测真实服务端的 `listTools` schema 作为唯一事实源。Codex 适配器精确构造 `codex`（`prompt`/`cwd`/`sandbox`，Reviewer 用 `read-only`）与 `codex-reply`（`threadId`/`prompt`）调用；Claude 适配器降级为 CLI-only 并返回解释性结构化错误；MCP 客户端不再盲选工具，找不到可识别任务工具时报错并列出可用工具。

**状态**：已解决。`buildCodexMcpToolCall` 映射、Claude 模式拒绝与 MCP 客户端拒绝盲选均有测试覆盖。

## P-023 损坏的 sessions.json 会让所有 AgentMesh 命令不可用

**问题**：会话存储文件损坏（JSON 截断或 schema 不匹配）时，`SessionManager` 构造函数抛出异常；由于 `defaultSessionManager` 在模块顶层实例化，导入链导致 CLI 全部命令和 MCP Server 在启动阶段直接崩溃，包括本应用来诊断的 `agentmesh sessions`。

**根因**：加载失败一律按致命错误处理；而 Windows 写入回退路径 `copyFileSync` 是非原子操作，进程中断时恰好可能产生残缺 JSON，即写入策略自己制造了触发数据。重试只针对并发写窗口，无法区分“暂时不可读”与“确定损坏”。

**解决方法**：区分错误类型——`SyntaxError`（JSON 解析失败）与 `ZodError`（schema 不匹配）视为确定损坏，把文件重命名为 `*.corrupt-<timestamp>` 隔离、输出告警并以空状态继续；其他 IO 错误保持重试后抛出的原行为。

**状态**：已解决。损坏存储的隔离与空启动、非损坏 IO 错误的保留行为均有测试覆盖。

## P-024 CLI 传输没有默认超时导致请求可能无限挂起

**问题**：调用方和项目配置都没有设置 `timeoutMs` 时，CLI 传输的子进程没有任何超时；一个挂死的 vendor CLI 会永久占用 delegate/continue 请求。对比之下 MCP 传输默认 120 秒，行为不对称。公共类型 `RunnerOptions` 声明了 `defaultTimeoutMs`/`sessionStoragePath` 却没有接线到任何实现。

**根因**：执行器把 `timeoutMs` 缺省视为 0（不超时），runner 只回退到调用参数与角色配置两层，缺少最终兜底；`RunnerOptions` 是先声明后实现的悬空公共契约。

**解决方法**：`MultiAgentRunner` 接受 `RunnerOptions` 作为第三个构造参数：`defaultTimeoutMs` 缺省 600000ms（`DEFAULT_RUN_TIMEOUT_MS`）作为超时解析的最后一层；`sessionStoragePath` 在未注入 SessionManager 时用于构造持久化管理器。

**状态**：已解决。默认超时与 `RunnerOptions` 覆盖行为均有测试覆盖，README 记录了默认值与覆盖方式。

## P-025 Shell 注入的 PWD 环境变量让子进程在错误仓库执行

**问题**：真实 MCP 编排测试中，Tester（opencode）的 `cwd` 明确指向演示仓库，但它实际在 AgentMesh 自己的仓库里运行了 `npm test` 并报告了错误的绿灯结果；手工在同一目录直接运行 opencode 却正常。

**根因**：从 POSIX shell（如 Git Bash）启动 AgentMesh 时，shell 会向 `process.env` 注入 `PWD`/`OLDPWD`。执行器用 `{...process.env, ...options.env}` 全量继承环境，spawn 的 `cwd` 是目标目录但 env 中的 `PWD` 仍是启动器目录；OpenCode 等 vendor CLI 优先信任 `PWD` 而不是 `process.cwd()`，于是解析到了错误的项目目录。

**解决方法**：提取 `buildChildEnvironment(cwd, overrides)` 统一构造子进程环境：Windows 上删除非原生的 `PWD`/`OLDPWD`，其他平台把 `PWD` 重写为实际 spawn 目录；CLI 执行器与 MCP client 传输共用该函数。

**状态**：已解决。通过 `env -u PWD` 与默认环境的对照实验定位根因；`buildChildEnvironment` 行为有单元测试，真实 opencode 调用已验证回到目标目录。

## P-026 Codex MCP 工具调用在 Windows 沙箱下挂起导致整轮重跑

**问题**：真实 MCP 编排中，Worker（codex MCP 首选传输）报告成功但耗时 706 秒：rollout 显示 codex 线程 60 秒内就完成了补丁，随后在 `npm test`（sandbox 禁止 Node 创建测试子进程，spawn EPERM）上挂起，MCP 工具调用 600 秒不返回，`auto` 模式降级到 CLI 用原始任务重新执行了一遍并成功。

**根因**：codex MCP 通道内的 exec 在 Windows sandbox 下遇到 spawn EPERM 时挂起而非快速失败（CLI `codex exec` 通道同样报 EPERM 但立即返回错误，agent 可改用 `node --test --test-isolation=none` 绕过）。等待期间无法区分"仍在工作"与"已经挂死"。

**解决方法**：保留 auto 降级作为兜底（本次实际挽救了任务），并记录该平台差异：Windows 上 codex sandbox 会阻止测试子进程创建，测试类任务应优先使用 CLI 传输或提示 agent 使用 `--test-isolation=none`。

**状态**：已缓解。降级链路真实生效；MCP 通道挂起属于 vendor 行为，等待上游修复。

## P-027 Claude 辅助调用的 stderr 诊断被误判为执行失败

**问题**：真实评审中 Claude Reviewer 整体失败，错误为 `unrecognized_model: {"query_source":"generate_session_title"}`，但同一进程的主任务实际成功（`is_error:false`，exit 0，结果完整）。

**根因**：用户级 `~/.claude/settings.json` 将 haiku 类模型映射为代理模型名，会话标题生成等辅助调用失败并在 stderr 输出 `[claude-code:...]` 诊断；适配器把任何该模式行都当作致命语义错误，覆盖了 stdout 中权威的成功 JSON（codex 适配器有"无解析输出才看 stderr"的保护，claude 缺失）。

**解决方法**：结构化输出优先——只有当 stdout 没有解析出有效结果时，才把 `[claude-code:...]` stderr 模式升级为语义错误，与 codex 对齐。

**状态**：已解决。用真实 claude 会话验证主任务成功且辅助诊断不再导致失败；fake-CLI 进程级回归测试覆盖该场景。

## P-028 MCP 客户端超时不取消服务端工作，留下无记录的孤儿执行

**问题**：真实编排第一轮中，编排端 60 秒请求超时后，服务端委托任务继续执行：codex 实际修改了演示仓库代码，但 AgentMesh 服务进程随后随连接退出，Bridge Session 该轮 0 条历史、无 nativeSessionId——出现"代码已改但证据全丢"的孤儿状态，且被取消的 Agent 进程可能继续在后台运行。

**根因**：工具处理器没有消费 MCP SDK 提供的请求级 `AbortSignal`（客户端超时会发送 `notifications/cancelled`，断连时 SDK 也会 abort 所有在途请求的 signal）；执行器与 MCP client 传输也没有任何取消通道，进程树无法按需终止。

**解决方法**：把 `AbortSignal` 从 MCP 工具处理器一路穿透到 runner、适配器、CLI 执行器与 MCP client：执行器 abort 时终止进程树（Windows `taskkill /T /F`）并以 `aborted` 标记结束；MCP client abort 时关闭 stdio transport 终止 vendor MCP server 进程树；取消后该轮以失败（`Run cancelled by the requesting client.`）记入会话历史并保留证据，同时禁止 `auto` 模式在取消后再用 CLI 重跑。

**状态**：已解决。进程级 abort、信号透传、取消后历史留痕与"不降级重跑"均有测试覆盖。

## P-029 归一化 MCP 响应丢弃 vendor 原始输出导致远程不可诊断

**问题**：真实链路中 Antigravity Reviewer 失败时，MCP 响应只有一句通用的 `Agent execution terminated due to error.`，vendor stderr 的真正原因（Google API 地域限制）完全丢失，只能登录本机手工复现排查。

**根因**：MCP 工具响应只输出归一化的 Summary/Final Answer/findings，`AgentResult.output` 携带的 vendor CLI 原始 stdout/stderr 从不进入响应；设计初衷是控制响应体积，但把诊断信息一并裁掉了。

**解决方法**：响应在 Summary 与 Final Answer 之外增加 `Raw Output` 段：内容为 vendor 原始输出，截断到 8000 字符；与最终回答一致时省略，避免重复。

**状态**：已解决。协议测试覆盖 Raw Output 的出现与省略两种情形。
