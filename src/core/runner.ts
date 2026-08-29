import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyPolicy,
  ReviewerSafetyReport,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../agents/types.js";
import { defaultRegistry } from "../agents/registry.js";
import type { AgentRegistry } from "../agents/registry.js";
import {
  evaluateModelOptionSupport,
  getCapability,
  readCapabilities,
  staticCapabilities,
} from "./capabilities.js";
import type { CapabilitiesFile } from "./capabilities.js";
import { defaultSessionManager, SessionManager, readSessionSummary } from "./session.js";
import type { SessionSummary } from "./session.js";
import { resolveRoleAssignment, loadProjectConfig } from "./config.js";
import type { AgentMetadata, BudgetConfig } from "./config.js";
import { captureRepositoryState } from "./repository.js";
import { classifyErrorCode } from "./resilience.js";
import { buildSummaryPrompt, stripAnalysisDraft, buildReworkFixPrompt } from "./prompts.js";
import { truncateText } from "./text.js";
import { evaluateBudgetGate } from "./budget.js";
import { type CheckpointStore, defaultCheckpointStore } from "./checkpoint.js";
import type {
  BridgeSession,
  ErrorCode,
  IdempotencyTombstone,
  RepositoryStateEvidence,
  RunnerOptions,
  SessionExecutionEvidence,
  SessionHistoryEntry,
  SharedContextAudit,
} from "./types.js";
import { idempotencyScopeKey } from "./types.js";

/** Upper bound for one delegated agent process when no timeout is configured anywhere. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/**
 * Hard cap for one stored compact summary, ~2000 tokens at the conventional
 * 4-chars-per-token estimate (T2.3). Oversized model output is truncated with
 * an explicit marker instead of being stored unbounded.
 */
export const COMPACT_SUMMARY_MAX_CHARS = 8_000;

/** Error codes eligible for the T4.4 upgrade-candidate hint. */
export const UPGRADEABLE_ERROR_CODES: readonly ErrorCode[] = [
  "MODEL_REJECTED",
  "SANDBOX_UNAVAILABLE",
];

/** Upper bound for hint.nextCandidates suggestions attached to a failed dispatch. */
const MAX_UPGRADE_HINTS = 3;

/** Hard ceiling for the T5.1 bounded rework loop; larger requests clamp to this. */
export const MAX_REWORK_ROUNDS = 3;

/** Terminal-result tombstone TTL for idempotency keys (P1 T1.1). */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 20 * 60 * 1000;

interface IdempotencyInFlightEntry {
  sessionId: string;
  startedAtMs: number;
}

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
  /**
   * Internal: declares the strict review contract so an unparseable reviewer
   * verdict fails closed. Only the review_changes pipeline sets this; it is
   * deliberately absent from the MCP input schemas.
   */
  reviewVerdictRequired?: boolean;
  /**
   * Deduplicates dispatches carrying the same key within one (cwd, agent)
   * scope: while an execution is in flight callers receive an in-flight
   * reference; after it reaches a terminal state, retries within the tombstone
   * TTL replay the recorded result instead of re-executing (P1 T1.1).
   */
  idempotencyKey?: string;
  /** Cancels the underlying agent run; the turn is still recorded as a failed history entry. */
  signal?: AbortSignal;
  /**
   * T1.4 background telemetry: tees CLI stdout/stderr to the given task output
   * file and feeds last-output timestamps to the stalled watchdog. Set only by
   * the background delegate path (mcp/tools.ts).
   */
  taskActivity?: { taskId: string; outputFile: string };
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
  /**
   * P5 T5.1 bounded rework loop: when the review FAILs, the structured
   * findings are injected into the worker session (workerSessionId) via
   * continue_task and the change is re-reviewed, at most this many rounds
   * (0-3, default 0 = v0.1 single-pass behavior).
   */
  maxReworkRounds?: number;
  /** Bridge session of the worker whose changes are under review; required for the rework loop. */
  workerSessionId?: string;
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
  /**
   * P5 T5.2 one-shot recovery baton: consumes the named checkpoint (saved by
   * the stalled watchdog, orphan sweep, or a failed background dispatch) and
   * injects its salvaged partial answer at the head of this continuation. A
   * checkpoint can be consumed exactly once; a second attempt fails closed.
   */
  fromCheckpoint?: string;
  /** Cancels the underlying agent run; the turn is still recorded as a failed history entry. */
  signal?: AbortSignal;
}

const MAX_SHARED_TURNS = 8;
const MAX_SHARED_ANSWER_CHARS = 4_000;
const MAX_CONTEXT_SOURCES = 4;

/**
 * T2.4 segmented budgets replace the legacy single 24k pool: every segment has
 * its own hard cap so one bloated segment can never starve the others (e.g.
 * saturated upstream conclusions no longer crowd out the environment snapshot).
 */
/** Segment 1 — per-turn task-description echo carried inside shared history. */
export const MAX_SHARED_TASK_DESC_CHARS = 4_000;
/** Segment 2 — total upstream-conclusions budget, split evenly across sources. */
export const UPSTREAM_CONCLUSIONS_BUDGET_CHARS = 12_000;
/** Segment 3 — environment-snapshot cap before the self-service hint kicks in. */
export const ENVIRONMENT_SNAPSHOT_BUDGET_CHARS = 2_000;
/**
 * Legacy overall ceiling, kept as the documented reserve: the three segments
 * allocate at most 18k of it, leaving ~6k of headroom so the downstream agent
 * keeps room for its own task framing and response planning.
 */
export const MAX_SHARED_CONTEXT_CHARS = 24_000;

function truncateSharedText(value: string, maxChars: number = MAX_SHARED_ANSWER_CHARS): string {
  return truncateText(value, maxChars, "... [truncated]");
}

/**
 * Renders the environment-snapshot segment under its own budget. When the
 * evidence line overflows, the cut is marked explicitly and a self-service
 * remediation instruction replaces the missing detail instead of silence.
 */
function renderEnvironmentSnapshot(evidence: RepositoryStateEvidence | undefined): string {
  const line = evidence
    ? `Current repository: ${formatRepositoryState(evidence)}`
    : "Current repository: unavailable";
  if (line.length <= ENVIRONMENT_SNAPSHOT_BUDGET_CHARS) return line;
  return `${truncateSharedText(line, ENVIRONMENT_SNAPSHOT_BUDGET_CHARS)}\n[Environment snapshot truncated; run git status for full detail.]`;
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
): { text: string; answerTruncated: boolean } {
  const details = [
    `[Shared Turn ${turnNumber} | Agent: ${session.agent.toUpperCase()} | Role: ${history.role.toUpperCase()} | Status: ${history.status.toUpperCase()}]`,
    `Task: ${truncateSharedText(history.task, MAX_SHARED_TASK_DESC_CHARS)}`,
  ];
  let answerTruncated = false;
  if (history.summary) details.push(`Summary: ${history.summary}`);
  if (history.finalAnswer) {
    answerTruncated = history.finalAnswer.length > MAX_SHARED_ANSWER_CHARS;
    details.push(`Final answer: ${truncateSharedText(history.finalAnswer)}`);
  }
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
  return { text: details.join("\n"), answerTruncated };
}

interface SourceRenderStats {
  sessionId: string;
  chars: number;
  truncated: boolean;
}

/**
 * T2.3 freshness gate: a stored summary stays injectable only while the source
 * session has not grown past the turn count captured at compaction time.
 */
