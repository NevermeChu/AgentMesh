import * as fs from "node:fs";
import path from "node:path";
import type { ReviewFinding } from "../agents/types.js";
import type { BlockerRequirement, HandoffBlocker, HandoffSummary } from "./types.js";
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

type SectionKey = "goal" | "decisions" | "files" | "commands" | "tests" | "openItems" | "blockers";

const SECTION_ALIASES: ReadonlyArray<readonly [SectionKey, string[]]> = [
  ["goal", ["goal", "objective"]],
  ["decisions", ["decisions", "key decisions"]],
  ["files", ["files", "key files", "files changed", "changed files"]],
  ["commands", ["commands", "commands run"]],
  ["tests", ["tests", "test results"]],
  ["openItems", ["open items", "open questions", "risks"]],
  ["blockers", ["blockers", "blocked"]],
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

const BLOCKER_REQUIREMENTS: readonly BlockerRequirement[] = [
  "agent",
  "user",
  "resource",
  "dependency",
  "environment",
];
const BLOCKER_REQUIREMENT_RE = /\brequires\s*[:=]\s*"?([A-Za-z]+)"?/;

/**
 * Parses one `## Blockers` item of the contract form
 * `- <what is blocked> (requires: agent|user|resource|dependency|environment)`.
 * Vendors frequently drop or mangle the `requires` marker; the summary is kept
 * and the escalation target degrades to `user` (a human decides) instead of
 * discarding the whole blocker — a machine-readable guess beats no signal.
 */
function parseBlockerItem(item: string): HandoffBlocker | undefined {
  if (!item.trim()) return undefined;
  const match = BLOCKER_REQUIREMENT_RE.exec(item);
  const raw = match?.[1]?.toLowerCase();
  const requires: BlockerRequirement = BLOCKER_REQUIREMENTS.includes(raw as BlockerRequirement)
    ? (raw as BlockerRequirement)
    : "user";
  const summary = truncateText(
    (match ? item.replace(match[0], " ") : item)
      .replace(/\s{2,}/g, " ")
      // The contract wraps the marker in parentheses; removing the marker must
      // not leave an empty "( )" tail behind.
      .replace(/\(\s*\)\s*$/, "")
      .replace(/[\s—-]+$/, "")
      .trim(),
    MAX_ITEM_CHARS,
  );
  return summary ? { summary, requires } : undefined;
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
        // Tests and blockers keep the inline value whole: splitting on commas
        // would shred a single blocker/test summary containing commas.
        const items =
          current === "tests" || current === "blockers"
            ? [match.inline]
            : splitListValues(match.inline);
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
  const blockers = (sections.get("blockers") ?? [])
    .map(parseBlockerItem)
    .filter((blocker): blocker is HandoffBlocker => Boolean(blocker));

  return {
    goal: reportGoal ? truncateText(reportGoal, MAX_GOAL_CHARS) : deriveGoalFromTask(task),
    outcome: status === "success" ? "success" : "failed",
    keyDecisions: list("decisions") ?? [],
    artifacts,
    openItems: list("openItems") ?? [],
    ...(blockers.length ? { blockers } : {}),
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

/**
 * Typed exact-match tokens extracted from handoff or final-answer text.
 *
 * This is the shared primitive of the lossless-handoff verification toolchain:
 * the offline semantic gate diffs these sets between a final answer and its
 * handoff (a precise value present in the answer but absent from the handoff is
 * recorded as lost), and the adversarial perturbation suite asserts that token
 * sets change exactly as a perturbation implies. Values are kept verbatim
 * (never normalized or lowercased) so comparisons stay exact rather than
 * fuzzy. This is a proxy metric, not end-to-end task fidelity.
 */
export interface TypedTokens {
  /** Filesystem paths (relative, absolute, or glob shapes containing a separator). */
  paths: string[];
  /** Version numbers: full semver (`1.2.3`, with optional prerelease) or `vN.N` forms. */
  versions: string[];
  /** Command invocations starting with an unambiguous CLI verb, verbatim up to the line end. */
  commands: string[];
  /** Standalone integer counts (including comma-grouped forms), kept as matched text. */
  counts: string[];
  /** Hex hashes 7–64 chars (git shas and prefixes) containing both letters and digits. */
  hashes: string[];
}

const TYPED_TOKEN_CATEGORIES = ["paths", "versions", "commands", "counts", "hashes"] as const;

const COMMAND_VERBS = [
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "deno",
  "bun",
  "git",
  "python",
  "python3",
  "pip",
  "pip3",
  "cargo",
  "tsc",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "pytest",
  "dotnet",
  "gradle",
  "mvn",
];

const URL_RE = /\b(?:https?|file):\/\/\S+/gi;
const COMMAND_RE = new RegExp(`\\b(?:${COMMAND_VERBS.join("|")})\\b[^\\n;\`]*`, "gi");
const PATH_RE =
  /(?<![\w@.%+*/\\-])(?:[A-Za-z]:[\\/])?(?:(?:[\w@.%+-]+|\*{1,2})[\\/])+(?:(?:\*{1,2})?[\w@.%+-]+|\*{1,2})(?![\w@.%+*/\\-])/g;
const VERSION_RE =
  /\bv\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b|\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/gi;
const HASH_RE = /(?<![\w.$/\\-])[0-9a-f]{7,64}(?![\w.$/\\-])/gi;
const COUNT_RE =
  /(?<![\w.$/\\-])\d{1,3}(?:,\d{3})+(?![\w.$/\\-])|(?<![\w.$/\\-])\d+(?![\w.$/\\-])/g;

/** Matches after every path segment is a bare 1–3 letter word with no extension — prose like "and/or", not a path. */
const PROSE_PATH_RE = /^(?:[a-z]{1,3})(?:\/(?:[a-z]{1,3}))+$/;

function collectMatches(text: string, regex: RegExp, keep?: (match: string) => boolean): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    if (value && (!keep || keep(value))) values.push(value);
  }
  return values;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Collects the matches accepted by `keep` and blanks out exactly those spans,
 * so later categories cannot re-match inside them while rejected matches stay
 * available (e.g. digits-only runs rejected as hashes still surface as counts).
 */
function collectAndErase(
  text: string,
  regex: RegExp,
  keep?: (match: string) => boolean,
): { values: string[]; text: string } {
  const values: string[] = [];
  const erased = text.replace(regex, (match) => {
    if (!keep || keep(match)) {
      values.push(match);
      return " ".repeat(match.length);
    }
    return match;
  });
  return { values, text: erased };
}

/**
 * Extracts typed exact-match tokens (paths, versions, commands, counts, hashes)
 * from free-form handoff or answer text. Pure and dependency-free; tolerant of
 * Markdown residue (backticks, paired emphasis) and CRLF line endings.
 * Extraction order matters: paths are erased before hashes/versions/counts so
 * hex-ish path segments and dotted versions are not double-counted; commands
 * are reported separately while their inner values still surface in the other
 * categories.
 */
export function extractTypedTokens(text: string | undefined): TypedTokens {
  const empty: TypedTokens = {
    paths: [],
    versions: [],
    commands: [],
    counts: [],
    hashes: [],
  };
  if (!text || !text.trim()) return empty;

  const withoutUrls = text.replace(URL_RE, " ");
  const commands = uniqueValues(
    collectMatches(withoutUrls, COMMAND_RE)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 160),
  );

  const pathStep = collectAndErase(withoutUrls, PATH_RE, (value) => {
    if (PROSE_PATH_RE.test(value)) return false;
    const normalized = value.replace(/\\/g, "/");
    // Strip glob/globstar noise for the heuristic: pure short word segments
    // with no extension or wildcard are prose ("and/or"), not paths, and so
    // are escaped-string fragments ("1\n") whose segments are all tiny.
    const segments = normalized
      .split("/")
      .filter((segment) => segment && segment !== "*" && segment !== "**");
    if (segments.length === 0) return false;
    if (segments.every((segment) => segment.length <= 2)) return false;
    return !(
      segments.every((segment) => /^[a-z]{1,3}$/.test(segment)) && !normalized.includes(".")
    );
  });
  const paths = uniqueValues(pathStep.values);

  const hashStep = collectAndErase(
    pathStep.text,
    HASH_RE,
    (value) => /[a-f]/i.test(value) && /\d/.test(value),
  );
  const hashes = uniqueValues(hashStep.values);

  const versionStep = collectAndErase(hashStep.text, VERSION_RE);
  const versions = uniqueValues(versionStep.values);

  const counts = uniqueValues(collectMatches(versionStep.text, COUNT_RE));

  return { paths, versions, commands, counts, hashes };
}

/**
 * One category of the typed-token diff used by the offline semantic gate.
 */
export interface TypedTokenDiff {
  /** Precise values present in the source text but missing from the comparison text. */
  missing: string[];
  /** Precise values claimed by the comparison text that the source does not contain. */
  extra: string[];
}

/** Computes the exact per-category set difference between two token extractions. */
export function diffTypedTokens(
  source: TypedTokens,
  comparison: TypedTokens,
): Record<(typeof TYPED_TOKEN_CATEGORIES)[number], TypedTokenDiff> {
  const result = {} as Record<(typeof TYPED_TOKEN_CATEGORIES)[number], TypedTokenDiff>;
  for (const category of TYPED_TOKEN_CATEGORIES) {
    const sourceSet = new Set(source[category]);
    const comparisonSet = new Set(comparison[category]);
    result[category] = {
      missing: [...sourceSet].filter((value) => !comparisonSet.has(value)),
      extra: [...comparisonSet].filter((value) => !sourceSet.has(value)),
    };
  }
  return result;
}

export interface HandoffFileGrounding {
  /** Files claimed by the handoff that could not be located in the recorded changes or the working tree. */
  ungrounded: string[];
  /** Files whose existence check failed with a filesystem error (never fabricated as verified or ungrounded). */
  unverifiable: number;
}

/**
 * Strips vendor annotation noise from a claimed path so the underlying file
 * reference can be judged: leading status labels ("Modified: x.ts"), trailing
 * parentheticals ("src/x.ts (created)"), em-dash comment tails ("src/x.js —
 * created: implements ..."), line-number suffixes ("src/x.js:36", "x.js:1-2"),
 * and separator/"./" noise. The handoff data itself is never rewritten — this
 * normalization applies to the grounding check only.
 */
function normalizePathClaim(value: string): string {
  return (
    value
      .replace(/^[A-Za-z][A-Za-z'\s]{1,24}:\s+/, "")
      .replace(/\s*\([^()]*\)\s*$/, "")
      .split(/\s+—\s*/)[0] ?? ""
  )
    .replace(/:\d+(?:-\d+)?$/, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/[/\\]+$/, "");
}

/** Splits comma-separated multi-file claims ("Decisive to read: SPEC.md, src/x.ts") into judgeable parts. */
function splitPathClaims(value: string): string[] {
  const normalized = normalizePathClaim(value);
  if (!normalized.includes(",")) return normalized ? [normalized] : [];
  return value
    .split(/,(?=\s*\S)/)
    .map((part) => normalizePathClaim(part))
    .filter(Boolean);
}

/**
 * Judges whether the files a handoff claims as artifacts can actually be
 * located: each claim must exactly or suffix-match a recorded repository
 * change, or exist under the session working directory. Conservative by
 * design — a filesystem failure counts the claim as unverifiable instead of
 * pretending it was verified or inventing an ungrounded verdict.
 */
export function findUngroundedHandoffFiles(
  files: readonly string[],
  options: { cwd?: string; changedPaths?: readonly string[] } = {},
): HandoffFileGrounding {
  const changed = (options.changedPaths ?? []).map(normalizePathClaim);
  const ungrounded: string[] = [];
  let unverifiable = 0;
  for (const file of files) {
    for (const claim of splitPathClaims(file)) {
      if (
        changed.some(
          (changedPath) =>
            changedPath === claim ||
            changedPath.endsWith(`/${claim}`) ||
            claim.endsWith(`/${changedPath}`),
        )
      ) {
        continue;
      }
      if (options.cwd) {
        try {
          if (fs.existsSync(path.resolve(options.cwd, claim))) continue;
        } catch {
          unverifiable += 1;
          continue;
        }
      }
      ungrounded.push(claim);
    }
  }
  return { ungrounded: uniqueValues(ungrounded), unverifiable };
}
