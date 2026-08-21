请实现一个本地运行的 **Multi-Agent Bridge MVP**，用于让一个主控 Agent 通过 MCP 调用其他厂商已有的 Coding Agent / CLI，而不是直接调用各家的模型 API。

## 1. 核心目标

项目要解决的问题是：

不同厂商的订阅额度通常绑定各自的 Harness，例如：

- GPT → Codex
- Gemini → Antigravity / AGY
- Grok → Grok CLI / Grok Build
- Claude → Claude Code

因此不要尝试把这些订阅转换成通用 API，也不要重新实现 Coding Agent Harness。

本项目只负责提供一个统一的 **Agent 调用桥接层**。

整体架构：

```text
主控 Agent
Codex / Antigravity / Claude Code 等
        │
        │ MCP
        ▼
Multi-Agent Bridge
        │
        ├── Codex Adapter
        │     └── codex exec / 官方支持接口
        │
        ├── Gemini Adapter
        │     └── agy -p
        │
        └── Grok Adapter
              └── grok -p
```

MVP 第一版只支持：

- Codex
- Antigravity / AGY
- Grok

暂时不要支持 Claude Code、OpenCode、ZCode 等，架构上保留扩展能力即可。

---

## 2. 技术栈

使用：

- TypeScript
- Node.js
- 官方 MCP TypeScript SDK
- Zod
- `child_process.spawn`

要求：

- 不使用 `any`
- 模块职责清晰
- Adapter 可扩展
- 不要过度抽象
- 不要实现 Web UI
- 不要实现后台常驻服务
- 第一版使用 stdio MCP transport

同时提供一个简单 CLI，用于脱离 MCP 单独调试各 Agent。

---

## 3. 项目结构建议

```text
multi-agent-bridge/
├─ src/
│  ├─ agents/
│  │  ├─ types.ts
│  │  ├─ codex.ts
│  │  ├─ antigravity.ts
│  │  └─ grok.ts
│  │
│  ├─ core/
│  │  ├─ runner.ts
│  │  ├─ session.ts
│  │  └─ result.ts
│  │
│  ├─ mcp/
│  │  └─ server.ts
│  │
│  ├─ cli/
│  │  └─ index.ts
│  │
│  └─ index.ts
│
├─ package.json
├─ tsconfig.json
└─ README.md
```

可以根据实际实现调整，但保持：

```text
MCP / CLI
    ↓
Core Runner
    ↓
Agent Adapter
```

三层职责分离。

---

## 4. Adapter 设计

所有 Agent Adapter 实现统一接口，例如：

```ts
interface AgentAdapter {
  readonly name: AgentName;

  run(options: RunAgentOptions): Promise<AgentResult>;

  continue?(options: ContinueAgentOptions): Promise<AgentResult>;
}
```

统一输入至少包括：

```ts
type RunAgentOptions = {
  task: string;
  cwd: string;
  role: "worker" | "reviewer" | "tester";
};
```

统一输出类似：

```ts
type AgentResult = {
  status: "success" | "failed";
  agent: AgentName;
  summary: string;
  output: string;
  sessionId?: string;
  exitCode?: number;
};
```

不要把各 CLI 原始返回格式暴露给 MCP 调用方。

Adapter 内部负责：

- 构造 CLI 参数
- 启动子进程
- 收集 stdout / stderr
- 转换统一结果
- 处理退出码
- 处理可恢复 session（如果官方 CLI 支持）

---

## 5. 第一版 MCP Tools

MVP 暴露以下几个 Tool。

### `delegate_task`

让某个 Agent 执行任务。

输入：

```text
agent
task
cwd
role
```

例如：

```text
agent = codex
role = worker
task = 实现项目邀请撤销功能
```

---

### `review_changes`

调用独立 Reviewer 检查当前代码修改。

默认：

```text
role = reviewer
```

Reviewer 提示词必须明确：

- 独立检查代码
- 不依赖 Worker 的自我总结
- 优先查看 git diff
- 检查 correctness
- regression
- security
- edge cases
- missing tests
- architecture violations
- 不修改文件

返回尽量结构化为：

```text
PASS
```

或者：

```text
FAIL

- severity
- file
- line
- issue
- suggestion
```

---

### `continue_task`

如果底层 Agent 支持 session resume，则继续已有任务。

