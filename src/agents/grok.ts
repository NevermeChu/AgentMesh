import { BaseAdapter } from "./base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "./types.js";
import { executeCommand, ProcessExecutionError } from "../core/executor.js";
import { buildRolePrompt } from "../core/prompts.js";
import { ARG_REJECTED, describeArgRejections, validateExtraArgs } from "../core/argPolicy.js";

export class GrokAdapter extends BaseAdapter {
  readonly name: AgentName = "grok";
  readonly displayName = "xAI Grok";
  readonly aliases = ["xai-grok", "grok-cli", "grok-build"] as const;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "GROK_BIN";
  readonly defaultExecutableName = "grok";

  /**
   * Runs Grok CLI (`grok -p`).
   */
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    // P3/T3.3: caller extraArgs must match this adapter's allowlist before any
    // process work happens; rejections fail closed without spawning.
    const extraArgsVerdict = validateExtraArgs(this.name, options.extraArgs);
    if (extraArgsVerdict.rejections.length > 0) {
      const detail = `${ARG_REJECTED}: ${describeArgRejections(extraArgsVerdict.rejections)}`;
      return {
        status: "failed",
        agent: this.name,
        output: "",
        summary: detail,
        error: detail,
        durationMs: Date.now() - startTime,
      };
    }
    const bin = await this.getExecutablePath();
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
      rubric: options.reviewVerdictRequired,
    });

    const args: string[] = ["-p", prompt];

    if (extraArgsVerdict.accepted.length > 0) {
      args.push(...extraArgsVerdict.accepted);
    }

    try {
      const res = await executeCommand(bin, args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        taskActivity: options.taskActivity,
      });

      const fullOutput = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      const nativeSessionId = this.extractSessionId(fullOutput) || options.nativeSessionId;

      if (res.exitCode !== 0) {
        return {
          status: "failed",
          agent: this.name,
          output: fullOutput,
          summary: `Grok exited with code ${res.exitCode}`,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
        };
      }

      return this.formatSuccessResult(fullOutput, startTime, {
        nativeSessionId,
        exitCode: res.exitCode,
        role,
        reviewVerdictRequired: options.reviewVerdictRequired,
      });
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `Grok execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private extractSessionId(output: string): string | undefined {
    const match = output.match(/(?:session|chat)[_:\s]+([a-zA-Z0-9_-]{8,})/i);
    return match?.[1];
  }
}
