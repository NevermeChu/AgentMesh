import type { AgentRole, ReviewFinding } from "../agents/types.js";
import type { SessionHistoryEntry } from "./types.js";

/**
 * Builds standard system and task instructions tailored to the assigned role.
 */
export function buildRolePrompt(
  task: string,
  role: AgentRole = "worker",
  context?: { baseCommit?: string; cwd?: string; historyContext?: string }
): string {
  let basePrompt = task;
  if (context?.historyContext && context.historyContext.trim()) {
    basePrompt = `${context.historyContext.trim()}\n\n## Current Task\n${task}`;
  }

  switch (role) {
    case "reviewer":
      return buildReviewerPrompt(basePrompt, context);
    case "tester":
      return buildTesterPrompt(basePrompt);
    case "worker":
    default:
      return basePrompt;
  }
}

/**
 * Generates an independent, strict Reviewer prompt following the architectural requirements.
 */
export function buildReviewerPrompt(
  task: string,
  context?: { baseCommit?: string; cwd?: string }
): string {
  const diffInstruction = context?.baseCommit
    ? `Compare against git base commit/branch: '${context.baseCommit}'.`
    : `Inspect latest uncommitted/committed changes (e.g. using 'git diff', 'git diff HEAD~1', or 'git status').`;

  return [
    `# ROLE: Independent Code Reviewer`,
    ``,
    `## Objective`,
    `Perform a rigorous, objective, independent code review.`,
    `Do NOT rely on or assume previous worker summaries are accurate. Verify the actual code directly.`,
    ``,
    `## Specific Review Focus / Context`,
    task || "Review the latest changes in the repository for correctness, stability, and adherence to requirements.",
    ``,
    `## Instructions & Constraints`,
    `1. ${diffInstruction}`,
    `2. STRICT READ-ONLY RULE: Do NOT edit, write, create, or delete any source files. You may ONLY run read-only commands (git diff, git status, read files, or test suites).`,
    `3. Check thoroughly for:`,
    `   - Correctness & logic errors`,
    `   - Regressions & breaking changes`,
    `   - Security vulnerabilities & credential leaks`,
    `   - Edge cases & unhandled errors`,
    `   - Missing or broken automated tests`,
    `   - Architecture, type-safety, and style violations`,
    ``,
    `## Required Output Format`,
    `If the changes are clean and meet all quality requirements, respond with:`,
    `PASS`,
    `Optional positive summary / remarks.`,
    ``,
    `If any issues or concerns are identified, respond with:`,
    `FAIL`,
    ``,
    `Then list each finding in this structured format:`,
    `- severity: [critical | high | medium | low]`,
    `  file: path/to/file`,
    `  line: line number or range`,
    `  issue: Detailed explanation of what is wrong`,
    `  suggestion: How to fix the issue`,
  ].join("\n");
}

/**
 * Generates a Tester prompt.
 */
export function buildTesterPrompt(task: string): string {
  return [
    `# ROLE: Automated QA / Test Engineer`,
    ``,
    `## Objective`,
    `Run and verify test suites for the repository, diagnose failures, and ensure test coverage.`,
    ``,
    `## Task`,
    task,
    ``,
    `## Instructions`,
    `1. Execute relevant automated test suites (e.g., unit, integration, linting, typecheck).`,
    `2. Report test outcomes clearly, including passed, failed, and skipped counts.`,
    `3. If tests fail, summarize the root cause and provide actionable recommendations.`,
  ].join("\n");
}

/**
 * Builds a structured continuation prompt incorporating previous session history and findings.
 */
export function buildContinuationPrompt(
  task: string,
  history: SessionHistoryEntry[] = [],
  options?: { nativeSessionId?: string }
): string {
  const parts: string[] = [];
  parts.push("# TASK CONTINUATION CONTEXT");
  if (options?.nativeSessionId) {
    parts.push(`Native Session ID: ${options.nativeSessionId}`);
  }

  if (history.length > 0) {
    parts.push("\n## Previous Activity in this Session");
    for (const [idx, h] of history.entries()) {
      parts.push(`\n### Turn ${idx + 1} [Role: ${h.role.toUpperCase()} | Status: ${h.status.toUpperCase()}]`);
      parts.push(`- Task: ${h.task}`);
      if (h.summary) {
        parts.push(`- Result Summary: ${h.summary}`);
      }
    }
  }

  parts.push("\n## Current Continuation Request / Instructions");
  parts.push(task);

  return parts.join("\n");
}

