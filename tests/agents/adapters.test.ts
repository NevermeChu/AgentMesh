import { describe, it, expect } from "vitest";
import { BaseAdapter } from "../../src/agents/base.js";
import { AntigravityAdapter } from "../../src/agents/antigravity.js";
import { GrokAdapter } from "../../src/agents/grok.js";
import type { RunAgentOptions } from "../../src/agents/types.js";

describe("agents/adapters", () => {
  it("reports the effective Antigravity reviewer sandbox for this platform", () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.name).toBe("antigravity");
    expect(adapter.displayName).toContain("Antigravity");
    expect(adapter.sandboxMechanism).toBe(
      process.platform === "win32" ? "prompt-only" : "native-sandbox",
    );
    expect(adapter.aliases).toContain("gemini");
    expect(adapter.aliases).toContain("agy");
  });

  it("returns a structured failure for a missing binary", async () => {
    process.env.GROK_BIN = "non_existent_binary_test_999";
    const grok = new GrokAdapter();

    const res = await grok.run({
      task: "Test task",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toBeDefined();

    delete process.env.GROK_BIN;
  });

  it("does not interpret worker test failures as a reviewer verdict", async () => {
    class MockWorkerAdapter extends BaseAdapter {
      readonly name = "codex" as const;
      readonly displayName = "Mock Codex";
      readonly supportedModes = ["cli"] as const;
      readonly sandboxMechanism = "prompt-only" as const;
      readonly envBinOverride = "TEST_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli(options: RunAgentOptions) {
        return this.formatSuccessResult(
          "Running test suite...\nFAIL: test_auth_login failed on assertion\nTotal: 1 failed, 10 passed",
          Date.now(),
          {
            role: options.role,
            exitCode: 0,
          },
        );
      }
    }

    const adapter = new MockWorkerAdapter();
    const result = await adapter.run({
      task: "Run tests",
      role: "worker",
    });

    expect(result.status).toBe("success");
    expect(result.reviewOutcome).toBeUndefined();
    expect(result.findings).toBeUndefined();
    expect(result.summary).not.toContain("Review FAILED");
    expect(result.output).toContain("FAIL: test_auth_login");
  });

  it("propagates structured reviewer findings as failure", async () => {
    class MockReviewerAdapter extends BaseAdapter {
      readonly name = "codex" as const;
      readonly displayName = "Mock Codex";
      readonly supportedModes = ["cli"] as const;
      readonly sandboxMechanism = "prompt-only" as const;
      readonly envBinOverride = "TEST_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli(options: RunAgentOptions) {
        return this.formatSuccessResult(
          "FAIL\n- severity: high\n  file: src/auth.ts\n  line: 42\n  issue: SQL Injection\n  suggestion: Use parameterized query",
          Date.now(),
          {
            role: options.role,
            exitCode: 0,
          },
        );
      }
    }

    const adapter = new MockReviewerAdapter();
    const result = await adapter.run({
      task: "Review changes",
      role: "reviewer",
    });

    expect(result.status).toBe("failed");
    expect(result.reviewOutcome).toBe("FAIL");
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.severity).toBe("high");
    expect(result.summary).toContain("Review FAILED");
  });

  it("fails closed when reviewer output has no verdict", async () => {
    class UnknownReviewerAdapter extends BaseAdapter {
      readonly name = "codex" as const;
      readonly displayName = "Mock Codex";
      readonly supportedModes = ["cli"] as const;
      readonly sandboxMechanism = "prompt-only" as const;
      readonly envBinOverride = "TEST_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli() {
        return this.formatSuccessResult("Review completed without a verdict.", Date.now(), {
          role: "reviewer",
          exitCode: 0,
        });
      }
    }

    const result = await new UnknownReviewerAdapter().run({
      task: "Review changes",
      role: "reviewer",
    });
    expect(result.status).toBe("failed");
    expect(result.reviewOutcome).toBe("UNKNOWN");
  });
});
