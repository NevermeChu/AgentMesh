import path from "node:path";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyPolicy,
  ReviewerSafetyReport,
  RunAgentOptions,
  TransportMode,
} from "../agents/types.js";
import { defaultRegistry } from "../agents/registry.js";
import type { AgentRegistry } from "../agents/registry.js";
import { defaultSessionManager, SessionManager } from "./session.js";
import { resolveRoleAssignment, loadProjectConfig } from "./config.js";
import { captureRepositoryState } from "./repository.js";
import type {
  BridgeSession,
  RepositoryStateEvidence,
  RunnerOptions,
  SessionHistoryEntry,
} from "./types.js";

/** Upper bound for one delegated agent process when no timeout is configured anywhere. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

export interface DelegateTaskParams {
  agent?: string;
  task: string;
  cwd?: string;
  role?: AgentRole;
  mode?: TransportMode;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  env?: Record<string, string>;
  extraArgs?: string[];
  sessionId?: string;
  /** Single source session whose normalized history should be injected (legacy form). */
  contextSessionId?: string;
  /** Source sessions (max 4) whose normalized history is injected first-hand, in the given order. */
  contextSessionIds?: string[];
  baseCommit?: string;
  /** Cancels the underlying agent run; the turn is still recorded as a failed history entry. */
  signal?: AbortSignal;
}

export interface ReviewChangesParams {
  agent?: string;
  task?: string;
  cwd?: string;
  baseCommit?: string;
  mode?: TransportMode;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  env?: Record<string, string>;
  /** Single source session whose normalized history should be injected (legacy form). */
  contextSessionId?: string;
  /** Source sessions (max 4) whose normalized history is injected first-hand, in the given order. */
  contextSessionIds?: string[];
  /** Cancels the underlying agent run; the turn is still recorded as a failed history entry. */
  signal?: AbortSignal;
}

export interface ContinueTaskParams {
  sessionId: string;
  task: string;
  mode?: TransportMode;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  env?: Record<string, string>;
  extraArgs?: string[];
  /** Source sessions (max 4) injected alongside the session's own native resume. */
  contextSessionIds?: string[];
  /** Cancels the underlying agent run; the turn is still recorded as a failed history entry. */
  signal?: AbortSignal;
}

const MAX_SHARED_TURNS = 8;
const MAX_SHARED_ANSWER_CHARS = 4_000;
const MAX_SHARED_CONTEXT_CHARS = 24_000;
const MAX_CONTEXT_SOURCES = 4;

