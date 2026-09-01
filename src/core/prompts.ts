import type { AgentRole, ReviewFinding } from "../agents/types.js";
import type { SessionHistoryEntry } from "./types.js";
import { truncateText } from "./text.js";

/**
 * Builds standard system and task instructions tailored to the assigned role.
 */
export function buildRolePrompt(
  task: string,
  role: AgentRole = "worker",
  context?: { baseCommit?: string; cwd?: string; historyContext?: string },
): string {
  let basePrompt = task;
  if (context?.historyContext && context.historyContext.trim()) {
    basePrompt = `${context.historyContext.trim()}\n\n## Current Task\n${task}`;
  }

  switch (role) {
    case "reviewer":
      // Reviewer output is governed by the strict verdict/findings contract;
      // a handoff report could displace the PASS/FAIL verdict, so it is not
      // requested here.
      return buildReviewerPrompt(basePrompt, context);
    case "tester":
      return `${buildTesterPrompt(basePrompt)}\n${buildHandoffContract()}`;
    case "worker":
    default:
      return `${basePrompt}\n${buildHandoffContract()}`;
  }
}

/**
 * Fixed contract appended to worker/tester prompts: the vendor agent ends its
 * final answer with structured sections that parseHandoffReport converts into
 * a per-turn HandoffSummary. Constraining the report at the source lets
 * injections stay small instead of replaying (and truncating) full answers.
 */
export function buildHandoffContract(): string {
  return [
    "---",
    "# Handoff Report (required)",
    "End your final answer with exactly the following sections so downstream agents can reuse your work without re-deriving it. Keep the report concise; omit a section only if it has nothing to report.",
    "",
    "## Goal",
    "<one sentence: what this turn was asked to accomplish>",
    "## Decisions",
    "- <key conclusions or decisions the next agent should not have to re-derive>",
    "## Files",
    "- <files created, modified, or decisive to read>",
    "## Commands",
    "- <commands that reproduce or verify the work>",
    "## Tests",
    "<one line: test outcome summary>",
    "## Open Items",
    "- <unfinished work, known risks, or open questions>",
    "- If the SPEC or task text itself is contradictory or impossible, state that FIRST here — a spec contradiction outranks any implementation defect.",
    "## Blockers",
    "- <ONLY when work cannot continue: one line per blocker> (requires: agent | user | resource | dependency | environment)",
    "- `requires` names who must resolve the blocker before work can resume: another agent role must act (agent), a human decision or credential is needed (user), quota/seats are missing (resource), an upstream task or library is waiting (dependency), or infrastructure such as transport/sandbox/network/toolchain is at fault (environment).",
    "- Omit this section entirely when nothing is blocking. Keep each blocker on a single line so the `requires:` marker stays machine-readable.",
  ].join("\n");
}

/**
 * Generates an independent, strict Reviewer prompt following the architectural requirements.
 */
