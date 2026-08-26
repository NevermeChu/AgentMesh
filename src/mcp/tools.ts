import * as crypto from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MultiAgentRunner } from "../core/runner.js";
import type { AgentResult } from "../agents/types.js";
import { BackgroundTaskNotFoundError, BackgroundTaskRegistry } from "../core/background.js";
import { forgetActivityHandle, getActivityHandle } from "../core/executor.js";
import { buildPreview, persistArtifact, selectArtifactSpill } from "../core/artifacts.js";
import type { AgentMetadata } from "../core/config.js";
import { truncateText } from "../core/text.js";

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_FINAL_ANSWER_CHARS = 12_000;
const MAX_RAW_OUTPUT_CHARS = 8_000;
const PROGRESS_INTERVAL_MS = 15_000;
type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const NonBlankString = z.string().trim().min(1);

/** One normalized section already spilled to an artifact and replaced by a pointer block. */
interface SpilledSection {
  source: "finalAnswer" | "rawOutput";
  previewBlock: string;
}

function buildNormalizedLines(result: AgentResult, spilled: SpilledSection | undefined): string[] {
  const details = [`Summary: ${result.summary}`];
  if (spilled?.source === "finalAnswer") {
    details.push(spilled.previewBlock);
  } else if (result.finalAnswer && result.finalAnswer.trim() !== result.summary.trim()) {
    details.push(
      `Final Answer:\n${truncateText(result.finalAnswer.trim(), MAX_FINAL_ANSWER_CHARS)}`,
    );
  }
  // Vendor logs and stderr stay diagnosable over MCP instead of being dropped
  // by normalization; without them, remote failures carry no actionable detail.
  const rawOutput = result.output?.trim();
  if (spilled?.source === "rawOutput") {
    details.push(spilled.previewBlock);
  } else if (
    rawOutput &&
    rawOutput !== result.finalAnswer?.trim() &&
    rawOutput !== result.summary.trim()
  ) {
    details.push(`Raw Output:\n${truncateText(rawOutput, MAX_RAW_OUTPUT_CHARS)}`);
  }
  if (result.error) details.push(`Error: ${result.error}`);
  if (result.errorCode) details.push(`error_code: ${result.errorCode}`);
  if (result.warning) details.push(`Warning: ${result.warning}`);
  if (result.timedOut) details.push("Execution Evidence: timed out");
  if (result.aborted) details.push("Execution Evidence: aborted");
  if (result.resourceEvidence) {
    details.push(`Resource Evidence:\n${JSON.stringify(result.resourceEvidence, null, 2)}`);
  }
  if (result.exitCode !== undefined) details.push(`Exit Code: ${result.exitCode}`);
  if (result.findings && result.findings.length > 0) {
    details.push(`Findings:\n${JSON.stringify(result.findings, null, 2)}`);
  }
  if (result.reviewerSafety) {
    details.push(`Reviewer Safety:\n${JSON.stringify(result.reviewerSafety, null, 2)}`);
  }
  return details;
}

/**
 * Sync legacy renderer without artifact spill. Sections over the spill
 * threshold degrade to the historical hard truncation here; production MCP
 * handlers use formatNormalizedResultDetailed so oversized sections are
 * persisted verbatim and referenced by path instead.
 */
export function formatNormalizedResult(result: AgentResult): string[] {
  return buildNormalizedLines(result, undefined);
}

export interface NormalizedResultFormatOptions {
  /** Bridge session owning the turn; required for artifact persistence. */
  sessionId?: string;
  /** 1-based turn number naming the artifact file and audit record. */
  turnNumber?: number;
  /**
   * Overrides the AgentMesh home root for artifact files (test isolation);
   * production leaves this unset so resolveAgentMeshHome() applies.
   */
  artifactHomeDir?: string;
  /**
   * Registers the spill pointer into the session sidecar audit trail; wired to
   * MultiAgentRunner.registerArtifactAudit by the MCP handlers.
   */
  registerAudit?: (record: {
    source: string;
    chars: number;
    sha256: string;
    artifactPath: string;
  }) => { file: string } | undefined;
}