function readFreshSessionSummary(session: BridgeSession): SessionSummary | undefined {
  const summary = readSessionSummary(session);
  if (!summary) return undefined;
  return session.history.length <= summary.summarizedTurns ? summary : undefined;
}

interface SharedContextRender {
  text: string;
  sources: SourceRenderStats[];
}

function renderSourceBlock(
  session: BridgeSession,
  index: number,
  total: number,
  budget: number,
  current: RepositoryStateEvidence | undefined,
): { text: string; truncated: boolean } {
  const header = [
    `### Source ${index + 1} of ${total} [Session: ${session.id} | Agent: ${session.agent.toUpperCase()} | Turns: ${session.history.length}]`,
    `Context freshness: ${formatFreshness(session, current)}`,
  ].join("\n");

  // T2.3: a fresh compact summary replaces the verbatim transcript; any turn
  // appended after compaction invalidates it and falls back to full injection.
  const summary = readFreshSessionSummary(session);
  if (summary) {
    const text = [
      header,
      `[Semantic summary via compact_context covering all ${summary.summarizedTurns} recorded turn(s)]`,
      summary.text,
      `[Full transcript: Bridge session '${session.id}' with ${session.history.length} turn(s) — use get_session to read specifics on demand.]`,
    ].join("\n\n");
    return { text, truncated: false };
  }

  let turns = session.history.slice(-MAX_SHARED_TURNS);
  let omittedTurns = session.history.length - turns.length;
  const render = () =>
    turns.map((history, offset) =>
      renderSharedTurn(history, session, session.history.length - turns.length + offset + 1),
    );

  let rendered = render();
  // Oldest turns are dropped first so the most recent handoff state survives.
  while (rendered.map((turn) => turn.text).join("\n\n").length > budget && turns.length > 1) {
    turns = turns.slice(1);
    omittedTurns += 1;
    rendered = render();
  }
  let body = rendered.map((turn) => turn.text).join("\n\n");
  let clamped = false;
  if (body.length > budget) {
    body = truncateSharedText(body, budget);
    clamped = true;
  }
  const omissionNote =
    omittedTurns > 0 ? `[${omittedTurns} older turn(s) omitted within the context budget]` : "";
  const text = [header, body, omissionNote].filter(Boolean).join("\n\n");
  return {
    text,
    truncated: clamped || omittedTurns > 0 || rendered.some((turn) => turn.answerTruncated),
  };
}

/**
 * Renders the normalized history of one or more source sessions as first-hand
 * shared context, replacing orchestrator-side relay through task text. Each
 * segment (per-turn task echo, upstream conclusions, environment snapshot)
 * keeps its own bounded character budget per the T2.4 segmented scheme.
 *
 * Returns per-source injection statistics so callers can audit verbatim what
 * downstream agents actually received (see SharedContextAudit).
 */
export function buildSharedContextDetailed(
  sources: BridgeSession[],
  currentRepositoryState?: RepositoryStateEvidence,
): SharedContextRender | undefined {
  const usable = sources.filter((session) => session.history.length > 0);
  if (usable.length === 0) return undefined;
  const perSourceBudget = Math.max(
    2_000,
    Math.floor(UPSTREAM_CONCLUSIONS_BUDGET_CHARS / usable.length),
  );
  const header =
    usable.length === 1 ? "## Shared Context" : `## Shared Context (${usable.length} sources)`;
  const blocks = usable.map((session, index) =>
    renderSourceBlock(session, index, usable.length, perSourceBudget, currentRepositoryState),
  );
  return {
    text: [
      header,
      "Reuse successful prior results and explicit findings only when a source's freshness is MATCHED. If it is STALE or UNKNOWN, revalidate affected evidence without automatically repeating unrelated checks. Treat summaries as context, not as authority over contradictory current evidence. When you rely on a source, cite its session ID; never claim to reuse information that is not present in this injected context.",
      renderEnvironmentSnapshot(currentRepositoryState),
      ...blocks.map((block) => block.text),
    ].join("\n\n"),
    sources: usable.map((session, index) => ({
      sessionId: session.id,
      chars: blocks[index]!.text.length,
      truncated: blocks[index]!.truncated,
    })),
  };
}

/**
 * Backward-compatible wrapper returning only the rendered shared-context text.
 */
export function buildSharedContext(
  sources: BridgeSession[],
  currentRepositoryState?: RepositoryStateEvidence,
): string | undefined {
  return buildSharedContextDetailed(sources, currentRepositoryState)?.text;
}

function readReviewerSafetyPolicy(session: BridgeSession): ReviewerSafetyPolicy | undefined {
  const value = session.metadata?.reviewerSafetyPolicy;
  return value === "best-effort" || value === "enforced" ? value : undefined;
}

/**
 * Loads the project safety policy for a reviewer continuation. The session
 * binding stays authoritative; the project config only fills what the session
 * does not already pin down. A broken config must not block a continuation,
 * so load failures degrade to `undefined` instead of throwing.
 */
function loadReviewerSafetyFallback(cwd: string): ReviewerSafetyPolicy | undefined {
  try {
    return resolveRoleAssignment(cwd, "reviewer").assignment?.safety;
  } catch {
    return undefined;
  }
}

/**
 * Validates and deduplicates requested context source sessions against the
 * working directory of the target execution.
 */
type CollectedContextSources =
  | { sources: BridgeSession[] }
  | { failure: "not-found"; contextId: string }
  | { failure: "cwd-mismatch"; contextId: string; sourceCwd: string };

function collectContextSources(
  sessionManager: SessionManager,
  requestedIds: string[],
  targetCwd: string,
): CollectedContextSources {
  const sources: BridgeSession[] = [];
  for (const contextId of requestedIds) {
    const found = sessionManager.getSession(contextId);
    if (!found) {
      return { failure: "not-found", contextId };
    }
    if (path.resolve(found.cwd) !== path.resolve(targetCwd)) {
      return { failure: "cwd-mismatch", contextId, sourceCwd: found.cwd };
    }
    if (!sources.some((existing) => existing.id === found.id)) {
      sources.push(found);
    }
  }
  return { sources };
}

function buildContextLimitError(maxSources: number, requested: number): string {
  return `At most ${maxSources} context sessions are supported, but ${requested} were requested.`;
}

function describeContextFailure(
  failure: Exclude<CollectedContextSources, { sources: BridgeSession[] }>,
  targetCwd: string,
): { summary: string; output: string } {
  const isMismatch = failure.failure === "cwd-mismatch";
  const summary = isMismatch
    ? `Context session cwd mismatch: Context '${failure.contextId}' belongs to '${failure.sourceCwd}', but the target session uses '${targetCwd}'.`
    : `Context session '${failure.contextId}' not found.`;
  const output = isMismatch
    ? "Cannot share context across different working directories."
    : `Cannot share context: No Bridge session with ID '${failure.contextId}'.`;
  return { summary, output };
}

/**
 * Surfaces every independent validation problem in one message. When both a
 * context-source problem and a role-resolution problem exist, neither masks
 * the other — the caller fixes both in one round trip.
 */
function mergeValidationMessages(contextSummary: string | undefined, roleMessage: string): string {
  return contextSummary ? `${contextSummary}; additionally: ${roleMessage}` : roleMessage;
}

