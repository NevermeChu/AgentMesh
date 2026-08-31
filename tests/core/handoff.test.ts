import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveReviewHandoff,
  extractTypedTokens,
  findUngroundedHandoffFiles,
  parseHandoffReport,
} from "../../src/core/handoff.js";
import { estimateTokens, truncateTextToTokenBudget } from "../../src/core/text.js";
import type { ReviewFinding } from "../../src/agents/types.js";

function finalAnswerWithReport(): string {
  return [
    "I implemented the login fix and ran the suite.",
    "",
    "## Decisions",
    "- Use parameterized queries for the auth lookup",
    "- Keep the legacy session cookie for one release",
    "## Files",
    "- src/auth/login.ts",
    "- src/auth/login.test.ts",
    "## Commands",
    "- npm test -- auth",
    "## Tests",
    "42 passed, 0 failed",
    "## Open Items",
    "- Rate limiting still uses the in-memory store",
  ].join("\n");
}

describe("core/handoff parseHandoffReport", () => {
  it("parses a full report into a structured handoff", () => {
    const handoff = parseHandoffReport(finalAnswerWithReport(), "Fix the login flow", "success");

    expect(handoff).toBeDefined();
    expect(handoff!.goal).toBe("Fix the login flow");
    expect(handoff!.outcome).toBe("success");
    expect(handoff!.keyDecisions).toEqual([
      "Use parameterized queries for the auth lookup",
      "Keep the legacy session cookie for one release",
    ]);
    expect(handoff!.artifacts.files).toEqual(["src/auth/login.ts", "src/auth/login.test.ts"]);
    expect(handoff!.artifacts.commands).toEqual(["npm test -- auth"]);
    expect(handoff!.artifacts.tests).toBe("42 passed, 0 failed");
    expect(handoff!.openItems).toEqual(["Rate limiting still uses the in-memory store"]);
  });

  it("accepts bold, list-labeled, and case variants of section headers", () => {
    const answer = [
      "Work done.",
      "**Decisions**: chose retry with backoff",
      "- files: a.ts",
      "Commands: npm run build",
    ].join("\n");
    const handoff = parseHandoffReport(answer, "Build", "failed");

    expect(handoff).toBeDefined();
    expect(handoff!.outcome).toBe("failed");
    expect(handoff!.keyDecisions).toEqual(["chose retry with backoff"]);
    expect(handoff!.artifacts.files).toEqual(["a.ts"]);
    expect(handoff!.artifacts.commands).toEqual(["npm run build"]);
  });

  it("returns a partial handoff when only some sections are present", () => {
    const handoff = parseHandoffReport(
      "Fixed the bug.\n\n## Files\n- src/x.ts",
      "Fix bug",
      "success",
    );

    expect(handoff).toBeDefined();
    expect(handoff!.keyDecisions).toEqual([]);
    expect(handoff!.artifacts.files).toEqual(["src/x.ts"]);
    expect(handoff!.artifacts.commands).toBeUndefined();
    expect(handoff!.artifacts.tests).toBeUndefined();
    expect(handoff!.openItems).toEqual([]);
  });

  it("returns undefined when the answer contains no report sections", () => {
    expect(
      parseHandoffReport("Just a plain answer without sections", "Task", "success"),
    ).toBeUndefined();
    expect(parseHandoffReport(undefined, "Task", "success")).toBeUndefined();
    expect(parseHandoffReport("   \n  ", "Task", "failed")).toBeUndefined();
  });

  it("stops collecting at unrelated markdown headings", () => {
    const answer = ["## Decisions", "- one", "## Appendix", "- not a decision"].join("\n");
    const handoff = parseHandoffReport(answer, "Task", "success");

    expect(handoff!.keyDecisions).toEqual(["one"]);
  });

  it("truncates the goal and ignores empty output", () => {
    const handoff = parseHandoffReport(
      finalAnswerWithReport(),
      `Very long task: ${"x".repeat(400)}`,
      "success",
    );
    expect(handoff!.goal.length).toBeLessThanOrEqual(200);
    expect(handoff!.goal.startsWith("Very long task:")).toBe(true);
  });

  it("prefers the report's own Goal section over the task-derived goal", () => {
    const answer = [
      "Work done.",
      "## Goal",
      "- Convert units between measurement scales per SPEC",
      "## Files",
      "- src/x.ts",
    ].join("\n");
    const handoff = parseHandoffReport(answer, "Some long instruction blob", "success");

    expect(handoff!.goal).toBe("Convert units between measurement scales per SPEC");
  });

  it("falls back to the first task line instead of a 200-char task blob", () => {
    // Regression (real-test R14): long multi-section tasks used to produce a
    // 200-character instruction prefix as the goal.
    const task = [
      "Implement the unitsmith CLI exactly as specified in SPEC.md (read it first - it is the authority).",
      "",
      "Scope and ownership:",
      "- You own everything in this repository except SPEC.md.",
    ].join("\n");
    const handoff = parseHandoffReport(finalAnswerWithReport(), task, "success");

    expect(handoff!.goal).toBe(
      "Implement the unitsmith CLI exactly as specified in SPEC.md (read it first - it is the authority).",
    );
    expect(handoff!.goal).not.toContain("Scope and ownership");
  });

  it("strips markdown link wrappers and backticks from handoff items", () => {
    const answer = [
      "## Goal",
      "- [Convert units](https://example.spec) correctly",
      "## Files",
      "- [src/auth.ts](file:///C:/repo/src/auth.ts)",
      "- [](file:///C:/repo/only-url.ts)",
      "- `lib/units.js` (created)",
    ].join("\n");
    const handoff = parseHandoffReport(answer, "Task", "success");

    expect(handoff!.goal).toBe("Convert units correctly");
    expect(handoff!.artifacts.files).toEqual([
      "src/auth.ts",
      "file:///C:/repo/only-url.ts",
      "lib/units.js (created)",
    ]);
  });

  it("preserves literal asterisks (cron/glob) while stripping paired emphasis", () => {
    // Regression (real-test R15): the blanket emphasis strip mangled cron
    // expressions and globs inside Commands items.
    const answer = [
      "## Commands",
      '- **run** `node bin/cronsmith.js "* * * * *" --from 2026-01-01T00:00:00Z --count 3`',
      "- glob check: src/**/*.test.js",
    ].join("\n");
    const handoff = parseHandoffReport(answer, "Task", "success");

    expect(handoff!.artifacts.commands).toEqual([
      'run node bin/cronsmith.js "* * * * *" --from 2026-01-01T00:00:00Z --count 3',
      "glob check: src/**/*.test.js",
    ]);
  });
});

