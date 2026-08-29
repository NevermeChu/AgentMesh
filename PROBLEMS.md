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

**状态**：已解决，附一条边界。进程级 abort、信号透传、取消后历史留痕与"不降级重跑"均有测试覆盖，并用真实 Antigravity 任务验证：客户端 12 秒请求超时后该轮以 `Run cancelled by the requesting client.` 失败记录落盘且证据完整。边界：客户端直接 `close()` 连接时，MCP SDK 的 stdio 客户端会立即终止 AgentMesh 服务进程，服务端可能来不及写入该轮记录——取消长任务必须走请求超时/取消通知路径（已在 README 注明）。

## P-029 归一化 MCP 响应丢弃 vendor 原始输出导致远程不可诊断

**问题**：真实链路中 Antigravity Reviewer 失败时，MCP 响应只有一句通用的 `Agent execution terminated due to error.`，vendor stderr 的真正原因（Google API 地域限制）完全丢失，只能登录本机手工复现排查。

**根因**：MCP 工具响应只输出归一化的 Summary/Final Answer/findings，`AgentResult.output` 携带的 vendor CLI 原始 stdout/stderr 从不进入响应；设计初衷是控制响应体积，但把诊断信息一并裁掉了。

**解决方法**：响应在 Summary 与 Final Answer 之外增加 `Raw Output` 段：内容为 vendor 原始输出，截断到 8000 字符；与最终回答一致时省略，避免重复。

**状态**：已解决。协议测试覆盖 Raw Output 的出现与省略两种情形。

## P-030 单源上下文引用迫使 Orchestrator 链式转述

**问题**：真实编排中 Reviewer 同时需要 Worker 与 Tester 的结论，但 `contextSessionId` 一次只能引用一个会话，`continue_task` 更是没有任何上下文参数——Orchestrator 只能把 Tester 的响应文本粘贴进任务描述，经 Worker 摘要二次转述后才被 Reviewer 读到，每一层转述都是有损压缩，且各层还叠加 MCP 响应截断（Final Answer 12000 / Raw Output 8000 字符）。

**根因**：注入机制按"单会话"设计（`buildHistoryContext` 只接受一个 session）；"有原生 Session ID 就完全不注入"的二选一规则在反馈回流场景下把跨会话事实挡在门外——原生续接只覆盖会话自身的历史，从不覆盖其他会话的反馈，两者本应正交。

**解决方法**：`contextSessionIds`（最多 4 个，按给定顺序）在 `delegate_task` / `review_changes` / `continue_task` 上多源一手注入：每个来源渲染为带 Session ID/Agent/轮数标签的独立块并各自计算 MATCHED/STALE/UNKNOWN 新鲜度；全局 24k 字符预算按源均分，超限先丢较旧轮次并显式标注 `[truncated]`；实际注入的来源记入历史条目的 `contextSources` 字段。注入规则改为"原生续接只免除自会话历史，显式来源照常注入"。`contextSessionId` 保留为单源兼容形式，超出 4 个或引用不存在的会话整体 fail-fast。

**状态**：已解决。多源注入内容与顺序、独立新鲜度、截断标记、continue 与原生续接并存、超限与缺失引用的 fail-fast、单参数兼容与 MCP 边界透传均有测试覆盖。

## P-031 真实测试暴露的多源 Reviewer 上下文转发遗漏

**问题**：MCP `review_changes` 接收了 `contextSessionIds`，但 Reviewer 实际看不到多个 Worker/Tester Session 的共享上下文，导致重复检索和重复验证。

**根因**：`MultiAgentRunner.reviewChanges` 转发到 `delegateTask` 时只传递旧版单源 `contextSessionId`，遗漏数组 `contextSessionIds`。

**解决方法**：补齐数组转发并增加 runner 回归测试，验证 Shared Context 的来源顺序、freshness 和历史 `contextSources` 记录。

**状态**：已解决。

## P-032 Codex MCP 成功结论未持久化

**问题**：Codex MCP Worker 的最终回答只出现在运行时输出，Bridge Session 中缺少 `finalAnswer`，下游交接无法复用实现结论。

**根因**：Codex MCP 成功路径调用 `formatSuccessResult` 时未传递 `finalAnswer`，与 CLI 路径行为不一致。

**解决方法**：MCP 成功路径将最终 MCP 输出写入 `AgentResult.finalAnswer`，沿用现有 Session history 和 Shared Context 持久化链路。

**状态**：已解决。