/**
 * Async renderer with T2.2 artifact spill ([CC] toolResultStorage): a
 * finalAnswer/rawOutput over ARTIFACT_SPILL_THRESHOLD_CHARS is persisted
 * verbatim to <agentmeshHome>/artifacts/<sessionId>/turn-<n>.txt and replaced
 * by a bounded newline-boundary preview plus the absolute artifact path and a
 * [hasMore] marker 鈥?no information is truncated away.
 */
export async function formatNormalizedResultDetailed(
  result: AgentResult,
  options: NormalizedResultFormatOptions = {},
): Promise<string[]> {
  const decision = selectArtifactSpill(result.finalAnswer, result.output);
  let spilled: SpilledSection | undefined;
  if (decision && options.sessionId && options.turnNumber !== undefined) {
    const artifact = await persistArtifact(
      options.sessionId,
      options.turnNumber,
      decision.content,
      {
        homeDir: options.artifactHomeDir,
      },
    );
    options.registerAudit?.({
      source: decision.source,
      chars: artifact.chars,
      sha256: artifact.sha256,
      artifactPath: artifact.path,
    });
    const { preview, truncated } = buildPreview(decision.content);
    const label = decision.source === "finalAnswer" ? "Final Answer" : "Raw Output";
    spilled = {
      source: decision.source,
      previewBlock: [
        `${label} Spilled To Artifact (full output preserved on disk, ${artifact.chars} chars):`,
        `Artifact Path: ${artifact.path}`,
        `sha256: ${artifact.sha256}`,
        "Preview:",
        preview,
        `[hasMore: ${truncated}]`,
      ].join("\n"),
    };
  }
  return buildNormalizedLines(result, spilled);
}

async function sendProgress(
  extra: ToolRequestExtra,
  progress: number,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message },
    });
  } catch {
    // Progress is advisory and must not change the task outcome.
  }
}

/** Combines the MCP request signal with a background dispatch controller. */
function mergeAbortSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  const anyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (external && anyImpl) return anyImpl([external, internal]);
  return internal;
}

export interface BackgroundLaunchParams {
  taskId: string;
  outputFile: string;
  run: (signal: AbortSignal) => Promise<AgentResult>;
}

/**
 * Owns in-process background dispatches (T1.4). Each launch registers its
 * promise for graceful shutdown and writes the terminal outcome into the
 * task registry so poll_task can report completed/failed states 鈥?including
 * after the MCP response that started the work has long returned.
 */
export class BackgroundDispatchService {
  readonly registry: BackgroundTaskRegistry;
  private readonly pending = new Map<
    string,
    { promise: Promise<void>; controller: AbortController }
  >();

  constructor(registry: BackgroundTaskRegistry = new BackgroundTaskRegistry()) {
    this.registry = registry;
    this.registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => getActivityHandle(taskId),
    });
  }

  /** Number of background dispatches still running in this process. */
  public get activeCount(): number {
    return this.pending.size;
  }

  public launch(params: BackgroundLaunchParams): void {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await params.run(controller.signal);
        await this.registry.writeStoredResult({
          taskId: params.taskId,
          status: result.status === "success" ? "completed" : "failed",
          summary: result.summary,
          finalAnswer: result.finalAnswer,
          error: result.error,
          exitCode: result.exitCode,
          completedAtMs: Date.now(),
        });
      } catch (err) {
        await this.registry.writeStoredResult({
          taskId: params.taskId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          completedAtMs: Date.now(),
        });
      } finally {
        forgetActivityHandle(params.taskId);
        this.registry.releaseTask(params.taskId);
        this.pending.delete(params.taskId);
      }
    })();
    this.pending.set(params.taskId, { promise, controller });
  }

  /**
   * Shutdown path: aborts every running dispatch through their controllers
   * (reusing the runner's tree-termination path) and waits for each to record
   * its terminal state.
   */
  public async abortAll(reason: string): Promise<void> {
    const entries = [...this.pending.values()];
    for (const entry of entries) entry.controller.abort(new Error(reason));
    await Promise.allSettled(entries.map((entry) => entry.promise));
  }
}