export function buildReviewerPrompt(
  task: string,
  context?: { baseCommit?: string; cwd?: string },
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
    task ||
      "Review the latest changes in the repository for correctness, stability, and adherence to requirements.",
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
    `After a PASS you may additionally list minor non-blocking observations`,
    `(severity medium or low) in the structured finding format below; they are`,
    `reported to the orchestrator but do not change the PASS verdict. Use this`,
    `only when you are confident the change should be approved.`,
    ``,
    `If blocking issues or concerns are identified, respond with:`,
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
  options?: { nativeSessionId?: string },
): string {
  const parts: string[] = [];
  parts.push("# TASK CONTINUATION CONTEXT");
  if (options?.nativeSessionId) {
    parts.push(`Native Session ID: ${options.nativeSessionId}`);
  }

  if (history.length > 0) {
    parts.push("\n## Previous Activity in this Session");
    for (const [idx, h] of history.entries()) {
      parts.push(
        `\n### Turn ${idx + 1} [Role: ${h.role.toUpperCase()} | Status: ${h.status.toUpperCase()}]`,
      );
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
  // ANSI escape sequences necessarily contain the ESC control character.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export interface ParsedReviewOutput {
  reviewOutcome: "PASS" | "FAIL" | "UNKNOWN";
  findings: ReviewFinding[];
  summary: string;
}

function matchVerdict(line: string, allowBarePrefix: boolean): "PASS" | "FAIL" | undefined {
  const trimmed = line.trim();
  // Strip Markdown header hashes: ### **PASS** -> **PASS**
  const clean = trimmed.replace(/^#+\s*/, "").trim();

  // Labeled verdicts: Verdict: PASS, Result: **PASS**, Status: FAIL, Outcome: PASS, Review: PASS
  const labeledPass =
    /^(?:verdict|result|status|outcome|decision|review(?:\s+verdict|\s+result|\s+outcome)?)\s*:\s*(\*{1,2}|_{1,2})?PASS\b/i;
  const labeledFail =
    /^(?:verdict|result|status|outcome|decision|review(?:\s+verdict|\s+result|\s+outcome)?)\s*:\s*(\*{1,2}|_{1,2})?FAIL\b/i;

  if (labeledPass.test(clean)) return "PASS";
  if (labeledFail.test(clean)) return "FAIL";

  // Direct word or bold/italic: PASS, **PASS**, *PASS*, __PASS__
  // A bare word that starts a longer line is only trusted near the top of the
  // output (the required verdict position); deeper in the text it may be a
  // quoted diff/test artifact and must not decide the review outcome.
  const barePattern = allowBarePrefix
    ? /^(\*{1,2}|_{1,2})?PASS\b(\*{1,2}|_{1,2})?/i
    : /^(\*{1,2}|_{1,2})?PASS(\*{1,2}|_{1,2})?$/i;
  if (barePattern.test(clean)) {
    return "PASS";
  }
  const bareFailPattern = allowBarePrefix
    ? /^(\*{1,2}|_{1,2})?FAIL\b(\*{1,2}|_{1,2})?/i
    : /^(\*{1,2}|_{1,2})?FAIL(\*{1,2}|_{1,2})?$/i;
  if (bareFailPattern.test(clean)) {
    return "FAIL";
  }

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
  const lines = cleanOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { reviewOutcome: "UNKNOWN", findings: [], summary: "Empty review output" };
  }

  let outcome: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN";
  const verdicts = new Set<"PASS" | "FAIL">();

  // The required output format places the verdict at the start of the review;
  // beyond that region only exact standalone words or labeled verdicts count.
  const BARE_VERDICT_PREFIX_LINES = 10;
  for (const [index, line] of lines.entries()) {
    const verdict = matchVerdict(line, index < BARE_VERDICT_PREFIX_LINES);
    if (verdict) verdicts.add(verdict);
  }

  if (verdicts.has("FAIL")) {
    outcome = "FAIL";
  } else if (verdicts.size === 1 && verdicts.has("PASS")) {
    outcome = "PASS";
  }

  const findings: ReviewFinding[] = [];
  let hasUnparsedSeverity = false;
  const findingBlocks = cleanOutput.split(/(?:^|\n)(?:[-*]\s*)?severity\s*:\s*/i);

  for (let i = 1; i < findingBlocks.length; i++) {
    const block = findingBlocks[i]!;
    const severityMatch = block.match(/^(critical|high|medium|low)\b/i);
    if (!severityMatch) {
      hasUnparsedSeverity = true;
    }
    const severity = (
      severityMatch ? severityMatch[1]?.toLowerCase() : "medium"
    ) as ReviewFinding["severity"];

    const fileMatch = block.match(/(?:file|path)\s*:\s*([^\r\n]+)/i);
    const lineMatch = block.match(/(?:line|lines)\s*:\s*([^\r\n]+)/i);
    const issueMatch = block.match(
      /(?:issue|description|finding|problem)\s*:\s*([^\r\n]+(?:\n(?!\s*(?:file|line|suggestion|severity)\s*:)[^\r\n]+)*)/i,
    );
    const suggestionMatch = block.match(
      /(?:suggestion|recommendation|fix)\s*:\s*([^\r\n]+(?:\n(?!\s*(?:file|line|issue|severity)\s*:)[^\r\n]+)*)/i,
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

  // An explicit FAIL verdict always decides the review. Under an explicit
  // PASS, only critical/high findings (or a finding whose severity cannot be
  // parsed) contradict the verdict strongly enough to fail closed; medium/low
  // observations stay non-blocking so reviewers can report minor notes without
  // flipping an approval into a failure. Without any verdict, findings still
  // fail closed rather than allow an unreviewed green result.
  const hasBlockingFinding =
    findings.length > 0 &&
    (hasUnparsedSeverity ||
      findings.some((f) => f.severity === "critical" || f.severity === "high"));
  if (findings.length > 0 && (outcome !== "PASS" || hasBlockingFinding)) {
    outcome = "FAIL";
  }

  let summary: string;
  if (outcome === "PASS") {
    summary =
      findings.length > 0
        ? `Review PASSED with ${findings.length} non-blocking finding(s).`
        : "Review PASSED: Changes are clean and verified.";
  } else if (outcome === "FAIL") {
    summary = `Review FAILED: ${findings.length > 0 ? `${findings.length} issue(s) detected.` : "Issues were detected during review."}`;
  } else {
    summary = pickSummaryLine(lines, "Execution completed");
  }

  return {
    reviewOutcome: outcome,
    findings,
    summary,
  };
}

function isSummaryNoise(line: string): boolean {
  if (
    /^(?:the )?(?:background|background task)\b.*(?:launched|started|waiting|results)/i.test(
      line.trim(),
    )
  ) {
    return true;
  }
  const normalized = line.trim().toLowerCase();
  return (
    normalized === "```" ||
    normalized === "~~~" ||
    normalized === "```text" ||
    normalized === "```markdown" ||
    normalized === "```powershell" ||
    normalized === "```json" ||
    /^(?:git )?(?:diff --check|status(?: --short)?)(?: passed|produced no errors|shows)?/.test(
      normalized,
    ) ||
    /^(?:exit code|duration|reading additional input from stdin)\s*:/i.test(line)
  );
}

/**
 * Labels that carry a conclusion value when followed by a colon.
 *   "Overall Status: PASS", "Summary: Implemented the feature",
 *   "- **Overall Status:** **PASS**".
 */
const SUMMARY_LABEL_RE =
  /^(?:summary|(?:overall\s+)?(?:status|result|verdict|outcome|conclusion)|final\s+verdict|decision)\s*:\s*(.+)$/i;

const SUMMARY_HEADING_RE = /^#+\s*(?:summary|conclusion|verdict|result|outcome|overall)\b\W*/i;

/** Strips markdown list markers and bold/italic decorations for summary matching. */
function normalizeSummaryLine(line: string): string {
  let value = line.trim();
  // Remove a leading unordered-list / emphasis marker: "- ", "* ", "** ".
  value = value.replace(/^\s*(?:[-*]\s+)+/, "");
  // Remove surrounding bold/italic markers from the label AND the value.
  value = value.replace(/^\*{1,2}|_{1,2}/, "").replace(/\*{1,2}|_{1,2}$/, "");
  return value;
}

function truncate(text: string, max = 200): string {
  return truncateText(text, max);
}

function pickSummaryLine(lines: string[], fallback: string): string {
  // 1. A labeled conclusion line carries the most intent:
  //    "Overall Status: PASS", "Summary: Implemented the feature",
  //    "- **Overall Status:** **PASS**".
  for (const line of lines) {
    const match = normalizeSummaryLine(line).match(SUMMARY_LABEL_RE);
    if (!match) continue;
    const value = normalizeSummaryLine(match[1]!);
    if (value && !isSummaryNoise(value)) {
      return truncate(value);
    }
  }
  // 2. A Markdown heading that names a conclusion section, e.g.
  //    "## Combined Verification Outcome", "### Summary".
  for (const line of lines) {
    if (SUMMARY_HEADING_RE.test(line.trim())) {
      const value = line.trim().replace(SUMMARY_HEADING_RE, "").trim();
      if (value && !isSummaryNoise(value)) {
        return truncate(value);
      }
    }
  }
  // 3. Fall back to the last non-noise line — conclusions tend to be near the
  //    end of an agent's run, while the leading lines are often progress chatter.
  const meaningful = lines.filter((line) => !isSummaryNoise(line));
  const candidate = meaningful[meaningful.length - 1] ?? lines[0] ?? fallback;
  return truncate(candidate);
}

/**
 * Summarizes the output of an agent run into a concise description.
 */
export function extractSummary(
  output: string,
  fallback = "Execution completed",
  role?: AgentRole,
): string {
  if (!output || !output.trim()) {
    return fallback;
  }
  const cleanOutput = stripAnsi(output);
  const lines = cleanOutput
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return fallback;

  if (role === "reviewer" || role === undefined) {
    const parsed = parseReviewOutput(cleanOutput);
    if (parsed.reviewOutcome !== "UNKNOWN") {
      return parsed.summary;
    }
  }

  return pickSummaryLine(lines, fallback);
}
