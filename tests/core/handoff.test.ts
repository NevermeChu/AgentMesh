import { describe, expect, it } from "vitest";
import { parseHandoffReport } from "../../src/core/handoff.js";
import { estimateTokens, truncateTextToTokenBudget } from "../../src/core/text.js";

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
