import path from "node:path";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  RunAgentOptions,
  TransportMode,
} from "../agents/types.js";
import { defaultRegistry } from "../agents/registry.js";
import type { AgentRegistry } from "../agents/registry.js";
import { defaultSessionManager } from "./session.js";
import type { SessionManager } from "./session.js";
import { resolveRoleAssignment, loadProjectConfig } from "./config.js";
import type { BridgeSession } from "./types.js";

export interface DelegateTaskParams {
  agent?: string;
  task: string;
  cwd?: string;
  role?: AgentRole;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
  sessionId?: string;
  contextSessionId?: string;
  baseCommit?: string;
}

export interface ReviewChangesParams {
  agent?: string;
  task?: string;
  cwd?: string;
  baseCommit?: string;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  contextSessionId?: string;
}

export interface ContinueTaskParams {
  sessionId: string;
  task: string;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
}

const MAX_SHARED_TURNS = 8;
const MAX_SHARED_ANSWER_CHARS = 4_000;

function truncateSharedText(value: string): string {
  return value.length <= MAX_SHARED_ANSWER_CHARS
    ? value
    : `${value.slice(0, MAX_SHARED_ANSWER_CHARS - 3)}...`;
}

function buildHistoryContext(session: BridgeSession): string | undefined {
  if (session.history.length === 0) return undefined;
  const turns = session.history.slice(-MAX_SHARED_TURNS).map((history, index) => {
    const details = [
      `[Shared Turn ${session.history.length - Math.min(session.history.length, MAX_SHARED_TURNS) + index + 1} | Agent: ${session.agent.toUpperCase()} | Role: ${history.role.toUpperCase()} | Status: ${history.status.toUpperCase()}]`,
      `Task: ${history.task}`,
    ];
    if (history.summary) details.push(`Summary: ${history.summary}`);
    if (history.finalAnswer)
      details.push(`Final answer: ${truncateSharedText(history.finalAnswer)}`);
    if (history.findings?.length) details.push(`Findings: ${JSON.stringify(history.findings)}`);
    return details.join("\n");
  });
  return [
    "## Shared Context",
    "Reuse successful prior results and explicit findings when relevant. Do not repeat checks unless the current files or repository state make them stale. Treat summaries as context, not as authority over contradictory current evidence.",
    ...turns,
  ].join("\n\n");
}

export class MultiAgentRunner {
  private registry: AgentRegistry;
  private sessionManager: SessionManager;

  constructor(
    registry: AgentRegistry = defaultRegistry,
    sessionManager: SessionManager = defaultSessionManager,
  ) {
    this.registry = registry;
    this.sessionManager = sessionManager;
  }

