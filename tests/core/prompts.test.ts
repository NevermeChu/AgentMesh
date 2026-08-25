import { describe, it, expect } from "vitest";
import {
  buildRolePrompt,
  buildReviewerPrompt,
  buildContinuationPrompt,
  stripAnsi,
  extractSummary,
  parseReviewOutput,
} from "../../src/core/prompts.js";

describe("core/prompts", () => {
  it("includes reviewer evidence, read-only, and verdict requirements", () => {
    const prompt = buildReviewerPrompt("Review user auth changes", {
      baseCommit: "main",
    });

    expect(prompt).toContain("ROLE: Independent Code Reviewer");
    expect(prompt).toContain("Review user auth changes");
    expect(prompt).toContain("STRICT READ-ONLY RULE");
    expect(prompt).toContain("Compare against git base commit/branch: 'main'");
    expect(prompt).toContain("PASS");
    expect(prompt).toContain("FAIL");
    expect(prompt).toContain("severity: [critical | high | medium | low]");
    expect(prompt).toContain("non-blocking observations");
  });

  it("injects shared history before the current task", () => {
    const prompt = buildRolePrompt("Fix the bug", "worker", {
      historyContext: "Turn 1: Implemented feature\nTurn 2: Reviewer found bug on line 10",
    });

    expect(prompt).toContain("Turn 1: Implemented feature");
    expect(prompt).toContain("Turn 2: Reviewer found bug on line 10");
    expect(prompt).toContain("## Current Task\nFix the bug");
  });

  it("builds structured continuation context", () => {
    const prompt = buildContinuationPrompt(
      "Fix reported null pointer exception",
      [
        {
          role: "worker",
          task: "Implement user handler",
          timestamp: new Date().toISOString(),
          status: "success",
          summary: "Implemented handler in src/user.ts",
        },
        {
          role: "reviewer",
          task: "Review changes",
          timestamp: new Date().toISOString(),
          status: "failed",
          summary: "FAIL: Null check missing on line 42",
        },
      ],
      { nativeSessionId: "native-thread-888" },
    );

    expect(prompt).toContain("# TASK CONTINUATION CONTEXT");
    expect(prompt).toContain("Native Session ID: native-thread-888");
    expect(prompt).toContain("Turn 1 [Role: WORKER | Status: SUCCESS]");
    expect(prompt).toContain("Turn 2 [Role: REVIEWER | Status: FAILED]");
    expect(prompt).toContain("FAIL: Null check missing on line 42");
    expect(prompt).toContain("Fix reported null pointer exception");
  });

  it("normalizes ANSI-colored reviewer verdicts", () => {
    const ansiPass = "\u001b[32mPASS\u001b[0m\nCode review succeeded cleanly.";
    expect(stripAnsi(ansiPass)).toBe("PASS\nCode review succeeded cleanly.");
    expect(extractSummary(ansiPass)).toContain("Review PASSED");

    const ansiFail =
      "\u001b[31mFAIL\u001b[0m\n- severity: high\n  file: db.ts\n  issue: Unhandled promise";
    expect(extractSummary(ansiFail)).toContain("Review FAILED");
  });

  it("does not use markdown fences or diagnostic status lines as worker summaries", () => {
    expect(extractSummary("Implemented the feature\n```", "fallback", "worker")).toBe(
      "Implemented the feature",
    );
    expect(
      extractSummary("Implemented the feature\ngit diff --check passed", "fallback", "worker"),
    ).toBe("Implemented the feature");
  });

  it("prefers a labeled conclusion line over leading progress chatter", () => {
    // Regression for P2: antigravity-style Tester output opens with a progress
    // sentence, so the summary should favor the labeled outcome, not the first line.
    const antigravityStyle = [
      "We have started searching for the Node.js and Git executables to run the test suite.",
      "# Automated QA / Test Verification Report",
      "- Overall Status: PASS",
      "- Working Tree: src tracked, no commit created.",
    ].join("\n");
    expect(extractSummary(antigravityStyle, "fallback", "tester")).toBe("PASS");

    const capitalSummary = "Summary: Implemented the timelog SPEC without committing.";
    expect(extractSummary(capitalSummary, "fallback", "worker")).toBe(
      "Implemented the timelog SPEC without committing.",
    );
  });

  it("falls back to the last non-noise line instead of leading progress chatter", () => {
    const progressFirst =
      "We have started running the suite.\n" +
      "# Summary\n" +
      "11 tests passed, 0 failed, exit code 0";
    expect(extractSummary(progressFirst, "fallback", "tester")).toBe(
      "11 tests passed, 0 failed, exit code 0",
    );
  });
  it("parses structured review findings", () => {
    const reviewText = `FAIL
Here are the review findings:
- severity: critical
  file: src/auth/token.ts
  line: 42-45
  issue: Unvalidated JWT expiration
  suggestion: Add exp claim validation

- severity: low
  file: src/config.ts
  line: 12
  issue: Missing trailing comma
  suggestion: Add comma
`;

    const parsed = parseReviewOutput(reviewText);
    expect(parsed.reviewOutcome).toBe("FAIL");
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toEqual({
      severity: "critical",
      file: "src/auth/token.ts",
      line: "42-45",
      issue: "Unvalidated JWT expiration",
      suggestion: "Add exp claim validation",
    });
    expect(parsed.findings[1]).toEqual({
      severity: "low",
      file: "src/config.ts",
      line: "12",
      issue: "Missing trailing comma",
      suggestion: "Add comma",
    });
    expect(parsed.summary).toContain("2 issue(s) detected");
  });

  it("recognizes representative Markdown PASS and FAIL verdicts", () => {
    const verdictPass = parseReviewOutput("# Code Review\nVerdict: PASS\nAll good!");
    expect(verdictPass.reviewOutcome).toBe("PASS");
    expect(verdictPass.summary).toContain("Review PASSED");
    const boldFail = parseReviewOutput(
      "**FAIL**\n- severity: high\n  file: src/api.ts\n  issue: Broken endpoint",
    );
    expect(boldFail.reviewOutcome).toBe("FAIL");
    expect(boldFail.findings).toHaveLength(1);
  });

  it("keeps an explicit PASS when only medium/low findings are attached", () => {
    const passWithNotes = parseReviewOutput(
      [
        "VERDICT: PASS",
        "Non-blocking remarks:",
        "",
        "- severity: low",
        "  file: tests/app.test.mjs",
        "  line: 550",
        "  issue: Assertion could flake if the wall clock ticks between calls",
        "  suggestion: Assert a range instead of an exact value",
        "",
        "- severity: medium",
        "  file: docs/usage.md",
        "  issue: Example omits error handling",
        "  suggestion: Show a try/catch variant",
      ].join("\n"),
    );
    expect(passWithNotes.reviewOutcome).toBe("PASS");
    expect(passWithNotes.findings).toHaveLength(2);
    expect(passWithNotes.summary).toContain("Review PASSED");
    expect(passWithNotes.summary).toContain("non-blocking");
  });

  it("fails closed when a PASS carries critical/high or unparsable-severity findings", () => {
    const passWithHigh = parseReviewOutput(
      "PASS\n- severity: high\n  file: src/auth.ts\n  issue: Authorization bypass",
    );
    expect(passWithHigh.reviewOutcome).toBe("FAIL");
    expect(passWithHigh.summary).toContain("Review FAILED");

    const passWithCritical = parseReviewOutput(
      "Verdict: **PASS**\n- severity: critical\n  file: src/db.ts\n  issue: Data loss on migration",
    );
    expect(passWithCritical.reviewOutcome).toBe("FAIL");

    const passWithGarbledSeverity = parseReviewOutput(
      "Final verdict: PASS\n- severity: moderate\n  file: src/api.ts\n  issue: Unclear error message",
    );
    expect(passWithGarbledSeverity.reviewOutcome).toBe("FAIL");
  });

  it("still fails closed for contradictory verdicts without any parseable outcome", () => {
    const contradictory = parseReviewOutput(
      "Status: PASS\nInitial checks passed.\nFAIL\n- severity: critical\n  file: src/db.ts\n  issue: Data loss",
    );
    expect(contradictory.reviewOutcome).toBe("FAIL");

    const noVerdictButFindings = parseReviewOutput(
      "- severity: low\n  file: src/config.ts\n  issue: Missing trailing comma",
    );
    expect(noVerdictButFindings.reviewOutcome).toBe("FAIL");
  });

  it("does not let quoted mid-output PASS-like prose decide the verdict", () => {
    // A diff/test artifact quoted deep in the report must not flip the outcome.
    const quoted = parseReviewOutput(
      [
        "I inspected the changes carefully.",
        "The updated suite still asserts 'PASS case 1 handled' correctly.",
        "No issues found in the reviewed scope.",
      ].join("\n"),
    );
    expect(quoted.reviewOutcome).toBe("UNKNOWN");

    const deepProse = parseReviewOutput(
      `${Array.from({ length: 15 }, (_, i) => `Detail line ${i + 1}`).join("\n")}\nAll PASS cases were re-verified manually.`,
    );
    expect(deepProse.reviewOutcome).toBe("UNKNOWN");
  });

  it("still honors a standalone verdict line after process chatter", () => {
    const chatter = Array.from({ length: 14 }, (_, i) => `Progress note ${i + 1}`).join("\n");
    const lateVerdict = parseReviewOutput(`${chatter}\nPASS\nEverything verified cleanly.`);
    expect(lateVerdict.reviewOutcome).toBe("PASS");
  });
});
