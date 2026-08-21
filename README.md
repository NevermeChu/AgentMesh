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

| Agent 名称 | 别名 (Aliases) | 默认二进制 | 首选模式 (Preferred) | 降级/备选模式 (Fallback) | 环境变量覆盖 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`codex`** | `openai-codex`, `codex-cli` | `codex` | MCP (`codex mcp-server`) | CLI (`codex exec` / `codex review`) | `CODEX_BIN` |
| **`claude`** | `claude-code`, `anthropic-claude` | `claude` | MCP (`claude mcp serve`) | CLI (`claude -p`) | `CLAUDE_BIN` |
| **`antigravity`** | `gemini`, `agy`, `google-gemini`, `google-antigravity` | `agy` / `gemini` | CLI (`agy -p`) | — | `AGY_BIN` / `GEMINI_BIN` |
| **`grok`** | `xai-grok`, `grok-cli`, `grok-build`| `grok` | CLI (`grok -p`) | — | `GROK_BIN` |
| **`opencode`** | `opencode-ai`, `opencode-cli` | `opencode` | CLI (`opencode run --auto`) | — | `OPENCODE_BIN` |
| **`zcode`** | `z-code`, `zcode-cli` | `zcode` | CLI (`zcode <prompt>`) | — | `ZCODE_BIN` |

> Claude Reviewer 在 `auto` 模式下会从 MCP 自动降级到 CLI，并移除 Bash/Edit/Write 等可写工具。显式指定 `mode=mcp` 的 Claude Reviewer 会返回错误，因为该路径目前无法建立可靠的只读边界。Antigravity Reviewer 在非 Windows 平台使用原生 `--sandbox` 与 `plan` 模式；Windows 上因原生沙箱可能在受保护工具链路径初始化失败，目前降级为 `plan` + `prompt-only`。所有标记为 `prompt-only` 的适配器都不能视为运行时只读沙箱。

> 底层 Agent CLI 只需已经安装、可执行并完成各自所需的登录或授权，不需要全部预先启动。AgentMesh 在收到任务后只会按角色配置启动本次使用的 CLI 或原生 MCP Server。

---

## 🚀 快速开始

### 1. 安装与构建

```bash
# 安装依赖
npm install

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
      "timeoutMs": 300000
    },
    "tester": "claude"
  }
}
```

同一 Agent 可以配置到多个角色。Worker、Reviewer、Tester 启动新的角色任务时会创建独立的 Bridge Session，因此同一 CLI 的不同会话可以同时承担不同角色；显式传入 `sessionId` 时则继续并校验已有 Session。`orchestrator` 用于记录项目的主控 Agent，不会替代三个可执行角色。

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
   - 参数：`task` (必填), `agent` (可选，省略时读取项目角色映射), `cwd` (可选), `role` (可选: `worker` | `reviewer` | `tester`), `mode` (可选: `auto` | `mcp` | `cli`), `timeoutMs` (可选，最大 3600000), `sessionId` (可选), `contextSessionId` (可选，用于共享另一个 Bridge Session 的规范化历史), `baseCommit` (可选)。
2. **`review_changes`**
   - 调度指定 Agent 执行只读代码审查，强制遵循独立审查 Prompt 并返回结构化 PASS/FAIL 结果。
   - 参数：`agent` (可选，省略时读取 `roles.reviewer`), `task` (可选), `cwd` (可选), `baseCommit` (可选), `mode` (可选), `timeoutMs` (可选，最大 3600000), `contextSessionId` (可选，用于继承一个 Worker/Tester Bridge Session 的规范化上下文)。
3. **`continue_task`**
   - 继续已有会话（Session Resume）。
   - 参数：`sessionId` (必填), `task` (必填), `mode` (可选), `timeoutMs` (可选，最大 3600000)。
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
      "args": [
        "d:/Project/Git Repository/AgentMesh/dist/cli/index.js",
        "serve"
      ],
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
review_changes(contextSessionId=Worker Session) → 独立审查
delegate_task(role=tester, contextSessionId=Reviewer Session) → 测试验证
continue_task(Worker Session, task=Orchestrator 整理的审查/测试反馈) → 原 Worker 会话修复
```

这段调用顺序由 Orchestrator 决定；AgentMesh 不会再建立第二套自动工作流状态机。`contextSessionId` 一次引用一个 Bridge Session，并把该 Session 的规范化历史注入目标角色；它不会合并所有会话，也不会把 Reviewer/Tester 结果自动追加到 Worker Session。

### 长任务超时

AgentMesh Tool 的 `timeoutMs` 控制底层 Agent 进程或 Agent 原生 MCP 调用，不会修改 Orchestrator 自身 MCP 客户端的 request timeout。长任务必须同时满足：

```text
Orchestrator MCP request timeout > AgentMesh timeoutMs > 预期 Agent 执行时间
```

例如使用 MCP SDK 直接调用时，应在客户端调用选项中另外设置请求超时：

```ts
await client.callTool(params, undefined, { timeout: 360_000 });
```

具体配置入口取决于 Orchestrator；若客户端固定在较短超时，即使 `.agentmesh/config.json` 已设置更长的 `timeoutMs`，外层请求仍会先取消。

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
# 运行单元测试与集成测试
npm test

# 检查严格 TypeScript 类型安全
npm run typecheck
```

---

## 📄 授权协议

MIT License.
