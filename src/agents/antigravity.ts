import * as fs from "node:fs";
import * as path from "node:path";
import { BaseAdapter } from "./base.js";
import type {
  AgentExecutableInfo,
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "./types.js";
import { executeCommand, findExecutableOnPath, ProcessExecutionError } from "../core/executor.js";
import { buildRolePrompt } from "../core/prompts.js";

export interface ParsedAntigravityOutput {
  output: string;
  sessionId?: string;
  status?: string;
  error?: string;
}

export function parseAntigravityJsonOutput(output: string): ParsedAntigravityOutput {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const response = typeof parsed.response === "string" ? parsed.response.trim() : output.trim();
    const sessionId =
      typeof parsed.conversation_id === "string"
        ? parsed.conversation_id
        : typeof parsed.session_id === "string"
          ? parsed.session_id
          : undefined;
    const status = typeof parsed.status === "string" ? parsed.status : undefined;
    const explicitError =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string" && status && status.toUpperCase() !== "SUCCESS"
          ? parsed.message
          : undefined;
    const error =
      explicitError ||
      (status && status.toUpperCase() !== "SUCCESS"
        ? `Antigravity returned status ${status}`
        : undefined);
    return { output: response, sessionId, status, error };
  } catch {
    return { output: output.trim() };
  }
}

export function findWinGetAntigravityBinary(
  localAppData = process.env.LOCALAPPDATA,
): string | undefined {
  if (!localAppData) return undefined;
  const packagesDir = path.join(localAppData, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("Google.AntigravityCLI_")) continue;
      const candidate = path.join(packagesDir, entry.name, "agy.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // WinGet is optional; normal PATH and environment overrides remain valid.
  }
  return undefined;
}

export class AntigravityAdapter extends BaseAdapter {
  readonly name: AgentName = "antigravity";
  readonly displayName = "Google Antigravity (AGY / Gemini)";
  readonly aliases = ["gemini", "agy", "google-gemini", "google-antigravity"] as const;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism =
    process.platform === "win32" ? "prompt-only" : "native-sandbox";
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

    if (process.platform === "win32") {
      const winGetPath = findWinGetAntigravityBinary();
      if (winGetPath) return { path: winGetPath, candidate: winGetPath };
    }

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
        ? process.platform === "win32"
          ? "Windows reviewer mode uses plan mode and prompt-level read-only constraints because Antigravity native sandbox initialization may fail on protected toolchain paths."
          : "Reviewer mode uses Antigravity's native --sandbox and plan mode."
        : `Binary '${resolved.candidate}' (or 'gemini') was not found in system PATH.`,
    };
  }

  /**
   * Constructs arguments with structured output and native conversation resume.
   */
  public buildCliArgs(options: RunAgentOptions): string[] {
    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
    });
    const args = ["-p", prompt, "--output-format", "json"];

    if (options.nativeSessionId) {
      args.push("--conversation", options.nativeSessionId);
    }
    // Headless AgentMesh calls have no interactive approval channel. Keep all
    // roles inside Antigravity's terminal sandbox while auto-approving only
    // actions that the sandbox and selected mode permit.
    if (process.platform !== "win32") args.push("--sandbox");
    args.push("--dangerously-skip-permissions");
    if (role === "reviewer") args.push("--mode", "plan");
    else if (role === "worker") args.push("--mode", "accept-edits");
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    return args;
  }

  /**
   * Runs Antigravity/AGY CLI.
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

      const parsed = parseAntigravityJsonOutput(res.stdout);
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
          summary: parsed.error || `Antigravity/AGY exited with code ${res.exitCode}`,
          error: parsed.error,
          exitCode: res.exitCode,
          nativeSessionId,
          durationMs: Date.now() - startTime,
        };
      }

      return this.formatSuccessResult(parsed.output, startTime, {
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
