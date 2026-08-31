**English** | [简体中文](README.zh-CN.md)

# AgentMesh

> A local bridge that exposes first-party coding-agent harnesses (Codex, Claude Code, Antigravity, Grok, OpenCode, ZCode) as unified MCP tools.
>
> 把不同第一方 Agent Harness 暴露成统一 MCP Tool 的本地桥接与编排网格层。

**AgentMesh** lets an orchestrator agent (e.g. Antigravity, Codex, Claude Code) drive other vendors' first-party coding agents through the standard **Model Context Protocol (MCP)**, instead of talking to raw model APIs. Each vendor keeps its own harness, subscription quota, and toolchain. Task decomposition and orchestration decisions belong to the orchestrator; AgentMesh owns role resolution, execution, sessions, and normalized handoffs.

## Core Capabilities

Cross-vendor multi-agent work lacks a unified entry point for session resume, context passing, and result verification; AgentMesh fills that with a thin local bridge:

- 🔌 **Unified MCP entry** — 8 structured MCP tools (`delegate_task`, `review_changes`, `continue_task`, `get_session_context`, …). Prefers vendors' native MCP servers and degrades to headless CLI automatically when unavailable.
- 🧵 **Auditable sessions and handoffs** — lightweight Bridge Session persistence; cross-role context injection with SHA-256 audit trails, token budgets, and per-turn freshness markers (`MATCHED` / `REWOUND` / `STALE` / `UNKNOWN`).
- 📐 **Structured handoff contract** — fixed `Goal / Decisions / Files / Blockers` sections; blockers carry machine-readable escalation routing; artifact claims are grounding-checked against the working tree.
- 🛡️ **Honest failure semantics** — process exit status is kept separate from semantic status; structured error propagation and persisted transport-fallback evidence; reviewer verdicts are parsed fail-closed.
- 🖥️ **Local, single-machine** — stdio transport, no daemon, no network layer; the lifecycle follows the MCP connection.

## Supported Agents

| Agent                | Preferred                   | Fallback                            |
| :------------------- | :-------------------------- | :---------------------------------- |
| codex (OpenAI Codex) | MCP (`codex mcp-server`)    | CLI (`codex exec` / `codex review`) |
| claude (Claude Code) | CLI (`claude -p`)           | —                                   |
| antigravity (Google) | CLI (`agy -p`)              | —                                   |
| grok (xAI)           | CLI (`grok -p`)             | —                                   |
| opencode             | CLI (`opencode run --auto`) | —                                   |
| zcode                | CLI (`zcode`)               | —                                   |

Transport details, reviewer sandbox limitations, and Windows platform differences are documented in [docs/GUIDE.md](docs/GUIDE.md) (Chinese).

## Non-Goals

Not an orchestrator (no DAG / scheduling / automatic retry), not a daemon, not a security sandbox, not a bidirectional messaging channel, no credential or quota management, not a remote service. Full boundaries and the design criterion live in [docs/GUIDE.md](docs/GUIDE.md#非目标与边界) (Chinese).

## Quick Start

Requires Node.js ≥ 22.13.

```bash
git clone https://github.com/NevermeChu/AgentMesh.git
cd AgentMesh && npm ci && npm run build

# Check availability of local agent CLIs
node dist/cli/index.js list
```

Register AgentMesh with your MCP client (Antigravity / Claude Desktop / Cursor, etc.):

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

The orchestrator agent then drives everything through the MCP tools. Project-level role mapping (`.agentmesh/config.json`), full tool parameters, and timeout/cancellation semantics are documented in [docs/GUIDE.md](docs/GUIDE.md).

## Documentation

| Document                       | Contents                                                                                                                                     |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/GUIDE.md](docs/GUIDE.md) | CLI management, role configuration, full MCP tool parameters, architecture, tests, and the lossless-handoff verification toolchain (Chinese) |
| [PROBLEMS.md](PROBLEMS.md)     | Confirmed real-link issues, fix status, and platform limitations (Chinese)                                                                   |
| [CHANGELOG.md](CHANGELOG.md)   | Release notes                                                                                                                                |
| [real_test.md](real_test.md)   | Handoff quality and resource evidence from real multi-agent test rounds (Chinese)                                                            |

## License

[MIT](LICENSE)