function safeResolveRoleAssignment(
  configCwd: string,
  role: AgentRole,
): { resolution?: ReturnType<typeof resolveRoleAssignment>; error?: string } {
  try {
    return { resolution: resolveRoleAssignment(configCwd, role) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Predicts which transport an auto/explicit mode will execute on so model
 * option support can be checked BEFORE dispatching the vendor process.
 */
function predictTransport(
  supportedModes: readonly TransportMode[],
  mode?: TransportMode,
): "mcp" | "cli" | undefined {
  if (mode && mode !== "auto" && supportedModes.includes(mode)) return mode;
  const preferred = supportedModes[0];
  return preferred === "mcp" || preferred === "cli" ? preferred : undefined;
}

/**
 * Detects vendor-level refusals of a requested model id (HTTP 4xx family,
 * "unsupported/invalid model" wording). Conservative on purpose: both the
 * model id and a refusal signal must appear before a diagnostic is emitted.
 */
export function modelRejectionDiagnostic(params: { model?: string; text?: string }): string[] {
  const { model, text } = params;
  if (!model || !text) return [];
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(escaped).test(text)) return [];
  const refusalSignal =
    /\b(?:400|401|403|404)\b|invalid[_-]?model|unsupported[_-]?model|model.{0,40}(?:not\s+(?:supported|available|found|valid)|is\s+unavailable)|does\s+not\s+have\s+access|no\s+access\s+to\s+model/i;
  if (!refusalSignal.test(text)) return [];
  return [
    `Capability diagnostic: model '${model}' was rejected by the vendor (account/model-id level refusal detected in the error text); ` +
      "the request was NOT applied. Verify the model id and account entitlement.",
  ];
}

/**
 * Surfaces the documented codex MCP sandbox mitigation when a child-process
 * spawn is rejected, instead of leaving agents to rediscover it every round.
 */
export function sandboxSpawnHint(
  agent: AgentName,
  transportUsed: "mcp" | "cli" | undefined,
  result: Pick<AgentResult, "error" | "output">,
): string | undefined {
  if (transportUsed !== "mcp") return undefined;
  const haystack = `${result.error ?? ""}\n${result.output ?? ""}`;
  if (!/spawn\s+EPERM/i.test(haystack)) return undefined;
  return agent === "codex"
    ? "codex MCP sandbox blocked a child process (spawn EPERM). Known mitigation: run tests with NODE_OPTIONS=--test-isolation=none, or rerun with mode=cli."
    : "An MCP sandbox blocked a child process (spawn EPERM); consider rerunning with the CLI transport.";
}

function contextSourceIds(sources: BridgeSession[]): string[] | undefined {
  const usable = sources.filter((source) => source.history.length > 0).map((s) => s.id);
  return usable.length ? usable : undefined;
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

export interface CompactContextSourceOutcome {
  sourceSessionId: string;
  /** summarized = sidecar written; in-flight = deduplicated; skipped/failed carry reason. */
  status: "summarized" | "in-flight" | "skipped" | "failed";
  reason?: string;
  summary?: string;
  summarizedTurns?: number;
  truncated?: boolean;
  durationMs?: number;
}

export interface CompactContextResult {
  outcomes: CompactContextSourceOutcome[];
}

const COMPACT_CONTEXT_MAX_SOURCES = 4;

/** One routing-table row for a registered adapter channel (T4.2). */
export interface AgentRoutingEntry {
  name: string;
  displayName: string;
  aliases: string[];
  available: boolean;
  availabilityNote?: string;
  executablePath?: string;
  preferredTransport: TransportMode;
  supportedTransports: TransportMode[];
  sandboxMechanism: SandboxMechanism;
  /** Self-declared routing metadata from the config agents section, when present. */
  metadata?: AgentMetadata;
  /** Capability diagnostics recorded by this agent's most recent turn, if any. */
  recentCapabilityDiagnostics: string[];
}

/** A declared tier/profile variant that is not a standalone binary (T4.2). */
export interface RoutingVariantEntry {
  key: string;
  metadata: AgentMetadata;
}

export interface AgentRoutingTable {
  /** Whether any agents metadata section was found for the working directory. */
  source: "configured" | "unconfigured";
  entries: AgentRoutingEntry[];
  variants: RoutingVariantEntry[];
  /** Present when the project config exists but could not be loaded. */
  configWarning?: string;
}

export class MultiAgentRunner {
  private registry: AgentRegistry;
  private sessionManager: SessionManager;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly idempotencyTtlMs: number;
  private readonly idempotencyInFlight = new Map<string, IdempotencyInFlightEntry>();
  /** Per-source compaction promises enabling the T2.3 in-flight dedupe. */
  private readonly compactInFlight = new Map<string, Promise<CompactContextSourceOutcome>>();
  /** T5.2 checkpoint store; overridable for test isolation. */
  private readonly checkpoints: CheckpointStore;

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
    this.now = options.now ?? Date.now;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.checkpoints = options.checkpointStore ?? defaultCheckpointStore;
  }

  /** Number of idempotent dispatches currently registered as in flight; observable for tests/diagnostics. */
  public get activeIdempotencyDispatches(): number {
    return this.idempotencyInFlight.size;
  }

  private readonly inFlight = new Map<
    number,
    { controller: AbortController; done: Promise<void> }
  >();
  private nextInFlightId = 1;

  /** Number of executions currently running; observable for shutdown diagnostics. */
  public get activeExecutionCount(): number {
    return this.inFlight.size;
  }

  /**
   * Aborts every active execution and waits for their turns to be recorded.
   * Called on server shutdown (stdio close / SIGINT / SIGTERM) so a client
   * disconnect leaves a terminal failed turn with full evidence behind
   * instead of a silent zero-trace disappearance (P-REAL-009).
   */
  public async abortAllInFlight(
    reason = "Client disconnected from the AgentMesh server.",
  ): Promise<void> {
    const entries = [...this.inFlight.values()];
    for (const entry of entries) entry.controller.abort(new Error(reason));
    await Promise.allSettled(entries.map((entry) => entry.done));
    this.inFlight.clear();
  }

  private beginInFlight(externalSignal: AbortSignal | undefined): {
    signal: AbortSignal;
    isDisconnectAborted: () => boolean;
    finish: () => void;
  } {
    const controller = new AbortController();
    const anyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal })
      .any;
    const signal =
      externalSignal && anyImpl
        ? anyImpl([externalSignal, controller.signal])
        : (externalSignal ?? controller.signal);
    const id = this.nextInFlightId++;
    let settle = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inFlight.set(id, { controller, done });
    return {
      signal,
      isDisconnectAborted: () => controller.signal.aborted,
      finish: () => {
        this.inFlight.delete(id);
        settle();
      },
    };
  }

  /**
   * P1 T1.1 idempotency branch resolution. Check-and-register is synchronous
   * (no awaits between lookup and registration) so two concurrent dispatches
   * with the same key cannot both pass the gate.
   */
  private resolveIdempotencyBranch(params: { scopeKey: string; key: string }):
    | { branch: "execute" }
    | { branch: "in-flight"; entry: IdempotencyInFlightEntry }
    | {
        branch: "replay";
        tombstone: IdempotencyTombstone;
      } {
    const live = this.idempotencyInFlight.get(params.scopeKey);
    if (live) return { branch: "in-flight", entry: live };
    const tombstone = this.sessionManager.getIdempotencyTombstone(params.scopeKey, this.now());
    if (tombstone) return { branch: "replay", tombstone };
    return { branch: "execute" };
  }

  /** In-flight duplicate response: a reference to the running execution, not a result. */
  private formatInFlightReference(params: {
    key: string;
    entry: IdempotencyInFlightEntry;
    agent: AgentName;
    startTime: number;
  }): AgentResult {
    const startedAt = new Date(params.entry.startedAtMs).toISOString();
    const summary =
      `Duplicate dispatch suppressed by idempotency key '${params.key}': ` +
      "an identical execution is already in flight.";
    const output =
      `An execution with this idempotency key started at ${startedAt} and is running in ` +
      `session '${params.entry.sessionId}'. Wait for it to finish, then re-send the SAME key to ` +
      "receive the replayed terminal result. Use a different key only for an intentionally distinct task.";
    return {
      status: "failed",
      agent: params.agent,
      sessionId: params.entry.sessionId,
      summary,
      output,
      error: `duplicate_in_flight: an execution with idempotency key '${params.key}' is already running`,
      durationMs: Date.now() - params.startTime,
    };
  }

  /**
   * Builds the replayed terminal result recorded under a tombstone. Returns
   * undefined when the referenced turn is no longer retrievable (evicted from
   * the capped history); the caller then degrades to a normal execution.
   */
  private formatReplayedResult(params: {
    tombstone: IdempotencyTombstone;
    key: string;
    fallbackAgent: AgentName;
    currentFingerprint?: string;
  }): AgentResult | undefined {
    const { tombstone } = params;
    const session = this.sessionManager.getSession(tombstone.sessionId);
    const turn = session?.history[tombstone.turnNumber - 1];
    if (!session || !turn) return undefined;

    const warnings: string[] = [];
    if (
      tombstone.repositoryFingerprint &&
      params.currentFingerprint &&
      tombstone.repositoryFingerprint !== params.currentFingerprint
    ) {
      warnings.push(
        "Freshness STALE: the repository fingerprint changed since the replayed turn completed; " +
          "its results may refer to outdated evidence. Re-execute with a new idempotency key if current-state output is required.",
      );
    }
    warnings.push(
      `This result was replayed from the idempotency tombstone of key '${params.key}' ` +
        "(no new agent execution was started).",
    );

    return {
      status: turn.status,
      agent: session.agent,
      sessionId: session.id,
      summary: `[idempotent replay] ${turn.summary}`,
      output: turn.finalAnswer || turn.summary || "",
      finalAnswer: turn.finalAnswer,
      findings: turn.findings ? structuredClone(turn.findings) : undefined,
      nativeSessionId: turn.nativeSessionId,
      exitCode: turn.evidence?.exitCode,
      errorCode: tombstone.errorCode,
      durationMs: turn.evidence?.durationMs,
      timedOut: turn.evidence?.timedOut,
      aborted: turn.evidence?.aborted,
      transportUsed: turn.evidence?.transportUsed,
      warning: warnings.join(" "),
      replayed: true,
    };
  }

  /** Records the terminal tombstone for one keyed dispatch (called after the turn is persisted). */
  private recordIdempotencyTombstone(params: {
    scopeKey: string;
    key: string;
    sessionId: string;
    turnNumber: number;
    outcome: "completed" | "failed";
    repositoryFingerprint?: string;
    errorCode?: ErrorCode;
  }): void {
    const completedAtMs = this.now();
    this.sessionManager.setIdempotencyTombstone(params.scopeKey, {
      key: params.key,
      sessionId: params.sessionId,
      turnNumber: params.turnNumber,
      outcome: params.outcome,
      ...(params.repositoryFingerprint
        ? { repositoryFingerprint: params.repositoryFingerprint }
        : {}),
      ...(params.errorCode ? { errorCode: params.errorCode } : {}),
      completedAtMs,
      expiresAtMs: completedAtMs + this.idempotencyTtlMs,
    });
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

    // Context-source validation runs before role resolution so a bad handoff
    // is reported precisely instead of being masked by an unrelated role error.
    // A role-resolution problem is still detected in the same pass so that the
    // combined message surfaces both problems at once (S4 aggregation).
    const requestedContextIds = [
      ...(params.contextSessionIds ?? []),
      ...(params.contextSessionId ? [params.contextSessionId] : []),
    ];
    if (requestedContextIds.length > MAX_CONTEXT_SOURCES) {
      const message = buildContextLimitError(MAX_CONTEXT_SOURCES, requestedContextIds.length);
      return {
        status: "failed",
        agent: (params.agent || existingSession?.agent || "unknown") as AgentName,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
    // Existing sessions own their execution context even before the binding is
    // re-validated below; new sessions use the explicitly requested cwd.
    const targetCwd = params.sessionId ? existingSession!.cwd : params.cwd || process.cwd();
    const collected = collectContextSources(this.sessionManager, requestedContextIds, targetCwd);
    const contextFailure = "failure" in collected ? collected : undefined;
    const contextSessions: BridgeSession[] =
      contextFailure === undefined && "sources" in collected ? collected.sources : [];

    const configCwd = params.cwd ?? existingSession?.cwd ?? process.cwd();
    const effectiveRole: AgentRole = params.role ?? existingSession?.role ?? "worker";
    const roleOutcome = safeResolveRoleAssignment(configCwd, effectiveRole);

    const selectedAgent =
      params.agent ?? existingSession?.agent ?? roleOutcome.resolution?.assignment?.agent;
    if (!selectedAgent) {
      const message = mergeValidationMessages(
        contextFailure ? describeContextFailure(contextFailure, targetCwd).summary : undefined,
        `No agent was provided and role '${effectiveRole}' is not configured in '${configCwd}/.agentmesh/config.json'.`,
      );
      return {
        status: "failed",
        agent: "unknown" as AgentName,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
    if (roleOutcome.error !== undefined || !roleOutcome.resolution) {
      // Role binding is broken but an explicit agent was provided; keep the
      // precise role diagnostics and merge any independent context failure.
      const message = mergeValidationMessages(
        contextFailure ? describeContextFailure(contextFailure, targetCwd).summary : undefined,
        roleOutcome.error ?? "Role assignment could not be resolved.",
      );
      return {
        status: "failed",
        agent: selectedAgent as AgentName,
        summary: message,
        output: message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
    const roleResolution = roleOutcome.resolution;
    if (contextFailure) {
      const described = describeContextFailure(contextFailure, targetCwd);
      return {
        status: "failed",
        agent: selectedAgent as AgentName,
        summary: described.summary,
        output: described.output,
        error: described.summary,
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

    // P5 T5.4 budget gate: fail-fast BEFORE the dispatch goes out so a
    // rejected session never registers an idempotency key. In-flight work and
    // poll_task are untouched — only new dispatches are gated.
    const budgetGate = this.evaluateBudgetForSession(configCwd, session);
    if (budgetGate.action === "reject") {
      return {
        status: "failed",
        agent: adapter.name,
        sessionId: session.id,
        summary: budgetGate.warning,
        output: budgetGate.warning,
        error: budgetGate.warning,
        errorCode: "BUDGET_EXHAUSTED",
        durationMs: Date.now() - startTime,
      };
    }

    // Existing sessions own their execution context. Omitted values inherit the
    // binding; explicitly supplied values were validated above.
    const effectiveCwd = params.cwd ?? session.cwd;
    const role: AgentRole = params.role ?? session.role;

    const repositoryBefore = await captureRepositoryState(effectiveCwd);
    // Native resume covers the target session's OWN history only; explicit
    // context sources always inject so cross-session facts arrive first-hand.
    const ownHistoryInjectable = !session.nativeSessionId && session.history.length > 0;
    const injectionSources = [...contextSessions, ...(ownHistoryInjectable ? [session] : [])];
    const sharedContext = buildSharedContextDetailed(injectionSources, repositoryBefore);

    const effectiveRequestedModel = params.model ?? roleResolution.assignment?.model;
    const effectiveRequestedEffort =
      params.reasoningEffort ?? roleResolution.assignment?.reasoningEffort;

    // P1 T1.1 idempotency gate: check-and-register runs synchronously so
    // concurrent duplicates cannot slip between lookup and registration. It is
    // placed after every validation early-return so pre-wire rejections never
    // register a key ("only accept when the dispatch really goes out").
    let idempotencyScope: string | undefined;
    let idempotencyExecutionWarning: string | undefined;
    if (params.idempotencyKey) {
      idempotencyScope = idempotencyScopeKey(effectiveCwd, adapter.name, params.idempotencyKey);
      const branch = this.resolveIdempotencyBranch({
        scopeKey: idempotencyScope,
        key: params.idempotencyKey,
      });
      if (branch.branch === "in-flight") {
        return this.formatInFlightReference({
          key: params.idempotencyKey,
          entry: branch.entry,
          agent: adapter.name,
          startTime,
        });
      }
      if (branch.branch === "replay") {
        const currentRepository = await captureRepositoryState(effectiveCwd);
        const replayed = this.formatReplayedResult({
          tombstone: branch.tombstone,
          key: params.idempotencyKey,
          fallbackAgent: adapter.name,
          currentFingerprint: currentRepository?.fingerprint,
        });
        if (replayed) return replayed;
        idempotencyExecutionWarning =
          `Idempotency key '${params.idempotencyKey}' holds a tombstone whose recorded turn is no longer ` +
          "retrievable from the capped session history; executing again and refreshing the tombstone.";
      }
      this.idempotencyInFlight.set(idempotencyScope, {
        sessionId: session.id,
        startedAtMs: this.now(),
      });
    }

    const inFlight = this.beginInFlight(params.signal);

    // Pre-flight capability check against the transport that will actually be
    // used. Never blocks execution; merged with post-execution diagnostics
    // (deduplicated) below so the caller sees one authoritative list.
    const requestedMode = params.mode ?? roleResolution.assignment?.mode;
    const preflightDiagnostics = evaluateModelOptionSupport({
      agent: adapter.name,
      transportUsed: predictTransport(adapter.supportedModes, requestedMode),
      model: effectiveRequestedModel,
      reasoningEffort: effectiveRequestedEffort,
      startDirectory: configCwd,
    });

    const runOptions: RunAgentOptions = {
      task: params.task,
      cwd: effectiveCwd,
      role,
      mode: params.mode ?? roleResolution.assignment?.mode,
      model: effectiveRequestedModel,
      reasoningEffort: effectiveRequestedEffort,
      timeoutMs: params.timeoutMs ?? roleResolution.assignment?.timeoutMs ?? this.defaultTimeoutMs,
      env: params.env,
      extraArgs: params.extraArgs,
      nativeSessionId: session.nativeSessionId,
      baseCommit: params.baseCommit,
      historyContext: sharedContext?.text,
      reviewVerdictRequired: params.reviewVerdictRequired,
      signal: inFlight.signal,
      taskActivity: params.taskActivity,
    };

    try {
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
          errorCode: classifyErrorCode({ message: errorMsg }),
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

      // Structured capability diagnostics: never let a requested vendor model or
      // reasoning option disappear silently on a transport that ignores it.
      const executedDiagnostics = evaluateModelOptionSupport({
        agent: adapter.name,
        transportUsed: result.transportUsed,
        model: effectiveRequestedModel,
        reasoningEffort: effectiveRequestedEffort,
        startDirectory: configCwd,
      });
      const rejectionDiagnostics = modelRejectionDiagnostic({
        model: effectiveRequestedModel,
        text: [result.error, result.output].filter(Boolean).join("\n"),
      });
      const spawnHint = sandboxSpawnHint(adapter.name, result.transportUsed, result);
      const diagnostics = [
        ...new Set([...preflightDiagnostics, ...executedDiagnostics, ...rejectionDiagnostics]),
      ];
      const extraWarnings = [...diagnostics, ...(spawnHint ? [spawnHint] : [])];
      if (extraWarnings.length > 0) {
        result.warning = [result.warning, ...extraWarnings].filter(Boolean).join(" ");
      }
      if (idempotencyExecutionWarning) {
        result.warning = [result.warning, idempotencyExecutionWarning].filter(Boolean).join(" ");
      }
      if (budgetGate.warning) {
        result.warning = [result.warning, budgetGate.warning].filter(Boolean).join(" ");
      }

      this.recordTurn({
        session,
        role,
        task: params.task,
        result,
        repositoryBefore,
        repositoryAfter,
        injectionSources,
        requestedModel: params.model,
        requestedReasoningEffort: params.reasoningEffort,
        capabilityDiagnostics: diagnostics,
        sharedContextText: sharedContext?.text,
        sharedContextSources: sharedContext?.sources,
        cancelReason: inFlight.isDisconnectAborted() ? "client_disconnect" : undefined,
      });

      // Post-execution water-level check: this turn's usage is now in the
      // session history, so a cap/80% crossing surfaces on the response that
      // caused it. Re-read the session: the local binding is a pre-turn
      // snapshot that does not include the just-recorded usage.
      const refreshedSession = this.sessionManager.getSession(session.id);
      if (refreshedSession) {
        const postGate = this.evaluateBudgetForSession(configCwd, refreshedSession);
        if (postGate.action === "warn" || postGate.action === "reject") {
          result.warning = [result.warning, postGate.warning].filter(Boolean).join(" ");
        }
      }

      // Terminal boundary of the keyed dispatch: persist the tombstone so
      // retries within the TTL replay this turn instead of re-executing.
      if (idempotencyScope && params.idempotencyKey) {
        const turnNumberAfterAppend =
          this.sessionManager.getSession(session.id)?.history.length ?? 0;
        this.recordIdempotencyTombstone({
          scopeKey: idempotencyScope,
          key: params.idempotencyKey,
          sessionId: session.id,
          turnNumber: turnNumberAfterAppend,
          outcome: result.status === "success" ? "completed" : "failed",
          repositoryFingerprint: repositoryAfter?.fingerprint,
          errorCode: result.errorCode,
        });
      }

      // T4.4 failure-upgrade hint: advisory only, attached at the terminal
      // failure exit so the orchestrator can reroute in one round trip.
      if (
        result.status === "failed" &&
        UPGRADEABLE_ERROR_CODES.includes(result.errorCode as ErrorCode)
      ) {
        const nextCandidates = this.buildUpgradeHint({
          declaredAgentKey: selectedAgent,
          canonicalAgent: adapter.name,
          requestedModel: effectiveRequestedModel,
          requestedReasoningEffort: effectiveRequestedEffort,
          transportUsed: result.transportUsed,
          startDirectory: configCwd,
        });
        if (nextCandidates.length) {
          const note =
            `hint.nextCandidates=[${nextCandidates.join(", ")}] (upgrade suggestions ordered by costLevel; ` +
            "the decision stays with the orchestrator — nothing is auto-redelivered)";
          result.warning = [result.warning, note].filter(Boolean).join(" ");
        }
      }

      return result;
    } finally {
      inFlight.finish();
      if (idempotencyScope) this.idempotencyInFlight.delete(idempotencyScope);
    }
  }

  /**
   * Performs an independent code review using the designated agent. With
   * maxReworkRounds > 0 (P5 T5.1) a FAIL verdict triggers a bounded rework
   * loop: the machine-parsed findings are injected into the original worker
   * session via continue_task, then a fresh reviewer re-reviews the repaired
   * working tree. Rounds are capped (≤3); exhaustion returns the final FAIL
   * with the full per-round evidence chain attached as result.rework.
   */
  public async reviewChanges(params: ReviewChangesParams): Promise<AgentResult> {
    const maxRounds = Math.min(Math.max(params.maxReworkRounds ?? 0, 0), MAX_REWORK_ROUNDS);
    const reviewOnce = (taskOverride?: string) =>
      this.delegateTask({
        agent: params.agent,
        task:
          taskOverride ||
          params.task ||
          "Review all recent changes against codebase standards and git diff.",
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
        reviewVerdictRequired: true,
        signal: params.signal,
      });

    let current = await reviewOnce();
    if (maxRounds === 0) return current;

    const workerSessionId = this.resolveReworkWorkerSession(params);
    const log: NonNullable<AgentResult["rework"]>["log"] = [];
    let roundsRun = 0;
    let reworkNote: string | undefined;

    while (current.reviewOutcome === "FAIL" && roundsRun < maxRounds) {
      if (!workerSessionId) {
        reworkNote =
          "Rework loop requested but no worker session was identified (pass workerSessionId or exactly one worker-role contextSessionId); returning the FAIL verdict unfixed.";
        break;
      }
      if (params.signal?.aborted) {
        reworkNote = "Rework loop stopped: the caller aborted the request.";
        break;
      }
      roundsRun += 1;
      const fixResult = await this.continueTask({
        sessionId: workerSessionId,
        task: buildReworkFixPrompt({
          round: roundsRun,
          maxRounds,
          findings: current.findings ?? [],
          reviewSummary: current.summary,
        }),
        signal: params.signal,
      });
      log.push({
        round: roundsRun,
        fixStatus: fixResult.status,
        reviewOutcome: "UNKNOWN",
      });
      if (fixResult.status !== "success") {
        reworkNote = `Rework round ${roundsRun} aborted: the worker fix turn failed (${
          fixResult.error || fixResult.summary
        }).`;
        break;
      }

      const reReview = await reviewOnce(
        `Re-review (rework round ${roundsRun} of ${maxRounds}): the worker reports the previous findings have been fixed. Re-run the full review against the current working tree.`,
      );
      log[log.length - 1]!.reviewOutcome = reReview.reviewOutcome ?? "UNKNOWN";
      current = reReview;
    }

    if (roundsRun > 0 || reworkNote) {
      current.rework = {
        ...(workerSessionId ? { workerSessionId } : { workerSessionId: "" }),
        rounds: roundsRun,
        log,
      };
      if (reworkNote) {
        current.warning = [current.warning, reworkNote].filter(Boolean).join(" ");
      }
    }
    return current;
  }

  /**
   * Resolves the worker session a rework loop should inject fix instructions
   * into: the explicit workerSessionId wins; otherwise exactly one worker-role
   * context session is accepted. Ambiguous or missing → undefined (no auto
   * guessing across multiple candidates).
   */
  private resolveReworkWorkerSession(params: ReviewChangesParams): string | undefined {
    if (params.workerSessionId) {
      const found = this.sessionManager.getSession(params.workerSessionId);
      return found && found.role === "worker" ? found.id : undefined;
    }
    const candidates = [
      ...(params.contextSessionIds ?? []),
      ...(params.contextSessionId ? [params.contextSessionId] : []),
    ]
      .map((id) => this.sessionManager.getSession(id))
      .filter((session): session is NonNullable<typeof session> => session?.role === "worker");
    return candidates.length === 1 ? candidates[0]!.id : undefined;
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
      const message = buildContextLimitError(MAX_CONTEXT_SOURCES, requestedContextIds.length);
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
    const collected = collectContextSources(this.sessionManager, requestedContextIds, session.cwd);
    if ("failure" in collected) {
      const described = describeContextFailure(collected, session.cwd);
      return {
        status: "failed",
        agent: session.agent,
        sessionId: session.id,
        summary: described.summary,
        output: described.output,
        error: described.summary,
        durationMs: Date.now() - startTime,
      };
    }
    const contextSessions = collected.sources;

    // P5 T5.2: consume the one-shot checkpoint baton BEFORE anything else can
    // observe it. Consumption is fail-closed: not-found and already-consumed
    // checkpoints abort the continuation instead of silently continuing with
    // less context than the caller believed.
    let checkpointInjection: string | undefined;
    if (params.fromCheckpoint) {
      try {
        const checkpoint = await this.checkpoints.consumeCheckpoint(params.fromCheckpoint);
        checkpointInjection = [
          `## Recovered Checkpoint (id: ${checkpoint.checkpointId}, reason: ${checkpoint.reason})`,
          "The interrupted run produced the partial output below before it terminated. Resume from this state; do not repeat work already reflected here.",
          "",
          checkpoint.partialAnswer,
        ].join("\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          agent: session.agent,
          sessionId: session.id,
          summary: `Checkpoint consumption failed: ${message}`,
          output: message,
          error: message,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const reviewerSafetyPolicy: ReviewerSafetyPolicy | undefined =
      session.role === "reviewer"
        ? readReviewerSafetyPolicy(session) ||
          loadReviewerSafetyFallback(session.cwd) ||
          "best-effort"
        : undefined;
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
    const sharedContext = buildSharedContextDetailed(injectionSources, repositoryBefore);

    const inFlight = this.beginInFlight(params.signal);
    const preflightDiagnostics = evaluateModelOptionSupport({
      agent: adapter.name,
      transportUsed: predictTransport(adapter.supportedModes, params.mode),
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      startDirectory: session.cwd,
    });

    try {
      const effectiveTask = checkpointInjection
        ? `${checkpointInjection}\n\n## Current Continuation Request / Instructions\n${params.task}`
        : params.task;
      let result: AgentResult;
      try {
        if (adapter.continue) {
          result = await adapter.continue({
            sessionId: session.id,
            nativeSessionId: session.nativeSessionId,
            task: effectiveTask,
            cwd: session.cwd,
            role: session.role,
            mode: params.mode,
            model: params.model,
            reasoningEffort: params.reasoningEffort,
            timeoutMs: params.timeoutMs ?? this.defaultTimeoutMs,
            env: params.env,
            extraArgs: params.extraArgs,
            historyContext: sharedContext?.text,
            signal: inFlight.signal,
          });
        } else {
          // Fallback to run with context
          result = await adapter.run({
            task: effectiveTask,
            cwd: session.cwd,
            role: session.role,
            mode: params.mode,
            timeoutMs: params.timeoutMs ?? this.defaultTimeoutMs,
            env: params.env,
            extraArgs: params.extraArgs,
            nativeSessionId: session.nativeSessionId,
            historyContext: sharedContext?.text,
            signal: inFlight.signal,
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
          errorCode: classifyErrorCode({ message: errorMsg }),
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

      // Structured capability diagnostics for continued runs as well.
      const executedDiagnostics = evaluateModelOptionSupport({
        agent: session.agent,
        transportUsed: result.transportUsed,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        startDirectory: session.cwd,
      });
      const rejectionDiagnostics = modelRejectionDiagnostic({
        model: params.model,
        text: [result.error, result.output].filter(Boolean).join("\n"),
      });
      const spawnHint = sandboxSpawnHint(session.agent, result.transportUsed, result);
      const diagnostics = [
        ...new Set([...preflightDiagnostics, ...executedDiagnostics, ...rejectionDiagnostics]),
      ];
      const extraWarnings = [...diagnostics, ...(spawnHint ? [spawnHint] : [])];
      if (extraWarnings.length > 0) {
        result.warning = [result.warning, ...extraWarnings].filter(Boolean).join(" ");
      }

      this.recordTurn({
        session,
        role: session.role,
        task: effectiveTask,
        result,
        repositoryBefore,
        repositoryAfter,
        injectionSources,
        requestedModel: params.model,
        requestedReasoningEffort: params.reasoningEffort,
        capabilityDiagnostics: diagnostics,
        sharedContextText: sharedContext?.text,
        sharedContextSources: sharedContext?.sources,
        cancelReason: inFlight.isDisconnectAborted() ? "client_disconnect" : undefined,
      });

      return result;
    } finally {
      inFlight.finish();
    }
  }

  /**
   * T2.3 compact_context: condenses each source session's normalized history
   * into a semantic summary sidecar using the session's own agent in a single
   * tool-free worker turn. Summaries are injected by shared-context rendering
   * only while fresh (no new turns since compaction). Concurrent compactions
   * of the same session are deduplicated: later callers receive an in-flight
   * notice instead of a second agent run.
   */
  public async compactContext(params: {
    sourceSessionIds: string[];
  }): Promise<CompactContextResult> {
    if (params.sourceSessionIds.length > COMPACT_CONTEXT_MAX_SOURCES) {
      throw new Error(
        `At most ${COMPACT_CONTEXT_MAX_SOURCES} source sessions are supported per compact_context call, but ${params.sourceSessionIds.length} were requested.`,
      );
    }
    const outcomes = await Promise.all(
      params.sourceSessionIds.map((id) => this.compactOneSource(id)),
    );
    return { outcomes };
  }

  /** Synchronous dedupe gate: check-and-register without awaits in between. */
  private compactOneSource(sourceSessionId: string): Promise<CompactContextSourceOutcome> {
    const existing = this.compactInFlight.get(sourceSessionId);
    if (existing) {
      return Promise.resolve({
        sourceSessionId,
        status: "in-flight",
        reason:
          "A compaction for this session is already running; wait for it to complete instead of dispatching another.",
      });
    }
    const task = this.runCompaction(sourceSessionId).finally(() => {
      this.compactInFlight.delete(sourceSessionId);
    });
    this.compactInFlight.set(sourceSessionId, task);
    return task;
  }

  private async runCompaction(sourceSessionId: string): Promise<CompactContextSourceOutcome> {
    const startTime = Date.now();
    const session = this.sessionManager.getSession(sourceSessionId);
    if (!session) {
      return {
        sourceSessionId,
        status: "failed",
        reason: `Session '${sourceSessionId}' not found.`,
      };
    }
    if (session.history.length === 0) {
      return {
        sourceSessionId,
        status: "skipped",
        reason: "The session has no recorded turns to summarize.",
      };
    }
    if (!this.registry.getAdapter(session.agent)) {
      return {
        sourceSessionId,
        status: "failed",
        reason: `No adapter is available for the session's agent '${session.agent}'.`,
      };
    }

    const turnCountAtCompaction = session.history.length;
    const normalizedHistory = buildSharedContextDetailed([session])?.text ?? "";
    // Tool-free summarization contract; the pointer names where details live.
    const prompt = buildSummaryPrompt(normalizedHistory, `Bridge session '${session.id}'`);

    const result = await this.delegateTask({
      agent: session.agent,
      cwd: session.cwd,
      role: "worker",
      task: prompt,
    });
    // The summarization turn runs on a throwaway bridge session bound to the
    // same agent/cwd. Delete it so compaction leaves exactly one durable
    // trace: the summary sidecar on the source session itself.
    const scratchSessionId =
      result.sessionId && result.sessionId !== sourceSessionId ? result.sessionId : undefined;

    const cleanupScratch = () => {
      if (scratchSessionId) this.sessionManager.deleteSession(scratchSessionId);
    };

    if (result.status !== "success") {
      cleanupScratch();
      return {
        sourceSessionId,
        status: "failed",
        reason: result.error || result.summary || "The summarization turn failed.",
        durationMs: Date.now() - startTime,
      };
    }

    let text = stripAnalysisDraft(result.finalAnswer || result.output || "");
    let truncated = false;
    if (!text.trim()) {
      cleanupScratch();
      return {
        sourceSessionId,
        status: "failed",
        reason: "The summarization turn produced no usable summary text.",
        durationMs: Date.now() - startTime,
      };
    }
    const pointerLine = `完整原文存于 Bridge session '${session.id}' ，需要细节请按需读取。`;
    const pointerTail = `\n${pointerLine}`;
    if (!text.includes("需要细节请按需读取")) {
      text += pointerTail;
    }
    if (text.length > COMPACT_SUMMARY_MAX_CHARS) {
      // Truncate with an explicit marker, keeping room so the provenance
      // pointer survives even a maximally oversized model answer.
      text =
        truncateText(
          text,
          COMPACT_SUMMARY_MAX_CHARS - pointerTail.length,
          "\n... [summary truncated]",
        ) + pointerTail;
      truncated = true;
    }

    const stored = this.sessionManager.setSummary(session.id, {
      text,
      summarizedTurns: turnCountAtCompaction,
      createdAt: new Date().toISOString(),
    });
    cleanupScratch();
    return {
      sourceSessionId,
      status: stored ? "summarized" : "failed",
      ...(stored ? {} : { reason: "The source session disappeared during compaction." }),
      ...(stored ? { summary: text } : {}),
      summarizedTurns: turnCountAtCompaction,
      truncated,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * T4.4 failure-upgrade hint builder. When a dispatch failed with an
   * upgradeable error code and the failed agent declares a candidates chain,
   * this resolves up to three next-hop suggestions: capability-checked via
   * evaluateModelOptionSupport (candidates whose transport would ignore the
   * requested model/effort again are dropped), ordered by declared costLevel
   * ascending (unmetered entries last, declaration order kept for ties).
   * Purely advisory output — nothing is ever auto-redelivered.
   */
  private buildUpgradeHint(params: {
    declaredAgentKey: string;
    canonicalAgent: AgentName;
    requestedModel?: string;
    requestedReasoningEffort?: ReasoningEffort;
    transportUsed?: "mcp" | "cli";
    startDirectory?: string;
  }): string[] {
    let metadataMap: Record<string, AgentMetadata> | undefined;
    try {
      metadataMap = loadProjectConfig(params.startDirectory ?? process.cwd())?.config.agents;
    } catch {
      return [];
    }
    const chain =
      metadataMap?.[params.declaredAgentKey]?.candidates ??
      metadataMap?.[params.canonicalAgent]?.candidates;
    if (!chain?.length) return [];

    let capabilities: CapabilitiesFile["capabilities"];
    try {
      capabilities = readCapabilities(params.startDirectory ?? process.cwd()).capabilities;
    } catch {
      capabilities = staticCapabilities();
    }
    const effectiveTransport: TransportMode = params.transportUsed ?? "cli";

    /** True only with positive evidence that this option would be ignored again. */
    const optionBlocked = (
      base: AgentName,
      field: "model" | "reasoningEffort",
      value: string | undefined,
    ): boolean => {
      if (!value) return false;
      const cap = getCapability(capabilities, base, effectiveTransport, field);
      if (!cap) return false;
      if (cap.supported === false) return true;
      return Boolean(cap.values && !cap.values.includes(value));
    };

    /** Resolves a chain entry to its backing binary; profile variants map to their base agent. */
    const baseOf = (key: string): AgentName | undefined => {
      const direct = this.registry.resolveName(key);
      if (direct) return direct;
      const parts = key.split("-");
      while (parts.length > 1) {
        parts.pop();
        const resolved = this.registry.resolveName(parts.join("-"));
        if (resolved) return resolved;
      }
      return undefined;
    };

    const meetsCapability = (key: string): boolean => {
      const base = baseOf(key);
      // Opaque keys carry unknown capabilities; leave the judgment to the orchestrator.
      if (!base) return true;
      return (
        !optionBlocked(base, "model", params.requestedModel) &&
        !optionBlocked(base, "reasoningEffort", params.requestedReasoningEffort)
      );
    };

    return chain
      .filter((key) => {
        if (key === params.declaredAgentKey || key === params.canonicalAgent) return false;
        const base = baseOf(key);
        return base !== params.canonicalAgent;
      })
      .filter(meetsCapability)
      .map((key) => ({ key, cost: metadataMap?.[key]?.costLevel }))
      .sort((a, b) => (a.cost ?? Number.POSITIVE_INFINITY) - (b.cost ?? Number.POSITIVE_INFINITY))
      .slice(0, MAX_UPGRADE_HINTS)
      .map((entry) => entry.key);
  }

  /**
   * P5 T5.4: evaluates the project budget config against one session's
   * accumulated usage. Config load failures degrade to "no gate" — a broken
   * config must not block dispatches.
   */
  private evaluateBudgetForSession(
    configCwd: string,
    session: BridgeSession,
  ): ReturnType<typeof evaluateBudgetGate> {
    let budget: BudgetConfig | undefined;
    try {
      budget = loadProjectConfig(configCwd)?.config.budget;
    } catch {
      budget = undefined;
    }
    return evaluateBudgetGate({ config: budget, session });
  }

  /**
   * Persists native session binding changes and one normalized turn of
   * execution evidence. Shared by delegateTask and continueTask.
   */
  private recordTurn(options: {
    session: BridgeSession;
    role: AgentRole;
    task: string;
    result: AgentResult;
    repositoryBefore: RepositoryStateEvidence | undefined;
    repositoryAfter: RepositoryStateEvidence | undefined;
    injectionSources: BridgeSession[];
    requestedModel?: string;
    requestedReasoningEffort?: ReasoningEffort;
    capabilityDiagnostics?: string[];
    sharedContextText?: string;
    sharedContextSources?: SourceRenderStats[];
    /** Overrides the derived cancel reason (e.g. server-shutdown disconnects). */
    cancelReason?: SessionExecutionEvidence["cancelReason"];
  }): void {
    const { session, result, repositoryBefore, repositoryAfter } = options;
    if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
      this.sessionManager.updateSession(session.id, {
        nativeSessionId: result.nativeSessionId,
      });
    }

    // Verbatim handoff audit: persist the exact injected block as a sidecar and
    // attach digest/size/truncation metadata to the turn so orchestrators can
    // verify what downstream agents actually saw.
    let sharedContextAudit: SharedContextAudit | undefined;
    if (options.sharedContextText && options.sharedContextSources?.length) {
      const text = options.sharedContextText;
      const artifact = this.sessionManager.persistContextArtifact(
        session.id,
        session.history.length + 1,
        text,
      );
      sharedContextAudit = {
        ...(artifact ? { file: artifact.file } : {}),
        bytes: artifact?.bytes ?? Buffer.byteLength(text, "utf-8"),
        sha256: createHash("sha256").update(text, "utf-8").digest("hex"),
        totalChars: text.length,
        sources: options.sharedContextSources.map((source) => ({ ...source })),
      };
    }

    this.sessionManager.addHistory(session.id, {
      role: options.role,
      task: options.task,
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
        cancelReason:
          options.cancelReason ??
          (result.timedOut ? "timeout" : result.aborted ? "client_cancel" : undefined),
        errorCode: result.errorCode,
        cleanupMethod: result.cleanupMethod,
        cleanupSucceeded: result.cleanupSucceeded,
        resourceEvidence: result.resourceEvidence,
        transportFallback: result.transportFallback,
      },
      reviewerSafety: result.reviewerSafety,
      requestedModel: options.requestedModel,
      requestedReasoningEffort: options.requestedReasoningEffort,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(options.capabilityDiagnostics?.length
        ? { capabilityDiagnostics: options.capabilityDiagnostics }
        : {}),
      ...(sharedContextAudit ? { sharedContextAudit } : {}),
      ...(contextSourceIds(options.injectionSources)
        ? { contextSources: contextSourceIds(options.injectionSources) }
        : {}),
    });
  }

  /**
   * Registers an artifact-spill pointer in the session sidecar audit trail
   * (T2.2). Returns undefined when persistence is disabled or the write fails;
   * audit loss must never fail the turn.
   */
  public registerArtifactAudit(
    sessionId: string,
    turnNumber: number,
    record: {
      source: string;
      chars: number;
      sha256: string;
      artifactPath: string;
    },
  ): { file: string } | undefined {
    return this.sessionManager.persistArtifactSidecar(sessionId, turnNumber, record);
  }

  /**
   * Returns list of supported agents and their availability on this machine.
   */
  public async listAgents() {
    return this.registry.listAgentAvailability();
  }

  /**
   * T4.2 routing table: one row per registered channel with live availability
   * (registry scan front-loaded here), transport and sandbox declarations,
   * self-declared metadata from the config agents section, the candidates
   * upgrade chain, and this channel's most recent capability diagnostics.
   * Declared tier/profile variants that are not standalone binaries are listed
   * separately. Missing metadata degrades to "unconfigured" instead of error.
   */
  public async getAgentRoutingTable(
    startDirectory: string = process.cwd(),
  ): Promise<AgentRoutingTable> {
    const availability = await this.registry.listAgentAvailability();

    let metadataMap: Record<string, AgentMetadata> | undefined;
    let configWarning: string | undefined;
    try {
      const loaded = loadProjectConfig(startDirectory);
      metadataMap = loaded?.config.agents;
    } catch (error) {
      configWarning = error instanceof Error ? error.message : String(error);
    }

    // Most recent capability diagnostics per agent, scanning newest history
    // entries first; sessions are returned most-recently-updated first.
    const recentDiagnostics = new Map<AgentName, string[]>();
    for (const session of this.sessionManager.listSessions()) {
      if (recentDiagnostics.has(session.agent)) continue;
      for (let i = session.history.length - 1; i >= 0; i--) {
        const diagnostics = session.history[i]?.capabilityDiagnostics;
        if (diagnostics?.length) {
          recentDiagnostics.set(session.agent, diagnostics);
          break;
        }
      }
    }

    const entries: AgentRoutingEntry[] = availability.map((channel) => ({
      name: channel.name,
      displayName: channel.displayName,
      aliases: channel.aliases,
      available: channel.available,
      ...(channel.info.notes ? { availabilityNote: channel.info.notes } : {}),
      ...(channel.info.path ? { executablePath: channel.info.path } : {}),
      preferredTransport: channel.info.preferredTransport,
      supportedTransports: channel.info.supportedTransports,
      sandboxMechanism: channel.info.sandboxMechanism,
      metadata: metadataMap?.[channel.name],
      recentCapabilityDiagnostics: recentDiagnostics.get(channel.name) ?? [],
    }));

    const variants: RoutingVariantEntry[] = Object.entries(metadataMap ?? {})
      .filter(([key]) => !this.registry.resolveName(key))
      .map(([key, metadata]) => ({ key, metadata }));

    return {
      source: metadataMap ? "configured" : "unconfigured",
      entries,
      variants,
      ...(configWarning ? { configWarning } : {}),
    };
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