describe("core/text token estimation", () => {
  it("estimates ascii text at roughly four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });

  it("counts dense CJK characters as one token each", () => {
    expect(estimateTokens("上下文交接")).toBe(5);
    expect(estimateTokens("abc上下文")).toBe(4);
  });

  it("truncates to a token budget with a visible marker", () => {
    const text = "a".repeat(400);
    const trimmed = truncateTextToTokenBudget(text, 50);
    expect(trimmed.endsWith("... [truncated]")).toBe(true);
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(50);
    expect(truncateTextToTokenBudget("short", 50)).toBe("short");
  });
});

describe("core/handoff deriveReviewHandoff", () => {
  const findings: ReviewFinding[] = [
    {
      severity: "high",
      file: "src/auth.ts",
      line: "42",
      issue: "SQL injection in the login lookup",
      suggestion: "Use parameterized queries",
    },
    {
      severity: "medium",
      file: "src/auth.ts",
      issue: "Missing rate limiting",
    },
  ];

  it("derives a failed handoff from a FAIL verdict and findings", () => {
    const handoff = deriveReviewHandoff({
      task: "Review login changes",
      status: "success",
      reviewOutcome: "FAIL",
      summary: "Review FAILED: 2 issue(s) detected.",
      findings,
    });

    expect(handoff).toBeDefined();
    expect(handoff!.goal).toBe("Review login changes");
    expect(handoff!.outcome).toBe("failed");
    expect(handoff!.keyDecisions).toEqual(["Review FAILED: 2 issue(s) detected."]);
    expect(handoff!.artifacts.files).toEqual(["src/auth.ts"]);
    expect(handoff!.openItems).toEqual([
      "high: src/auth.ts:42 — SQL injection in the login lookup",
      "medium: src/auth.ts — Missing rate limiting",
    ]);
  });

  it("derives a passed handoff with verdict-only decisions when there are no findings", () => {
    const handoff = deriveReviewHandoff({
      task: "Review clean changes",
      status: "success",
      reviewOutcome: "PASS",
      summary: "Review PASSED: Changes are clean and verified.",
    });

    expect(handoff).toBeDefined();
    expect(handoff!.outcome).toBe("success");
    expect(handoff!.keyDecisions).toEqual(["Review PASSED: Changes are clean and verified."]);
    expect(handoff!.artifacts.files).toBeUndefined();
    expect(handoff!.openItems).toEqual([]);
  });

  it("returns undefined without a verdict or findings", () => {
    expect(deriveReviewHandoff({ task: "Worker task", status: "success" })).toBeUndefined();
    expect(
      deriveReviewHandoff({ task: "Worker task", status: "failed", summary: "Execution failed" }),
    ).toBeUndefined();
  });

  it("falls back to the execution status when the verdict is UNKNOWN", () => {
    const handoff = deriveReviewHandoff({
      task: "Review without verdict",
      status: "failed",
      reviewOutcome: "UNKNOWN",
    });
    expect(handoff).toBeDefined();
    expect(handoff!.outcome).toBe("failed");
    expect(handoff!.keyDecisions).toEqual(["Review verdict: UNKNOWN"]);
  });
});

describe("core/handoff extractTypedTokens", () => {
  it("extracts paths, versions, commands, counts, and hashes from a mixed answer", () => {
    const tokens = extractTypedTokens(
      [
        "Updated src/auth/login.ts and lib/units.js; released 1.2.3 and v2.0.",
        "Ran npm test -- auth",
        "42 passed, 0 failed",
        "Commit abc1234 is on main",
      ].join("\n"),
    );

    expect(tokens.paths).toEqual(["src/auth/login.ts", "lib/units.js"]);
    expect(tokens.versions).toEqual(["1.2.3", "v2.0"]);
    expect(tokens.commands).toEqual(["npm test -- auth"]);
    expect(tokens.counts).toEqual(["42", "0"]);
    expect(tokens.hashes).toEqual(["abc1234"]);
  });

  it("handles Chinese-English mixed text with backtick-wrapped commands", () => {
    const tokens = extractTypedTokens(
      "创建了 src/core/prompts.ts，共 128 行；发布版本 v1.4.2；验证命令：`npm run build`。",
    );

    expect(tokens.paths).toContain("src/core/prompts.ts");
    expect(tokens.counts).toContain("128");
    expect(tokens.versions).toEqual(["v1.4.2"]);
    expect(tokens.commands).toEqual(["npm run build"]);
  });

  it("survives R14/R15 markdown residue: links, backticks, annotations, globs, cron", () => {
    const tokens = extractTypedTokens(
      [
        "- [src/auth.ts](file:///C:/repo/src/auth.ts)",
        "- `lib/units.js` (created)",
        '- **run** `node bin/cronsmith.js "* * * * *" --from 2026-01-01T00:00:00Z --count 3`',
        "- glob check: src/**/*.test.js",
      ].join("\n"),
    );

    expect(tokens.paths).toContain("src/auth.ts");
    expect(tokens.paths).toContain("lib/units.js");
    expect(tokens.paths).toContain("src/**/*.test.js");
    expect(tokens.commands).toContain(
      'node bin/cronsmith.js "* * * * *" --from 2026-01-01T00:00:00Z --count 3',
    );
    expect(tokens.counts).toContain("3");
    // Dates must not pollute counts or hashes.
    expect(tokens.counts).not.toContain("2026");
    expect(tokens.hashes).toEqual([]);
  });

  it("separates digit-only numbers (counts) from hex hashes containing letters", () => {
    const tokens = extractTypedTokens("Saw 1234567 items and commit def9876a");

    expect(tokens.counts).toContain("1234567");
    expect(tokens.hashes).toEqual(["def9876a"]);
    expect(tokens.counts).not.toContain("def9876a");
  });

  it("ignores prose slash pairs and strips URLs before path extraction", () => {
    const tokens = extractTypedTokens(
      "Compare and/or merge; docs at https://example.com/docs/x/y.ts and file:///C:/repo/a/b.ts",
    );

    expect(tokens.paths).not.toContain("and/or");
    expect(tokens.paths).not.toContain("x/y.ts");
    expect(tokens.paths).not.toContain("a/b.ts");
  });

  it("returns empty sets for empty or undefined input", () => {
    expect(extractTypedTokens(undefined)).toEqual({
      paths: [],
      versions: [],
      commands: [],
      counts: [],
      hashes: [],
    });
    expect(extractTypedTokens("   \n  ").counts).toEqual([]);
  });
});

describe("core/handoff findUngroundedHandoffFiles", () => {
  it("accepts files that exact- or suffix-match recorded repository changes", () => {
    const result = findUngroundedHandoffFiles(["src/a.ts", "b.ts"], {
      changedPaths: ["src/a.ts", "lib/b.ts"],
    });

    expect(result).toEqual({ ungrounded: [], unverifiable: 0 });
  });

  it("accepts files that exist under the session cwd and flags the rest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-grounding-"));
    try {
      fs.writeFileSync(path.join(dir, "existing.ts"), "export {};\n");
      const result = findUngroundedHandoffFiles(["existing.ts", "missing.ts"], { cwd: dir });

      expect(result.ungrounded).toEqual(["missing.ts"]);
      expect(result.unverifiable).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips trailing parenthetical annotations and normalizes separators", () => {
    const result = findUngroundedHandoffFiles(["lib/units.js (created)", "src\\win.ts"], {
      changedPaths: ["lib/units.js", "src/win.ts"],
    });

    expect(result.ungrounded).toEqual([]);
  });

  it("strips em-dash annotation tails seen in real vendor artifacts (R16-R18 form)", () => {
    const result = findUngroundedHandoffFiles(
      [
        "src/semver.js — created: implements parseVersion per SPEC.",
        "SPEC.md — read (authority, not modified); package.json — read (type:module)",
      ],
      { changedPaths: ["src/semver.js", "SPEC.md", "package.json"] },
    );

    expect(result.ungrounded).toEqual([]);
  });

  it("strips leading status labels, line-number suffixes, and splits comma lists", () => {
    const result = findUngroundedHandoffFiles(
      [
        "Modified: src/legacy-ini.js:36 — current[key] = value.trim();",
        "Created: tests/phase1.test.js — 6 tests for C1-C6",
        "Decisive to read: SPEC.md, src/legacy-ini.js, package.json",
        "src/truncate.js:1 — created",
        "src/index.js:1-2 — read (re-exports, not modified)",
      ],
      {
        changedPaths: [
          "src/legacy-ini.js",
          "tests/phase1.test.js",
          "SPEC.md",
          "package.json",
          "src/truncate.js",
          "src/index.js",
        ],
      },
    );

    expect(result.ungrounded).toEqual([]);
  });

  it("flags the specific missing file inside a comma-separated claim list", () => {
    const result = findUngroundedHandoffFiles(["Decisive to read: SPEC.md, src/ghost.ts"], {
      changedPaths: ["SPEC.md"],
    });

    expect(result.ungrounded).toEqual(["src/ghost.ts"]);
  });

  it("reports ungrounded claims when no cwd and no change evidence exists", () => {
    const result = findUngroundedHandoffFiles(["src/ghost.ts"]);

    expect(result.ungrounded).toEqual(["src/ghost.ts"]);
    expect(result.unverifiable).toBe(0);
  });

  it("never throws or fabricates a verdict for pathological path input", () => {
    // fs.existsSync is total in Node (it catches its own validation errors),
    // so the conservative branch is defense-in-depth: the observable contract
    // is "no crash, and a pathological claim is never silently verified".
    const result = findUngroundedHandoffFiles(["bad\0file.ts"], { cwd: os.tmpdir() });

    expect(result.ungrounded).toContain("bad\0file.ts");
    expect(result.unverifiable).toBe(0);
  });
});
