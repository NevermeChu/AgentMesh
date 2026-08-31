[English](README.md) | **简体中文**

# AgentMesh

> 把不同第一方 Agent Harness 暴露成统一 MCP Tool 的本地桥接与编排网格层。
>
> A local bridge that exposes first-party coding agents (Codex, Claude Code, Antigravity, Grok, OpenCode, ZCode) as unified MCP tools.

**AgentMesh** 允许主控 Agent（Orchestrator）通过标准 **Model Context Protocol (MCP)** 调用其他厂商的第一方 Coding Agent，而不是直接对接各家底层模型 API。各厂商的 Harness、订阅额度与工具链保持不变；任务拆分与编排决策归主控 Agent 所有，AgentMesh 只负责角色解析、执行、会话与规范化交接。

## 核心能力

跨厂商多 Agent 协作缺少统一的会话续接、上下文传递与结果复核入口，AgentMesh 用一层薄的本地桥接补齐：

- 🔌 **统一 MCP 入口**：8 个结构化 MCP Tools（`delegate_task` / `review_changes` / `continue_task` / `get_session_context` 等）；优先连接厂商原生 MCP Server，不可用时自动降级 Headless CLI。
- 🧵 **可审计的会话与交接**：轻量 Bridge Session 持久化；跨角色上下文注入带 SHA-256 审计、token 预算与逐轮新鲜度标记（`MATCHED` / `REWOUND` / `STALE` / `UNKNOWN`）。
- 📐 **结构化 Handoff 契约**：固定的 Goal / Decisions / Files / Blockers 小节；Blocker 携带机器可读的升级路由信号；产物声称经落盘一致性校验。
- 🛡️ **诚实的失败语义**：进程退出码与语义状态分离；结构化错误传播、传输回退留痕；Reviewer 结论 fail-closed 解析。
- 🖥️ **本地单机**：stdio 传输、无守护进程、无网络层，生命周期跟随 MCP 连接。

## 支持的 Agent

| Agent                 | 首选模式                     | 降级模式                             |
| :-------------------- | :--------------------------- | :----------------------------------- |
| codex（OpenAI Codex） | MCP（`codex mcp-server`）    | CLI（`codex exec` / `codex review`） |
| claude（Claude Code） | CLI（`claude -p`）           | —                                    |
| antigravity（Google） | CLI（`agy -p`）              | —                                    |
| grok（xAI）           | CLI（`grok -p`）             | —                                    |
| opencode              | CLI（`opencode run --auto`） | —                                    |
| zcode                 | CLI（`zcode`）               | —                                    |

传输细节、Reviewer 沙箱限制与 Windows 平台差异见 [docs/GUIDE.md](docs/GUIDE.md)。

## 非目标

不是编排器（无 DAG / 调度 / 自动重试）、不是守护进程、不是安全沙箱、不是双向消息通道、不管凭证与额度、不是远程服务。完整边界与判断标准见 [docs/GUIDE.md](docs/GUIDE.md#非目标与边界)。

## 快速开始

要求 Node.js ≥ 22.13。

```bash
git clone https://github.com/NevermeChu/AgentMesh.git
cd AgentMesh && npm ci && npm run build

# 检查本机 Agent CLI 可用性
node dist/cli/index.js list
```

在 MCP 客户端（Antigravity / Claude Desktop / Cursor 等）中注册：

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["/path/to/AgentMesh/dist/cli/index.js", "serve"]
    }
  }
}
```

之后由主控 Agent 自动调用 MCP Tools 编排任务。项目级角色映射（`.agentmesh/config.json`）、全部工具参数、超时与取消语义见 [docs/GUIDE.md](docs/GUIDE.md)。

## 文档

| 文档                           | 内容                                                                   |
| :----------------------------- | :--------------------------------------------------------------------- |
| [docs/GUIDE.md](docs/GUIDE.md) | CLI 管理、角色配置、MCP Tools 完整参数、架构设计、测试与无损交接工具链 |
| [PROBLEMS.md](PROBLEMS.md)     | 真实链路已确认的问题、修复状态与平台限制                               |
| [CHANGELOG.md](CHANGELOG.md)   | 版本变更记录                                                           |
| [real_test.md](real_test.md)   | 真实多 Agent 测试轮的交接质量与资源证据                                |

## 授权协议

[MIT](LICENSE)