## P-033 普通 Agent 摘要被 Markdown 围栏或诊断尾行污染

**问题**：Worker 输出以 ```、git diff 状态或 Exit Code 结尾时，summary 退化为无信息的尾行。Tester 输出以引导性进度消息（如 "We have started searching for..."）开头时，取首个非噪声行亦非摘要。

**根因**：`extractSummary` 无条件选择最后一个非空行（首次修复改为首个非噪声行），但首个非噪声行可能是进度消息而非结论句。

**解决方法**：首次修复跳过纯 Markdown 围栏、git 状态检查和执行诊断尾行。**第二次改进**：改用 `pickSummaryLine`——优先匹配带标签的结论行（`Overall Status: PASS`、`Summary: 已实现`），其次匹配 Markdown 结论章节标题，最后回退到最后一个非噪声行（结论通常出现在输出末尾）。同时新增 `normalizeSummaryLine` 剥离无序列表标记（`- `、`* `）和加粗/斜体装饰，使 `- **Overall Status:** **PASS**` 也能正确匹配。覆盖标签行、标题行、进度噪音和带装饰的实例如测试。

**状态**：已解决（第二次改进，2026-08-24）。

## P-034 Vendor 部分成功输出被误判为失败

**问题**：Antigravity 已输出完整 PASS/FAIL 正文，但 JSON 尾部附带 `context canceled` 或工具路径错误时，整个执行被判为失败，正文和 findings 丢失。

**根因**：适配器只要看到结构化 `error` 就返回失败，没有区分 exit code、实质输出和辅助诊断。

**解决方法**：exit code 为 0 且存在实质正文时继续走统一结果归一化，保留正文并将 vendor error 放入 `warning`；无正文或非零退出仍失败，Reviewer UNKNOWN/FAIL 继续 fail-closed。

**状态**：已解决（OpenCode/Codex 的同类语义保留现状，后续按真实协议单独评估）。

## P-035 Session 未持久化超时、取消和进程树清理证据

**问题**：Session 只能看到退出码和耗时，无法区分超时、客户端取消及 Windows 进程树清理结果。

**根因**：executor 返回的 `timedOut`/`aborted` 未贯通 AgentResult、Runner history 和 Session schema。

**解决方法**：扩展执行结果和历史 evidence，记录 `timedOut`、`aborted`、`cancelReason`、`cleanupMethod`、`cleanupSucceeded`，并保持旧 sessions.json 兼容；不对未采集的 CPU/RSS 填充伪造值。

**状态**：已解决。

## P-036 Windows Codex MCP 测试子进程能力差异

**问题**：Windows Codex MCP 沙箱运行 `node --test` 可能出现 `spawn EPERM`，而 CLI 传输可以运行，容易导致重复重试或误以为 AgentMesh 参数错误。

**根因**：vendor sandbox 的子进程策略，不属于 AgentMesh MCP tool schema 可控制的字段。

**解决方法**：不向 vendor MCP 工具注入未知参数；文档明确推荐 `mode: auto`/CLI fallback 或 `node --test --test-isolation=none`，显式 MCP 失败保持可见。

**状态**：已缓解；vendor 限制未宣称已修复。

## P-037 模型与推理强度缺少 vendor-aware 配置

**问题**：项目只能选择 Agent 和传输方式，无法稳定选择模型或推理强度；直接把通用字段发往 Codex MCP 还会违反严格 schema。

**根因**：配置、Runner 和 adapter 没有模型/推理类型，也没有持久化的 vendor 能力声明文件。

**解决方法**：增加 `.agentmesh/capabilities.json` 的显式生成/读取命令；扩展角色和 MCP 请求的 `model`/`reasoningEffort` 字段；各 adapter 只在 CLI 路径按自身白名单解释，Codex MCP 继续严格 allowlist，不发送未知字段。能力文件不含凭据，普通任务不会隐式探测或覆盖。

**状态**：已解决基础能力；vendor 具体可用模型仍须以已安装 CLI 和账号返回的诊断为准。

## P-038 正常完成后 vendor MCP 服务器子进程未清理

**问题**：真实测试五中，Worker（codex）+ Tester（antigravity）全部 SUCCESS/PASS 并正常退出后，残留两个孤立进程——`agy.exe`（RSS≈260MB，CPU≈624.8s）和 `codex.js`（RSS≈37MB），父进程已消失。这些进程持续消耗 CPU 和内存，属于资源泄漏。

**根因**：MCP 传输路径中，SDK 的 `StdioClientTransport.close()` 只 SIGTERM+SIGKILL 其直接子进程（vendor MCP server），不会终止该 server 已经 fork 的孙子进程（如 `codex exec` 和 `agy` 守护进程）。CLI 传输路径中，`executeCommand` 在子进程正常退出后不再检查并清理其后台派生进程。两种路径都允许 vendor 守护进程在任务完成后继续存活。

**解决方法**：MCP 传输路径——在 `executeViaMcpClient` 的 `finally` 块中、`transport.close()` 之前，读取 `transport.pid`（SDK 暴露的 getter），用 `spawn("taskkill", ["/pid", pid, "/T", "/F"])` 在 Windows 上先杀死整个进程树，确保孙子进程被一并回收。CLI 传输路径现在等待 `taskkill /T /F` 的真实退出结果，并在 timeout、abort 和进程错误路径统一回收仍挂在根 PID 下的 descendants；清理失败会保留为 `cleanupSucceeded: false`，不再把“已启动 taskkill”误报为成功。vendor 主动脱离父树的守护进程仍无法由 AgentMesh 安全定位，继续作为外部监控边界记录在 README 的已知限制中。

**状态**：MCP 传输路径已解决（2026-08-24）；CLI 传输路径中仍挂在根 PID 树内的 descendants 已修复并通过回归测试（2026-08-24）；vendor 主动脱离 PID 树的守护进程仍未解决。

## P-039 真实测试驱动的证据目录生命周期不安全

**问题**：复杂真实测试中，Tester 运行后隔离仓库内的 `evidence/` 目录被删除或重置，主驱动随后写入 `worker-final.json` 时收到 `ENOENT`，预定的 `continue_task` 没有执行，编排证据不完整。

**根因**：驱动把编排证据放在 Agent 可操作的工作区内，且写文件前没有重新创建目录；测试产物和驱动证据没有隔离。

**解决方法**：本轮通过独立 continuation 补做修复闭环，但生产代码未改。后续真实测试驱动应将证据输出放在工作区外，或每次写入前原子创建目录并验证路径。

**状态**：已解决（2026-08-24 第七轮真实测试验证：证据目录置于工作区外后全程编排零中断；属编排脚本实践，不涉及 AgentMesh 运行时）。

## P-040 复杂任务的空记录语义未在规范中明确

**问题**：CSV 任务的最终空行和中间空记录边界未预先写入 SPEC，Reviewer 首轮发现 `parseCsv("\\n")` 可被解析为一列表头，并要求明确空记录语义。

**根因**：任务设计只规定“忽略最终空行”，没有区分最终物理空记录与非最终空记录，也没有定义一列 CSV 的空字段行为。

**解决方法**：Continue 阶段明确并实现：最终空 LF/CRLF 记录忽略；非最终空记录作为一列空字段，宽表中因列数不匹配而跳过；增加 9 项 parser 回归测试和 20 项流水线测试。

**状态**：已解决（本轮真实 FAIL→continue 已验证）。

## P-041 本轮资源采样器未建立有效证据

**问题**：为复杂真实测试启动的 PowerShell 进程采样器因内联变量展开/脚本解析失败，没有生成 CPU、RSS、进程树或孤儿进程证据。

**根因**：采样命令通过 Git Bash 内联传递 PowerShell 变量，shell 先行展开 `$root`、`$end` 等变量，导致 PowerShell 收到缺失表达式。

**解决方法**：改为独立 `.ps1` 文件后重新启动，但采样任务仍未产生可用 `process-samples.jsonl`；最终报告明确资源指标未知，不填零、不宣称正常。

**状态**：已解决（2026-08-24 第七轮真实测试：先以 4 秒 smoke run 验证采样器产物，再全程启用，产出 24211 行 JSONL 样本覆盖完整流水线）。

## P-042 子进程 stdin 缺少错误监听可导致服务进程崩溃

**问题**：executeCommand 向子进程写入 input 后，如果子进程提前退出（未排空 stdin），异步 EPIPE 错误事件在 stdin 流上没有监听器，会以 unhandled error 事件使常驻的 AgentMesh MCP Server 进程整体崩溃。

**根因**：src/core/executor.ts 中只对 stdin.write 做了同步 try/catch，而 EPIPE 是异步 error 事件，必须注册监听器才能吞掉。

**解决方法**：在 spawn 后为 childProcess.stdin 注册 no-op error 监听器；stdin 写入失败不改变任务结果（stdout/stderr 已保留进程实际产出）。新增回归测试：子进程立即退出且传入大量 input 时命令正常收敛。

**状态**：已解决（单元回归覆盖；真实链路未验证）。

## P-043 POSIX 侧没有真正的进程树终止

**问题**：非 Windows 平台超时/取消时只对根进程发 SIGTERM/SIGKILL，vendor CLI fork 出的后台子进程会成为孤儿；README 只承认了 Windows taskkill 的局限，未如实说明 POSIX 侧同样存在。

**根因**：spawn 未使用 detached 进程组，终止逻辑缺少 kill(-pid) 的组信号路径。

**解决方法**：POSIX 上以 detached 方式 spawn 使子进程成为独立进程组组长，终止时先向整个进程组发送 SIGTERM，1 秒后升级 SIGKILL，组信号失败时回退为仅杀根进程。新增 executor.integ.ts 集成测试：shell fork 出的心跳子进程必须在超时后停止心跳。Windows 路径保持 taskkill /T /F 不变。

**状态**：已解决（代码与集成测试完成；集成测试仅在非 Windows 执行，Windows 真实链路行为未变化）。

## P-044 硬结算兜底伪造 exit code 124

**问题**：子进程在强杀后仍不退出时，executor 的 hard-settle 兜底路径无条件返回 exitCode=124，即使并未发生超时，违反项目“证据如实”的原则。

**根因**：兜底 resolve 直接硬编码 124，没有区分“观测到的退出码”和“未知的退出码”。

**解决方法**：ExecutionResult.exitCode 与 ProcessExecutionError.exitCode 放宽为可选；hard settle 仅在确实发生超时时报告 124，否则报告 undefined（未知）。所有消费方均按 optional 处理，无破坏性影响。

**状态**：已解决。

## P-045 Reviewer PASS 判定可被输出中引用内容误触发

**问题**：parseReviewOutput 对全部行做前缀式 PASS/FAIL 匹配，若 Reviewer 引用的 diff/测试内容恰有行首 PASS 且全文无 FAIL，评审结论会被误判为 PASS（findings 只能部分兜底）。

**根因**：裸词判定没有位置约束，也没有区分“行首词 + 任意后文”与“整行只有该词”。

**解决方法**：前 10 行内保留原有的行首前缀匹配（规范要求 verdict 位于输出开头）；超过该区域后仅接受“整行独立成词”（允许 Markdown 加粗/斜体装饰）或带标签形式（Verdict:/Status: 等）。标签判定不受位置限制，兼容真实测试中出现过的“先过程消息后结论”输出。

**状态**：已解决（含正反用例回归）。

## P-046 Codex CLI 仍存在“结构化错误清空部分成功输出”的残留模式

**问题**：antigravity 已修复为“exitCode=0 且有实质正文时保留 finalAnswer、error 降级为 warning”，但 codex.ts CLI 路径仍是 parsed.error 存在即整体判败，finalAnswer 不持久化——与 real_test.md P3/P8 同类模式在不同适配器上残留。

**根因**：两个适配器的失败判定各自实现，修复只落在了 antigravity 一侧。

**解决方法**：codex runViaCli 对齐同一语义：exitCode!==0 或（有 error 且无实质 agent_message 输出）才判失败；error 与实质正文并存时返回成功并携带 warning 字段。新增两条集成测试覆盖正反场景。

**状态**：已解决（fake CLI 集成测试验证；真实 Codex 链路待下次真实测试确认）。

## P-047 会话存储无界增长导致写放大

**问题**：sessions.json 每次追加历史都全量重写，会话数与每会话轮数均无上限，长期使用下每次 addHistory 都是 O(N) 重写且体积无限增长。

**根因**：SessionManager 只有单文件 JSON 持久化，没有任何容量治理。

**解决方法**：新增 SessionManagerOptions.maxHistoryTurnsPerSession（默认 50，超出丢弃最旧轮次）与 maxSessions（默认 200，按 updatedAt LRU 逐出，平局按插入顺序），设为 0 可关闭上限。逐出/裁剪均在文件锁内执行以保证跨进程一致性。

**状态**：已解决（默认上限生效；如需长期归档请自行调大或定期导出 sessions.json）。

## P-048 delegateTask 与 continueTask 大面积重复且行为漂移

**问题**：两个入口各自维护 context 校验、reviewer safety、历史落盘约 200 行近乎相同的代码；且 continueTask 的 reviewer safety 只读 session metadata、不回退项目配置的 roles.reviewer.safety，与 delegateTask 行为不一致。另有一处隐患：delegateTask 对 context 会话的第一遍 cwd 校验使用 process.cwd() 兜底，而 existing session 实际绑定的是 session.cwd，绑定会话继续时可能误判。

**根因**：continueTask 从 delegateTask 复制而来，后续单侧演进。

**解决方法**：提取 collectContextSources / recordTurn / loadReviewerSafetyFallback 共享辅助；context 校验统一针对“目标执行 cwd”（existing session 用其绑定的 cwd）一次性完成并删除冗余的第二遍循环；continueTask 的 safety 按 session metadata → 项目配置 → best-effort 顺序解析（配置加载失败降级为不阻塞续接）；共享上下文指令中新增“引用来源需给出 session ID、不得声称复用未注入的信息”的归因约束（缓解 real_test.md P5）。全部既有协议测试通过。

**状态**：已解决。

## P-049 评审输出契约不支持"PASS + 非阻塞备注"，fail-closed 解析把干净评审判为失败

**问题**：2026-08-24 第七轮真实测试中，opencode Reviewer 两次完成实质 PASS 评审（一次含约 30 个独立行为探针，一次含 20 万次×2 差分模糊逐位匹配），但都按现代 vendor 惯例附上 `severity: low` 的非阻塞 observations；`parseReviewOutput` 的 fail-closed 规则（findings 非空即覆盖 PASS→FAIL）使两次评审整体判 FAIL、MCP 返回 `isError=true`，触发不必要的修复闭环与 orchestrator 重试。

**根因**：评审提示词模板是二元输出契约（"clean → PASS / any issues or concerns → FAIL + findings"），没有为"PASS + 非阻塞备注"提供表达通道；解析器无严重度分级概念，任何 findings 都视为否决。vendor 倾向于输出分级备注，契约与模型行为不匹配。

**解决方法**：提示词与解析器同步引入严重度感知判定：①`buildReviewerPrompt` 为 PASS 增加显式非阻塞通道（允许在 PASS 后以结构化格式附带 severity medium/low 的 observations，并说明其不影响结论）；②`parseReviewOutput` 仅在显式 PASS 且 findings 含 critical/high（或 severity 无法解析）时按矛盾输出 fail-closed 判 FAIL；medium/low findings 保持 PASS、原样返回给 orchestrator 自行取舍。显式 FAIL 判定始终优先，无任何可解析 verdict 时维持原有 fail-closed 行为。

**状态**：已解决（2026-08-24，含正反用例回归：PASS+low/medium → PASSED with non-blocking findings；PASS+critical/high/garbled-severity → FAIL；显式 FAIL 与无 verdict 场景行为不变）。同日第八轮真实测试验证：opencode PASS 附带 3 个 low findings → `Review PASSED with 3 non-blocking finding(s).`、status=SUCCESS、isError=false。

## P-050 能力协商零接线：vendor 模型/推理请求被静默丢弃

**问题**：第九轮真实测试（2026-08-25）向 codex(auto→mcp) 请求 `model:"gpt-5-codex"` + `reasoningEffort:"high"`，Session history 记录了 requestedModel/requestedReasoningEffort，执行照常走 mcp，但该传输按 vendor schema 不支持模型参数——MCP 返回与会话条目均无任何"不支持/已忽略"诊断，请求被静默丢弃。`getCapability()` 在仓库中没有任何调用方，能力门控只有声明层。

**根因**：capabilities.ts 的能力矩阵（schema/generator/静态矩阵）从未在执行路径被咨询；README"vendor 不支持时保留结构化诊断、不静默切换模型"的承诺没有代码兑现。

**解决方法**：新增 `evaluateModelOptionSupport()`（capabilities.ts），在 delegateTask/continueTask 执行结束后按实际 transportUsed 对照能力矩阵（优先 .agentmesh/capabilities.json，缺失时回退内建静态矩阵）；不支持组合产生结构化诊断，附加到结果 warning 与会话 history 新增的 `capabilityDiagnostics` 字段。任务不因此失败。

**状态**：已解决（2026-08-25；含单元回归：不支持/缺声明/values 不匹配/支持静默四类路径）

## P-051 客户端取消留下 0-turn 僵尸会话

**问题**：第九轮真实测试中 20s 客户端取消后，全局存储残留 bridge-sess 壳：history=0、无 status/aborted/cancelReason/cleanup 任何证据；MCP 层只向调用方回传 -32001，服务端已有的进程清理事实不可达。僵尸会话可被后续 continue_task/contextSessionIds 引用且语义不明。

**根因**：createSession 在执行前即时持久化；客户端断开使 stdio server 在 recordTurn 之前退出，空壳永久留在共享存储。

**解决方法**：SessionManager 引入延迟首持久化（unsavedSessions 集合）：createSession 只写内存，首个 turn 落盘时会话才变为持久；withFileLock/getSession/listSessions 的磁盘重载保留未落盘会话。硬死亡不再可能留下零轮空壳；优雅取消路径仍会记录完整 failed/aborted 终态轮。

**状态**：已解决（2026-08-25；并发实例回归测试覆盖"零轮不可见/首轮后可见"）

## P-052 注入的共享上下文不可逐字审计（截断盲区）

**问题**：buildSharedContext 渲染的多源注入块（含 4000 字符/答案、24000/源预算、旧轮省略等截断）只存在于当次 prompt 中，不持久化；下游 history 仅记录 contextSources ID。orchestrator 无法事后验证下游实际看到什么，截断只能推断，交接争议（如 r3-P5 归因错误）无法裁决。

**根因**：渲染文本未进入任何持久化通道，也无摘要/摘要指纹。

**解决方法**：新增 buildSharedContextDetailed 返回逐源注入统计（chars/truncated，含内层 finalAnswer>4000 截断判定）；recordTurn 将完整渲染块以 sidecar 工件持久化到 `<sessions 目录>/contexts/<sessionId>/<turn>.txt`，并在 history 条目的 `sharedContextAudit` 记录相对路径、字节数、SHA-256、totalChars 与逐源截断标志。主 JSON 存储不膨胀。

**状态**：已解决（2026-08-25；回归验证 sidecar 存在、哈希与内容一致、超限答案标记 truncated=true）

## P-053 校验错误优先级：context 问题被角色解析错误掩盖

**问题**：delegateTask 先做角色解析再做 context 校验。目标 cwd 缺 .agentmesh/config.json 且同时存在跨仓 context 引用时，返回"role not configured"而掩盖真正的交接 cwd-mismatch，误导编排方调试。

**根因**：两段校验顺序与信息价值倒置；context 收集本不依赖角色解析结果。

**解决方法**：将 contextSources 上限检查与 collectContextSources 移至角色解析之前（两者均只需 existingSession/params）；错误结果的 agent 标签回退为 params.agent ?? existingSession?.agent ?? "unknown"。

**状态**：已解决（2026-08-25；回归测试验证无效 config + 跨仓 context 场景优先报告 mismatch）。同日二次增强（S4 聚合）：优先级修复后存在反向掩盖——context 错误先返回时角色问题不可见。delegateTask 现在同趟完成两类校验，同时失败时返回合并消息（含 "; additionally:"），仅一类失败时保持精确单因报告；continueTask 复用共享 describeContextFailure helper。回归双覆盖。

## P-054 delegate_task 对 reviewer 角色无条件跑评审 verdict 解析，讨论类回复被误判失败（N-R11-A）

**问题**：2026-08-25 第十一轮真实测试冒烟实证：formatSuccessResult 对任何 role=reviewer 的输出执行 parseReviewOutput，无显式 verdict 即 UNKNOWN → status=failed/isError=true——即使 exit 0 且答案完整。reviewer 角色无法承载讨论、答疑类回复；两次复现。

**根因**：「reviewer 角色」与「评审契约」被混为一谈：fail-closed 只应由声明评审契约的调用（review_changes）触发，却无差别作用于全部 reviewer 角色调用。

**解决方法**：RunAgentOptions/DelegateTaskParams 新增内部标记 reviewVerdictRequired，仅 reviewChanges() 置 true 并透传至 formatSuccessResult（MCP schema 不暴露）。置位时维持 fail-closed；未置位时 UNKNOWN+实质回答判 SUCCESS 并附警告（reviewOutcome=UNKNOWN 保留供裁决），无实质输出仍判失败；显式 FAIL 在所有入口恒为失败。六个适配器同步透传。

**状态**：已解决（2026-08-25）；回归覆盖宽严两路径 + MCP 协议层 delegate_task/review_changes 对照用例。

## P-055 auto 模式静默传输回退销毁根因证据（N-R10-C）

**问题**：第十轮真实测试中并发双 worker 两次 runViaMcp 快速失败后静默回退 CLI（transportUsed=cli 为唯一线索），原始错误被丢弃，事后无法复现根因（疑似 vendor 并发握手竞态）。

**根因**：base.ts 回退点只执行 fallback，不捕获原始 MCP 错误；AgentResult 与 Session 证据均无回退字段。

**解决方法**：回退时捕获原始错误文本；结果携带结构化 transportFallback {from,to,reason} 并追加 warning；SessionExecutionEvidence 新增同名持久化字段，get_session 可见。回退行为本身保留。

**状态**：已解决（2026-08-25）；回归断言 result/evidence 双通道 + warning 文本。

## P-056 断开式客户端取消零审计痕迹（P-REAL-009）

**问题**：传输层 close()/SIGINT/SIGTERM 触发的服务端关闭不留任何会话或轮次证据；r10 P2 断开式取消实验中会话与审计痕迹完全丢失。

**根因**：server 随 stdin 关闭直接退出，in-flight 执行既未被中止也未走 recordTurn。

**解决方法**：MultiAgentRunner 维护 in-flight AbortController 注册表并新增 abortAllInFlight()；runner 用 AbortSignal.any 组合外部信号与服务端信号。startMcpServer 将 stdio onclose/SIGINT/SIGTERM 统一接入优雅关闭：先中止全部 in-flight，再事件驱动等待各轮经既有 recordTurn 链落盘（整体上限 10s 兜底），最后关闭 server。cancelReason 枚举新增 client_disconnect（types 与 session zod 两处同步）。SIGKILL 强杀仍无法落盘，作为残留边界写入 README。

**状态**：已解决（2026-08-25）；回归：在途任务经 abortAllInFlight 后 history 记录 failed + cancelReason=client_disconnect + aborted=true。

## P-057 vendor 账户级模型拒绝无预检诊断（P-REAL-007 矩阵粒度缺口）

**问题**：r10 A0 以 CLI 请求 gpt-5-codex 被 vendor 账户拒绝（400）；矩阵 flag 层面声明支持导致无任何 capability diagnostic，编排方无法快速归因。

**根因**：能力矩阵只有 flag/transport 维度，「声明支持不等于实际可用」缺少诊断通道；诊断仅在执行后评估一次。

**解决方法**：delegateTask/continueTask 派发前按预测 transport 做预检诊断并与执行后评估去重合并（永不阻断执行）；新增保守分类器 modelRejectionDiagnostic——错误文本同时含所请求 model id 与 4xx/unsupported-model 特征时输出结构化拒绝诊断（含 requestedModel）。模型枚举 values 字段维持仅 provenance=manual 人工维护写入，静态生成器不猜测值，防止枚举腐烂产生假阴性警告。

**状态**：已解决（2026-08-25）；回归覆盖分类器正反用例与预检合并路径。「MCP 忽略 model」真链路用例按仓库规则保持 opt-in 不入 CI。

## P-058 codex MCP spawn EPERM 缓解指引未进入结构化信息通道（P6/P-036 增强）

**问题**：codex MCP 沙箱阻止子进程派生的 spawn EPERM 连续多轮复现，缓解知识只存在于真实测试记录中；agent 每轮需自行重新发现绕过方式。

**解决方法**：内置能力矩阵 codex.mcp 增加 notes 缓解指引（TransportCapabilitySchema 扩展可选 notes 字段）；runner 检测到 MCP 传输结果中的 spawn EPERM 特征时自动在 warning 附带「NODE_OPTIONS=--test-isolation=none 或改用 cli」提示（sandboxSpawnHint）。

**状态**：已解决（2026-08-25）；回归覆盖命中/传输/特征三重排除条件。

## P-059 antigravity artifact-path 白名单失败无产物可复核性警示（P9 产品侧检测）

**问题**：antigravity 的 write_to_file 以 artifact 白名单为由拒绝写入工作区且间歇性致命（r9 吞掉整轮产出）；vendor 行为无法根治，但 AgentMesh 未对「自述产出可能不可复核」给出任何结构化警示。

**解决方法**：antigravity 适配器以常量特征匹配 "not a valid artifact path"，命中时经 warning 通道附加「产物可能未落盘工作区、需独立复核」警示；成功与致命失败两个分支均覆盖。不注入 findings，避免干扰 parseReviewOutput 的 fail-closed 语义。README 已知限制同步更新编排方降级指引建议。

**状态**：已解决（2026-08-25，检测与警示层面；vendor 白名单本身属平台限制，如实记录）。

## P-060 MCP 客户端在 POSIX 上不收割 vendor 子孙进程树（P10 回归在 Linux CI 暴露）

**问题**：`executeViaMcpClient` 的进程树收割只实现了 Windows 分支（taskkill /T /F）；Linux 上 SDK `StdioClientTransport.close()` 只终止直接子进程，vendor MCP server fork 出的孙进程成为孤儿继续运行。P10 进程回收回归测试在 ubuntu CI 上断言失败（孤儿存活并写入 marker），此前该测试还因固定 3.5s 观察窗口叠加 CI 慢机时序超过 vitest 默认 5s 超时。

**根因**：SDK 自行 spawn 子进程且不支持 detached/process-group 透传，executor.ts 的「detached + `-pid` 进程组信号」方案无法复用；mcp-client.ts 清理路径缺少 POSIX 等价实现。

**解决方法**：teardown 前从 procfs `/proc/<pid>/task/*/children` 递归快照仍存活的后代 PID（快照必须在根进程存活时进行，否则深层后代会重新挂到 init 失去追踪），`client.close()` 之后对幸存者补发 SIGKILL。测试增加 15s 显式超时，与项目内其他慢测试惯例一致。

**状态**：已解决（2026-08-26）。Linux 上孤儿被收割、回归测试通过；Windows 路径不变；macOS 无 procfs 时保持原有行为并在代码注释中如实说明。

## P-061 posix executor 集成测试的 shell 引号注入导致脚本秒退（首次在 CI 上真正执行即失败）

**问题**：`executor.integ.ts` 的 posix 进程组清理测试在 ubuntu CI 上 81ms 内断言失败（`timedOut` 为 false）。该测试 `skipIf(win32)` 且诞生于最后一次全绿 CI 之后，此前每次 CI 都在更早阶段失败而从未真正执行过它。

**根因**：生成的 sh 脚本用双引号包裹 `-e` 的 JS 代码，又把 `JSON.stringify(heartbeat)` 的带引号路径插值进同一段双引号内——路径的双引号提前闭合了 shell 引号，路径以裸 token 进入 JS：`/tmp/...` 被 V8 解析为正则字面量，`writeFileSync(regex.txt, ...)` 抛 TypeError，后台 node 立即退出、`wait` 随即返回，进程远早于 500ms 超时结束。作者在 Windows 上开发时该测试被跳过，无法暴露。

**解决方法**：心跳路径改经 `executeCommand` 的任务级环境变量（`AGENTMESH_HEARTBEAT_FILE`）传入子进程，脚本内引用 `process.env`，彻底消除对生成脚本的内插值注入；不再依赖路径不含空格/特殊字符的隐含假设。

**状态**：已解决（2026-08-26）；教训：POSIX-only 测试在 Windows 开发机上不可见，依赖 CI 才能执行，生成 shell 脚本时禁止向引号定界符内部插值含引号的值。

## P-062 ESLint 10 递归发现 vendored 参考源码的 eslint 配置导致 `npm run lint` 崩溃

**问题**：在项目 `reference/` 下引入 Codex 与 Claude Code 的外部源码做阅读参考后，`npm run lint`（`eslint .`）不再输出 lint 结果，而是直接抛 `ERR_MODULE_NOT_FOUND: Cannot find package 'eslint-plugin-node-import' imported from reference\...\sdk\typescript\eslint.config.js`，整个质量门无法运行。

**根因**：ESLint 10 对 flat config 启用了按文件的逐级配置发现（config file discovery）：即使根目录存在 `eslint.config.js`，ESLint 在 lint 子目录文件时也会向上查找到 vendored 仓库自带的 `eslint.config.js` 并加载它，而该配置依赖的插件在外部仓库里并未安装。此外被 gitignore 的本地实验脚本 `driver-r*.mjs` 也不受 ESLint 忽略约束，其内既有错误同样会挡住门禁。

**解决方法**：在根 `eslint.config.js` 的 `ignores` 中显式加入 `reference/**` 与 `driver-r*.mjs`。`reference/**` 注明 vendored 外部源码自带工具链配置、不得参与 lint 或配置发现；本地实验脚本按仓库既有约定（commit 8ca373b）排除在 lint 之外。

**状态**：已解决（2026-08-29）。教训：向工作区引入任何自带工程配置的外部仓库时，必须同步检查 ESLint 10 的逐级配置发现、Prettier 与 tsc 的扫描范围，vendored 目录应第一时间加入所有工具的 ignore 名单。
