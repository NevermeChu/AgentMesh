import { describe, expect, it } from "vitest";
import {
  assertNoForbiddenCodexArgs,
  buildCodexSecurityBaselineArgs,
  CODEX_STRICT_CONFIG_FLAG,
  CodexSecurityViolationError,
  findForbiddenCodexArgs,
  withCodexHome,
} from "../../src/core/codexSecurity.js";

describe("core/codexSecurity", () => {
  it("assembles the explicit approval/network locks with strict-config", () => {
    expect(buildCodexSecurityBaselineArgs()).toEqual([
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "--strict-config",
    ]);
    expect(CODEX_STRICT_CONFIG_FLAG).toBe("--strict-config");
  });

  it("flags every bypass flag and danger-full-access sandbox value variant", () => {
    const forbidden = findForbiddenCodexArgs([
      "--yolo",
      "--YOLO",
      "--dangerously-bypass-approvals-and-sandbox",
      'sandbox_mode="danger-full-access"',
      "sandbox_mode=danger-full-access",
      "sandbox_mode = danger-full-access",
    ]);
    expect(forbidden).toHaveLength(6);
  });

  it("keeps benign overrides and model flags untouched", () => {
    expect(
      findForbiddenCodexArgs([
        "--model",
        "o3",
        "-c",
        'model_reasoning_effort="high"',
        "--add-dir",
        "D:/workspace",
        'sandbox_mode="workspace-write"',
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
      ]),
    ).toEqual([]);
  });

  it("throws a structured violation listing the rejected arguments", () => {
    try {
      assertNoForbiddenCodexArgs(["--json", "--yolo"]);
      throw new Error("expected CodexSecurityViolationError");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexSecurityViolationError);
      const violation = error as CodexSecurityViolationError;
      expect(violation.forbiddenArgs).toEqual(["--yolo"]);
      expect(violation.message).toContain("--yolo");
    }
  });

  it("accepts undefined or empty extra args without violation", () => {
    expect(() => assertNoForbiddenCodexArgs(undefined)).not.toThrow();
    expect(() => assertNoForbiddenCodexArgs([])).not.toThrow();
  });

  it("merges a dedicated CODEX_HOME without mutating the caller env", () => {
    const env: Record<string, string> = { PATH: "C:/bin", FAKE_CAPTURE: "1" };
    const merged = withCodexHome(env, "D:/governed-home");
    expect(merged.CODEX_HOME).toBe("D:/governed-home");
    expect(merged.PATH).toBe("C:/bin");
    expect(env.CODEX_HOME).toBeUndefined();

    expect(withCodexHome(undefined, "D:/governed-home")).toEqual({
      CODEX_HOME: "D:/governed-home",
    });
    expect(() => withCodexHome(env, "  ")).toThrow(/non-empty/);
  });
});
