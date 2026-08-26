import { describe, it, expect } from "vitest";
import {
  ARG_REJECTED,
  ALLOWED_EXTRA_ARGS,
  DANGEROUS_ARG_MARKERS,
  describeArgRejections,
  isDangerousArg,
  validateExtraArgs,
} from "../../src/core/argPolicy.js";

describe("core/argPolicy", () => {
  it("centralizes the ARG_REJECTED code placeholder for the window① contract", () => {
    expect(ARG_REJECTED).toBe("ARG_REJECTED");
    const { rejections } = validateExtraArgs("grok", ["--bogus"]);
    expect(rejections[0]?.code).toBe(ARG_REJECTED);
  });

  it("flags dangerous tokens by case-insensitive substring match", () => {
    expect(isDangerousArg("--yolo")).toBeDefined();
    expect(isDangerousArg("--YOLO")).toBeDefined();
    expect(isDangerousArg("--dangerously-bypass-approvals-and-sandbox")).toBeDefined();
    expect(isDangerousArg('-c sandbox_mode="danger-full-access"')).toBeDefined();
    expect(isDangerousArg("--settings /tmp/evil.json")).toBeDefined();
    expect(isDangerousArg("--mcp-config evil.json")).toBeDefined();
    expect(isDangerousArg("--model")).toBeUndefined();

    for (const marker of ["--yolo", "dangerously-skip-permissions", "danger-full-access"]) {
      expect(DANGEROUS_ARG_MARKERS).toContain(marker);
    }
  });

  it("accepts whitelisted flags with their values per adapter", () => {
    expect(validateExtraArgs("claude", ["--model", "claude-sonnet-4"]).accepted).toEqual([
      "--model",
      "claude-sonnet-4",
    ]);
    expect(validateExtraArgs("grok", ["--model", "grok-4"]).rejections).toEqual([]);
    expect(validateExtraArgs("zcode", ["--model", "glm-5"]).rejections).toEqual([]);
    expect(validateExtraArgs("opencode", ["--model", "provider/model"]).rejections).toEqual([]);
    expect(validateExtraArgs("antigravity", ["--model", "gemini-pro"]).rejections).toEqual([]);
  });

  it("keeps the codex placeholder table restricted to plan T3.3 entries", () => {
    expect(
      validateExtraArgs("codex", [
        "--model",
        "o3",
        "-c",
        'model_reasoning_effort="high"',
        "--add-dir",
        "D:/extra",
      ]).rejections,
    ).toEqual([]);

    const sandboxAttempt = validateExtraArgs("codex", ["-c", 'sandbox_mode="danger-full-access"']);
    // danger-full-access is caught as a dangerous marker before table lookup.
    expect(sandboxAttempt.rejections[0]?.reason).toBe("dangerous-flag");

    const configAttempt = validateExtraArgs("codex", ["-c", 'approval_policy="on-request"']);
    expect(configAttempt.accepted).toEqual([]);
    expect(configAttempt.rejections[0]?.reason).toBe("value-not-allowed");
  });

  it("rejects unknown flags with structured not-in-allowlist reasons", () => {
    const verdict = validateExtraArgs("claude", ["--model", "x", "--allowedTools", "Bash(*)"]);
    expect(verdict.accepted).toEqual(["--model", "x"]);
    expect(verdict.rejections).toHaveLength(2);
    expect(verdict.rejections[0]).toMatchObject({
      code: "ARG_REJECTED",
      agent: "claude",
      arg: "--allowedTools",
      reason: "not-in-allowlist",
    });
    expect(verdict.rejections[1]).toMatchObject({ arg: "Bash(*)", reason: "not-in-allowlist" });
  });

  it("catches privilege-escalation flags before allowlist lookup", () => {
    const verdict = validateExtraArgs("opencode", ["--yolo", "--share"]);
    expect(verdict.rejections[0]).toMatchObject({
      reason: "dangerous-flag",
      matchedMarker: "--yolo",
    });
    expect(verdict.rejections[1]?.reason).toBe("not-in-allowlist");
  });

  it("rejects flags whose value is missing or looks like another flag", () => {
    const missing = validateExtraArgs("zcode", ["--model"]);
    expect(missing.rejections[0]?.reason).toBe("missing-value");
    expect(missing.accepted).toEqual([]);

    const flagAsValue = validateExtraArgs("claude", ["--model", "--resume", "abc"]);
    expect(flagAsValue.rejections[0]?.reason).toBe("value-not-allowed");
    // The suspicious value must never reach the vendor argv, even if a later
    // token would independently pass validation.
    expect(flagAsValue.accepted).toEqual([]);
  });

  it("rejects empty tokens (S9 boundary variants)", () => {
    const verdict = validateExtraArgs("antigravity", ["", "--model", "gemini-pro"]);
    expect(verdict.rejections[0]?.reason).toBe("empty-token");
    expect(verdict.accepted).toEqual(["--model", "gemini-pro"]);
  });

  it("treats flags case-sensitively so --MODEL cannot impersonate --model", () => {
    const verdict = validateExtraArgs("claude", ["--MODEL", "x"]);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejections[0]?.reason).toBe("not-in-allowlist");
  });

  it("fails closed for agents without an allowlist entry", () => {
    const verdict = validateExtraArgs("gemini", ["--anything"]);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejections[0]?.reason).toBe("not-in-allowlist");
    expect(validateExtraArgs("grok").rejections).toEqual([]);
    expect(validateExtraArgs("grok", []).accepted).toEqual([]);
  });

  it("describes rejections readably without values or secrets", () => {
    const text = describeArgRejections([
      {
        code: ARG_REJECTED,
        agent: "grok",
        arg: "--yolo",
        reason: "dangerous-flag",
        matchedMarker: "--yolo",
      },
      { code: ARG_REJECTED, agent: "grok", arg: "--foo", reason: "not-in-allowlist" },
    ]);
    expect(text).toContain("--yolo (dangerous-flag: --yolo)");
    expect(text).toContain("--foo (not-in-allowlist)");
  });

  it("declares an entry for every executable adapter channel", () => {
    for (const agent of ["codex", "claude", "grok", "zcode", "opencode", "antigravity"] as const) {
      expect(ALLOWED_EXTRA_ARGS[agent]?.length).toBeGreaterThan(0);
    }
  });
});
