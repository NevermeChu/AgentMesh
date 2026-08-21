import { describe, it, expect } from "vitest";
import { BaseAdapter } from "../../src/agents/base.js";
import { CodexAdapter } from "../../src/agents/codex.js";
import { ClaudeAdapter } from "../../src/agents/claude.js";
import { AntigravityAdapter } from "../../src/agents/antigravity.js";
import { GrokAdapter } from "../../src/agents/grok.js";
import { OpenCodeAdapter } from "../../src/agents/opencode.js";
import { ZCodeAdapter } from "../../src/agents/zcode.js";
import type { RunAgentOptions } from "../../src/agents/types.js";

describe("agents/adapters", () => {
  it("should instantiate CodexAdapter with correct defaults and native sandbox", async () => {
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe("codex");
    expect(adapter.displayName).toBe("OpenAI Codex");
    expect(adapter.supportedModes).toEqual(["mcp", "cli"]);
    expect(adapter.sandboxMechanism).toBe("native-sandbox");
    expect(adapter.envBinOverride).toBe("CODEX_BIN");
  });

  it("should instantiate ClaudeAdapter with correct defaults and tool filtering", async () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.name).toBe("claude");
    expect(adapter.displayName).toBe("Anthropic Claude Code");
    expect(adapter.supportedModes).toEqual(["mcp", "cli"]);
    expect(adapter.sandboxMechanism).toBe("tool-filtering");
    expect(adapter.envBinOverride).toBe("CLAUDE_BIN");
  });

  it("should instantiate AntigravityAdapter with prompt-only sandbox", async () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.name).toBe("antigravity");
    expect(adapter.displayName).toContain("Antigravity");
    expect(adapter.sandboxMechanism).toBe("prompt-only");
    expect(adapter.aliases).toContain("gemini");
    expect(adapter.aliases).toContain("agy");
  });

  it("should report available true in getExecutableInfo when GEMINI_BIN or AGY_BIN is set", async () => {
    process.env.GEMINI_BIN = "node";
    const adapter = new AntigravityAdapter();
    const info = await adapter.getExecutableInfo();
    const isAvail = await adapter.isAvailable();
    const execPath = await adapter.getExecutablePath();

    expect(info.available).toBe(true);
    expect(isAvail).toBe(true);
    expect(info.path).toBeDefined();
    expect(execPath).toBeDefined();

    delete process.env.GEMINI_BIN;

    process.env.AGY_BIN = "node";
    const adapter2 = new AntigravityAdapter();
    const info2 = await adapter2.getExecutableInfo();
    expect(info2.available).toBe(true);
    expect(await adapter2.isAvailable()).toBe(true);

    delete process.env.AGY_BIN;
  });

  it("should instantiate GrokAdapter with prompt-only sandbox", async () => {
    const adapter = new GrokAdapter();
    expect(adapter.name).toBe("grok");
    expect(adapter.displayName).toContain("Grok");
    expect(adapter.sandboxMechanism).toBe("prompt-only");
  });

  it("should instantiate OpenCodeAdapter and ZCodeAdapter with prompt-only sandbox", async () => {
    const opencode = new OpenCodeAdapter();
    expect(opencode.name).toBe("opencode");
    expect(opencode.sandboxMechanism).toBe("prompt-only");

    const zcode = new ZCodeAdapter();
    expect(zcode.name).toBe("zcode");
    expect(zcode.sandboxMechanism).toBe("prompt-only");
  });

  it("should report sandbox mechanism and notes in getExecutableInfo", async () => {
    const grok = new GrokAdapter();
    const info = await grok.getExecutableInfo();
    expect(info.sandboxMechanism).toBe("prompt-only");

    const codex = new CodexAdapter();
    const codexInfo = await codex.getExecutableInfo();
    expect(codexInfo.sandboxMechanism).toBe("native-sandbox");
  });

  it("should return failure when executing missing binary instead of throwing uncaught", async () => {
    process.env.GROK_BIN = "non_existent_binary_test_999";
    const grok = new GrokAdapter();

    const res = await grok.run({
      task: "Test task",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toBeDefined();

    delete process.env.GROK_BIN;
  });

  it("should handle continue with historyContext and nativeSessionId gracefully", async () => {
    process.env.CODEX_BIN = "non_existent_codex_bin_123";
    const codex = new CodexAdapter();

    const res = await codex.continue?.({
      sessionId: "bridge-sess_12345",
      nativeSessionId: "native_sess_abc",
      task: "Fix review finding",
      historyContext: "Turn 1: Implemented feature",
    });

    expect(res).toBeDefined();
    expect(res?.status).toBe("failed");
    expect(res?.agent).toBe("codex");

    delete process.env.CODEX_BIN;
  });

  it("should not pollute worker task status when output contains FAIL keyword", async () => {
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
          }
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

  it("should parse reviewOutcome and set failed status when role is reviewer and output is FAIL", async () => {
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
          }
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

  it("should fail closed when reviewer output has no PASS or FAIL decision", async () => {
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
