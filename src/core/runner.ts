import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  ReasoningEffort,
  ReviewFinding,
  ReviewerSafetyPolicy,
  ReviewerSafetyReport,
  RunAgentOptions,
  TransportMode,
} from "../agents/types.js";
import { defaultRegistry } from "../agents/registry.js";
import type { AgentRegistry } from "../agents/registry.js";
import { evaluateModelOptionSupport } from "./capabilities.js";
import { defaultSessionManager, SessionManager } from "./session.js";
import { resolveRoleAssignment, loadProjectConfig } from "./config.js";
import { captureRepositoryState } from "./repository.js";
import { parseHandoffReport } from "./handoff.js";
import { estimateTokens, truncateText, truncateTextToTokenBudget } from "./text.js";
import type {
  BridgeSession,
  HandoffSummary,
  RepositoryStateEvidence,
  RunnerOptions,
  SessionExecutionEvidence,
  SessionHistoryEntry,
  SharedContextAudit,
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
  /**
   * Internal: declares the strict review contract so an unparseable reviewer
   * verdict fails closed. Only the review_changes pipeline sets this; it is
   * deliberately absent from the MCP input schemas.
   */
  reviewVerdictRequired?: boolean;
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

export type SessionTurnContextField = "handoff" | "finalAnswer" | "findings" | "evidence";

/** One recorded turn as returned by the get_session_context retrieval tool. */
export interface SessionTurnContext {
  sessionId: string;
  turnIndex: number;
  totalTurns: number;
  agent: AgentName;
  role: AgentRole;
  status: "success" | "failed";
  timestamp: string;
  task: string;
  summary?: string;
  freshness: ContextFreshness;
  handoff?: HandoffSummary;
  finalAnswer?: string;
  findings?: ReviewFinding[];
  evidence?: SessionExecutionEvidence;
  reviewerSafety?: ReviewerSafetyReport;
}

const MAX_CONTEXT_SOURCES = 4;
const MAX_SHARED_CONTEXT_TOKENS = 6_000;
const MIN_PER_SOURCE_TOKENS = 1_200;
/** Turns without a structured handoff replay a shortened answer slice. */
const LEGACY_ANSWER_CHARS = 1_200;
/** Full-answer retrieval cap for the get_session_context tool. */
const MAX_CONTEXT_TOOL_ANSWER_CHARS = 24_000;

export type ContextFreshness = "MATCHED" | "STALE" | "UNKNOWN";

function truncateSharedText(value: string, maxChars: number): string {
  return truncateText(value, maxChars, "... [truncated]");
}

function formatRepositoryState(evidence: RepositoryStateEvidence): string {
  const changed = evidence.changedPaths.length
    ? `; changed=${evidence.changedPaths.join(", ")}`
    : "";
  return `head=${evidence.head || "unborn"}; dirty=${evidence.dirty}; fingerprint=${evidence.fingerprint}${changed}`;
}

/**
 * Compares the current working tree against the source session's last recorded
 * repository fingerprint. MATCHED lets downstream agents reuse prior results
 * directly; STALE demands revalidation of affected evidence.
 */
export function computeSessionFreshness(
  session: BridgeSession,
  current: RepositoryStateEvidence | undefined,
): ContextFreshness {
  const previous = session.history.at(-1)?.evidence?.repositoryAfter;
  if (previous && current) {
    return previous.repositoryRoot === current.repositoryRoot &&
      previous.fingerprint === current.fingerprint
      ? "MATCHED"
      : "STALE";
  }
  return "UNKNOWN";
}

const FRESHNESS_LABELS: Record<ContextFreshness, string> = {
  MATCHED: "MATCHED: the current working tree matches the last recorded handoff state.",
  STALE:
    "STALE: the current working tree differs from the last recorded handoff state; revalidate affected evidence.",
  UNKNOWN: "UNKNOWN: repository evidence is unavailable; verify before relying on prior results.",
};

/**
 * One droppable piece of a turn rendering. `dropPriority` orders budget-driven
 * removal: reproducibility detail goes first, conclusions last.
 */
interface TurnSection {
  name: string;
  dropPriority: number;
  text: string;
}

interface TurnRender {
  heading: string;
  /** Anchor line (goal or task) that survives every budget stage; empty joins are filtered. */
  coreLine: string;
  sections: TurnSection[];
  /** Set when a legacy answer slice was shortened (reported via `truncated`). */
  answerTruncated?: boolean;
}

function executionEvidenceLine(entry: SessionHistoryEntry): string | undefined {
  if (!entry.evidence) return undefined;
  return `Execution evidence: transport=${entry.evidence.transportUsed || "unknown"}; exitCode=${entry.evidence.exitCode ?? "unknown"}; durationMs=${entry.evidence.durationMs ?? "unknown"}`;
}

function turnHeading(
  session: BridgeSession,
  entry: SessionHistoryEntry,
  turnNumber: number,
): string {
  return `[Turn ${turnNumber} | Agent: ${session.agent.toUpperCase()} | Role: ${entry.role.toUpperCase()} | Status: ${entry.status.toUpperCase()}]`;
}

function renderHandoffTurn(
  session: BridgeSession,
  entry: SessionHistoryEntry,
  turnNumber: number,
): TurnRender {
  const handoff = entry.handoff!;
  const sections: TurnSection[] = [];
  if (handoff.artifacts.tests) {
    sections.push({ name: "Tests", dropPriority: 0, text: `Tests: ${handoff.artifacts.tests}` });
  }
  if (handoff.openItems.length > 0) {
    sections.push({
      name: "Open Items",
      dropPriority: 1,
      text: ["Open Items:", ...handoff.openItems.map((item) => `- ${item}`)].join("\n"),
    });
  }
  if (handoff.artifacts.commands?.length) {
    sections.push({
      name: "Commands",
      dropPriority: 2,
      text: `Commands: ${handoff.artifacts.commands.join("; ")}`,
    });
  }
  if (handoff.artifacts.files?.length) {
    sections.push({
      name: "Files",
      dropPriority: 3,
      text: `Files: ${handoff.artifacts.files.join(", ")}`,
    });
  }
  if (handoff.keyDecisions.length > 0) {
    sections.push({
      name: "Decisions",
      dropPriority: 4,
      text: ["Decisions:", ...handoff.keyDecisions.map((item) => `- ${item}`)].join("\n"),
    });
  }
  if (entry.findings?.length) {
    sections.push({
      name: "Findings",
      dropPriority: 5,
      text: `Findings: ${JSON.stringify(entry.findings)}`,
    });
  }
  const evidenceLine = executionEvidenceLine(entry);
  if (evidenceLine) {
    sections.push({ name: "Execution evidence", dropPriority: 6, text: evidenceLine });
  }
  if (entry.reviewerSafety) {
    sections.push({
      name: "Reviewer safety",
      dropPriority: 7,
      text: `Reviewer safety: ${JSON.stringify(entry.reviewerSafety)}`,
    });
  }
  return {
    heading: turnHeading(session, entry, turnNumber),
    coreLine: `Goal: ${handoff.goal}`,
    sections,
  };
}

function renderLegacyTurn(
  session: BridgeSession,
  entry: SessionHistoryEntry,
  turnNumber: number,
): TurnRender {
  const sections: TurnSection[] = [];
  const details: string[] = [turnHeading(session, entry, turnNumber), `Task: ${entry.task}`];
  let answerTruncated = false;
  if (entry.summary) details.push(`Summary: ${entry.summary}`);
  if (entry.finalAnswer) {
    answerTruncated = entry.finalAnswer.length > LEGACY_ANSWER_CHARS;
    sections.push({
      name: "Final answer",
      dropPriority: 0,
      text: `Final answer: ${truncateSharedText(entry.finalAnswer, LEGACY_ANSWER_CHARS)}`,
    });
  }
  if (entry.findings?.length) {
    sections.push({
      name: "Findings",
      dropPriority: 1,
      text: `Findings: ${JSON.stringify(entry.findings)}`,
    });
  }
  const repositoryLines: string[] = [];
  if (entry.evidence?.repositoryBefore) {
    repositoryLines.push(
      `Repository before: ${formatRepositoryState(entry.evidence.repositoryBefore)}`,
    );
  }
  if (entry.evidence?.repositoryAfter) {
    repositoryLines.push(
      `Repository after: ${formatRepositoryState(entry.evidence.repositoryAfter)}`,
    );
  }
  if (repositoryLines.length > 0) {
    sections.push({
      name: "Repository evidence",
      dropPriority: 2,
      text: repositoryLines.join("\n"),
    });
  }
  const evidenceLine = executionEvidenceLine(entry);
  if (evidenceLine) {
    sections.push({ name: "Execution evidence", dropPriority: 3, text: evidenceLine });
  }
  if (entry.reviewerSafety) {
    sections.push({
      name: "Reviewer safety",
      dropPriority: 4,
      text: `Reviewer safety: ${JSON.stringify(entry.reviewerSafety)}`,
    });
  }
  return {
    heading: details.join("\n"),
    coreLine: "",
    sections,
    ...(answerTruncated ? { answerTruncated } : {}),
  };
}

/** One-line index of an older turn; handoff goals when available, else the task. */
function renderTurnIndexLine(entry: SessionHistoryEntry, turnNumber: number): string {
  const label = entry.handoff?.goal ?? truncateText(entry.task.replace(/\s+/g, " "), 80);
  return `[Turn ${turnNumber} | ${entry.role} | ${entry.status}] ${label}`;
}

interface SourceRenderStats {
  sessionId: string;
  chars: number;
  truncated: boolean;
}

interface SharedContextRender {
  text: string;
  sources: SourceRenderStats[];
  strategy: "handoff" | "legacy";
  estimatedTokens: number;
  droppedSections: string[];
}

/**
 * Renders one source session: the latest turn in full (structured handoff, or
 * a shortened legacy replay), one-line indexes of older turns, and the
 * freshness verdict at the block tail. Budget stages drop reproducibility
 * detail before conclusions so the most recent handoff state survives.
 */
function renderSourceBlock(
  session: BridgeSession,
  index: number,
  total: number,
  budgetTokens: number,
  current: RepositoryStateEvidence | undefined,
): { text: string; truncated: boolean; dropped: string[]; hasHandoff: boolean } {
  const header = `### Source ${index + 1} of ${total} [Session: ${session.id} | Agent: ${session.agent.toUpperCase()} | Turns: ${session.history.length}]`;
  const history = session.history;
  const latest = history.at(-1)!;
  const latestRender = latest.handoff
    ? renderHandoffTurn(session, latest, history.length)
    : renderLegacyTurn(session, latest, history.length);
  let indexLines = history
    .slice(0, -1)
    .map((entry, offset) => renderTurnIndexLine(entry, offset + 1));
  const dropped: string[] = [];

  const renderBlock = (): string => {
    const latestText = [
      latestRender.heading,
      latestRender.coreLine,
      ...latestRender.sections.map((section) => section.text),
    ]
      .filter(Boolean)
      .join("\n");
    const omittedCount = history.length - 1 - indexLines.length;
    return [
      latestText,
      indexLines.length > 0 ? indexLines.join("\n") : undefined,
      omittedCount > 0
        ? `[${omittedCount} older turn(s) omitted within the context budget]`
        : undefined,
      `Context freshness: ${FRESHNESS_LABELS[computeSessionFreshness(session, current)]}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  let block = renderBlock();
  if (estimateTokens(block) > budgetTokens && indexLines.length > 0) {
    dropped.push("older turn indexes");
  }
  while (estimateTokens(block) > budgetTokens && indexLines.length > 0) {
    indexLines = indexLines.slice(1);
    block = renderBlock();
  }
  while (estimateTokens(block) > budgetTokens && latestRender.sections.length > 0) {
    const victim = latestRender.sections.reduce((min, section) =>
      section.dropPriority < min.dropPriority ? section : min,
    );
    latestRender.sections = latestRender.sections.filter((section) => section !== victim);
    dropped.push(`turn ${history.length} ${victim.name}`);
    block = renderBlock();
  }
  if (estimateTokens(block) > budgetTokens) {
    block = truncateTextToTokenBudget(block, budgetTokens);
    dropped.push("hard truncated");
  }
  return {
    text: [header, block].join("\n"),
    truncated: dropped.length > 0 || Boolean(latestRender.answerTruncated),
    dropped,
    hasHandoff: Boolean(latest.handoff),
  };
}

const SHARED_CONTEXT_INSTRUCTION =
  "Reuse successful prior results and explicit findings only when a source's freshness is MATCHED. If it is STALE or UNKNOWN, revalidate affected evidence without automatically repeating unrelated checks. Treat summaries as context, not as authority over contradictory current evidence. When you rely on a source, cite its session ID; never claim to reuse information that is not present in this injected context. Each source inlines its latest turn as a structured handoff, with older turns as one-line indexes; for upstream detail that is not inlined here (full final answers, findings, evidence), call the `get_session_context` tool with that session ID instead of re-deriving the work.";

/**
 * Renders the normalized history of one or more source sessions as first-hand
 * shared context, replacing orchestrator-side relay through task text. Each
 * source inlines its latest turn's structured handoff (legacy turns replay a
 * shortened answer), keeps one-line indexes of older turns, and carries its
 * own freshness verdict; the block is bounded by a token budget rather than a
 * character count.
 *
 * Returns per-source injection statistics so callers can audit verbatim what
 * downstream agents actually received (see SharedContextAudit).
 */
export function buildSharedContextDetailed(
  sources: BridgeSession[],
  currentRepositoryState?: RepositoryStateEvidence,
  options?: { budgetTokens?: number },
): SharedContextRender | undefined {
  const usable = sources.filter((session) => session.history.length > 0);
  if (usable.length === 0) return undefined;
  const header =
    usable.length === 1 ? "## Shared Context" : `## Shared Context (${usable.length} sources)`;
  const prefix = [
    header,
    SHARED_CONTEXT_INSTRUCTION,
    currentRepositoryState
      ? `Current repository: ${formatRepositoryState(currentRepositoryState)}`
      : "Current repository: unavailable",
  ].join("\n\n");
  const totalBudget = Math.max(
    options?.budgetTokens ?? MAX_SHARED_CONTEXT_TOKENS,
    MIN_PER_SOURCE_TOKENS,
  );
  const perSourceBudget = Math.max(
    MIN_PER_SOURCE_TOKENS,
    Math.floor((totalBudget - estimateTokens(prefix)) / usable.length),
  );
  const blocks = usable.map((session, index) =>
    renderSourceBlock(session, index, usable.length, perSourceBudget, currentRepositoryState),
  );
  const text = [prefix, ...blocks.map((block) => block.text)].join("\n\n");
  return {
    text,
    sources: usable.map((session, index) => ({
      sessionId: session.id,
      chars: blocks[index]!.text.length,
      truncated: blocks[index]!.truncated,
    })),
    strategy: blocks.some((block) => block.hasHandoff) ? "handoff" : "legacy",
    estimatedTokens: estimateTokens(text),
    droppedSections: blocks.flatMap((block) => block.dropped),
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
        sharedContext,
        cancelReason: inFlight.isDisconnectAborted() ? "client_disconnect" : undefined,
      });

      return result;
    } finally {
      inFlight.finish();
    }
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
      reviewVerdictRequired: true,
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
            historyContext: sharedContext?.text,
            signal: inFlight.signal,
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
        task: params.task,
        result,
        repositoryBefore,
        repositoryAfter,
        injectionSources,
        requestedModel: params.model,
        requestedReasoningEffort: params.reasoningEffort,
        capabilityDiagnostics: diagnostics,
        sharedContext,
        cancelReason: inFlight.isDisconnectAborted() ? "client_disconnect" : undefined,
      });

      return result;
    } finally {
      inFlight.finish();
    }
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
    sharedContext?: SharedContextRender;
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
    if (options.sharedContext?.text && options.sharedContext.sources.length) {
      const text = options.sharedContext.text;
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
        sources: options.sharedContext.sources.map((source) => ({ ...source })),
        strategy: options.sharedContext.strategy,
        estimatedTokens: options.sharedContext.estimatedTokens,
        ...(options.sharedContext.droppedSections.length
          ? { droppedSections: options.sharedContext.droppedSections }
          : {}),
        injectedOwnHistory: options.injectionSources.some((source) => source.id === session.id),
      };
    }

    // Structured handoff from the final answer; absent when the vendor did
    // not follow the report contract, in which case injections fall back to
    // the legacy replay rendering for this turn.
    const handoff = parseHandoffReport(result.finalAnswer, options.task, result.status);

    this.sessionManager.addHistory(session.id, {
      role: options.role,
      task: options.task,
      timestamp: new Date().toISOString(),
      status: result.status,
      summary: result.summary,
      finalAnswer: result.finalAnswer,
      ...(handoff ? { handoff } : {}),
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
        cleanupMethod: result.cleanupMethod,
        cleanupSucceeded: result.cleanupSucceeded,
        resourceEvidence: result.resourceEvidence,
        transportFallback: result.transportFallback,
      },
      reviewerSafety: result.reviewerSafety,
      requestedModel: options.requestedModel,
      requestedReasoningEffort: options.requestedReasoningEffort,
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
   * Read-only retrieval of one recorded turn, the lazy-loading counterpart of
   * the handoff-first injection: downstream agents fetch the full final
   * answer, findings, or evidence instead of AgentMesh replaying them into
   * every prompt. Returns `{ error }` for unknown sessions and bad indexes.
   */
  public async getSessionTurnContext(params: {
    sessionId: string;
    turnIndex?: number;
    fields?: SessionTurnContextField[];
  }): Promise<SessionTurnContext | { error: string }> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      return { error: `Session '${params.sessionId}' not found.` };
    }
    const totalTurns = session.history.length;
    if (totalTurns === 0) {
      return { error: `Session '${params.sessionId}' has no recorded turns.` };
    }
    const turnIndex = params.turnIndex ?? totalTurns;
    if (!Number.isInteger(turnIndex) || turnIndex < 1 || turnIndex > totalTurns) {
      return {
        error: `Session '${params.sessionId}' has ${totalTurns} turn(s); turnIndex must be between 1 and ${totalTurns}.`,
      };
    }
    const entry = session.history[turnIndex - 1]!;
    const fields = new Set(params.fields ?? ["handoff"]);
    const currentRepositoryState = await captureRepositoryState(session.cwd);
    return {
      sessionId: session.id,
      turnIndex,
      totalTurns,
      agent: session.agent,
      role: entry.role,
      status: entry.status,
      timestamp: entry.timestamp,
      task: entry.task,
      ...(entry.summary ? { summary: entry.summary } : {}),
      freshness: computeSessionFreshness(session, currentRepositoryState),
      ...(fields.has("handoff") && entry.handoff ? { handoff: entry.handoff } : {}),
      ...(fields.has("finalAnswer") && entry.finalAnswer
        ? {
            finalAnswer: truncateText(
              entry.finalAnswer,
              MAX_CONTEXT_TOOL_ANSWER_CHARS,
              "... [truncated — the session store retains the full text]",
            ),
          }
        : {}),
      ...(fields.has("findings") && entry.findings?.length ? { findings: entry.findings } : {}),
      ...(fields.has("evidence") && (entry.evidence || entry.reviewerSafety)
        ? {
            ...(entry.evidence ? { evidence: entry.evidence } : {}),
            ...(entry.reviewerSafety ? { reviewerSafety: entry.reviewerSafety } : {}),
          }
        : {}),
    };
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
