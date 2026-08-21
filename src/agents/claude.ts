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

export function findClaudeSessionId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["session_id", "sessionId", "conversation_id", "conversationId"]) {
    if (typeof record[key] === "string" && record[key].length > 0) {
      return record[key];
    }
  }
  for (const nested of Object.values(record)) {
    const found = findClaudeSessionId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function parseClaudeJsonOutput(output: string): {
  output: string;
  sessionId?: string;
  error?: string;
} {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const sessionId =
      typeof parsed.session_id === "string"
        ? parsed.session_id
        : typeof parsed.sessionId === "string"
          ? parsed.sessionId
          : undefined;
    const result = typeof parsed.result === "string" ? parsed.result : output;
    const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : undefined;
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : undefined;
    const explicitError =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error &&
            typeof parsed.error === "object" &&
            typeof (parsed.error as Record<string, unknown>).message === "string"
          ? String((parsed.error as Record<string, unknown>).message)
          : undefined;
    const isError =
      parsed.is_error === true ||
      status === "error" ||
      status === "failed" ||
      subtype?.includes("error") === true;
    return {
      output: result,
      sessionId,
      error: explicitError || (isError ? result || "Claude returned an error result" : undefined),
    };
  } catch {
    return { output };
  }
}

export class ClaudeAdapter extends BaseAdapter {
  readonly name: AgentName = "claude";
  readonly displayName = "Anthropic Claude Code";
  readonly aliases = ["claude-code", "anthropic-claude"] as const;
  readonly supportedModes: readonly TransportMode[] = ["mcp", "cli"];
  readonly sandboxMechanism: SandboxMechanism = "tool-filtering";
  readonly envBinOverride = "CLAUDE_BIN";
  readonly defaultExecutableName = "claude";

  /**
   * Runs Claude Code via official MCP server (`claude mcp serve`).
   */
  protected override async runViaMcp(options: RunAgentOptions): Promise<AgentResult> {
    if (options.role === "reviewer") {
      throw new Error(
        "Claude MCP reviewer mode is disabled because it cannot enforce a read-only tool boundary.",
      );
    }
    const startTime = Date.now();
    const bin = await this.getExecutablePath();
    const prompt = buildRolePrompt(options.task, options.role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });

    const mcpRes = await executeViaMcpClient({
      command: bin,
      args: ["mcp", "serve"],
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      toolArguments: {
        prompt,
        task: prompt,
        cwd: options.cwd,
        role: options.role,
        sessionId: options.nativeSessionId,
      },
    });

    const nativeSessionId =
      findClaudeSessionId(mcpRes.structuredResult) ||
      this.extractSessionId(mcpRes.output) ||
      options.nativeSessionId;

    return this.formatSuccessResult(mcpRes.output, startTime, {
      nativeSessionId,
      role: options.role,
    });
  }

  /**
   * Constructs command-line arguments for Claude CLI invocation.
   */
  public buildCliArgs(options: RunAgentOptions): string[] {
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });

    const args: string[] = ["-p", prompt, "--output-format", "json"];

    if (options.nativeSessionId) {
      args.push("--resume", options.nativeSessionId);
    }

    if (role === "reviewer") {
      // Do not expose Bash: command allowlists cannot prevent shell redirection
      // or indirect writes reliably.
      args.push("--tools", "Read,Grep,Glob,LS,NotebookRead,View");
    } else {
      // In automated headless mode for workers, pass bypass permission flags
      args.push("--dangerously-skip-permissions");
    }

    if (role !== "reviewer" && options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  /**
   * Runs Claude Code via CLI (`claude -p`).
   * For reviewer, enforces tool filtering to read-only tools and avoids unconfirmed writes.
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

      const parsed = this.parseJsonOutput(res.stdout);
      const fullOutput = [parsed.output || res.stdout, res.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      const nativeSessionId = parsed.sessionId || options.nativeSessionId;
      const stderrSemanticError = res.stderr.match(/\[claude-code:([^\]]+)\]\s*(.*)/i);
      const semanticError =
        parsed.error ||
        (stderrSemanticError
          ? `Claude ${stderrSemanticError[1]}: ${stderrSemanticError[2] || "semantic execution error"}`
          : undefined);

      if (res.exitCode !== 0 || semanticError) {
        return {
          status: "failed",
          agent: this.name,
          output: fullOutput,
          summary: semanticError || `Claude exited with code ${res.exitCode}`,
          error: semanticError,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
        };
      }

      return this.formatSuccessResult(fullOutput, startTime, {
        nativeSessionId,
        exitCode: res.exitCode,
        finalAnswer: parsed.output,
        role,
      });
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `Claude execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private parseJsonOutput(output: string): { output: string; sessionId?: string; error?: string } {
    return parseClaudeJsonOutput(output);
  }

  private extractSessionId(output: string): string | undefined {
    return this.parseJsonOutput(output).sessionId;
  }
}
