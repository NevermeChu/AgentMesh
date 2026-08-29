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
  ReviewerSafetyPolicy,
  ReviewerSafetyReport,
} from "./agents/types.js";

export type {
  BridgeSession,
  SessionHistoryEntry,
  RepositoryStateEvidence,
  SessionExecutionEvidence,
  SharedContextAudit,
  HandoffSummary,
  SessionManagerOptions,
  RunnerOptions,
} from "./core/types.js";

// Adapters
export { BaseAdapter } from "./agents/base.js";
export { CodexAdapter, buildCodexMcpToolCall } from "./agents/codex.js";
export type { CodexMcpToolCall } from "./agents/codex.js";
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
  /**
   * @deprecated cmd.exe does not honor backslash escaping; these helpers are
   * retained only for backwards compatibility and are not used internally.
   */
  escapeCmdArg,
  /**
   * @deprecated cmd.exe does not honor backslash escaping; these helpers are
   * retained only for backwards compatibility and are not used internally.
   */
  buildCmdCommandLine,
  resolveCommandInvocation,
  buildChildEnvironment,
  ProcessExecutionError,
} from "./core/executor.js";
export type { CommandInvocation, ExecutionOptions, ExecutionResult } from "./core/executor.js";

export { executeViaMcpClient } from "./core/mcp-client.js";
export type { McpClientExecutionOptions, McpClientExecutionResult } from "./core/mcp-client.js";

export {
  buildRolePrompt,
  buildReviewerPrompt,
  buildTesterPrompt,
  buildContinuationPrompt,
  buildHandoffContract,
  stripAnsi,
  extractSummary,
  parseReviewOutput,
} from "./core/prompts.js";
export type { ParsedReviewOutput } from "./core/prompts.js";
export { parseHandoffReport } from "./core/handoff.js";
export { VERSION } from "./version.js";

export { SessionManager, defaultSessionManager } from "./core/session.js";
export { captureRepositoryState } from "./core/repository.js";
export { truncateText, estimateTokens, truncateTextToTokenBudget } from "./core/text.js";
export { findProjectConfigPath, loadProjectConfig, resolveRoleAssignment } from "./core/config.js";
export type {
  AgentMeshProjectConfig,
  ConfigurableRole,
  LoadedProjectConfig,
  RoleAssignment,
} from "./core/config.js";

export {
  MultiAgentRunner,
  AgentMeshRunner,
  defaultRunner,
  DEFAULT_RUN_TIMEOUT_MS,
  buildSharedContext,
  buildSharedContextDetailed,
  computeSessionFreshness,
} from "./core/runner.js";
export type {
  DelegateTaskParams,
  ReviewChangesParams,
  ContinueTaskParams,
  ContextFreshness,
  SessionTurnContext,
  SessionTurnContextField,
} from "./core/runner.js";

// MCP Server
export { createMcpServer, startMcpServer } from "./mcp/server.js";
export type { McpServerOptions } from "./mcp/server.js";
export { registerMcpTools } from "./mcp/tools.js";
