import { BaseAdapter } from "./base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "./types.js";
import { executeCommand, ProcessExecutionError } from "../core/executor.js";
import { executeViaMcpClient } from "../core/mcp-client.js";
import { buildRolePrompt } from "../core/prompts.js";

function findSessionId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["thread_id", "threadId", "session_id", "sessionId"]) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = findSessionId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function parseCodexJsonLines(output: string): {
  output: string;
  sessionId?: string;
  error?: string;
} {
  let sessionId: string | undefined;
  let finalMessage = "";
  let error: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      sessionId = findSessionId(event) || sessionId;
      if (event.type === "error" || event.error) {
        error =
          typeof event.error === "string"
            ? event.error
            : event.error &&
                typeof event.error === "object" &&
                typeof (event.error as Record<string, unknown>).message === "string"
              ? String((event.error as Record<string, unknown>).message)
              : typeof event.message === "string"
                ? event.message
                : "Codex returned an error event";
      }
      const item = event.item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (record.type === "agent_message" && typeof record.text === "string") {
          finalMessage = record.text;
        }
      }
    } catch {
      // Preserve compatibility with older/non-JSON Codex output.
    }
  }

  return { output: finalMessage, sessionId, error };
}

export interface CodexMcpToolCall {
  toolName: "codex" | "codex-reply";
  toolArguments: Record<string, string>;
}

/**
 * Maps a run onto the exact `codex` / `codex-reply` MCP tool schemas. Both tools
 * reject unknown arguments (`additionalProperties: false`), so only schema
 * fields may be forwarded.
 */
export function buildCodexMcpToolCall(options: RunAgentOptions, prompt: string): CodexMcpToolCall {
  if (options.nativeSessionId) {
    return {
      toolName: "codex-reply",
      toolArguments: { threadId: options.nativeSessionId, prompt },
    };
  }
  return {
    toolName: "codex",
    toolArguments: {
      prompt,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      sandbox: options.role === "reviewer" ? "read-only" : "workspace-write",
    },
  };
}

export class CodexAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "OpenAI Codex";
  readonly aliases = ["openai-codex", "codex-cli"] as const;
  readonly supportedModes: readonly TransportMode[] = ["mcp", "cli"];
  readonly sandboxMechanism: SandboxMechanism = "native-sandbox";
  readonly envBinOverride = "CODEX_BIN";
  readonly defaultExecutableName = "codex";

  /**
   * Runs Codex via official MCP server (`codex mcp-server`).
   * When role is 'reviewer', enforces read-only sandbox permissions.
   */
  protected override async runViaMcp(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const bin = await this.getExecutablePath();
    const prompt = buildRolePrompt(options.task, options.role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });

    const mcpArgs = ["mcp-server"];
    if (options.role === "reviewer") {
      mcpArgs.push(
        "-c",
        'sandbox_permissions=["disk-full-read-access"]',
        "-c",
        'sandbox_mode="read-only"',
      );
    } else {
      mcpArgs.push("-c", 'sandbox_mode="workspace-write"');
    }

    const toolCall = buildCodexMcpToolCall(options, prompt);
    const mcpRes = await executeViaMcpClient({
      command: bin,
      args: mcpArgs,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      toolName: toolCall.toolName,
      toolArguments: toolCall.toolArguments,
    });

    const nativeSessionId =
      findSessionId(mcpRes.structuredResult) ||
      this.extractSessionId(mcpRes.output) ||
      options.nativeSessionId;

    return this.formatSuccessResult(mcpRes.output, startTime, {
      nativeSessionId,
      role: options.role,
    });
  }

  /**
   * Constructs command-line arguments for Codex CLI invocation.
   */
  public buildCliArgs(options: RunAgentOptions): string[] {
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });

    const args: string[] = [];

    if (role === "reviewer") {
      // Codex supports native 'review' command which is read-only
      args.push("review");
      args.push(
        "-c",
        'sandbox_permissions=["disk-full-read-access"]',
        "-c",
        'sandbox_mode="read-only"',
      );
      if (options.baseCommit) {
        args.push("--base", options.baseCommit);
      } else {
        args.push("--uncommitted");
      }
      args.push(prompt);
    } else {
      // Standard worker execution via 'codex exec' or 'codex exec resume'
      args.push("exec");
      if (options.nativeSessionId) {
        args.push("resume", options.nativeSessionId);
      }
      args.push("-c", 'sandbox_mode="workspace-write"');
      args.push("--json");
      if (options.extraArgs && options.extraArgs.length > 0) {
        args.push(...options.extraArgs);
      }
      args.push(prompt);
    }

    return args;
  }

  /**
   * Runs Codex via CLI (`codex exec` or `codex review`).
   * For reviewer, leverages native read-only 'codex review'.
   */
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const bin = await this.getExecutablePath();
    const role = options.role ?? "worker";
    const args = this.buildCliArgs(options);

    try {
      const res = await executeCommand(bin, args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });

      const parsed = this.parseJsonLines(res.stdout);
      const fullOutput = [parsed.output || res.stdout, res.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      const nativeSessionId = parsed.sessionId || options.nativeSessionId;
      const stderrSemanticError =
        !parsed.output &&
        /(?:\bERROR\b|patch rejected|writing is blocked|rejected by user approval)/i.test(
          res.stderr,
        )
          ? res.stderr.trim()
          : undefined;
      const semanticError = parsed.error || stderrSemanticError;

      if (res.exitCode !== 0 || semanticError) {
        return {
          status: "failed",
          agent: this.name,
          output: fullOutput,
          summary: semanticError || `Codex exited with code ${res.exitCode}`,
          error: semanticError,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
        };
      }

      return this.formatSuccessResult(fullOutput, startTime, {
        nativeSessionId,
        exitCode: res.exitCode,
        finalAnswer: parsed.output || undefined,
        role,
      });
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `Codex execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  /**
   * Extracts session/thread IDs from Codex CLI output if present.
   */
  private extractSessionId(output: string): string | undefined {
    return this.parseJsonLines(output).sessionId;
  }

  private parseJsonLines(output: string): { output: string; sessionId?: string; error?: string } {
    return parseCodexJsonLines(output);
  }
}
