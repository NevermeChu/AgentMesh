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

export interface ParsedOpenCodeOutput {
  output: string;
  sessionId?: string;
  error?: string;
}

function findStringField(value: unknown, keys: ReadonlySet<string>, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key) && typeof nested === "string" && nested.trim()) return nested;
  }
  for (const nested of Object.values(record)) {
    const found = findStringField(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function parseOpenCodeJsonLines(output: string): ParsedOpenCodeOutput {
  const answers: string[] = [];
  let sessionId: string | undefined;
  let error: string | undefined;
  let parsedAny = false;

  for (const line of output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      parsedAny = true;
      sessionId ||= findStringField(event, new Set(["sessionID", "sessionId", "session_id"]));
      const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
      const part =
        event.part && typeof event.part === "object"
          ? (event.part as Record<string, unknown>)
          : undefined;
      const text =
        type === "text" && typeof part?.text === "string"
          ? part.text
          : typeof event.result === "string"
            ? event.result
            : undefined;
      if (text?.trim()) answers.push(text.trim());
      if (type === "error" || event.error) {
        error =
          typeof event.error === "string"
            ? event.error
            : findStringField(event.error, new Set(["message", "name", "code"])) ||
              "OpenCode returned an error event";
      }
    } catch {
      // Preserve compatibility with older/default output if a CLI emits mixed lines.
    }
  }

  return {
    output: answers.join("\n\n") || (parsedAny ? "" : output.trim()),
    sessionId,
    error,
  };
}

export class OpenCodeAdapter extends BaseAdapter {
  readonly name: AgentName = "opencode";
  readonly displayName = "OpenCode";
  readonly aliases = ["opencode-ai", "opencode-cli"] as const;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "OPENCODE_BIN";
  readonly defaultExecutableName = "opencode";

  public buildCliArgs(options: RunAgentOptions): string[] {
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
      rubric: options.reviewVerdictRequired,
    });
    const args = ["run", prompt, "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (options.nativeSessionId) args.push("--session", options.nativeSessionId);
    if (role === "reviewer") args.push("--agent", "plan");
    else args.push("--auto");
    // P3/T3.3: forward only allowlisted extraArgs; validation failures are
    // reported by runViaCli before any process is spawned.
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...validateExtraArgs(this.name, options.extraArgs).accepted);
    }
    return args;
  }

  /**
   * Runs OpenCode CLI (`opencode run <prompt> --auto`).
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
    const args = this.buildCliArgs(options);

    try {
      const res = await executeCommand(bin, args, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        taskActivity: options.taskActivity,
      });

      const parsed = parseOpenCodeJsonLines(res.stdout);
      const diagnosticOutput = [parsed.output || res.stdout, res.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      const nativeSessionId =
        parsed.sessionId || this.extractSessionId(res.stdout) || options.nativeSessionId;

      if (res.exitCode !== 0 || parsed.error) {
        return {
          status: "failed",
          agent: this.name,
          output: diagnosticOutput,
          summary: parsed.error || `OpenCode exited with code ${res.exitCode}`,
          error: parsed.error,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
          timedOut: res.timedOut,
          aborted: res.aborted,
          cleanupMethod: res.cleanupMethod,
          cleanupSucceeded: res.cleanupSucceeded,
          resourceEvidence: res.resourceEvidence,
        };
      }

      return this.formatSuccessResult(parsed.output || diagnosticOutput, startTime, {
        nativeSessionId,
        exitCode: res.exitCode,
        finalAnswer: parsed.output || undefined,
        role,
        reviewVerdictRequired: options.reviewVerdictRequired,
      });
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        return {
          status: "failed",
          agent: this.name,
          output: [err.stdout, err.stderr].filter(Boolean).join("\n"),
          summary: `OpenCode execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
        };
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private extractSessionId(output: string): string | undefined {
    const match = output.match(/(?:session|run)[_:\s]+([a-zA-Z0-9_-]{8,})/i);
    return match?.[1];
  }
}