async function runWithProgress(
  extra: ToolRequestExtra,
  label: string,
  operation: () => Promise<AgentResult>,
): Promise<AgentResult> {
  const startedAt = Date.now();
  await sendProgress(extra, 0, `${label} started`);
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1_000));
    void sendProgress(extra, elapsedSeconds, `${label} is still running`);
  }, PROGRESS_INTERVAL_MS);
  heartbeat.unref();

  try {
    const result = await operation();
    const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000));
    await sendProgress(extra, elapsedSeconds, `${label} ${result.status}`);
    return result;
  } catch (error) {
    const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1_000));
    await sendProgress(extra, elapsedSeconds, `${label} failed`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export const DelegateTaskInputSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Target agent harness name. When omitted, resolves the assigned role from .agentmesh/config.json",
    ),
  task: NonBlankString.describe("Task instructions or prompt to execute"),
  cwd: NonBlankString.optional().describe(
    "Working directory for the agent execution (defaults to current directory)",
  ),
  role: z
    .enum(["worker", "reviewer", "tester"])
    .optional()
    .describe("Role assigned to the agent ('worker', 'reviewer', or 'tester')"),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  sessionId: NonBlankString.optional().describe(
    "Optional bridge session ID to associate or continue",
  ),
  contextSessionId: NonBlankString.optional().describe(
    "Optional Bridge session whose normalized history should be shared with this new or existing agent session (legacy single-source form)",
  ),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions whose normalized history is injected first-hand in the given order, replacing relay through task text",
    ),
  baseCommit: NonBlankString.optional().describe(
    "Optional git base branch/commit for diff comparison",
  ),
  idempotencyKey: NonBlankString.max(200)
    .optional()
    .describe(
      "Optional deduplication key within the (cwd, agent) scope. While an identical dispatch is in " +
        "flight, callers receive an in-flight reference instead of a second execution; after it reaches " +
        "a terminal state, retries within a 20-minute window replay the recorded result (replayed:true) " +
        "with a STALE warning when the repository changed since. Use a distinct key per logical task",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run asynchronously: returns immediately with taskId and outputFile; use poll_task to observe " +
        "progress and collect the terminal result",
    ),
});

export const PollTaskInputSchema = z.object({
  taskId: NonBlankString.describe(
    "Background task ID previously returned by delegate_task(background:true)",
  ),
  sinceOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Byte offset into the task output file; only new bytes past this offset are returned. " +
        "Pass nextOffset from the previous poll_task response",
    ),
});

export const ReviewChangesInputSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Target reviewer agent. When omitted, resolves roles.reviewer from .agentmesh/config.json",
    ),
  task: NonBlankString.optional().describe(
    "Specific review focus, checklist, or instructions (defaults to standard rigorous review)",
  ),
  cwd: NonBlankString.optional().describe(
    "Working directory for review (defaults to current directory)",
  ),
  baseCommit: NonBlankString.optional().describe(
    "Base branch/commit to diff against (e.g. 'main', 'HEAD~1')",
  ),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  contextSessionId: NonBlankString.optional().describe(
    "Optional worker/tester Bridge session whose normalized evidence should be shared with the reviewer (legacy single-source form)",
  ),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions (e.g. worker and tester) injected first-hand so the reviewer reads their conclusions without relay",
    ),
});

export const ContinueTaskInputSchema = z.object({
  sessionId: NonBlankString.describe(
    "The Bridge session ID returned from a previous delegate_task or review_changes call",
  ),
  task: NonBlankString.describe("Follow-up instructions or fix requests to continue the session"),
  mode: z
    .enum(["auto", "mcp", "cli"])
    .optional()
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
  model: NonBlankString.max(200).optional().describe("Vendor-specific model identifier"),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh"])
    .optional()
    .describe("Requested reasoning effort; supported values depend on the selected vendor"),
  contextSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Up to 4 Bridge sessions (e.g. reviewer and tester) injected alongside the session's own native resume",
    ),
});

export const GetSessionInputSchema = z.object({
  sessionId: NonBlankString.describe("The Bridge session ID to inspect"),
});

export const GetRoleConfigInputSchema = z.object({
  cwd: NonBlankString.optional().describe(
    "Project directory used to locate the nearest .agentmesh/config.json",
  ),
});

/**
 * Renders one normalized result for MCP output with T2.2 artifact spill
 * enabled. The turn number is the just-recorded history length because the
 * runner persists its turn before the handler formats the response.
 */
