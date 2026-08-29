import type { ReviewFinding } from "../agents/types.js";
import type { HandoffSummary } from "./types.js";
import { truncateText } from "./text.js";

/**
 * Parses the structured Handoff Report that worker/tester prompts request at
 * the end of every final answer (see buildHandoffContract). The parser is
 * deliberately lenient about surface syntax — `## Decisions`, `**Decisions**:`,
 * and `Decisions:` all open a section — because vendor agents render Markdown
 * differently. When no section is found the turn has no handoff and callers
 * fall back to legacy replay rendering.
 */

const MAX_GOAL_CHARS = 200;
const MAX_ITEM_CHARS = 400;
const MAX_TESTS_CHARS = 300;

type SectionKey = "goal" | "decisions" | "files" | "commands" | "tests" | "openItems";

const SECTION_ALIASES: ReadonlyArray<readonly [SectionKey, string[]]> = [
  ["goal", ["goal", "objective"]],
  ["decisions", ["decisions", "key decisions"]],
  ["files", ["files", "key files", "files changed", "changed files"]],
  ["commands", ["commands", "commands run"]],
  ["tests", ["tests", "test results"]],
  ["openItems", ["open items", "open questions", "risks"]],
];

/**
 * Matches heading or labeled forms and splits an optional inline value:
 * `## Files:`, `**Decisions**: chose X`, `- Files: a.ts`, `Commands:` …
 */
function matchSectionLabel(line: string): { key: SectionKey; inline?: string } | undefined {
  let text = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
  text = text.replace(/^\*{1,2}/, "").replace(/^_{1,2}/, "");
  const colonIndex = text.indexOf(":");
  let labelPart: string;
  let inline: string | undefined;
  if (colonIndex !== -1) {
    labelPart = text.slice(0, colonIndex);
    inline = text.slice(colonIndex + 1).trim() || undefined;
  } else {
    labelPart = text;
  }
  labelPart = labelPart
    .replace(/\*{1,2}$/, "")
    .replace(/_{1,2}$/, "")
    .trim();
  const label = labelPart.toLowerCase();
  if (!label || label.length > 24) return undefined;
  for (const [key, aliases] of SECTION_ALIASES) {
    if (aliases.includes(label)) return { key, inline };
  }
  return undefined;
}

function splitListValues(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanItemLine(line: string): string {
  return truncateText(
    line
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
      // Vendor agents love wrapping file paths in Markdown links and backticks;
      // keep the link text (or the URL when the text is empty) and drop the wrappers.
      .replace(
        /\[([^\]]*)\]\(([^)]+)\)/g,
        (_match, text: string, url: string) => text.trim() || url,
      )
      .replace(/`/g, "")
      // Strip paired emphasis only (**bold**, __bold__). Bare `*` must survive:
      // it is a literal in cron expressions, globs, and shell wildcards, and the
      // earlier blanket strip mangled handoff commands (R15 real-test finding).
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .trim(),
    MAX_ITEM_CHARS,
  );
}

/**
 * Fallback goal when the report carries no `## Goal` section: the first
 * non-blank task line is the closest thing to a one-sentence goal. Collapsing
 * the whole task (the pre-R14 behavior) turned long multi-section tasks into
 * a 200-character instruction blob instead of a goal.
 */
function deriveGoalFromTask(task: string): string {
  const firstLine = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const collapsed = (firstLine ?? task).replace(/\s+/g, " ");
  return truncateText(collapsed, MAX_GOAL_CHARS);
}

export function parseHandoffReport(
  finalAnswer: string | undefined,
  task: string,
  status: "success" | "failed",
): HandoffSummary | undefined {
  if (!finalAnswer || !finalAnswer.trim()) return undefined;

  const lines = finalAnswer.split(/\r?\n/);
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | undefined;

  for (const rawLine of lines) {
    const match = matchSectionLabel(rawLine);
    if (match) {
      current = match.key;
      if (!sections.has(current)) sections.set(current, []);
      if (match.inline) {
        const items = current === "tests" ? [match.inline] : splitListValues(match.inline);
        sections.get(current)!.push(...items.map((item) => cleanItemLine(item)).filter(Boolean));
      }
      continue;
    }
    if (!current) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      // A different Markdown heading ends the handoff report.
      current = undefined;
      continue;
    }
    sections.get(current)!.push(cleanItemLine(trimmed));
  }

  if (sections.size === 0) return undefined;

  const list = (key: SectionKey): string[] | undefined => {
    const items =
      sections
        .get(key)
        ?.map((item) => item.trim())
        .filter(Boolean) ?? [];
    return items.length ? items : undefined;
  };

  const testsLines = sections.get("tests") ?? [];
  const artifacts: HandoffSummary["artifacts"] = {
    ...(list("files") ? { files: list("files") } : {}),
    ...(list("commands") ? { commands: list("commands") } : {}),
    ...(testsLines.length ? { tests: truncateText(testsLines.join("; "), MAX_TESTS_CHARS) } : {}),
  };

  // The report's own one-sentence goal wins; the task's first line is the fallback.
  const reportGoal = list("goal")?.[0];

  return {
    goal: reportGoal ? truncateText(reportGoal, MAX_GOAL_CHARS) : deriveGoalFromTask(task),
    outcome: status === "success" ? "success" : "failed",
    keyDecisions: list("decisions") ?? [],
    artifacts,
    openItems: list("openItems") ?? [],
  };
}

const MAX_REVIEW_OPEN_ITEMS = 8;

/**
 * Derives a structured handoff for review turns without a report contract.
 * The Reviewer's output format is already governed by the strict PASS/FAIL
 * findings contract, so the handoff is assembled deterministically from the
 * parsed verdict, summary, and findings instead of asking the vendor for
 * another report format that could displace the verdict.
 */
export function deriveReviewHandoff(params: {
  task: string;
  status: "success" | "failed";
  reviewOutcome?: "PASS" | "FAIL" | "UNKNOWN";
  summary?: string;
  findings?: ReviewFinding[];
}): HandoffSummary | undefined {
  const { task, status, reviewOutcome, summary, findings } = params;
  if (!reviewOutcome && !(findings && findings.length > 0)) return undefined;

  const outcome =
    reviewOutcome === "PASS" ? "success" : reviewOutcome === "FAIL" ? "failed" : status;

  const verdictDecision =
    summary ?? (reviewOutcome ? `Review verdict: ${reviewOutcome}` : undefined);

  const files = (findings ?? [])
    .map((finding) => finding.file)
    .filter((file) => file && file !== "unknown");
  const openItems = (findings ?? [])
    .slice(0, MAX_REVIEW_OPEN_ITEMS)
    .map((finding) =>
      truncateText(
        `${finding.severity}: ${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.issue}`,
        MAX_ITEM_CHARS,
      ),
    );

  return {
    goal: deriveGoalFromTask(task),
    outcome,
    keyDecisions: verdictDecision ? [truncateText(verdictDecision, MAX_ITEM_CHARS)] : [],
    artifacts: files.length > 0 ? { files: [...new Set(files)] } : {},
    openItems,
  };
}
