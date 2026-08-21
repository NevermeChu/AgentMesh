import { describe, it, expect } from "vitest";
import {
  buildRolePrompt,
  buildReviewerPrompt,
  buildTesterPrompt,
  buildContinuationPrompt,
  stripAnsi,
  extractSummary,
  parseReviewOutput,
} from "../../src/core/prompts.js";

describe("core/prompts", () => {
  it("should generate standard reviewer prompt with mandatory rules", () => {
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
  });

  it("should generate tester prompt correctly", () => {
    const prompt = buildTesterPrompt("Run vitest unit tests");
    expect(prompt).toContain("ROLE: Automated QA / Test Engineer");
    expect(prompt).toContain("Run vitest unit tests");
  });

  it("should pass through worker prompt", () => {
    const prompt = buildRolePrompt("Build feature X", "worker");
    expect(prompt).toBe("Build feature X");
  });

  it("should inject historyContext into role prompt when continuing", () => {
    const prompt = buildRolePrompt("Fix the bug", "worker", {
      historyContext: "Turn 1: Implemented feature\nTurn 2: Reviewer found bug on line 10",
    });

    expect(prompt).toContain("Turn 1: Implemented feature");
    expect(prompt).toContain("Turn 2: Reviewer found bug on line 10");
    expect(prompt).toContain("## Current Task\nFix the bug");
  });

  it("should build structured continuation prompt", () => {
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
      { nativeSessionId: "native-thread-888" }
    );

    expect(prompt).toContain("# TASK CONTINUATION CONTEXT");
    expect(prompt).toContain("Native Session ID: native-thread-888");
    expect(prompt).toContain("Turn 1 [Role: WORKER | Status: SUCCESS]");
    expect(prompt).toContain("Turn 2 [Role: REVIEWER | Status: FAILED]");
    expect(prompt).toContain("FAIL: Null check missing on line 42");
    expect(prompt).toContain("Fix reported null pointer exception");
  });

  it("should extract summary from reviewer PASS output", () => {
    const output = "PASS\nAll tests pass and diff is clean.";
    const summary = extractSummary(output);
    expect(summary).toContain("Review PASSED");
  });

  it("should extract summary from reviewer FAIL output", () => {
    const output = "FAIL\n- severity: high\n  file: src/auth.ts\n  issue: Token leak";
    const summary = extractSummary(output);
    expect(summary).toContain("Review FAILED");
  });

  it("should strip ANSI colors and extract PASS / FAIL correctly", () => {
    const ansiPass = "\u001b[32mPASS\u001b[0m\nCode review succeeded cleanly.";
    expect(stripAnsi(ansiPass)).toBe("PASS\nCode review succeeded cleanly.");
    expect(extractSummary(ansiPass)).toContain("Review PASSED");

    const ansiFail = "\u001b[31mFAIL\u001b[0m\n- severity: high\n  file: db.ts\n  issue: Unhandled promise";
    expect(extractSummary(ansiFail)).toContain("Review FAILED");
  });

  it("should parse structured review findings accurately", () => {
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

  it("should handle empty or plain output", () => {
    expect(extractSummary("")).toBe("Execution completed");
    expect(extractSummary("Single line output")).toBe("Single line output");
  });

  it("should robustly parse Markdown formatted PASS / FAIL verdicts", () => {
    // Bold PASS
    const boldPass = parseReviewOutput("**PASS**\nEverything is clean and well tested.");
    expect(boldPass.reviewOutcome).toBe("PASS");
    expect(boldPass.summary).toContain("Review PASSED");

    // Labeled Verdict: PASS
    const verdictPass = parseReviewOutput("# Code Review\nVerdict: PASS\nAll good!");
    expect(verdictPass.reviewOutcome).toBe("PASS");
    expect(verdictPass.summary).toContain("Review PASSED");

    // Header PASS
    const headerPass = parseReviewOutput("### **PASS**\nNo issues found.");
    expect(headerPass.reviewOutcome).toBe("PASS");

    // Labeled Result: **PASS**
    const resultPass = parseReviewOutput("Review Outcome: **PASS**\nLooks ready for merge.");
    expect(resultPass.reviewOutcome).toBe("PASS");

    // Bold FAIL
    const boldFail = parseReviewOutput("**FAIL**\n- severity: high\n  file: src/api.ts\n  issue: Broken endpoint");
    expect(boldFail.reviewOutcome).toBe("FAIL");
    expect(boldFail.findings).toHaveLength(1);

    // Labeled Verdict: FAIL
    const verdictFail = parseReviewOutput("Verdict: FAIL\nFound critical security bug in auth flow.");
    expect(verdictFail.reviewOutcome).toBe("FAIL");
  });

  it("should fail closed for contradictory verdicts or findings declared after PASS", () => {
    const passWithFinding = parseReviewOutput(
      "PASS\n- severity: high\n  file: src/auth.ts\n  issue: Authorization bypass"
    );
    expect(passWithFinding.reviewOutcome).toBe("FAIL");
    expect(passWithFinding.summary).toContain("Review FAILED");

    const contradictory = parseReviewOutput(
      "Status: PASS\nInitial checks passed.\nFAIL\n- severity: critical\n  file: src/db.ts\n  issue: Data loss"
    );
    expect(contradictory.reviewOutcome).toBe("FAIL");
  });
});
