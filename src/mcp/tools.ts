import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { MultiAgentRunner } from "../core/runner.js";
import type { AgentResult } from "../agents/types.js";

const MAX_TIMEOUT_MS = 3_600_000;
const MAX_FINAL_ANSWER_CHARS = 12_000;
const MAX_RAW_OUTPUT_CHARS = 8_000;
const PROGRESS_INTERVAL_MS = 15_000;
type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const NonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Value must not be blank",
  });

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function formatNormalizedResult(result: AgentResult): string[] {
  const details = [`Summary: ${result.summary}`];
  if (result.finalAnswer && result.finalAnswer.trim() !== result.summary.trim()) {
    details.push(
      `Final Answer:\n${truncateText(result.finalAnswer.trim(), MAX_FINAL_ANSWER_CHARS)}`,
    );
  }
  // Vendor logs and stderr stay diagnosable over MCP instead of being dropped
  // by normalization; without them, remote failures carry no actionable detail.
  const rawOutput = result.output?.trim();
  if (
    rawOutput &&
    rawOutput !== result.finalAnswer?.trim() &&
    rawOutput !== result.summary.trim()
  ) {
    details.push(`Raw Output:\n${truncateText(rawOutput, MAX_RAW_OUTPUT_CHARS)}`);
  }
  if (result.error) details.push(`Error: ${result.error}`);
  if (result.exitCode !== undefined) details.push(`Exit Code: ${result.exitCode}`);
  if (result.findings && result.findings.length > 0) {
    details.push(`Findings:\n${JSON.stringify(result.findings, null, 2)}`);
  }
  if (result.reviewerSafety) {
    details.push(`Reviewer Safety:\n${JSON.stringify(result.reviewerSafety, null, 2)}`);
  }
  return details;
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
  sessionId: NonBlankString.optional().describe(
    "Optional bridge session ID to associate or continue",
  ),
  contextSessionId: NonBlankString.optional().describe(
    "Optional Bridge session whose normalized history should be shared with this new or existing agent session",
  ),
  baseCommit: NonBlankString.optional().describe(
    "Optional git base branch/commit for diff comparison",
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
  contextSessionId: NonBlankString.optional().describe(
    "Optional worker/tester Bridge session whose normalized evidence should be shared with the reviewer",
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
    .default("auto")
    .describe("Preferred transport mode ('auto', 'mcp', or 'cli')"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Execution timeout in milliseconds"),
});

export const GetSessionInputSchema = z.object({
  sessionId: NonBlankString.describe("The Bridge session ID to inspect"),
});

export const GetRoleConfigInputSchema = z.object({
  cwd: NonBlankString.optional().describe(
    "Project directory used to locate the nearest .agentmesh/config.json",
  ),
});

export function registerMcpTools(server: McpServer, runner: MultiAgentRunner) {
  // delegate_task
  server.tool(
    "delegate_task",
    "Delegates a task to an explicit agent or to the agent assigned to its role in .agentmesh/config.json",
    DelegateTaskInputSchema.shape,
    async (args: z.infer<typeof DelegateTaskInputSchema>, extra) => {
      try {
        const result = await runWithProgress(extra, "Agent task", () =>
          runner.delegateTask({
            agent: args.agent,
            task: args.task,
            cwd: args.cwd,
            role: args.role,
            mode: args.mode,
            timeoutMs: args.timeoutMs,
            sessionId: args.sessionId,
            contextSessionId: args.contextSessionId,
            baseCommit: args.baseCommit,
            signal: extra.signal,
          }),
        );

        // A FAIL verdict must surface as an MCP error even when the reviewer
        // role was inherited from the session rather than requested explicitly.
        const isError = result.status === "failed" || result.reviewOutcome === "FAIL";

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId || "none"}]`,
          ...formatNormalizedResult(result),
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
            contextSessionId: args.contextSessionId,
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
          ...formatNormalizedResult(result),
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
            signal: extra.signal,
          }),
        );

        const formattedText = [
          `[Agent: ${result.agent} | Status: ${result.status.toUpperCase()}${result.reviewOutcome ? ` | Review Outcome: ${result.reviewOutcome}` : ""} | Session: ${result.sessionId}]`,
          ...formatNormalizedResult(result),
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

  // list_agents
  server.tool(
    "list_agents",
    "Lists all supported agent adapters and queries their current availability and binary presence on the host system",
    {},
    async () => {
      try {
        const agents = await runner.listAgents();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(agents, null, 2),
            },
          ],
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
