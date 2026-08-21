import path from "node:path";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  RunAgentOptions,
  TransportMode,
} from "../agents/types.js";
import { AgentRegistry, defaultRegistry } from "../agents/registry.js";
import { SessionManager, defaultSessionManager } from "./session.js";
import type { BridgeSession } from "./types.js";

export interface DelegateTaskParams {
  agent: string;
  task: string;
  cwd?: string;
  role?: AgentRole;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
  sessionId?: string;
  baseCommit?: string;
}

export interface ReviewChangesParams {
  agent: string;
  task?: string;
  cwd?: string;
  baseCommit?: string;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ContinueTaskParams {
  sessionId: string;
  task: string;
  mode?: TransportMode;
  timeoutMs?: number;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export class MultiAgentRunner {
  private registry: AgentRegistry;
  private sessionManager: SessionManager;

  constructor(
    registry: AgentRegistry = defaultRegistry,
    sessionManager: SessionManager = defaultSessionManager
  ) {
    this.registry = registry;
    this.sessionManager = sessionManager;
  }

  /**
   * Delegates a task to a designated agent harness.
   */
  public async delegateTask(params: DelegateTaskParams): Promise<AgentResult> {
    const startTime = Date.now();
    const adapter = this.registry.getAdapter(params.agent);

    if (!adapter) {
      return {
        status: "failed",
        agent: params.agent as AgentName,
        summary: `Unknown agent '${params.agent}'. Supported agents: ${this.registry.listSupportedNames().join(", ")}`,
        output: `Agent '${params.agent}' is not recognized by the bridge.`,
        error: `Unknown agent '${params.agent}'`,
        durationMs: Date.now() - startTime,
      };
    }

    // Manage or create bridge session with consistency validation
    let session: BridgeSession;
    if (params.sessionId) {
      const existing = this.sessionManager.getSession(params.sessionId);
      if (!existing) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Session '${params.sessionId}' not found.`,
          output: `Cannot delegate task: No active session with ID '${params.sessionId}'.`,
          error: `Session '${params.sessionId}' not found`,
          durationMs: Date.now() - startTime,
        };
      }

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
      const role: AgentRole = params.role || "worker";
      session = this.sessionManager.createSession({
        agent: adapter.name,
        cwd: effectiveCwd,
        role,
      });
    }

    // Existing sessions own their execution context. Omitted values inherit the
    // binding; explicitly supplied values were validated above.
    const effectiveCwd = params.cwd ?? session.cwd;
    const role: AgentRole = params.role ?? session.role;

    const runOptions: RunAgentOptions = {
      task: params.task,
      cwd: effectiveCwd,
      role,
      mode: params.mode,
      timeoutMs: params.timeoutMs,
      env: params.env,
      extraArgs: params.extraArgs,
      nativeSessionId: session.nativeSessionId,
      baseCommit: params.baseCommit,
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
    if (result.nativeSessionId && !session.nativeSessionId) {
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
    const historyContext =
      session.history.length > 0
        ? session.history
            .map(
              (h, idx) =>
                `[Turn ${idx + 1} | Role: ${h.role.toUpperCase()} | Status: ${h.status.toUpperCase()}]:\nTask: ${h.task}\n${h.summary ? `Summary/Findings: ${h.summary}` : ""}`
            )
            .join("\n\n")
        : undefined;

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

    if (result.nativeSessionId && !session.nativeSessionId) {
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
    });

    return result;
  }

  /**
   * Returns list of supported agents and their availability on this machine.
   */
  public async listAgents() {
    return this.registry.listAgentAvailability();
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