function truncateSharedText(value: string, maxChars: number = MAX_SHARED_ANSWER_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}... [truncated]`;
}

function formatRepositoryState(evidence: RepositoryStateEvidence): string {
  const changed = evidence.changedPaths.length
    ? `; changed=${evidence.changedPaths.join(", ")}`
    : "";
  return `head=${evidence.head || "unborn"}; dirty=${evidence.dirty}; fingerprint=${evidence.fingerprint}${changed}`;
}

function formatFreshness(
  session: BridgeSession,
  current: RepositoryStateEvidence | undefined,
): string {
  const previous = session.history.at(-1)?.evidence?.repositoryAfter;
  if (previous && current) {
    return previous.repositoryRoot === current.repositoryRoot &&
      previous.fingerprint === current.fingerprint
      ? "MATCHED: the current working tree matches the last recorded handoff state."
      : "STALE: the current working tree differs from the last recorded handoff state; revalidate affected evidence.";
  }
  return "UNKNOWN: repository evidence is unavailable; verify before relying on prior results.";
}

function renderSharedTurn(
  history: SessionHistoryEntry,
  session: BridgeSession,
  turnNumber: number,
): string {
  const details = [
    `[Shared Turn ${turnNumber} | Agent: ${session.agent.toUpperCase()} | Role: ${history.role.toUpperCase()} | Status: ${history.status.toUpperCase()}]`,
    `Task: ${history.task}`,
  ];
  if (history.summary) details.push(`Summary: ${history.summary}`);
  if (history.finalAnswer) details.push(`Final answer: ${truncateSharedText(history.finalAnswer)}`);
  if (history.findings?.length) details.push(`Findings: ${JSON.stringify(history.findings)}`);
  if (history.evidence?.repositoryBefore) {
    details.push(`Repository before: ${formatRepositoryState(history.evidence.repositoryBefore)}`);
  }
  if (history.evidence?.repositoryAfter) {
    details.push(`Repository after: ${formatRepositoryState(history.evidence.repositoryAfter)}`);
  }
  if (history.evidence) {
    details.push(
      `Execution evidence: transport=${history.evidence.transportUsed || "unknown"}; exitCode=${history.evidence.exitCode ?? "unknown"}; durationMs=${history.evidence.durationMs ?? "unknown"}`,
    );
  }
  if (history.reviewerSafety) {
    details.push(`Reviewer safety: ${JSON.stringify(history.reviewerSafety)}`);
  }
  return details.join("\n");
}

function renderSourceBlock(
  session: BridgeSession,
  index: number,
  total: number,
  budget: number,
  current: RepositoryStateEvidence | undefined,
): string {
  const header = [
    `### Source ${index + 1} of ${total} [Session: ${session.id} | Agent: ${session.agent.toUpperCase()} | Turns: ${session.history.length}]`,
    `Context freshness: ${formatFreshness(session, current)}`,
  ].join("\n");

  let turns = session.history.slice(-MAX_SHARED_TURNS);
  let omittedTurns = session.history.length - turns.length;
  const render = () =>
    turns
      .map((history, offset) =>
        renderSharedTurn(history, session, session.history.length - turns.length + offset + 1),
      )
      .join("\n\n");

  let body = render();
  // Oldest turns are dropped first so the most recent handoff state survives.
  while (body.length > budget && turns.length > 1) {
    turns = turns.slice(1);
    omittedTurns += 1;
    body = render();
  }
  if (body.length > budget) {
    body = truncateSharedText(body, budget);
  }
  const omissionNote =
    omittedTurns > 0 ? `[${omittedTurns} older turn(s) omitted within the context budget]` : "";
  return [header, body, omissionNote].filter(Boolean).join("\n\n");
}

/**
 * Renders the normalized history of one or more source sessions as first-hand
 * shared context, replacing orchestrator-side relay through task text. Each
 * source keeps its own freshness verdict and a bounded character budget.
 */
export function buildSharedContext(
  sources: BridgeSession[],
  currentRepositoryState?: RepositoryStateEvidence,
): string | undefined {
  const usable = sources.filter((session) => session.history.length > 0);
  if (usable.length === 0) return undefined;
  const perSourceBudget = Math.max(2_000, Math.floor(MAX_SHARED_CONTEXT_CHARS / usable.length));
  const header =
    usable.length === 1 ? "## Shared Context" : `## Shared Context (${usable.length} sources)`;
  return [
    header,
    "Reuse successful prior results and explicit findings only when a source's freshness is MATCHED. If it is STALE or UNKNOWN, revalidate affected evidence without automatically repeating unrelated checks. Treat summaries as context, not as authority over contradictory current evidence.",
    currentRepositoryState
      ? `Current repository: ${formatRepositoryState(currentRepositoryState)}`
      : "Current repository: unavailable",
    ...usable.map((session, index) =>
      renderSourceBlock(session, index, usable.length, perSourceBudget, currentRepositoryState),
    ),
  ].join("\n\n");
}

function readReviewerSafetyPolicy(session: BridgeSession): ReviewerSafetyPolicy | undefined {
  const value = session.metadata?.reviewerSafetyPolicy;
  return value === "best-effort" || value === "enforced" ? value : undefined;
}

