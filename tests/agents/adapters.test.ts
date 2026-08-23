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

  it("rejects an explicitly unsupported transport without falling back", async () => {
    process.env.GROK_BIN = "non_existent_binary_transport_probe";
    const result = await new GrokAdapter().run({ task: "Probe transport", mode: "mcp" });

    expect(result).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
    expect(result.error).toContain("MCP mode is not supported");
    expect(result.transportUsed).toBeUndefined();
    expect(result.output).not.toContain("ENOENT");

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

  it("rejects reviewer extra arguments before invoking the CLI", async () => {
    let invoked = false;
    class ProtectedReviewerAdapter extends BaseAdapter {
      readonly name = "codex" as const;
      readonly displayName = "Protected Reviewer";
      readonly supportedModes = ["cli"] as const;
      readonly sandboxMechanism = "native-sandbox" as const;
      readonly envBinOverride = "TEST_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli() {
        invoked = true;
        return this.formatSuccessResult("PASS", Date.now(), { role: "reviewer" });
      }
    }

    const result = await new ProtectedReviewerAdapter().run({
      task: "Review",
      role: "reviewer",
      extraArgs: ["--dangerously-disable-sandbox"],
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Additional CLI arguments are not allowed");
    expect(invoked).toBe(false);
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

  it("derives summaries from the normalized final answer", async () => {
    class FinalAnswerAdapter extends BaseAdapter {
      readonly name = "codex" as const;
      readonly displayName = "Mock Codex";
      readonly supportedModes = ["cli"] as const;
      readonly sandboxMechanism = "prompt-only" as const;
      readonly envBinOverride = "TEST_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli() {
        return this.formatSuccessResult("Reading additional input from stdin...", Date.now(), {
          finalAnswer: "Implemented the requested cache safely.",
        });
      }
    }

    const result = await new FinalAnswerAdapter().run({ task: "Implement cache" });
    expect(result.summary).toBe("Implemented the requested cache safely.");
  });
});
