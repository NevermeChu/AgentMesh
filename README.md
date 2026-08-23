# AgentMesh (Multi-Agent Bridge MVP)

> **把不同第一方 Agent Harness 暴露成统一 MCP Tool 的本地桥接与编排网格层。**

**AgentMesh** 允许主控 Agent（如 Antigravity / Codex / Claude Code）通过标准 **Model Context Protocol (MCP)** 调用其他厂商的第一方 Coding Agent，而不是直接调用各家的模型底层 API。管理 CLI 用于启动服务、检查配置和诊断适配器；正常任务编排由主控 Agent 完成。各厂商的 Harness、订阅额度和工具链保持不变。

---

## 🌟 核心特性

- 🔌 **官方连接优先 (Official MCP Preferred)**：支持直接连接底层 Agent 的原生 MCP Server（如 `codex mcp-server`、`claude mcp serve`），并在不可用时自动无缝降级为 Headless CLI。
- 🛡️ **结构化错误传播**：底层 Agent 未安装、未登录、额度不足或执行失败时，适配器和 MCP Tools 会尽量捕获错误并返回结构化诊断；启动配置、Session 存储或进程级故障仍会显式失败，而不是被静默忽略。
- 🔍 **独立 Reviewer 规范**：内置代码评审提示词模板与只读权限约束（如 Codex `--sandbox read-only`）；无法解析为 `PASS` / `FAIL` 的结果按失败处理，避免误报通过。
- 🧵 **轻量 Session 跟踪**：支持 `continue_task` 继续原 Agent 会话，也支持通过 `contextSessionId` 向新角色传递规范化历史。Reviewer/Tester 结果不会自动写回 Worker 原会话，Orchestrator 负责在修复任务中明确携带反馈。
- 💻 **Orchestrator-first**：正常工作流由主控 Agent 通过 MCP Tools 编排；CLI 负责启动服务、配置、状态和会话管理，直接执行仅保留在 `debug` 命名空间用于诊断。

真实链路中已经确认的问题、修复状态和平台限制见 [PROBLEMS.md](./PROBLEMS.md)。

---

## 🤖 支持的 Agent 矩阵

| Agent 名称        | 别名 (Aliases)                                         | 默认二进制       | 首选模式 (Preferred)        | 降级/备选模式 (Fallback)            | 环境变量覆盖             |
| :---------------- | :----------------------------------------------------- | :--------------- | :-------------------------- | :---------------------------------- | :----------------------- |
| **`codex`**       | `openai-codex`, `codex-cli`                            | `codex`          | MCP (`codex mcp-server`)    | CLI (`codex exec` / `codex review`) | `CODEX_BIN`              |
| **`claude`**      | `claude-code`, `anthropic-claude`                      | `claude`         | CLI (`claude -p`)           | —                                   | `CLAUDE_BIN`             |
| **`antigravity`** | `gemini`, `agy`, `google-gemini`, `google-antigravity` | `agy` / `gemini` | CLI (`agy -p`)              | —                                   | `AGY_BIN` / `GEMINI_BIN` |
| **`grok`**        | `xai-grok`, `grok-cli`, `grok-build`                   | `grok`           | CLI (`grok -p`)             | —                                   | `GROK_BIN`               |
| **`opencode`**    | `opencode-ai`, `opencode-cli`                          | `opencode`       | CLI (`opencode run --auto`) | —                                   | `OPENCODE_BIN`           |
| **`zcode`**       | `z-code`, `zcode-cli`                                  | `zcode`          | CLI (`zcode <prompt>`)      | —                                   | `ZCODE_BIN`              |