async function formatResultForMcp(
  runner: MultiAgentRunner,
  result: AgentResult,
): Promise<string[]> {
  const turnNumber = result.sessionId
    ? (runner.getSession(result.sessionId)?.history.length ?? 0)
    : undefined;
  return formatNormalizedResultDetailed(result, {
    sessionId: result.sessionId,
    turnNumber,
    registerAudit:
      result.sessionId && turnNumber !== undefined
        ? (record) =>
            runner.registerArtifactAudit(result.sessionId!, turnNumber, record) ?? undefined
        : undefined,
  });
}

export const ListAgentsInputSchema = z.object({
  cwd: NonBlankString.optional().describe(
    "Project directory used to locate the nearest .agentmesh/config.json agents metadata (defaults to current directory)",
  ),
});

export const CompactContextInputSchema = z.object({
  sourceSessionIds: z
    .array(NonBlankString)
    .min(1)
    .max(4)
    .describe(
      "Up to 4 Bridge sessions whose normalized history should be condensed into a semantic summary sidecar",
    ),
});

/** Formats one routing-metadata field group, degrading to "unmetered" (T4.2). */
function formatRoutingMetadata(metadata: AgentMetadata | undefined): string[] {
  if (!metadata) {
    return [
      "Tier: unmetered | Cost level: unmetered",
      "Strengths: unmetered | Not good at: unmetered",
      "Notes: unmetered (no agents metadata declared for this channel in .agentmesh/config.json)",
    ];
  }
  const lines = [
    `Tier: ${metadata.tier ?? "unmetered"} | Cost level: ${metadata.costLevel ?? "unmetered"}`,
    `Speed: ${metadata.speed ?? "unmetered"}`,
    `Strengths: ${metadata.strengths?.length ? metadata.strengths.join(", ") : "unmetered"}`,
    `Not good at: ${metadata.notGoodAt?.length ? metadata.notGoodAt.join(", ") : "unmetered"}`,
  ];
  lines.push(`Notes: ${metadata.notes ?? "unmetered"}`);
  return lines;
}

