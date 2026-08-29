import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BaseAdapter } from "./base.js";
import type {
  AgentName,
  AgentResult,
  AgentRole,
  RunAgentOptions,
  ReviewFinding,
  SandboxMechanism,
  TransportMode,
  UsageInfo,
} from "./types.js";
import { executeCommand, ProcessExecutionError } from "../core/executor.js";
import { executeViaMcpClient } from "../core/mcp-client.js";
import { buildRolePrompt } from "../core/prompts.js";
import {
  fileExists,
  recoverCodexRollout,
  resolveCodexHome,
  type CodexRolloutRecovery,
} from "../core/codexRollout.js";
import {
  assertNoForbiddenCodexArgs,
  buildCodexSecurityBaselineArgs,
  CODEX_STRICT_CONFIG_FLAG,
  CodexSecurityViolationError,
} from "../core/codexSecurity.js";

export interface ParsedCodexOutput {
  output: string;
  sessionId?: string;
  error?: string;
  /**
   * Usage from the last `turn.completed` event (THREAD-CUMULATIVE per the
   * vendor contract; single-turn deltas require runner-level aggregation).
   */
  usage?: UsageInfo;
}

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

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapExecUsage(raw: unknown): UsageInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const usage: UsageInfo = {
    inputTokens: pickNumber(source.input_tokens),
    cachedInputTokens: pickNumber(source.cached_input_tokens),
    cacheWriteInputTokens: pickNumber(source.cache_write_input_tokens),
    outputTokens: pickNumber(source.output_tokens),
    reasoningOutputTokens: pickNumber(source.reasoning_output_tokens),
    totalTokens: pickNumber(source.total_tokens),
  };
  const hasAny = Object.values(usage).some((value) => value !== undefined);
  return hasAny ? usage : undefined;
}