> Claude 适配器目前仅使用 CLI 传输：当前版本的 `claude mcp serve` 暴露的是 Claude Code 的原始工具集（Read/Edit/Agent 等）而非一次性任务入口，因此显式 `mode=mcp` 会返回结构化错误。Claude Reviewer 在 CLI 中通过 `--tools` 只保留只读工具并移除 Bash/Edit/Write 等可写工具。Codex 的 MCP 调用严格遵循服务端 schema（`additionalProperties: false`），原生续接使用 `codex-reply(threadId)`。Antigravity Reviewer 在非 Windows 平台使用原生 `--sandbox` 与 `plan` 模式；Windows 上因原生沙箱可能在受保护工具链路径初始化失败，目前降级为 `plan` + `prompt-only`。所有标记为 `prompt-only` 的适配器都不能视为运行时只读沙箱。

> 底层 Agent CLI 只需已经安装、可执行并完成各自所需的登录或授权，不需要全部预先启动。AgentMesh 在收到任务后只会按角色配置启动本次使用的 CLI 或原生 MCP Server。

> `mode=auto` 会优先使用适配器的首选传输，并在支持时自动降级；显式指定 `mode=mcp` 或 `mode=cli` 时严格执行该选择，不支持的模式直接返回结构化错误。Windows 上 npm 生成的 `.cmd` CLI shim 会被解析为对应的 Node.js 或包内原生可执行入口，Prompt 不经过 `cmd.exe`；无法安全识别的任意 `.cmd` / `.bat` 会被拒绝。子进程环境继承时会移除 Shell 注入的 `PWD`/`OLDPWD`（POSIX 上按 spawn 目录重写 `PWD`），避免信任这些变量的 Agent CLI（如 OpenCode）在错误的项目目录中执行。

---

## 🚀 快速开始

### 1. 安装与构建

开发与发布要求 Node.js `>=22.13.0`，CI 同时验证 Node.js 22 和 24。仓库固定使用 npm `11.16.0`；本机 Node.js 24 与构建目标并不冲突，`tsup` 的 `node22` target 表示发布产物兼容的最低 Node.js 运行时，而不是实际执行构建的本机版本。

```bash
# 按 lockfile 安装完全一致的依赖
npm ci

# 编译构建
npm run build
```

### 2. 检查本地 Agent 可用状态

```bash
node dist/cli/index.js list
# 或全局链接后使用:
# agentmesh list
```

输出示例：

```text
Supported Agent Adapters & System Status:

NAME            DISPLAY NAME                       STATUS        PREFERRED   PATH / NOTE
-----------------------------------------------------------------------------------------------
codex           OpenAI Codex                       [AVAILABLE]   MCP         D:\Work\Env\global_modules\npm_global\codex.cmd
claude          Anthropic Claude Code              [AVAILABLE]   MCP         D:\Work\Env\global_modules\npm_global\claude.cmd
antigravity     Google Antigravity (AGY / Gemini)  [MISSING]     CLI         Binary 'agy' was not found in system PATH.
grok            xAI Grok                           [MISSING]     CLI         Binary 'grok' was not found in system PATH.
opencode        OpenCode                           [MISSING]     CLI         Binary 'opencode' was not found in system PATH.
zcode           ZCode                              [MISSING]     CLI         Binary 'zcode' was not found in system PATH.
```

---

## 🛠️ AgentMesh CLI（管理与诊断）

正常任务不通过 CLI 手动执行，而是由 Orchestrator 调用 AgentMesh MCP。顶层 CLI 只提供管理能力：

```bash
agentmesh serve                 # 启动 stdio MCP Server（通常由 Orchestrator 自动执行）
agentmesh config                # 查看并校验项目角色配置
agentmesh list                  # 检查本机 Agent CLI 可用性
agentmesh sessions              # 查看 Bridge Sessions
agentmesh session <sessionId>   # 查看单个会话
```

直接执行仅用于排查 MCP、适配器或 CLI 参数问题：

```bash
agentmesh debug run antigravity "协议冒烟测试" --role worker
agentmesh debug review claude "检查当前 diff"
agentmesh debug continue bridge-sess_8f3d1a "继续诊断"
```

### 项目级角色映射 (`.agentmesh/config.json`)

在用户项目根目录创建 `.agentmesh/config.json`：