export function registerMcpTools(
  server: McpServer,
  runner: MultiAgentRunner,
  options: { background?: BackgroundDispatchService } = {},
) {
  const background = options.background ?? new BackgroundDispatchService();
  // delegate_task
  server.tool(
    "delegate_task",
    [
      "Delegates a task to an explicit agent or to the agent assigned to its role in .agentmesh/config.json.",
      "",
      "Delegation discipline (protocol-as-prompt):",
      "1. Brief like a smart colleague who just walked in — NEVER delegate understanding: every instruction must carry concrete file paths and the exact intended change. Anti-pattern: 'based on your findings' — the downstream agent has only what you wrote, not your understanding.",
      "2. Parallelism: fan out read-only tasks (research/review/analysis) freely; strictly serialize write tasks that touch the same set of files.",
      "3. Continue-vs-fresh: send correction feedback back to the SAME session so error context carries over; run verification in a NEW session for fresh eyes; also start a new session when the direction was fundamentally wrong to avoid anchoring.",
      "4. Define done: an implementation task is done only when the report includes actual test results and a summary of changes made.",
    ].join("\n"),
    DelegateTaskInputSchema.shape,
    async (args: z.infer<typeof DelegateTaskInputSchema>, extra) => {
      try {
        if (args.background) {
          const taskId = `bgtask_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
          const outputFile = background.registry.outputFilePath(taskId);
          background.registry.registerTask({
            taskId,
            pid: process.pid,
            startedAtMs: Date.now(),
            outputFile,
          });
          background.launch({
            taskId,
            outputFile,
            run: (signal) =>
              runner.delegateTask({
                agent: args.agent,
                task: args.task,
                cwd: args.cwd,
                role: args.role,
                mode: args.mode,
                timeoutMs: args.timeoutMs,
                model: args.model,
                reasoningEffort: args.reasoningEffort,
                sessionId: args.sessionId,
                contextSessionId: args.contextSessionId,
                contextSessionIds: args.contextSessionIds,
                baseCommit: args.baseCommit,
                idempotencyKey: args.idempotencyKey,
                signal: mergeAbortSignals(extra.signal, signal),
                taskActivity: { taskId, outputFile },
              }),
          });
          return {
            content: [
              {
                type: "text",
                text: [
                  "[Background Task Accepted]",
                  `Task ID: ${taskId}`,
                  `Output File: ${outputFile}`,
                  "Status: RUNNING",
                  "",
                  "The task is executing asynchronously; use poll_task to observe.",
                  `Call poll_task with taskId="${taskId}" to read incremental output and the terminal result.`,
                ].join("\n"),
              },
            ],
          };
        }
        const result = await runWithProgress(extra, "Agent task", () =>
          runner.delegateTask({
            agent: args.agent,
            task: args.task,
            cwd: args.cwd,
            role: args.role,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            sessionId: args.sessionId,
            contextSessionId: args.contextSessionId,
            contextSessionIds: args.contextSessionIds,
            baseCommit: args.baseCommit,
            idempotencyKey: args.idempotencyKey,
            signal: extra.signal,
          }),
        );

        // A FAIL verdict must surface as an MCP error even when the reviewer
        // role was inherited from the session rather than requested explicitly.
        const isError = result.status === "failed" || result.reviewOutcome === "FAIL";

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId || "none"}]`,
          ...(await formatResultForMcp(runner, result)),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in delegate_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // poll_task
  server.tool(
    "poll_task",
    "Observes a background delegate_task: reports status (running/completed/failed/stalled), the incremental output since a byte offset, and the terminal result once available",
    PollTaskInputSchema.shape,
    async (args: z.infer<typeof PollTaskInputSchema>) => {
      try {
        const outcome = await background.registry.pollTask({
          taskId: args.taskId,
          sinceOffset: args.sinceOffset,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(outcome, null, 2),
            },
          ],
        };
      } catch (err) {
        if (err instanceof BackgroundTaskNotFoundError) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "NOT_FOUND", taskId: err.taskId, message: err.message },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in poll_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_role_config",
    "Loads and validates the project .agentmesh/config.json role-to-agent assignments",
    GetRoleConfigInputSchema.shape,
    async (args: z.infer<typeof GetRoleConfigInputSchema>) => {
      try {
        const loaded = runner.getProjectConfiguration(args.cwd);
        return {
          content: [
            {
              type: "text",
              text: loaded
                ? JSON.stringify(loaded, null, 2)
                : `No .agentmesh/config.json found for '${args.cwd || process.cwd()}'.`,
            },
          ],
          isError: !loaded,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  );

  // review_changes
  server.tool(
    "review_changes",
    "Invokes an independent Reviewer Agent to inspect code changes, git diff, and report PASS / FAIL findings with line-level details",
    ReviewChangesInputSchema.shape,
    async (args: z.infer<typeof ReviewChangesInputSchema>, extra) => {
      try {
        const result = await runWithProgress(extra, "Review", () =>
          runner.reviewChanges({
            agent: args.agent,
            task: args.task,
            cwd: args.cwd,
            baseCommit: args.baseCommit,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            contextSessionId: args.contextSessionId,
            contextSessionIds: args.contextSessionIds,
            signal: extra.signal,
          }),
        );

        const isError = result.status === "failed" || result.reviewOutcome === "FAIL";

        const findingsHeader =
          result.findings && result.findings.length > 0
            ? ` | Findings: ${result.findings.length}`
            : "";

        const formattedText = [
          `[Reviewer: ${result.agent} | Review Outcome: ${result.reviewOutcome || "UNKNOWN"} | Status: ${result.status.toUpperCase()}${findingsHeader} | Session: ${result.sessionId || "none"}]`,
          ...(await formatResultForMcp(runner, result)),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in review_changes: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // continue_task
  server.tool(
    "continue_task",
    "Continues an ongoing task on a previous Agent session (e.g. to fix issues reported by a reviewer)",
    ContinueTaskInputSchema.shape,
    async (args: z.infer<typeof ContinueTaskInputSchema>, extra) => {
      try {
        const result = await runWithProgress(extra, "Continued agent task", () =>
          runner.continueTask({
            sessionId: args.sessionId,
            task: args.task,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            model: args.model,
            reasoningEffort: args.reasoningEffort,
            contextSessionIds: args.contextSessionIds,
            signal: extra.signal,
          }),
        );

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId}]`,
          ...(await formatResultForMcp(runner, result)),
          `Duration: ${result.durationMs ?? 0}ms`,
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: formattedText,
            },
          ],
          isError: result.status === "failed" || result.reviewOutcome === "FAIL",
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Bridge Error in continue_task: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // list_agents — T4.2 routing-table view
  server.tool(
    "list_agents",
    "Routing table over all supported agent channels: live availability (eager scan), transport modes, declared sandbox level, self-declared routing metadata (tier / costLevel / strengths / notGoodAt / notes from .agentmesh/config.json), the candidates upgrade chain, and the most recent capability diagnostics. Read this once to plan every delegation; missing metadata is reported as unmetered rather than an error.",
    ListAgentsInputSchema.shape,
    async (args: z.infer<typeof ListAgentsInputSchema>) => {
      try {
        const table = await runner.getAgentRoutingTable(args.cwd ?? process.cwd());
        const sections: string[] = [
          `Agent Routing Table (${table.entries.length} channels, ${table.variants.length} declared variants; metadata source: ${table.source})`,
          ...(table.configWarning ? [`Config warning: ${table.configWarning}`] : []),
        ];
        for (const entry of table.entries) {
          sections.push(
            [
              `== ${entry.name} (${entry.displayName}) ==`,
              `Availability: ${entry.available ? "available" : "unavailable"}${entry.executablePath ? ` — ${entry.executablePath}` : ""}`,
              ...(entry.availabilityNote ? [entry.availabilityNote] : []),
              `Aliases: ${entry.aliases.length ? entry.aliases.join(", ") : "(none)"}`,
              `Transports: ${entry.supportedTransports.join(", ")} (preferred: ${entry.preferredTransport})`,
              `Sandbox declared: ${entry.sandboxMechanism}`,
              ...formatRoutingMetadata(entry.metadata),
              `Candidates chain: ${entry.metadata?.candidates?.length ? entry.metadata.candidates.join(" -> ") : "(none declared)"}`,
              `Recent capability diagnostics: ${entry.recentCapabilityDiagnostics.length ? "\n  - " + entry.recentCapabilityDiagnostics.join("\n  - ") : "none recorded"}`,
            ].join("\n"),
          );
        }
        if (table.variants.length) {
          sections.push("Declared routing variants (profile-backed tier entries):");
          for (const variant of table.variants) {
            sections.push(
              [
                `== ${variant.key} (variant) ==`,
                ...formatRoutingMetadata(variant.metadata),
                `Candidates chain: ${variant.metadata.candidates?.length ? variant.metadata.candidates.join(" -> ") : "(none declared)"}`,
              ].join("\n"),
            );
          }
        }
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error listing agents: ${errorMsg}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // compact_context
  server.tool(
    "compact_context",
    "Condenses each listed Bridge session's normalized history into a semantic summary sidecar using that session's own agent in one tool-free turn (≤2000 tokens). Downstream shared-context injection prefers a fresh summary plus a full-transcript pointer; any new turn on the source session invalidates the summary and falls back to the full transcript. Concurrent compactions of the same session are deduplicated with an in-flight notice.",
    CompactContextInputSchema.shape,
    async (args: z.infer<typeof CompactContextInputSchema>) => {
      try {
        const { outcomes } = await runner.compactContext({
          sourceSessionIds: args.sourceSessionIds,
        });
        const sections = outcomes.map((outcome) => {
          const header = `[Session: ${outcome.sourceSessionId} | Status: ${outcome.status.toUpperCase()}]`;
          switch (outcome.status) {
            case "summarized":
              return [
                `${header} Turns covered: ${outcome.summarizedTurns}${outcome.truncated ? " | Summary truncated" : ""}`,
                outcome.summary ?? "",
              ].join("\n");
            case "in-flight":
            case "skipped":
            case "failed":
              return `${header} ${outcome.reason ?? ""}`.trim();
          }
        });
        const isError = outcomes.every((outcome) => outcome.status === "failed");
        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          isError,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Bridge Error in compact_context: ${errorMsg}` }],
          isError: true,
        };
      }
    },
  );

  // get_session
  server.tool(
    "get_session",
    "Retrieves the history and metadata of an active Bridge Session",
    GetSessionInputSchema.shape,
    async (args: z.infer<typeof GetSessionInputSchema>) => {
      const session = runner.getSession(args.sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Session '${args.sessionId}' not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(session, null, 2),
          },
        ],
      };
    },
  );
}