  /**
   * Delegates a task to a designated agent harness.
   */
  public async delegateTask(params: DelegateTaskParams): Promise<AgentResult> {
    const startTime = Date.now();
    const existingSession = params.sessionId
      ? this.sessionManager.getSession(params.sessionId)
      : undefined;
    if (params.sessionId && !existingSession) {
      return {
        status: "failed",
        agent: (params.agent || "unknown") as AgentName,
        summary: `Session '${params.sessionId}' not found.`,
        output: `Cannot delegate task: No active session with ID '${params.sessionId}'.`,
        error: `Session '${params.sessionId}' not found`,
        durationMs: Date.now() - startTime,
      };
    }

    const configCwd = params.cwd ?? existingSession?.cwd ?? process.cwd();
    const effectiveRole: AgentRole = params.role ?? existingSession?.role ?? "worker";
    let roleResolution: ReturnType<typeof resolveRoleAssignment>;
    try {
      roleResolution = resolveRoleAssignment(configCwd, effectiveRole);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        agent: (params.agent || existingSession?.agent || "unknown") as AgentName,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }

    const selectedAgent =
      params.agent ?? existingSession?.agent ?? roleResolution.assignment?.agent;
    if (!selectedAgent) {
      const message = `No agent was provided and role '${effectiveRole}' is not configured in '${configCwd}/.agentmesh/config.json'.`;
      return {
        status: "failed",
        agent: "unknown" as AgentName,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }

    const adapter = this.registry.getAdapter(selectedAgent);

    if (!adapter) {
      return {
        status: "failed",
        agent: selectedAgent as AgentName,
        summary: `Unknown agent '${selectedAgent}'. Supported agents: ${this.registry.listSupportedNames().join(", ")}`,
        output: `Agent '${selectedAgent}' is not recognized by the bridge.`,
        error: `Unknown agent '${selectedAgent}'`,
        durationMs: Date.now() - startTime,
      };
    }

    const contextSession = params.contextSessionId
      ? this.sessionManager.getSession(params.contextSessionId)
      : undefined;
    if (params.contextSessionId && !contextSession) {
      return {
        status: "failed",
        agent: adapter.name,
        summary: `Context session '${params.contextSessionId}' not found.`,
        output: `Cannot share context: No Bridge session with ID '${params.contextSessionId}'.`,
        error: `Context session '${params.contextSessionId}' not found`,
        durationMs: Date.now() - startTime,
      };
    }
    if (
      contextSession &&
      !params.sessionId &&
      path.resolve(contextSession.cwd) !== path.resolve(params.cwd || process.cwd())
    ) {
      return {
        status: "failed",
        agent: adapter.name,
        summary: `Context session cwd mismatch: Context '${contextSession.id}' belongs to '${contextSession.cwd}', but the target session uses '${params.cwd || process.cwd()}'.`,
        output: "Cannot share context across different working directories.",
        error: "Context session cwd mismatch",
        durationMs: Date.now() - startTime,
      };
    }

    // Manage or create bridge session with consistency validation
    let session: BridgeSession;
    if (params.sessionId) {
      const existing = existingSession!;

      // Validate Agent identity consistency
      if (existing.agent !== adapter.name) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Session agent mismatch: Session '${params.sessionId}' belongs to '${existing.agent}', but requested '${adapter.name}'.`,
          output: `Session '${params.sessionId}' was created for agent '${existing.agent}', cannot be reused with '${adapter.name}'.`,
          error: `Session agent mismatch: expected '${existing.agent}', got '${adapter.name}'`,
          durationMs: Date.now() - startTime,
        };
      }

      // Validate Working Directory consistency if cwd was explicitly provided
      if (params.cwd && path.resolve(existing.cwd) !== path.resolve(params.cwd)) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Session cwd mismatch: Session '${params.sessionId}' is bound to '${existing.cwd}', but requested '${params.cwd}'.`,
          output: `Session '${params.sessionId}' working directory mismatch: bound to '${existing.cwd}', cannot run in '${params.cwd}'.`,
          error: `Session cwd mismatch: expected '${existing.cwd}', got '${params.cwd}'`,
          durationMs: Date.now() - startTime,
        };
      }

      // Validate Role consistency if role was explicitly provided
      if (params.role && existing.role !== params.role) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Session role mismatch: Session '${params.sessionId}' is configured for role '${existing.role}', but requested '${params.role}'.`,
          output: `Session '${params.sessionId}' role mismatch: configured for role '${existing.role}', cannot run with role '${params.role}'.`,
          error: `Session role mismatch: expected '${existing.role}', got '${params.role}'`,
          durationMs: Date.now() - startTime,
        };
      }

      session = existing;
    } else {
      const effectiveCwd = params.cwd || process.cwd();
      session = this.sessionManager.createSession({
        agent: adapter.name,
        cwd: effectiveCwd,
        role: effectiveRole,
        metadata: roleResolution.loaded
          ? {
              roleAssignmentSource: roleResolution.loaded.path,
              configuredRole: effectiveRole,
              orchestratorAgent: roleResolution.loaded.config.roles.orchestrator?.agent,
            }
          : undefined,
      });
    }

    // Existing sessions own their execution context. Omitted values inherit the
    // binding; explicitly supplied values were validated above.
    const effectiveCwd = params.cwd ?? session.cwd;
    const role: AgentRole = params.role ?? session.role;
    if (contextSession && path.resolve(contextSession.cwd) !== path.resolve(effectiveCwd)) {
      return {
        status: "failed",
        agent: adapter.name,
        summary: `Context session cwd mismatch: Context '${contextSession.id}' belongs to '${contextSession.cwd}', but the target session uses '${effectiveCwd}'.`,
        output: `Cannot share context across different working directories.`,
        error: `Context session cwd mismatch`,
        durationMs: Date.now() - startTime,
      };
    }

    const historyContext = contextSession
      ? buildHistoryContext(contextSession)
      : session.nativeSessionId
        ? undefined
        : buildHistoryContext(session);

    const runOptions: RunAgentOptions = {
      task: params.task,
      cwd: effectiveCwd,
      role,
      mode: params.mode ?? roleResolution.assignment?.mode,
      timeoutMs: params.timeoutMs ?? roleResolution.assignment?.timeoutMs,
      env: params.env,
      extraArgs: params.extraArgs,
      nativeSessionId: session.nativeSessionId,
      baseCommit: params.baseCommit,
      historyContext,
    };

    let result: AgentResult;
    try {
      result = await adapter.run(runOptions);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        status: "failed",
        agent: adapter.name,
        summary: `Execution failed: ${errorMsg}`,
        output: errorMsg,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }

    // Attach bridge session ID
    result.sessionId = session.id;

    // Update session record
    if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
      this.sessionManager.updateSession(session.id, {
        nativeSessionId: result.nativeSessionId,
      });
    }

    this.sessionManager.addHistory(session.id, {
      role,
      task: params.task,
      timestamp: new Date().toISOString(),
      status: result.status,
      summary: result.summary,
      finalAnswer: result.finalAnswer,
      findings: result.findings,
      nativeSessionId: result.nativeSessionId,
    });

    return result;
  }

  /**
   * Performs an independent code review using the designated agent.
   */
  public async reviewChanges(params: ReviewChangesParams): Promise<AgentResult> {
    return this.delegateTask({
      agent: params.agent,
      task: params.task || "Review all recent changes against codebase standards and git diff.",
      cwd: params.cwd,
      role: "reviewer",
      baseCommit: params.baseCommit,
      mode: params.mode,
      timeoutMs: params.timeoutMs,
      env: params.env,
      contextSessionId: params.contextSessionId,
    });
  }

  /**
   * Continues a previously initiated session.
   */
  public async continueTask(params: ContinueTaskParams): Promise<AgentResult> {
    const startTime = Date.now();
    const session = this.sessionManager.getSession(params.sessionId);

    if (!session) {
      return {
        status: "failed",
        agent: "unknown" as AgentName,
        summary: `Session '${params.sessionId}' not found.`,
        output: `Cannot continue task: No active session with ID '${params.sessionId}'.`,
        error: `Session '${params.sessionId}' not found`,
        durationMs: Date.now() - startTime,
      };
    }

    const adapter = this.registry.getAdapter(session.agent);
    if (!adapter) {
      return {
        status: "failed",
        agent: session.agent,
        summary: `Adapter for session agent '${session.agent}' not found.`,
        output: `Adapter not found for agent '${session.agent}'.`,
        error: `Adapter not found for '${session.agent}'`,
        durationMs: Date.now() - startTime,
      };
    }

    // Generate structured history context from prior session turns
    // Native conversations already contain their own history. Only inject the
    // normalized Bridge context when a CLI cannot provide a native resume ID.
    const historyContext = session.nativeSessionId ? undefined : buildHistoryContext(session);

    let result: AgentResult;
    try {
      if (adapter.continue) {
        result = await adapter.continue({
          sessionId: session.id,
          nativeSessionId: session.nativeSessionId,
          task: params.task,
          cwd: session.cwd,
          role: session.role,
          mode: params.mode,
          timeoutMs: params.timeoutMs,
          env: params.env,
          extraArgs: params.extraArgs,
          historyContext,
        });
      } else {
        // Fallback to run with context
        result = await adapter.run({
          task: params.task,
          cwd: session.cwd,
          role: session.role,
          mode: params.mode,
          timeoutMs: params.timeoutMs,
          env: params.env,
          extraArgs: params.extraArgs,
          nativeSessionId: session.nativeSessionId,
          historyContext,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        status: "failed",
        agent: session.agent,
        summary: `Continuation failed: ${errorMsg}`,
        output: errorMsg,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }

    result.sessionId = session.id;

    if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
      this.sessionManager.updateSession(session.id, {
        nativeSessionId: result.nativeSessionId,
      });
    }

    this.sessionManager.addHistory(session.id, {
      role: session.role,
      task: params.task,
      timestamp: new Date().toISOString(),
      status: result.status,
      summary: result.summary,
      finalAnswer: result.finalAnswer,
      findings: result.findings,
      nativeSessionId: result.nativeSessionId,
    });

    return result;
  }

  /**
   * Returns list of supported agents and their availability on this machine.
   */
  public async listAgents() {
    return this.registry.listAgentAvailability();
  }

  /** Returns the nearest project role configuration, if present. */
  public getProjectConfiguration(cwd = process.cwd()) {
    return loadProjectConfig(cwd);
  }

  /**
   * Retrieves a session by its bridge session ID.
   */
  public getSession(sessionId: string): BridgeSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Lists all sessions.
   */
  public listSessions(): BridgeSession[] {
    return this.sessionManager.listSessions();
  }
}

export const defaultRunner = new MultiAgentRunner();
export { MultiAgentRunner as AgentMeshRunner };
