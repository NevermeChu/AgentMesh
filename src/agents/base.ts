import type {
  AgentAdapter,
  AgentExecutableInfo,
  AgentName,
  AgentResult,
  AgentRole,
  ContinueAgentOptions,
  ReviewFinding,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "./types.js";
import { findExecutableOnPath } from "../core/executor.js";
import { extractSummary, parseReviewOutput } from "../core/prompts.js";

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly name: AgentName;
  abstract readonly displayName: string;
  readonly aliases: readonly string[] = [];
  abstract readonly supportedModes: readonly TransportMode[];
  abstract readonly sandboxMechanism: SandboxMechanism;

  /**
   * Environment variable used to override the executable path.
   */
  abstract readonly envBinOverride: string;

  /**
   * Default executable name to look up in system PATH.
   */
  abstract readonly defaultExecutableName: string;

  /**
   * Resolves the actual binary/command path.
   */
  public async getExecutablePath(): Promise<string> {
    const envOverride = process.env[this.envBinOverride];
    if (envOverride && envOverride.trim()) {
      return envOverride.trim();
    }
    const found = await findExecutableOnPath(this.defaultExecutableName);
    return found || this.defaultExecutableName;
  }

  /**
   * Checks whether the agent CLI or binary is accessible.
   */
  public async isAvailable(): Promise<boolean> {
    const info = await this.getExecutableInfo();
    return info.available;
  }

  /**
   * Returns diagnostic info about this agent's executable.
   */
  public async getExecutableInfo(): Promise<AgentExecutableInfo> {
    const envOverride = process.env[this.envBinOverride];
    const candidate = envOverride || this.defaultExecutableName;
    const foundPath = await findExecutableOnPath(candidate);

    return {
      available: foundPath !== null,
      path: foundPath || undefined,
      preferredTransport: this.supportedModes[0] || "cli",
      supportedTransports: [...this.supportedModes],
      sandboxMechanism: this.sandboxMechanism,
      notes: foundPath
        ? this.sandboxMechanism === "prompt-only"
          ? `Note: ${this.displayName} relies on prompt-level constraints for read-only roles.`
          : undefined
        : `Binary '${candidate}' was not found in system PATH.`,
    };
  }

  /**
   * Main entry point for executing a task with the agent.
   */
  public async run(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const mode = options.mode || "auto";

    // Determine whether to use MCP or CLI
    const useMcp =
      (mode === "mcp" && this.supportedModes.includes("mcp")) ||
      (mode === "auto" && this.supportedModes[0] === "mcp");

    if (useMcp) {
      try {
        const res = await this.runViaMcp(options);
        return {
          ...res,
          transportUsed: "mcp",
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        // If mode is 'auto', fall back gracefully to CLI
        if (mode === "auto" && this.supportedModes.includes("cli")) {
          try {
            const fallbackRes = await this.runViaCli(options);
            return {
              ...fallbackRes,
              transportUsed: "cli",
              durationMs: Date.now() - startTime,
            };
          } catch (cliErr) {
            return this.formatErrorResult(cliErr, startTime);
          }
        }
        return this.formatErrorResult(err, startTime);
      }
    }

    try {
      const res = await this.runViaCli(options);
      return {
        ...res,
        transportUsed: "cli",
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return this.formatErrorResult(err, startTime);
    }
  }

  /**
   * Default continue implementation.
   */
  public async continue?(options: ContinueAgentOptions): Promise<AgentResult> {
    return this.run({
      task: options.task,
      cwd: options.cwd,
      role: options.role,
      mode: options.mode,
      timeoutMs: options.timeoutMs,
      env: options.env,
      extraArgs: options.extraArgs,
      nativeSessionId: options.nativeSessionId,
      historyContext: options.historyContext,
    });
  }

  protected abstract runViaCli(options: RunAgentOptions): Promise<AgentResult>;

  protected async runViaMcp(_options: RunAgentOptions): Promise<AgentResult> {
    throw new Error(`MCP mode is not supported by ${this.displayName}`);
  }

  protected formatSuccessResult(
    output: string,
    startTime: number,
    options?: {
      nativeSessionId?: string;
      exitCode?: number;
      summary?: string;
      finalAnswer?: string;
      role?: AgentRole;
    }
  ): AgentResult {
    const isReviewer = options?.role === "reviewer";
    let status: "success" | "failed" = "success";
    let reviewOutcome: "PASS" | "FAIL" | "UNKNOWN" | undefined;
    let findings: ReviewFinding[] | undefined;
    let summary = options?.summary;

    if (isReviewer) {
      const parsed = parseReviewOutput(output);
      reviewOutcome = parsed.reviewOutcome;
      findings = parsed.findings;
      if (parsed.reviewOutcome !== "PASS") {
        status = "failed";
      }
      if (!summary) {
        summary = parsed.summary;
      }
    }

    if (!summary) {
      summary = extractSummary(output, "Execution completed", options?.role);
    }

    return {
      status,
      agent: this.name,
      output,
      finalAnswer: options?.finalAnswer,
      summary,
      nativeSessionId: options?.nativeSessionId,
      exitCode: options?.exitCode ?? 0,
      durationMs: Date.now() - startTime,
      reviewOutcome,
      findings,
    };
  }

  protected formatErrorResult(
    err: unknown,
    startTime: number,
    output = ""
  ): AgentResult {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const combinedOutput = output ? `${output}\n${errorMsg}` : errorMsg;
    return {
      status: "failed",
      agent: this.name,
      output: combinedOutput,
      summary: `Failed to execute ${this.displayName}: ${errorMsg}`,
      error: errorMsg,
      exitCode: 1,
      durationMs: Date.now() - startTime,
    };
  }
}
