import type { AgentRole, ReviewFinding } from "../agents/types.js";
import type { SessionHistoryEntry } from "./types.js";
import { truncateText } from "./text.js";

/**
 * Builds standard system and task instructions tailored to the assigned role.
 */
export function buildRolePrompt(
  task: string,
  role: AgentRole = "worker",
  context?: { baseCommit?: string; cwd?: string; historyContext?: string; rubric?: boolean },
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
 * Substituted by buildSummaryPrompt with the concrete artifact/session
 * reference so the delivered summary always ends with a provenance pointer.
 */
const SUMMARY_SOURCE_REF_PLACEHOLDER = "<artifact/session reference>";

/**
 * T2.3 semantic handoff template. Merges the eight-section structure
 * (original intent / key concepts / files & data / errors & fixes / all user
 * instructions / pending tasks / current state / next steps) into one compact
 * contract. The model drafts privately inside <analysis>, then emits the
 * deliverable inside <summary>; the analysis block is stripped before storage
 * (see stripAnalysisDraft). Tool use is forbidden for the summarization turn.
 */
export const SUMMARY_TEMPLATE = `You are producing a handoff summary of the conversation history printed below, so a later agent can resume the work without reading the full transcript.

Respond with TEXT ONLY. Tools are disabled for this job: do not read files, run commands, or invoke any tool. Base every statement strictly on the provided history.

Before writing the deliverable, draft your private reasoning inside an <analysis> block: walk the history chronologically and confirm every request, decision, file, failure, and open item is accounted for. This draft is discarded before delivery; it exists only to make the final summary complete.

After the analysis, emit the deliverable inside a <summary> block with exactly these eight numbered sections. Keep the whole summary tight enough to fit in roughly 2000 tokens:

<summary>
1. Original Intent: what the requesting side ultimately wanted, stated precisely.
2. Key Technical Concepts: technologies, modules, constraints, and design decisions the work depends on.
3. Files and Data Touched: each file, function, dataset, or notable command result, always with concrete paths or identifiers.
4. Errors and Fixes: every failure hit and how it was resolved, plus failures still unresolved.
5. All User Instructions: every explicit instruction, preference, or restriction from the requesting side, kept specific rather than paraphrased away.
6. Pending Tasks: work that was explicitly requested but is not finished.
7. Current State and Key Data: completed progress, decisions taken, test/build status, and the critical values or snippets needed to resume safely.
8. Next Steps: the immediate continuation implied by the latest state.
</summary>

Finish the <summary> block with this exact line, replacing only the placeholder with the real reference:
完整原文存于 ${SUMMARY_SOURCE_REF_PLACEHOLDER} ，需要细节请按需读取。`;

/**
 * Assembles the tool-free summarization task for one source session:
 * the template contract plus that session's normalized history rendering.
 */
export function buildSummaryPrompt(normalizedHistory: string, sourceReference: string): string {
  return [
    SUMMARY_TEMPLATE.replace(SUMMARY_SOURCE_REF_PLACEHOLDER, sourceReference),
    "## Conversation History to Summarize",
    normalizedHistory,
  ].join("\n\n");
}

/**
 * Removes the <analysis> drafting scratchpad and unwraps the <summary> block,
 * leaving only the deliverable text. Models that skip the tags degrade
 * gracefully: the raw text passes through with tags stripped.
 */
export function stripAnalysisDraft(text: string): string {
  let value = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
  const match = value.match(/<summary>([\s\S]*?)<\/summary>/i);
  value = (match?.[1] ?? value.replace(/<\/?summary>/gi, "")).trim();
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Generates an independent, strict Reviewer prompt following the architectural requirements.
 */
export function buildReviewerPrompt(
  task: string,
  context?: { baseCommit?: string; cwd?: string; rubric?: boolean },
): string {
  const diffInstruction = context?.baseCommit
    ? `Compare against git base commit/branch: '${context.baseCommit}'.`
    : `Inspect latest uncommitted/committed changes (e.g. using 'git diff', 'git diff HEAD~1', or 'git status').`;

  const sections = [
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
    `2b. WORKSPACE CLEANLINESS: verification commands (npm test etc.) MUST redirect all output to the system temp directory (e.g. > "%TEMP%\review-out.txt" or /tmp/). NEVER create any file inside the working repository — including logs, err*.txt/out*.txt captures, or scratch scripts. The working tree must be byte-identical to how you found it; any new file counts as a violation.`,
    `   (Rationale: the bridge fingerprints the working tree before and after your review — any file you create is detected, flagged as a HIGH finding, and flips a PASS verdict to FAIL. Round-18 real-chain incident.)`,
    `3. Check thoroughly for:`,
    `   - Correctness & logic errors`,
    `   - Regressions & breaking changes`,
    `   - Security vulnerabilities & credential leaks`,
    `   - Edge cases & unhandled errors`,
    `   - Missing or broken automated tests`,
    `   - Architecture, type-safety, and style violations`,
    ``,
  ];
  if (context?.rubric) sections.push(REVIEW_RUBRIC, ``);
  sections.push(
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
  );
  return sections.join("\n");
}

/**
 * T5.1 default review rubric, ported from the codex review template
 * ([CX] prompts/templates/review/rubric.md) and collapsed into the verdict +
 * structured-findings contract the bridge already parses (parseReviewOutput).
 * P0-P3 priorities map onto the four severities so no parser change is needed.
 */
export const REVIEW_RUBRIC = `
## Review Rubric (severity = priority)
Judge every finding against this scale and use the mapped severity label:
- P0 → severity: critical — correctness bug that breaks the task's stated requirements, security vulnerability, credential leak, data loss, or a change that makes existing tests fail.
- P1 → severity: high — likely regression, unhandled error path with real trigger, broken/in missing tests for changed behavior, API or schema break.
- P2 → severity: medium — edge case with plausible trigger, misleading error message, style/type-safety violation with maintenance cost.
- P3 → severity: low — nit, naming, comment or formatting observation.
Writing rules: findings must cite the exact file (and line/range when possible); describe the defect, not the taste; every critical/high finding must carry an actionable suggestion.
Verdict rule: FAIL if any P0 or P1 finding exists, or if the change does not define done (implementation tasks must report test results); otherwise PASS.`;

/**
 * Builds the structured fix instruction injected into the original worker
 * session for one bounded rework round (T5.1). Findings arrive machine-parsed
 * so nothing depends on the reviewer's prose surviving the round trip.
 */
export function buildReworkFixPrompt(params: {
  round: number;
  maxRounds: number;
  findings: ReviewFinding[];
  reviewSummary?: string;
}): string {
  const lines = [
    `# REWORK ROUND ${params.round} OF ${params.maxRounds} (bounded rework loop)`,
    ``,
    `The independent reviewer rejected the previous changes with verdict FAIL.`,
  ];
  if (params.reviewSummary) {
    lines.push(`Reviewer summary: ${params.reviewSummary}`);
  }
  lines.push(
    ``,
    `Address EVERY finding below in the same working tree. Do not restart the task from scratch; keep the existing changes and repair them.`,
    ``,
    `## Reviewer Findings (must all be resolved)`,
  );
  if (params.findings.length === 0) {
    lines.push(
      "- (no structured findings were machine-parsed; re-read the reviewer context and fix the reported defects)",
    );
  } else {
    for (const [index, finding] of params.findings.entries()) {
      lines.push(
        `${index + 1}. [${finding.severity}] ${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.issue}`,
      );
      if (finding.suggestion) lines.push(`   Fix suggestion: ${finding.suggestion}`);
    }
  }
  lines.push(
    ``,
    `## Definition of done`,
    `1. Every finding above is fixed or explicitly argued why it should not apply.`,
    `2. Relevant tests were run and their results are reported verbatim (pass/fail counts).`,
    `3. A concise summary of the changes made in this round is included.`,
  );
  return lines.join("\n");
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
 *
 * Vendor models frequently wrap labels in Markdown decorations
 * (`**Verdict: FAIL**`, `**severity:** critical`, backticked file paths).
 * Verdict and finding parsing therefore runs on a decoration-stripped copy
 * (bold/italic/code markers removed); the fail-closed semantics — bare
 * verdicts trusted only near the top, blocking findings under an explicit
 * PASS — are unchanged.
 */
export function parseReviewOutput(output: string): ParsedReviewOutput {
  if (!output || !output.trim()) {
    return { reviewOutcome: "UNKNOWN", findings: [], summary: "Empty review output" };
  }

  const cleanOutput = stripAnsi(output).trim();
  const normalized = cleanOutput.replace(/\*\*|__|`/g, "");
  const lines = normalized
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
  const findingBlocks = normalized.split(/(?:^|\n)(?:[-*]\s*)?severity\s*:\s*/i);

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