```json
{
  "version": 1,
  "roles": {
    "orchestrator": "antigravity",
    "worker": "antigravity",
    "reviewer": {
      "agent": "claude",
      "mode": "cli",
      "timeoutMs": 300000,
      "safety": "best-effort"
    },
    "tester": "claude"
  }
}
```

同一 Agent 可以配置到多个角色。Worker、Reviewer、Tester 启动新的角色任务时会创建独立的 Bridge Session，因此同一 CLI 的不同会话可以同时承担不同角色；显式传入 `sessionId` 时则继续并校验已有 Session。`orchestrator` 用于记录项目的主控 Agent，不会替代三个可执行角色。

Reviewer 的 `safety` 支持：

- `best-effort`（默认）：允许所有 Agent，使用适配器当前能提供的最强保护；`prompt-only` 会返回明确警告。
- `enforced`：只允许 `native-sandbox` 或 `tool-filtering`，遇到 `prompt-only` Agent 时在启动前失败。

所有 Reviewer 都禁止调用者追加 `extraArgs`，避免覆盖固定的沙箱、工具或权限参数。AgentMesh 会比较 Reviewer 执行前后的仓库内容指纹；工作树在执行期间发生变化时，Review 会返回 `FAIL`、列出变更路径且不会自动回滚，以免覆盖用户的并发修改。该检测能发现误写，但 `best-effort` 本身不是操作系统级只读隔离。

```bash
# 查看并校验当前生效配置
agentmesh config
```

Orchestrator 调用 `delegate_task` / `review_changes` 时省略 `agent`，AgentMesh 就会根据 `cwd` 和角色读取这份配置。显式 MCP `agent` 参数的优先级高于项目配置。

配置查找会从 `cwd` 向上查找，但不会越过最近的 Git 仓库根目录，防止意外继承其他项目的角色配置。

---

## 🔌 MCP Server 配置指南

将 AgentMesh 配置为 MCP Server，供主控 Agent（如 Antigravity、Codex、Claude Code、Cursor 等）调用。主控 Agent 负责规划和调用顺序；AgentMesh 负责角色解析、会话、上下文和底层 Agent 启动。

### 暴露的 MCP Tools

1. **`delegate_task`**
   - 让显式 Agent 或项目中分配给指定角色的 Agent 执行任务。
   - 参数：`task` (必填), `agent` (可选，省略时读取项目角色映射), `cwd` (可选), `role` (可选: `worker` | `reviewer` | `tester`), `mode` (可选: `auto` | `mcp` | `cli`), `timeoutMs` (可选，最大 3600000), `sessionId` (可选), `contextSessionIds` (可选，最多 4 个，按给定顺序一手注入多个 Bridge Session 的规范化历史), `contextSessionId` (可选，单源兼容形式), `baseCommit` (可选)。
2. **`review_changes`**
   - 调度指定 Agent 执行只读代码审查，强制遵循独立审查 Prompt 并返回结构化 PASS/FAIL 结果。
   - 参数：`agent` (可选，省略时读取 `roles.reviewer`), `task` (可选), `cwd` (可选), `baseCommit` (可选), `mode` (可选), `timeoutMs` (可选，最大 3600000), `contextSessionIds` (可选，最多 4 个，如同时注入 Worker 与 Tester 的结论), `contextSessionId` (可选，单源兼容形式)。
3. **`continue_task`**
   - 继续已有会话（Session Resume），并可同时注入其他会话的上下文。
   - 参数：`sessionId` (必填), `task` (必填), `contextSessionIds` (可选，最多 4 个，与该会话自身的历史续接并存，例如一手注入 Reviewer/Tester 的反馈), `mode` (可选), `timeoutMs` (可选，最大 3600000)。
4. **`list_agents`**
   - 查询所有支持的 Agent 及其在当前系统中的安装状态。
   - 无参数。
5. **`get_session`**
   - 查询指定 Bridge Session 的执行历史与元数据。
   - 参数：`sessionId` (必填)。