/**
 * Strips ANSI escape sequences from terminal output.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export interface ParsedReviewOutput {
  reviewOutcome: "PASS" | "FAIL" | "UNKNOWN";
  findings: ReviewFinding[];
  summary: string;
}

function matchVerdict(line: string): "PASS" | "FAIL" | undefined {
  const trimmed = line.trim();
  // Strip Markdown header hashes: ### **PASS** -> **PASS**
  const clean = trimmed.replace(/^#+\s*/, "").trim();

  // Direct word or bold/italic: PASS, **PASS**, *PASS*, __PASS__
  if (/^(\*{1,2}|_{1,2})?PASS\b(\*{1,2}|_{1,2})?/i.test(clean)) {
    return "PASS";
  }
  if (/^(\*{1,2}|_{1,2})?FAIL\b(\*{1,2}|_{1,2})?/i.test(clean)) {
    return "FAIL";
  }

  // Labeled verdicts: Verdict: PASS, Result: **PASS**, Status: FAIL, Outcome: PASS, Review: PASS
  const labeledPass = /^(?:verdict|result|status|outcome|decision|review(?:\s+verdict|\s+result|\s+outcome)?)\s*:\s*(\*{1,2}|_{1,2})?PASS\b/i;
  const labeledFail = /^(?:verdict|result|status|outcome|decision|review(?:\s+verdict|\s+result|\s+outcome)?)\s*:\s*(\*{1,2}|_{1,2})?FAIL\b/i;

  if (labeledPass.test(clean)) return "PASS";
  if (labeledFail.test(clean)) return "FAIL";

  return undefined;
}

/**
 * Parses structured PASS / FAIL review findings from output.
 */
export function parseReviewOutput(output: string): ParsedReviewOutput {
  if (!output || !output.trim()) {
    return { reviewOutcome: "UNKNOWN", findings: [], summary: "Empty review output" };
  }

  const cleanOutput = stripAnsi(output).trim();
  const lines = cleanOutput.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { reviewOutcome: "UNKNOWN", findings: [], summary: "Empty review output" };
  }

  let outcome: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN";
  const verdicts = new Set<"PASS" | "FAIL">();

  for (const line of lines) {
    const verdict = matchVerdict(line);
    if (verdict) verdicts.add(verdict);
  }

  if (verdicts.has("FAIL")) {
    outcome = "FAIL";
  } else if (verdicts.size === 1 && verdicts.has("PASS")) {
    outcome = "PASS";
  }

  const findings: ReviewFinding[] = [];
  const findingBlocks = cleanOutput.split(/(?:^|\n)(?:[-*]\s*)?severity\s*:\s*/i);

  for (let i = 1; i < findingBlocks.length; i++) {
    const block = findingBlocks[i]!;
    const severityMatch = block.match(/^(critical|high|medium|low)\b/i);
    const severity = (severityMatch ? severityMatch[1]?.toLowerCase() : "medium") as ReviewFinding["severity"];

    const fileMatch = block.match(/(?:file|path)\s*:\s*([^\r\n]+)/i);
    const lineMatch = block.match(/(?:line|lines)\s*:\s*([^\r\n]+)/i);
    const issueMatch = block.match(
      /(?:issue|description|finding|problem)\s*:\s*([^\r\n]+(?:\n(?!\s*(?:file|line|suggestion|severity)\s*:)[^\r\n]+)*)/i
    );
    const suggestionMatch = block.match(
      /(?:suggestion|recommendation|fix)\s*:\s*([^\r\n]+(?:\n(?!\s*(?:file|line|issue|severity)\s*:)[^\r\n]+)*)/i
    );

    const file = fileMatch ? fileMatch[1]?.trim() || "unknown" : "unknown";
    const line = lineMatch ? lineMatch[1]?.trim() : undefined;
    const issue = issueMatch ? issueMatch[1]?.trim() || "Unspecified issue" : "Unspecified issue";
    const suggestion = suggestionMatch ? suggestionMatch[1]?.trim() : undefined;

    findings.push({
      severity,
      file,
      line,
      issue,
      suggestion,
    });
  }

  // Findings always override a PASS declaration. Contradictory or unsafe
  // reviewer output must fail closed rather than allow a false green result.
  if (findings.length > 0) {
    outcome = "FAIL";
  }

  let summary: string;
  if (outcome === "PASS") {
    summary = "Review PASSED: Changes are clean and verified.";
  } else if (outcome === "FAIL") {
    summary = `Review FAILED: ${findings.length > 0 ? `${findings.length} issue(s) detected.` : "Issues were detected during review."}`;
  } else {
    const lastLine = lines[lines.length - 1];
    if (lastLine && lastLine.length < 200) {
      summary = lastLine;
    } else {
      const snippet = lines[0] ?? "Execution completed";
      summary = snippet.length > 200 ? `${snippet.slice(0, 197)}...` : snippet;
    }
  }

  return {
    reviewOutcome: outcome,
    findings,
    summary,
  };
}

/**
 * Summarizes the output of an agent run into a concise description.
 */
export function extractSummary(
  output: string,
  fallback = "Execution completed",
  role?: AgentRole
): string {
  if (!output || !output.trim()) {
    return fallback;
  }
  const cleanOutput = stripAnsi(output);
  const lines = cleanOutput.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return fallback;

  if (role === "reviewer" || role === undefined) {
    const parsed = parseReviewOutput(cleanOutput);
    if (parsed.reviewOutcome !== "UNKNOWN") {
      return parsed.summary;
    }
  }

  const lastLine = lines[lines.length - 1];
  if (lastLine && lastLine.length < 200) {
    return lastLine;
  }
  const snippet = lines[0] ?? fallback;
  return snippet.length > 200 ? `${snippet.slice(0, 197)}...` : snippet;
}