export function parseCodexJsonLines(output: string): ParsedCodexOutput {
  let sessionId: string | undefined;
  let finalMessage = "";
  let error: string | undefined;
  let usage: UsageInfo | undefined;

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
      if (event.type === "turn.completed") {
        usage = mapExecUsage(event.usage) ?? usage;
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

  return { output: finalMessage, sessionId, error, usage };
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

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * Structured-output contract enforced for reviewer runs via `--output-schema`
 * (`[CX] exec/src/cli.rs`): the model's final response must be machine-readable
 * JSON instead of prose whose verdict has to be scraped by regex.
 */
const REVIEWER_VERDICT_OUTPUT_SCHEMA = {
  name: "agentmesh_review_verdict",
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    severity: { type: "string", enum: ["none", "critical", "high", "medium", "low"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          line: { type: ["number", "string"] },
          issue: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "file", "issue"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict"],
  additionalProperties: false,
} as const;

interface StructuredReviewVerdict {
  outcome: "PASS" | "FAIL";
  findings: ReviewFinding[];
}

/**
 * Parses a reviewer final answer that conforms to the `--output-schema`
 * contract. Tolerates markdown fences; returns `undefined` when the answer is
 * not schema-shaped so the legacy regex pipeline still gets its chance.
 */
export function parseStructuredReviewVerdict(
  finalAnswer: string | undefined,
): StructuredReviewVerdict | undefined {
  if (!finalAnswer) return undefined;
  let candidate = finalAnswer.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidate = fenced[1].trim();
  if (!candidate.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const verdict = typeof record.verdict === "string" ? record.verdict.trim().toUpperCase() : "";
  if (verdict !== "PASS" && verdict !== "FAIL") return undefined;

  const findings: ReviewFinding[] = [];
  if (Array.isArray(record.findings)) {
    for (const entry of record.findings) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const finding = entry as Record<string, unknown>;
      const issue = typeof finding.issue === "string" ? finding.issue.trim() : "";
      if (!issue) continue;
      const rawSeverity =
        typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
      const severity = (
        REVIEW_SEVERITIES.has(rawSeverity) ? rawSeverity : "medium"
      ) as ReviewFinding["severity"];
      findings.push({
        severity,
        file:
          typeof finding.file === "string" && finding.file.trim() ? finding.file.trim() : "unknown",
        line:
          typeof finding.line === "number" || typeof finding.line === "string"
            ? finding.line
            : undefined,
        issue,
        suggestion: typeof finding.suggestion === "string" ? finding.suggestion : undefined,
      });
    }
  }
  return { outcome: verdict, findings };
}

let artifactSequence = 0;

function createArtifactPath(kind: "last-message" | "review-schema"): string {
  artifactSequence += 1;
  const unique = [
    process.pid.toString(36),
    Date.now().toString(36),
    artifactSequence.toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("-");
  const extension = kind === "last-message" ? ".txt" : ".json";
  return path.join(os.tmpdir(), `agentmesh-codex-${kind}-${unique}${extension}`);
}

async function removeArtifact(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  await fsp.rm(filePath, { recursive: true, force: true }).catch(() => undefined);
}

function readNonEmptyFile(filePath: string | undefined): string | undefined {
  if (!fileExists(filePath)) return undefined;
  try {
    const contents = fs.readFileSync(filePath!, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

export interface PreparedCodexCliRun {
  args: string[];
  /** `--output-last-message` target; read after exit as the official answer. */
  lastMessageFile: string;
  /** `--output-schema` contract file; present for reviewer runs. */
  schemaFile?: string;
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
      rubric: options.reviewVerdictRequired,
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
      signal: options.signal,
    });

    const nativeSessionId =
      findSessionId(mcpRes.structuredResult) ||
      this.extractSessionId(mcpRes.output) ||
      options.nativeSessionId;

    return this.formatSuccessResult(mcpRes.output, startTime, {
      nativeSessionId,
      finalAnswer: mcpRes.output,
      role: options.role,
      reviewVerdictRequired: options.reviewVerdictRequired,
    });
  }

  /**
   * Constructs command-line arguments for Codex CLI invocation.
   */
  public buildCliArgs(options: RunAgentOptions): string[] {
    return this.buildCliArgsWithArtifacts(options).args;
  }

  /**
   * Builds the full CLI argv plus the artifact paths wired into it. Security
   * validation happens first so forbidden arguments fail before any temp
   * artifact is created and long before a process is spawned.
   */
  public buildCliArgsWithArtifacts(options: RunAgentOptions): PreparedCodexCliRun {
    assertNoForbiddenCodexArgs(options.extraArgs);

    const role = options.role ?? "worker";
    const prompt = buildRolePrompt(options.task, role, {
      baseCommit: options.baseCommit,
      cwd: options.cwd,
      historyContext: options.historyContext,
      rubric: options.reviewVerdictRequired,
    });
    const baseline = buildCodexSecurityBaselineArgs();
    const lastMessageFile = createArtifactPath("last-message");
    const args: string[] = [];

    if (role === "reviewer") {
      // Codex supports native 'review' command which is read-only.
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
      args.push(...baseline);
      const schemaFile = createArtifactPath("review-schema");
      args.push("--output-schema", schemaFile, "--output-last-message", lastMessageFile);
      args.push(prompt);
      return { args, lastMessageFile, schemaFile };
    }

    // Standard worker execution via 'codex exec' or 'codex exec resume'.
    args.push("exec");
    if (options.nativeSessionId) {
      args.push("resume", options.nativeSessionId);
    }
    args.push("-c", 'sandbox_mode="workspace-write"');
    args.push("--json");
    if (options.model) args.push("--model", options.model);
    if (options.reasoningEffort)
      args.push("-c", `model_reasoning_effort=${options.reasoningEffort}`);
    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }
    // Baseline locks go AFTER extra args so duplicate override keys resolve
    // to the locked value under the vendor's last-wins merge.
    args.push(...baseline);
    args.push("--output-last-message", lastMessageFile);
    args.push(prompt);
    return { args, lastMessageFile };
  }

  /**
   * Runs Codex via CLI (`codex exec`/`exec resume`, `codex review`).
   * finalAnswer uses the official `--output-last-message` channel; the JSONL
   * event stream remains a fallback. Abnormal deaths trigger rollout-file
   * salvage so SIGKILL-level crashes still recover results.
   */
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    const startTime = Date.now();
    const bin = await this.getExecutablePath();
    const role = options.role ?? "worker";
    const prepared = this.buildCliArgsWithArtifacts(options);

    try {
      if (prepared.schemaFile) {
        await fsp.writeFile(
          prepared.schemaFile,
          JSON.stringify(REVIEWER_VERDICT_OUTPUT_SCHEMA, null, 2),
          "utf8",
        );
      }
      try {
        const res = await executeCommand(bin, prepared.args, {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          taskActivity: options.taskActivity,
        });
        return await this.settleCliExecution(
          res,
          options,
          role,
          prepared.lastMessageFile,
          startTime,
        );
      } finally {
        await removeArtifact(prepared.lastMessageFile);
        await removeArtifact(prepared.schemaFile);
      }
    } catch (err) {
      if (err instanceof ProcessExecutionError) {
        const parsed = this.parseJsonLines(err.stdout);
        const salvaged = await this.salvageFromRollout(options, parsed.sessionId);
        const baseOutput = [err.stdout, err.stderr].filter(Boolean).join("\n");
        return {
          status: "failed",
          agent: this.name,
          output: salvaged?.answerText
            ? `${baseOutput}\n${salvaged.answerText}`.trim()
            : baseOutput,
          summary: `Codex execution error: ${err.message}`,
          exitCode: err.exitCode,
          durationMs: Date.now() - startTime,
          timedOut: err.timedOut,
          ...(salvaged?.answerText ? { finalAnswer: salvaged.answerText } : {}),
          ...(salvaged?.recovery.usage ? { usage: salvaged.recovery.usage } : {}),
          ...(salvaged && !baseOutput.includes(salvaged.note) ? { warning: salvaged.note } : {}),
        } satisfies AgentResult;
      }
      return this.formatErrorResult(err, startTime);
    }
  }

  private async settleCliExecution(
    res: Awaited<ReturnType<typeof executeCommand>>,
    options: RunAgentOptions,
    role: AgentRole,
    lastMessageFile: string,
    startTime: number,
  ): Promise<AgentResult> {
    const parsed = this.parseJsonLines(res.stdout);
    // Official extraction channel first ([CX] --output-last-message); JSONL
    // parsing demoted to fallback with a mandatory warning.
    const officialAnswer = readNonEmptyFile(lastMessageFile);
    const fallbackAnswer = officialAnswer ? undefined : parsed.output || undefined;
    const extractedAnswer = officialAnswer ?? fallbackAnswer ?? "";
    const fallbackWarning =
      fallbackAnswer &&
      "The --output-last-message channel produced no content; the final answer was recovered from the JSONL event stream fallback.";

    const fullOutput = [extractedAnswer || res.stdout, res.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const nativeSessionId = parsed.sessionId || options.nativeSessionId;
    const stderrSemanticError =
      !extractedAnswer &&
      /(?:\bERROR\b|patch rejected|writing is blocked|rejected by user approval)/i.test(res.stderr)
        ? res.stderr.trim()
        : undefined;
    const semanticError = parsed.error || stderrSemanticError;
    // A structured error next to a substantive final message with a clean
    // exit code is vendor teardown noise, not a business failure; keep the
    // conclusion and surface the error as a warning instead of discarding it.
    const hasSubstantiveOutput = Boolean(extractedAnswer.trim());
    const shouldFail = res.exitCode !== 0 || (semanticError && !hasSubstantiveOutput);

    if (shouldFail) {
      const salvaged =
        res.exitCode !== 0 || res.timedOut || res.aborted
          ? await this.salvageFromRollout(options, nativeSessionId)
          : undefined;
      return {
        status: "failed",
        agent: this.name,
        output: salvaged?.answerText ? `${fullOutput}\n${salvaged.answerText}`.trim() : fullOutput,
        summary: semanticError || `Codex exited with code ${res.exitCode}`,
        error: semanticError,
        exitCode: res.exitCode,
        nativeSessionId,
        durationMs: Date.now() - startTime,
        timedOut: res.timedOut,
        aborted: res.aborted,
        cleanupMethod: res.cleanupMethod,
        cleanupSucceeded: res.cleanupSucceeded,
        resourceEvidence: res.resourceEvidence,
        ...(extractedAnswer || salvaged?.answerText
          ? { finalAnswer: extractedAnswer || salvaged?.answerText }
          : {}),
        ...(parsed.usage || salvaged?.recovery.usage
          ? { usage: parsed.usage ?? salvaged?.recovery.usage }
          : {}),
        ...(salvaged && !(semanticError ?? "").includes(salvaged.note)
          ? { warning: salvaged.note }
          : {}),
      };
    }

    const result = this.formatSuccessResult(fullOutput, startTime, {
      nativeSessionId,
      exitCode: res.exitCode,
      finalAnswer: extractedAnswer || undefined,
      role,
    });

    result.usage = parsed.usage;
    const warnings = [semanticError, fallbackWarning].filter(Boolean);
    if (warnings.length > 0) result.warning = warnings.join(" ");

    if (role === "reviewer") {
      this.applyStructuredReviewVerdict(result);
    }
    return result;
  }

  /**
   * Overrides regex-scraped review outcomes with the machine-readable verdict
   * from the `--output-schema` contract. Unparseable answers stay on the
   * legacy pipeline (which fails closed under the strict contract).
   */
  private applyStructuredReviewVerdict(result: AgentResult): void {
    const structured = parseStructuredReviewVerdict(result.finalAnswer ?? result.output);
    if (!structured) return;
    result.reviewOutcome = structured.outcome;
    result.findings = structured.findings;
    result.status = structured.outcome === "FAIL" ? "failed" : "success";
    result.summary =
      structured.outcome === "PASS"
        ? structured.findings.length > 0
          ? `Review PASSED with ${structured.findings.length} non-blocking finding(s).`
          : "Review PASSED: Changes are clean and verified."
        : `Review FAILED: ${
            structured.findings.length > 0
              ? `${structured.findings.length} issue(s) detected.`
              : "Issues were detected during review."
          }`;
    // A schema-backed verdict supersedes the lenient UNKNOWN warning.
    if (result.warning?.startsWith("No explicit PASS/FAIL verdict")) {
      const rest = result.warning
        .replace(/^No explicit PASS\/FAIL verdict was detected[^.]*\.\s*/, "")
        .trim();
      result.warning = rest.length > 0 ? rest : undefined;
    }
    result.warning = [
      result.warning,
      "Review verdict was extracted from the --output-schema structured response.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  /**
   * Best-effort crash salvage from the codex rollout files. Only meaningful
   * when the native session id is positively identified; failures degrade to
   * `undefined` and never mask the original business failure.
   */
  private async salvageFromRollout(
    options: RunAgentOptions,
    nativeSessionId: string | undefined,
  ): Promise<{ recovery: CodexRolloutRecovery; note: string; answerText?: string } | undefined> {
    const sessionId = nativeSessionId?.trim() || options.nativeSessionId?.trim();
    if (
      !sessionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    ) {
      return undefined;
    }
    try {
      const recovery = await recoverCodexRollout({
        sessionId,
        codexHome: resolveCodexHome(options.env?.CODEX_HOME),
      });
      if (!recovery) return undefined;
      const answerText = recovery.lastAgentMessage ?? recovery.partialAgentMessage;
      const note =
        `Crash salvage: recovered ${recovery.lastAgentMessage ? "the completed turn answer" : "partial agent messages"} ` +
        `and token usage from codex rollout '${path.basename(recovery.rolloutPath)}'.`;
      return { recovery, note, answerText };
    } catch {
      // Rollout salvage must never mask the original failure.
      return undefined;
    }
  }

  /**
   * Extracts session/thread IDs from Codex CLI output if present.
   */
  private extractSessionId(output: string): string | undefined {
    return this.parseJsonLines(output).sessionId;
  }

  private parseJsonLines(output: string): ParsedCodexOutput {
    return parseCodexJsonLines(output);
  }
}

// Re-exported so callers of this module can reference the strict-config flag
// without importing the security module directly.
export { CODEX_STRICT_CONFIG_FLAG, CodexSecurityViolationError };
