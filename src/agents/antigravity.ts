import { BaseAdapter } from "./base.js";
import type { AgentExecutableInfo, AgentName, AgentResult, RunAgentOptions, SandboxMechanism, TransportMode } from "./types.js";
import { executeCommand, findExecutableOnPath, ProcessExecutionError } from "../core/executor.js";
import { buildRolePrompt } from "../core/prompts.js";

export class AntigravityAdapter extends BaseAdapter {
  readonly name: AgentName = "antigravity";
  readonly displayName = "Google Antigravity (AGY / Gemini)";
  readonly aliases = ["gemini", "agy", "google-gemini", "google-antigravity"] as const;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "AGY_BIN";
  readonly defaultExecutableName = "agy";

  /**
   * Resolves the candidate binary path and actual resolved path on system.
   */
  private async resolveBinary(): Promise<{ path: string | null; candidate: string }> {
    const envOverride = process.env.AGY_BIN || process.env.GEMINI_BIN;
    if (envOverride && envOverride.trim()) {
      const candidate = envOverride.trim();
      const found = await findExecutableOnPath(candidate);
      return { path: found, candidate };
    }

    const agyPath = await findExecutableOnPath("agy");
    if (agyPath) return { path: agyPath, candidate: "agy" };

    const geminiPath = await findExecutableOnPath("gemini");
    if (geminiPath) return { path: geminiPath, candidate: "gemini" };

    return { path: null, candidate: "agy" };
  }

  /**
   * Overrides getExecutablePath to check AGY_BIN, GEMINI_BIN, 'agy', or 'gemini'.
   */
  public override async getExecutablePath(): Promise<string> {
    const resolved = await this.resolveBinary();
    return resolved.path || resolved.candidate;
  }

  /**
   * Returns diagnostic info about Antigravity/Gemini executable.
   */
  public override async getExecutableInfo(): Promise<AgentExecutableInfo> {
    const resolved = await this.resolveBinary();

    return {
      available: resolved.path !== null,
      path: resolved.path || undefined,
      preferredTransport: this.supportedModes[0] || "cli",
      supportedTransports: [...this.supportedModes],
      sandboxMechanism: this.sandboxMechanism,
      notes: resolved.path
        ? `Note: ${this.displayName} relies on prompt-level constraints for read-only roles.`
        : `Binary '${resolved.candidate}' (or 'gemini') was not found in system PATH.`,
    };
  }

  /**
   * Runs Antigravity/AGY CLI.
   */
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const bin = await this.getExecutablePath();
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });

    const args: string[] = ["-p", prompt];

    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    try {
      const res = await executeCommand(bin, args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });

      const fullOutput = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      const nativeSessionId = this.extractSessionId(fullOutput) || options.nativeSessionId;

      if (res.exitCode !== 0) {
        return {
          status: "failed",
          agent: this.name,
          output: fullOutput,
          summary: `Antigravity/AGY exited with code ${res.exitCode}`,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
        };
      }

      return this.formatSuccessResult(fullOutput, startTime, {
        nativeSessionId,
        exitCode: res.exitCode,
        role,
      });
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `Antigravity execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private extractSessionId(output: string): string | undefined {
    const match = output.match(/(?:conversation|session)[_:\s]+([a-zA-Z0-9_-]{8,})/i);
    return match?.[1];
  }
}