6. **`get_role_config`**
   - 加载并校验项目 `.agentmesh/config.json`，返回当前角色到 Agent 的映射。
   - 参数：`cwd` (可选，默认当前目录)。

### 配置到 MCP 客户端

#### 在 Antigravity, Claude Desktop 或 Cursor 中配置 (`mcp.json` 或 `claude_desktop_config.json`)：

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["d:/Project/Git Repository/AgentMesh/dist/cli/index.js", "serve"],
      "env": {
        "CODEX_BIN": "codex",
        "CLAUDE_BIN": "claude"
      }
    }
  }
}
```

配置完成后，Orchestrator 会自动启动 AgentMesh MCP Server，并按需要调用：

```text
delegate_task(role=worker) → 返回 Worker Session
review_changes(contextSessionIds=[Worker Session]) → 独立审查
delegate_task(role=tester, contextSessionIds=[Worker Session, Reviewer Session]) → 测试验证
continue_task(Worker Session, contextSessionIds=[Reviewer Session, Tester Session], task=修复要求) → 原 Worker 会话一手接收全部反馈
```

这段调用顺序由 Orchestrator 决定；AgentMesh 不会再建立第二套自动工作流状态机，也不会把 Reviewer/Tester 结果自动追加到 Worker Session。

`contextSessionIds`（最多 4 个）按给定顺序把多个来源 Session 的规范化历史**一手**注入目标 prompt，每个来源渲染为带独立标签的块（Session ID、Agent、轮数）并**各自计算** `MATCHED` / `STALE` / `UNKNOWN` 新鲜度——接收方可以精确知道哪些来源可信、哪些需要重验，而不必经过 Orchestrator 在任务文本里转述。注入内容有全局字符预算（24k，按源均分），超限会先丢弃较旧轮次并显式标注 `[truncated]` / `[N older turn(s) omitted]`；该轮实际注入了哪些来源会记录在历史条目的 `contextSources` 字段中，便于复盘。`contextSessionId` 仍是可用的单源兼容形式。会话自身的原生续接与外部来源注入是并存的：`continue_task` 有原生 Session ID 时只免除自身历史的注入，`contextSessionIds` 指定的其他来源照常注入。

每次执行都会在 Session 历史中记录调用前后的 Git HEAD、工作树内容指纹、变更文件、传输方式、退出码和耗时。交接时 AgentMesh 将当前指纹与各来源 Session 最后一轮指纹比较，明确标记为 `MATCHED`、`STALE` 或 `UNKNOWN`：只有 `MATCHED` 可以直接复用已有结论，`STALE` 只要求重新验证受影响的证据，从而减少无关的重复检查。旧 Session 没有证据字段时仍可加载，但交接状态为 `UNKNOWN`。Orchestrator 需要完整未截断的 `finalAnswer` 时应调用 `get_session`（Session 存储保留全文；工具响应中的 `Final Answer` 截断到 12000 字符）。

### 长任务超时

AgentMesh Tool 的 `timeoutMs` 控制底层 Agent 进程或 Agent 原生 MCP 调用，不会修改 Orchestrator 自身 MCP 客户端的 request timeout。长任务必须同时满足：

```text
Orchestrator MCP request timeout > AgentMesh timeoutMs > 预期 Agent 执行时间
```

未显式传入 `timeoutMs` 且项目角色配置也未设置时，AgentMesh 会对底层执行应用 10 分钟（600000ms）的默认超时（`DEFAULT_RUN_TIMEOUT_MS`），避免挂死的 Agent 进程无限占用请求；程序化使用时可通过 `MultiAgentRunner` 的 `RunnerOptions.defaultTimeoutMs` 覆盖。

AgentMesh 在客户端请求 Progress 时会在任务开始、每 15 秒和完成时发送标准 MCP Progress 通知。使用 MCP SDK 直接调用时，应同时注册进度回调、允许进度重置空闲超时，并设置总超时上限：

```ts
await client.callTool(params, undefined, {
  timeout: 30_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 360_000,
  onprogress: ({ message }) => console.log(message),
});
```

> **注意**：请只通过 `onprogress` 回调接收进度。不要再额外调用 `setNotificationHandler(ProgressNotificationSchema, ...)` 注册全局进度处理器——在实测的 TS SDK 行为中，全局处理器会接管进度路由，`onprogress` 不再触发，`resetTimeoutOnProgress` 也随之失效，客户端会在基础超时处误判请求超时。

### 客户端取消与断连

MCP 客户端**请求超时或发送取消通知**时，AgentMesh 会终止底层 Agent 进程树（Windows 上 `taskkill /T /F`），该轮执行在 Bridge Session 历史中记录为失败并保留执行证据（`Run cancelled by the requesting client.`），不会留下"代码已修改但会话无记录"的孤儿状态；取消后 `auto` 模式不会再用 CLI 重跑同一任务。

边界：如果客户端**直接关闭连接**（而非超时/取消），MCP SDK 的 stdio 客户端会立即终止 AgentMesh 服务进程，服务端可能来不及写入该轮记录。编排方应依赖请求超时 + 取消通知来取消长任务，而不是强行断开。

### 结果中的原始诊断输出

MCP 工具响应在 `Summary` / `Final Answer` 之外，还会包含截断到 8000 字符的 `Raw Output` 段（vendor CLI 的原始输出与 stderr），用于远程排查底层 Agent 失败；当原始输出与最终回答一致时该段省略。

具体配置入口取决于 Orchestrator；若客户端不请求 Progress 且固定在较短超时，即使 `.agentmesh/config.json` 已设置更长的 `timeoutMs`，外层请求仍会先取消。同步 MCP 链路通过 Progress 提供实时状态和失败结果；跨请求或离线 webhook 不属于当前本地 stdio Bridge 的职责。

---

## 📐 架构设计

```text
MCP Client / 主控 Agent (Antigravity / Codex / Claude Code)
         │ (stdio JSON-RPC)
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentMesh MCP Server                     │
│ (delegate_task, review_changes, continue_task, config...)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Core Runner                         │
│  - SessionManager (轻量 Bridge 会话持久化与状态跟踪)        │
│  - ProjectConfig (.agentmesh/config.json 角色映射)          │
│  - PromptBuilder (Reviewer 独立评审规则与格式约束)          │
│  - Executor (跨平台子进程调度与超时保护)                   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        Adapters                             │
│   ├── CodexAdapter (MCP: codex mcp-server / CLI: exec)      │
│   ├── ClaudeAdapter (MCP: claude mcp serve / CLI: -p)       │
│   ├── AntigravityAdapter (CLI: agy -p / gemini -p)          │
│   ├── GrokAdapter (CLI: grok -p)                            │
│   ├── OpenCodeAdapter (CLI: opencode run --auto)            │
│   └── ZCodeAdapter (CLI: zcode)                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧪 自动化测试

```bash
# 按仓库规则格式化全部受支持文件
npm run format

# 仅检查格式，不修改文件
npm run format:check

# 运行单元测试和内存内 MCP 协议测试
npm test

# 执行覆盖率门槛
npm run test:coverage

# 通过真实子进程调用假的 Agent CLI，验证参数、JSON 与会话交接
npm run test:integration

# 打包、安装到临时消费项目，并验证导出、版本和 CLI
npm run test:package

# 运行类型感知 ESLint
npm run lint

# 检查严格 TypeScript 类型安全
npm run typecheck

# 执行格式、Lint、类型、分层测试、构建和发布包验证
npm run check
```

VS Code 在安装推荐的 Prettier 扩展后会按 `.prettierrc.json` 在保存时格式化。Husky 的 pre-commit hook 会通过 lint-staged 格式化并检查暂存文件，再执行类型检查；GitHub Actions 会在 Ubuntu 与 Windows 的 Node.js 22/24 矩阵中执行完整校验。依赖统一从 npm 官方仓库解析，Dependabot 定期提交 npm 与 GitHub Actions 更新。

---

## 📄 授权协议

MIT License.
