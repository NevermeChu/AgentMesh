// Types
export type {
  AgentName,
  AgentRole,
  TransportMode,
  RunAgentOptions,
  ContinueAgentOptions,
  AgentResult,
  AgentExecutableInfo,
  AgentAdapter,
  ReviewFinding,
} from "./agents/types.js";

export type {
  BridgeSession,
  SessionHistoryEntry,
  SessionManagerOptions,
  RunnerOptions,
} from "./core/types.js";

// Adapters
export { BaseAdapter } from "./agents/base.js";
export { CodexAdapter } from "./agents/codex.js";
export { ClaudeAdapter } from "./agents/claude.js";
export { AntigravityAdapter } from "./agents/antigravity.js";
export { GrokAdapter } from "./agents/grok.js";
export { OpenCodeAdapter } from "./agents/opencode.js";
export { ZCodeAdapter } from "./agents/zcode.js";
export { AgentRegistry, defaultRegistry } from "./agents/registry.js";

// Core
export {
  executeCommand,
  findExecutableOnPath,
  isCommandAvailable,
  escapeCmdArg,
  buildCmdCommandLine,
  ProcessExecutionError,
} from "./core/executor.js";
export type { ExecutionOptions, ExecutionResult } from "./core/executor.js";

export { executeViaMcpClient } from "./core/mcp-client.js";
export type {
  McpClientExecutionOptions,
  McpClientExecutionResult,
} from "./core/mcp-client.js";

export {
  buildRolePrompt,
  buildReviewerPrompt,
  buildTesterPrompt,
  buildContinuationPrompt,
  stripAnsi,
  extractSummary,
  parseReviewOutput,
} from "./core/prompts.js";
export type { ParsedReviewOutput } from "./core/prompts.js";

export { SessionManager, defaultSessionManager } from "./core/session.js";

export {
  MultiAgentRunner,
  AgentMeshRunner,
  defaultRunner,
} from "./core/runner.js";
export type {
  DelegateTaskParams,
  ReviewChangesParams,
  ContinueTaskParams,
} from "./core/runner.js";

// MCP Server
export { createMcpServer, startMcpServer } from "./mcp/server.js";
export type { McpServerOptions } from "./mcp/server.js";
export { registerMcpTools } from "./mcp/tools.js";