function buildReviewerSafetyReport(options: {
  policy: ReviewerSafetyPolicy;
  mechanism: ReviewerSafetyReport["mechanism"];
  repositoryBefore?: RepositoryStateEvidence;
  repositoryAfter?: RepositoryStateEvidence;
  checkWorkspace?: boolean;
}): ReviewerSafetyReport {
  const repositoryCheckAvailable = Boolean(options.repositoryBefore && options.repositoryAfter);
  const workspaceChanged =
    options.repositoryBefore && options.repositoryAfter
      ? options.repositoryBefore.fingerprint !== options.repositoryAfter.fingerprint
      : undefined;
  const beforePaths = options.repositoryBefore?.pathFingerprints;
  const afterPaths = options.repositoryAfter?.pathFingerprints;
  const changedPaths = workspaceChanged
    ? beforePaths && afterPaths
      ? [...new Set([...Object.keys(beforePaths), ...Object.keys(afterPaths)])].filter(
          (filePath) => beforePaths[filePath] !== afterPaths[filePath],
        )
      : [
          ...new Set([
            ...(options.repositoryBefore?.changedPaths || []),
            ...(options.repositoryAfter?.changedPaths || []),
          ]),
        ]
    : undefined;
  const warnings: string[] = [];
  if (options.mechanism === "prompt-only") {
    warnings.push("This Reviewer relies on prompt-level constraints, not a runtime sandbox.");
  }
  if (options.checkWorkspace !== false && !repositoryCheckAvailable) {
    warnings.push("The repository fingerprint check was unavailable.");
  }

  return {
    requested: options.policy,
    mechanism: options.mechanism,
    enforced: options.mechanism !== "prompt-only",
    workspaceChanged,
    changedPaths,
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}

function applyReviewerSafety(result: AgentResult, report: ReviewerSafetyReport): void {
  result.reviewerSafety = report;
  if (!report.workspaceChanged) return;

  const changedPaths = report.changedPaths?.length
    ? report.changedPaths.join(", ")
    : "unknown paths";
  const message = `The working tree changed during Reviewer execution: ${changedPaths}. The changes were not reverted.`;
  result.status = "failed";
  result.reviewOutcome = "FAIL";
  result.summary = message;
  result.error = result.error ? `${result.error}; ${message}` : message;
  result.output = result.output ? `${result.output}\n\n${message}` : message;
  result.findings = [
    ...(result.findings || []),
    {
      severity: "high",
      file: report.changedPaths?.[0] || ".",
      issue: "The repository state changed while the Reviewer was running.",
      suggestion: "Inspect the reported paths and rerun the review in a clean working tree.",
    },
  ];
}

export class MultiAgentRunner {
  private registry: AgentRegistry;
  private sessionManager: SessionManager;
  private readonly defaultTimeoutMs: number;

  constructor(
    registry: AgentRegistry = defaultRegistry,
    sessionManager?: SessionManager,
    options: RunnerOptions = {},
  ) {
    this.registry = registry;
    this.sessionManager =
      sessionManager ??
      (options.sessionStoragePath
        ? new SessionManager({ storagePath: options.sessionStoragePath })
        : defaultSessionManager);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
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

    const reviewerSafetyPolicy: ReviewerSafetyPolicy | undefined =
      effectiveRole === "reviewer"
        ? existingSession
          ? readReviewerSafetyPolicy(existingSession) ||
            roleResolution.assignment?.safety ||
            "best-effort"
          : roleResolution.assignment?.safety || "best-effort"
        : undefined;
    if (reviewerSafetyPolicy === "enforced" && adapter.sandboxMechanism === "prompt-only") {
      const message = `${adapter.displayName} cannot run this Reviewer task because safety='enforced' rejects prompt-only protection.`;
      return {
        status: "failed",
        agent: adapter.name,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
        reviewerSafety: buildReviewerSafetyReport({
          policy: reviewerSafetyPolicy,
          mechanism: adapter.sandboxMechanism,
          checkWorkspace: false,
        }),
      };
    }

    const requestedContextIds = [
      ...(params.contextSessionIds ?? []),
      ...(params.contextSessionId ? [params.contextSessionId] : []),
    ];
    if (requestedContextIds.length > MAX_CONTEXT_SOURCES) {
      const message = `At most ${MAX_CONTEXT_SOURCES} context sessions are supported, but ${requestedContextIds.length} were requested.`;
      return {
        status: "failed",
        agent: adapter.name,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
    const contextSessions: BridgeSession[] = [];
    for (const contextId of requestedContextIds) {
      const found = this.sessionManager.getSession(contextId);
      if (!found) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Context session '${contextId}' not found.`,
          output: `Cannot share context: No Bridge session with ID '${contextId}'.`,
          error: `Context session '${contextId}' not found`,
          durationMs: Date.now() - startTime,
        };
      }
      // New sessions must be validated before creation so an invalid reference
      // cannot leave an orphaned session behind.
      if (
        !params.sessionId &&
        path.resolve(found.cwd) !== path.resolve(params.cwd || process.cwd())
      ) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Context session cwd mismatch: Context '${found.id}' belongs to '${found.cwd}', but the target session uses '${params.cwd || process.cwd()}'.`,
          output: "Cannot share context across different working directories.",
          error: "Context session cwd mismatch",
          durationMs: Date.now() - startTime,
        };
      }
      if (!contextSessions.some((existing) => existing.id === found.id)) {
        contextSessions.push(found);
      }
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
      const roleMetadata = roleResolution.loaded
        ? {
            roleAssignmentSource: roleResolution.loaded.path,
            configuredRole: effectiveRole,
            orchestratorAgent: roleResolution.loaded.config.roles.orchestrator?.agent,
          }
        : {};
      const metadata = {
        ...roleMetadata,
        ...(reviewerSafetyPolicy ? { reviewerSafetyPolicy } : {}),
      };
      session = this.sessionManager.createSession({
        agent: adapter.name,
        cwd: effectiveCwd,
        role: effectiveRole,
        metadata: Object.keys(metadata).length ? metadata : undefined,
      });
    }

    // Existing sessions own their execution context. Omitted values inherit the
    // binding; explicitly supplied values were validated above.
    const effectiveCwd = params.cwd ?? session.cwd;
    const role: AgentRole = params.role ?? session.role;
    for (const source of contextSessions) {
      if (path.resolve(source.cwd) !== path.resolve(effectiveCwd)) {
        return {
          status: "failed",
          agent: adapter.name,
          summary: `Context session cwd mismatch: Context '${source.id}' belongs to '${source.cwd}', but the target session uses '${effectiveCwd}'.`,
          output: "Cannot share context across different working directories.",
          error: "Context session cwd mismatch",
          durationMs: Date.now() - startTime,
        };
      }
    }

    const repositoryBefore = await captureRepositoryState(effectiveCwd);
    // Native resume covers the target session's OWN history only; explicit
    // context sources always inject so cross-session facts arrive first-hand.
    const ownHistoryInjectable = !session.nativeSessionId && session.history.length > 0;
    const injectionSources = [...contextSessions, ...(ownHistoryInjectable ? [session] : [])];
    const historyContext = buildSharedContext(injectionSources, repositoryBefore);

    const runOptions: RunAgentOptions = {
      task: params.task,
      cwd: effectiveCwd,
      role,
      mode: params.mode ?? roleResolution.assignment?.mode,
      model: params.model ?? roleResolution.assignment?.model,
      reasoningEffort: params.reasoningEffort ?? roleResolution.assignment?.reasoningEffort,
      timeoutMs: params.timeoutMs ?? roleResolution.assignment?.timeoutMs ?? this.defaultTimeoutMs,
      env: params.env,
      extraArgs: params.extraArgs,
      nativeSessionId: session.nativeSessionId,
      baseCommit: params.baseCommit,
      historyContext,
      signal: params.signal,
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
    const repositoryAfter = await captureRepositoryState(effectiveCwd);
    if (role === "reviewer" && reviewerSafetyPolicy) {
      applyReviewerSafety(
        result,
        buildReviewerSafetyReport({
          policy: reviewerSafetyPolicy,
          mechanism: adapter.sandboxMechanism,
          repositoryBefore,
          repositoryAfter,
        }),
      );
    }

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
      evidence: {
        repositoryBefore,
        repositoryAfter,
        transportUsed: result.transportUsed,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        cancelReason: result.timedOut ? "timeout" : result.aborted ? "client_cancel" : undefined,
        cleanupMethod: result.cleanupMethod,
        cleanupSucceeded: result.cleanupSucceeded,
        resourceEvidence: result.resourceEvidence,
      },
      reviewerSafety: result.reviewerSafety,
      requestedModel: params.model,
      requestedReasoningEffort: params.reasoningEffort,
      ...(injectionSources.some((source) => source.history.length > 0)
        ? {
            contextSources: injectionSources
              .filter((source) => source.history.length > 0)
              .map((source) => source.id),
          }
        : {}),
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
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      env: params.env,
      contextSessionId: params.contextSessionId,
      contextSessionIds: params.contextSessionIds,
      signal: params.signal,
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

    const requestedContextIds = params.contextSessionIds ?? [];
    if (requestedContextIds.length > MAX_CONTEXT_SOURCES) {
      const message = `At most ${MAX_CONTEXT_SOURCES} context sessions are supported, but ${requestedContextIds.length} were requested.`;
      return {
        status: "failed",
        agent: session.agent,
        sessionId: session.id,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
    const contextSessions: BridgeSession[] = [];
    for (const contextId of requestedContextIds) {
      const found = this.sessionManager.getSession(contextId);
      if (!found) {
        return {
          status: "failed",
          agent: session.agent,
          sessionId: session.id,
          summary: `Context session '${contextId}' not found.`,
          output: `Cannot share context: No Bridge session with ID '${contextId}'.`,
          error: `Context session '${contextId}' not found`,
          durationMs: Date.now() - startTime,
        };
      }
      if (path.resolve(found.cwd) !== path.resolve(session.cwd)) {
        return {
          status: "failed",
          agent: session.agent,
          sessionId: session.id,
          summary: `Context session cwd mismatch: Context '${found.id}' belongs to '${found.cwd}', but the target session uses '${session.cwd}'.`,
          output: "Cannot share context across different working directories.",
          error: "Context session cwd mismatch",
          durationMs: Date.now() - startTime,
        };
      }
      if (!contextSessions.some((existing) => existing.id === found.id)) {
        contextSessions.push(found);
      }
    }

    const reviewerSafetyPolicy: ReviewerSafetyPolicy | undefined =
      session.role === "reviewer" ? readReviewerSafetyPolicy(session) || "best-effort" : undefined;
    if (reviewerSafetyPolicy === "enforced" && adapter.sandboxMechanism === "prompt-only") {
      const message = `${adapter.displayName} cannot continue this Reviewer task because safety='enforced' rejects prompt-only protection.`;
      return {
        status: "failed",
        agent: adapter.name,
        sessionId: session.id,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
        reviewerSafety: buildReviewerSafetyReport({
          policy: reviewerSafetyPolicy,
          mechanism: adapter.sandboxMechanism,
          checkWorkspace: false,
        }),
      };
    }

    // Native resume carries the session's OWN history; explicit context sources
    // inject alongside it so reviewer/tester feedback arrives first-hand.
    const repositoryBefore = await captureRepositoryState(session.cwd);
    const ownHistoryInjectable = !session.nativeSessionId && session.history.length > 0;
    const injectionSources = [...contextSessions, ...(ownHistoryInjectable ? [session] : [])];
    const historyContext = buildSharedContext(injectionSources, repositoryBefore);

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
          model: params.model,
          reasoningEffort: params.reasoningEffort,
          timeoutMs: params.timeoutMs ?? this.defaultTimeoutMs,
          env: params.env,
          extraArgs: params.extraArgs,
          historyContext,
          signal: params.signal,
        });
      } else {
        // Fallback to run with context
        result = await adapter.run({
          task: params.task,
          cwd: session.cwd,
          role: session.role,
          mode: params.mode,
          timeoutMs: params.timeoutMs ?? this.defaultTimeoutMs,
          env: params.env,
          extraArgs: params.extraArgs,
          nativeSessionId: session.nativeSessionId,
          historyContext,
          signal: params.signal,
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
    const repositoryAfter = await captureRepositoryState(session.cwd);
    if (session.role === "reviewer" && reviewerSafetyPolicy) {
      applyReviewerSafety(
        result,
        buildReviewerSafetyReport({
          policy: reviewerSafetyPolicy,
          mechanism: adapter.sandboxMechanism,
          repositoryBefore,
          repositoryAfter,
        }),
      );
    }

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
      evidence: {
        repositoryBefore,
        repositoryAfter,
        transportUsed: result.transportUsed,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        cancelReason: result.timedOut ? "timeout" : result.aborted ? "client_cancel" : undefined,
        cleanupMethod: result.cleanupMethod,
        cleanupSucceeded: result.cleanupSucceeded,
        resourceEvidence: result.resourceEvidence,
      },
      reviewerSafety: result.reviewerSafety,
      requestedModel: params.model,
      requestedReasoningEffort: params.reasoningEffort,
      ...(injectionSources.some((source) => source.history.length > 0)
        ? {
            contextSources: injectionSources
              .filter((source) => source.history.length > 0)
              .map((source) => source.id),
          }
        : {}),
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