输入：

```text
sessionId
task
```

主要用于：

```text
Codex 实现
↓
Grok Review
↓
发现问题
↓
继续原来的 Codex session 修复
```

如果某个 Adapter 暂不支持 session continuation，可以返回明确的 unsupported 错误。

---

## 6. CLI

同时提供简单 CLI，方便单独测试 Adapter。

例如：

```bash
multi-agent run codex "分析当前项目"
```

```bash
multi-agent run gemini "检查当前 git diff"
```

```bash
multi-agent review grok
```

CLI 和 MCP 必须共用同一套 Core Runner，不要复制逻辑。

---

## 7. 权限与角色

第一版先做基础角色约束。

### Worker

允许：

- read
- write
- shell
- test

### Reviewer

原则上：

- read only
- 可以执行只读 git 命令
- 可以运行测试
- 不应该修改源码

如果对应 CLI 有官方 sandbox / read-only 参数，应优先使用真正的权限限制，而不只是通过 prompt 要求 Reviewer 不修改。

如果某个平台暂时无法可靠限制写权限，在代码中明确记录这一限制。

---

## 8. Session

设计一个非常轻量的 session abstraction。

至少记录：

```ts
type BridgeSession = {
  id: string;
  agent: AgentName;
  nativeSessionId?: string;
  cwd: string;
  role: AgentRole;
  createdAt: string;
};
```

MVP 不需要数据库。

可以先使用：

- 内存 Map

或者：

- 本地 JSON 文件

优先选择最简单可靠的方案。

---

## 9. 不要实现的内容

第一版明确不要做：

- Web UI
- 用户系统
- 云端部署
- 数据库
- Agent 自动选择模型
- 自动成本计算
- 并行多 Worker
- DAG 工作流
- 自动无限 Review 循环
- 自己实现 LLM API
- 抽取或复用各家订阅 OAuth Token
- OpenAI / Gemini / Claude 非官方反向代理
- OpenCode 统一模型 Harness
- 完整工作流引擎

这个项目不是新的 OpenCode，也不是新的 Coding IDE。

它只是一个：

> **把不同第一方 Agent Harness 暴露成统一 MCP Tool 的薄桥接层。**

---

## 10. MVP 的目标工作流

最终至少能够支持：

```text
用户
 ↓
主控 Agent，例如 Antigravity
 ↓
delegate_task(codex)
 ↓
Codex 实现代码
 ↓
review_changes(grok)
 ↓
Grok 返回 FAIL
 ↓
continue_task(codex)
 ↓
Codex 修复
 ↓
review_changes(grok)
 ↓
PASS
 ↓
主控 Agent 汇总给用户
```

也应该允许反过来：

```text
Codex 主控
 ↓
delegate_task(gemini)
 ↓
review_changes(grok)
```

MCP Server 本身不要决定谁是 Worker、谁是 Reviewer。

**编排决策由上层 Orchestrator Agent 完成。**

---

## 11. 设计原则

重点遵循：

1. MCP 统一的是 **Agent 能力入口**，不是模型 API。
2. 保留各厂商自己的第一方 Harness。
3. Core 与 MCP 解耦。
4. CLI 与 MCP 共用 Core。
5. 每个 Agent 使用独立 Adapter。
6. Adapter 尽量使用官方 CLI / headless / MCP 能力。
7. 不依赖非官方 OAuth Token 提取或订阅反代。
8. 第一版以简单、稳定、可调试为优先。
9. 不过度工程化。
10. 为以后增加 Claude Code、OpenCode、ZCode 等 Adapter 保留清晰扩展点。

---

## 12. 完成标准

实现完成后应至少能够：

- 启动 stdio MCP Server
- 被支持 MCP 的主 Agent 注册
- 调用 Codex 执行一次任务
- 调用 AGY 执行一次任务
- 调用 Grok 执行一次任务
- 统一返回执行结果
- CLI 可以分别测试三个 Adapter
- 一个 Agent 执行失败时不会导致整个 MCP Server 崩溃
- cwd 能正确传递
- stdout / stderr 能正确处理
- README 给出安装、配置和 MCP 注册示例
- 至少为 Core Runner 和参数构造逻辑提供基础测试

优先先做一个真正能工作的 MVP，再考虑高级能力。
