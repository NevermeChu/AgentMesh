# AgentMesh (Multi-Agent Bridge MVP)

> **把不同第一方 Agent Harness 暴露成统一 MCP Tool 的本地桥接与编排网格层。**

**AgentMesh** 允许主控 Agent（如 Antigravity / Codex / Claude Code）通过标准 **Model Context Protocol (MCP)** 协议和统一的 **CLI 接口** 调用其他厂商的第一方 Coding Agent，而不是直接调用各家的模型底层 API。保留各厂商的 Harness、订阅额度和工具链。

---

## 🌟 核心特性

- 🔌 **官方连接优先 (Official MCP Preferred)**：支持直接连接底层 Agent 的原生 MCP Server（如 `codex mcp-server`、`claude mcp serve`），并在不可用时自动无缝降级为 Headless CLI。
- 🛡️ **健壮容错与防崩溃**：当底层 Agent 未安装、未登录、额度不足或执行失败时，安全捕获错误并返回结构化诊断，绝对不会导致 MCP Server 崩溃退出。
- 🔍 **独立 Reviewer 规范**：内置代码评审提示词模板与只读权限约束（如 Codex `--sandbox read-only`）；无法解析为 `PASS` / `FAIL` 的结果按失败处理，避免误报通过。
- 🧵 **轻量 Session 跟踪**：支持 `continue_task` 继续先前的会话，实现 `Worker 实现 -> Reviewer 审查 -> 原 Session 修复` 的多 Agent 协作闭环。
- 💻 **双模运行 (MCP + CLI)**：既可以通过 stdio 作为 MCP Server 被各大 IDE / Agent 挂载，也可以作为独立 CLI 工具用于调试与自动化脚本。

---

## 🤖 支持的 Agent 矩阵

| Agent 名称 | 别名 (Aliases) | 默认二进制 | 首选模式 (Preferred) | 降级/备选模式 (Fallback) | 环境变量覆盖 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`codex`** | `openai-codex`, `codex-cli` | `codex` | MCP (`codex mcp-server`) | CLI (`codex exec` / `codex review`) | `CODEX_BIN` |
| **`claude`** | `claude-code`, `anthropic-claude` | `claude` | MCP (`claude mcp serve`) | CLI (`claude -p`) | `CLAUDE_BIN` |
| **`antigravity`** | `gemini`, `agy`, `google-gemini` | `agy` / `gemini` | CLI (`agy -p`) | 自定义命令 | `AGY_BIN` / `GEMINI_BIN` |
| **`grok`** | `xai-grok`, `grok-cli`, `grok-build`| `grok` | CLI (`grok -p`) | 自定义命令 | `GROK_BIN` |
| **`opencode`** | `opencode-ai`, `opencode-cli` | `opencode` | CLI (`opencode run --auto`) | MCP Wrapper | `OPENCODE_BIN` |
| **`zcode`** | `z-code`, `zcode-cli` | `zcode` | CLI (`zcode <prompt>`) | 自定义命令 | `ZCODE_BIN` |

> Claude Reviewer 在 `auto` 模式下会从 MCP 自动降级到 CLI，并移除 Bash/Edit/Write 等可写工具。显式指定 `mode=mcp` 的 Claude Reviewer 会返回错误，因为该路径目前无法建立可靠的只读边界。标记为 `prompt-only` 的适配器只能提供提示词约束，不能视为运行时沙箱。

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

## 🛠️ CLI 使用示例

### 1. 委托任务 (`run`)
```bash
# 使用 Codex 执行代码编写
node dist/cli/index.js run codex "为用户模块添加邮箱验证功能"

# 使用 Claude Code 执行特定目录下的任务
node dist/cli/index.js run claude "修复 package.json 中的依赖版本冲突" --cwd ./my-project

# 强制指定传输模式为 cli 或 mcp
node dist/cli/index.js run codex "重构 database 连接池" --mode cli
```

### 2. 独立代码审查 (`review`)
```bash
# 让 Grok 进行独立代码评审
node dist/cli/index.js review grok "重点检查 SQL 注入与鉴权漏洞"

# 针对特定基准分支进行对比评审
node dist/cli/index.js review codex --base main
```

### 3. 继续已有会话 (`continue`)
```bash
# 当 Reviewer 发现问题时，使用先前 Worker 返回的 Session ID 继续修复
node dist/cli/index.js continue bridge-sess_8f3d1a "根据 Reviewer 的反馈，修复第 45 行空指针异常"
```

---

## 🔌 MCP Server 配置指南

将 AgentMesh 配置为 MCP Server，供主控 Agent（如 Antigravity, Claude Desktop, Cursor, Codex 等）调用。

### 暴露的 MCP Tools

1. **`delegate_task`**
   - 让指定 Agent 执行任务。
   - 参数：`agent` (必填), `task` (必填), `cwd` (可选), `role` (可选: `worker` | `reviewer` | `tester`), `mode` (可选: `auto` | `mcp` | `cli`), `sessionId` (可选)。
2. **`review_changes`**
   - 调度指定 Agent 执行只读代码审查，强制遵循独立审查 Prompt 并返回结构化 PASS/FAIL 结果。
   - 参数：`agent` (必填), `task` (可选), `cwd` (可选), `baseCommit` (可选), `mode` (可选)。
3. **`continue_task`**
   - 继续已有会话（Session Resume）。
   - 参数：`sessionId` (必填), `task` (必填), `mode` (可选)。
4. **`list_agents`**
   - 查询所有支持的 Agent 及其在当前系统中的安装状态。
5. **`get_session`**
   - 查询指定 Bridge Session 的执行历史与元数据。

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

---

## 📐 架构设计

```text
MCP Client / 主控 Agent (Antigravity / Codex / Claude Code)
         │ (stdio JSON-RPC)
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentMesh MCP Server                     │
│    (tools: delegate_task, review_changes, continue_task)    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Core Runner                         │
│  - SessionManager (轻量 Bridge 会话持久化与状态跟踪)        │
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
