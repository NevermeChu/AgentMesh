import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CodexAdapter,
  CodexSecurityViolationError,
  parseCodexJsonLines,
  buildCodexMcpToolCall,
  parseStructuredReviewVerdict,
} from "../../src/agents/codex.js";
import {
  ClaudeAdapter,
  findClaudeSessionId,
  parseClaudeJsonOutput,
} from "../../src/agents/claude.js";
import {
  AntigravityAdapter,
  findWinGetAntigravityBinary,
  parseAntigravityJsonOutput,
} from "../../src/agents/antigravity.js";
import { OpenCodeAdapter, parseOpenCodeJsonLines } from "../../src/agents/opencode.js";

describe("agents/args construction", () => {
  it("maps model and reasoning settings to Codex CLI without leaking them into MCP", () => {
    const adapter = new CodexAdapter();
    const args = adapter.buildCliArgs({
      task: "work",
      role: "worker",
      model: "o3",
      reasoningEffort: "high",
    });
    expect(args).toContain("--model");
    expect(args).toContain("o3");
    expect(args).toContain("model_reasoning_effort=high");
    const mcp = buildCodexMcpToolCall(
      { task: "work", role: "worker", model: "o3", reasoningEffort: "high" },
      "work",
    );
    expect(mcp.toolArguments).toEqual({ prompt: "work", sandbox: "workspace-write" });
  });

  it("maps model settings to Antigravity and OpenCode CLI", () => {
    expect(new AntigravityAdapter().buildCliArgs({ task: "work", model: "gemini-pro" })).toContain(
      "gemini-pro",
    );
    expect(new OpenCodeAdapter().buildCliArgs({ task: "work", model: "provider/model" })).toContain(
      "provider/model",
    );
  });

  it("resolves Antigravity binary overrides in precedence order", async () => {
    process.env.GEMINI_BIN = "gemini-pro-cli";
    const adapter = new AntigravityAdapter();
    const binPath = await adapter.getExecutablePath();
    expect(binPath).toBe("gemini-pro-cli");
    delete process.env.GEMINI_BIN;

    process.env.AGY_BIN = "agy-custom";
    const binPath2 = await adapter.getExecutablePath();
    expect(binPath2).toBe("agy-custom");
    delete process.env.AGY_BIN;
  });

  it("discovers Antigravity in the WinGet package directory", () => {
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-winget-"));
    try {
      const packageDir = path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Packages",
        "Google.AntigravityCLI_Microsoft.Winget.Source_test",
      );
      fs.mkdirSync(packageDir, { recursive: true });
      const binary = path.join(packageDir, "agy.exe");
      fs.writeFileSync(binary, "test");
      expect(findWinGetAntigravityBinary(localAppData)).toBe(binary);
    } finally {
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it("enforces Codex reviewer arguments and excludes worker session flags", () => {
    const adapter = new CodexAdapter();

    const reviewerArgs = adapter.buildCliArgs({
      task: "Review PR #99",
      role: "reviewer",
      baseCommit: "main",
      nativeSessionId: "thread_abc123",
    });

    expect(reviewerArgs[0]).toBe("review");
    expect(reviewerArgs).toContain("--base");
    expect(reviewerArgs).toContain("main");
    expect(reviewerArgs).not.toContain("--session");
    expect(reviewerArgs).not.toContain("thread_abc123");
    expect(reviewerArgs).toContain('sandbox_mode="read-only"');
    // Security baseline (T3.1) + official extraction/contract channels (T1.5).
    expect(reviewerArgs).toContain("--strict-config");
    expect(reviewerArgs).toContain('approval_policy="never"');
    expect(reviewerArgs).toContain("sandbox_workspace_write.network_access=false");
    expect(reviewerArgs).toContain("--output-schema");
    expect(reviewerArgs).toContain("--output-last-message");

    const uncommittedArgs = adapter.buildCliArgs({
      task: "Review uncommitted",
      role: "reviewer",
    });
    expect(uncommittedArgs[0]).toBe("review");
    expect(uncommittedArgs).toContain("--uncommitted");
    expect(uncommittedArgs).not.toContain("--session");
  });

  it("enforces Codex worker sandbox and native resume arguments", () => {
    const adapter = new CodexAdapter();

    const workerArgs = adapter.buildCliArgs({
      task: "Implement feature",
      role: "worker",
    });
    expect(workerArgs[0]).toBe("exec");
    expect(workerArgs).not.toContain("resume");
    expect(workerArgs).toContain("--json");
    expect(workerArgs).toContain('sandbox_mode="workspace-write"');
    // Security baseline locks land after caller args so they win last-wins.
    expect(workerArgs).toContain("--strict-config");
    expect(workerArgs).toContain('approval_policy="never"');
    expect(workerArgs).toContain("sandbox_workspace_write.network_access=false");
    // Official final-answer extraction channel (T1.5).
    expect(workerArgs).toContain("--output-last-message");
    expect(
      workerArgs.findIndex((argument) => argument.startsWith("approval_policy")),
    ).toBeGreaterThan(workerArgs.indexOf("--json"));

    const resumeArgs = adapter.buildCliArgs({
      task: "Fix review comments",
      role: "worker",
      nativeSessionId: "native_thread_xyz",
    });
    expect(resumeArgs[0]).toBe("exec");
    expect(resumeArgs[1]).toBe("resume");
    expect(resumeArgs[2]).toBe("native_thread_xyz");
    expect(resumeArgs).not.toContain("--resume");
    expect(resumeArgs).toContain("--json");
    expect(resumeArgs).toContain('sandbox_mode="workspace-write"');
    expect(resumeArgs).toContain("--output-last-message");
  });

  it("physically rejects bypass flags before any codex spawn", () => {
    const adapter = new CodexAdapter();
    for (const forbidden of [
      ["--yolo"],
      ["--dangerously-bypass-approvals-and-sandbox"],
      ["-c", 'sandbox_mode="danger-full-access"'],
    ]) {
      try {
        adapter.buildCliArgs({ task: "Escape sandbox", role: "worker", extraArgs: [...forbidden] });
        throw new Error(`expected violation for ${forbidden.join(" ")}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CodexSecurityViolationError);
        expect((error as CodexSecurityViolationError).message).toContain(forbidden.at(-1) ?? "");
      }
    }
  });

  it("extracts thread-cumulative usage from turn.completed events", () => {
    const parsed = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-usage-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done." },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 120,
            cached_input_tokens: 40,
            cache_write_input_tokens: 8,
            output_tokens: 55,
            reasoning_output_tokens: 17,
          },
        }),
      ].join("\n"),
    );
    expect(parsed.sessionId).toBe("thread-usage-1");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 8,
      outputTokens: 55,
      reasoningOutputTokens: 17,
      totalTokens: undefined,
    });
    expect(parseCodexJsonLines("no json at all").usage).toBeUndefined();
  });

  it("parses the structured reviewer verdict contract", () => {
    const pass = parseStructuredReviewVerdict(JSON.stringify({ verdict: "PASS", findings: [] }));
    expect(pass).toEqual({ outcome: "PASS", findings: [] });

    const fail = parseStructuredReviewVerdict(
      JSON.stringify({
        verdict: "FAIL",
        findings: [
          {
            severity: "high",
            file: "src/auth.ts",
            line: 42,
            issue: "SQL injection",
            suggestion: "Parameterize the query",
          },
        ],
      }),
    );
    expect(fail?.outcome).toBe("FAIL");
    expect(fail?.findings).toHaveLength(1);
    expect(fail?.findings[0]).toMatchObject({ file: "src/auth.ts", issue: "SQL injection" });

    expect(parseStructuredReviewVerdict("PASS\nAll good.")).toBeUndefined();
    expect(parseStructuredReviewVerdict('{"verdict":"MAYBE"}')).toBeUndefined();
    expect(parseStructuredReviewVerdict(undefined)).toBeUndefined();
  });

  it("separates Claude reviewer tools from worker permissions", () => {
    const adapter = new ClaudeAdapter();

    const reviewerArgs = adapter.buildCliArgs({
      task: "Review auth changes",
      role: "reviewer",
    });
    expect(reviewerArgs).toContain("-p");
    expect(reviewerArgs).toContain("--tools");
    expect(reviewerArgs).toContain("Read,Grep,Glob,LS,NotebookRead,View");
    expect(reviewerArgs.join(" ")).not.toContain("Bash");
    expect(reviewerArgs).not.toContain("--dangerously-skip-permissions");
    expect(reviewerArgs).toContain("--output-format");
    expect(reviewerArgs).toContain("json");

    const workerArgs = adapter.buildCliArgs({
      task: "Build frontend",
      role: "worker",
      nativeSessionId: "claude_sess_777",
    });
    expect(workerArgs).toContain("-p");
    expect(workerArgs).toContain("--resume");
    expect(workerArgs).toContain("claude_sess_777");
    expect(workerArgs).toContain("--dangerously-skip-permissions");
  });

  it("enforces Antigravity reviewer mode and native resume arguments", () => {
    const adapter = new AntigravityAdapter();
    const args = adapter.buildCliArgs({
      task: "Review changes",
      role: "reviewer",
      nativeSessionId: "conversation-12345678",
    });

    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--conversation");
    expect(args).toContain("conversation-12345678");
    if (process.platform === "win32") expect(args).not.toContain("--sandbox");
    else expect(args).toContain("--sandbox");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("plan");
  });

  it("avoids OpenCode auto approval for reviewers", () => {
    const adapter = new OpenCodeAdapter();
    const reviewerArgs = adapter.buildCliArgs({
      task: "Review changes",
      role: "reviewer",
      nativeSessionId: "ses_12345678",
    });
    expect(reviewerArgs).toContain("--format");
    expect(reviewerArgs).toContain("json");
    expect(reviewerArgs).toContain("--session");
    expect(reviewerArgs).toContain("ses_12345678");
    expect(reviewerArgs).not.toContain("--auto");
    expect(reviewerArgs).toEqual(expect.arrayContaining(["--agent", "plan"]));

    expect(adapter.buildCliArgs({ task: "Implement", role: "worker" })).toContain("--auto");
  });

  it("parses Codex and Claude session results and transport errors", () => {
    const codex = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-12345678" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Implemented safely." },
        }),
      ].join("\n"),
    );
    expect(codex.sessionId).toBe("thread-12345678");
    expect(codex.output).toBe("Implemented safely.");

    const codexWithProgress = parseCodexJsonLines(
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Reading additional input from stdin..." },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Final implementation summary." },
        }),
      ].join("\n"),
    );
    expect(codexWithProgress.output).toBe("Final implementation summary.");

    const codexError = parseCodexJsonLines(
      JSON.stringify({ type: "error", message: "workspace write rejected" }),
    );
    expect(codexError.error).toBe("workspace write rejected");

    const claude = parseClaudeJsonOutput(
      JSON.stringify({ session_id: "claude-12345678", result: "Review complete." }),
    );
    expect(claude.sessionId).toBe("claude-12345678");
    expect(claude.output).toBe("Review complete.");

    expect(
      findClaudeSessionId({ content: [{ metadata: { session_id: "claude-mcp-87654321" } }] }),
    ).toBe("claude-mcp-87654321");
  });

  it("normalizes Antigravity and OpenCode final answers", () => {
    const antigravity = parseAntigravityJsonOutput(
      JSON.stringify({
        conversation_id: "agy-conversation-12345678",
        status: "SUCCESS",
        response: "Implemented safely.\n",
      }),
    );
    expect(antigravity.sessionId).toBe("agy-conversation-12345678");
    expect(antigravity.output).toBe("Implemented safely.");
    expect(antigravity.error).toBeUndefined();

    const opencode = parseOpenCodeJsonLines(
      [
        JSON.stringify({ type: "step_start", sessionID: "ses_opencode_12345678" }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_opencode_12345678",
          part: { type: "text", text: "Implemented safely." },
        }),
      ].join("\n"),
    );
    expect(opencode.sessionId).toBe("ses_opencode_12345678");
    expect(opencode.output).toBe("Implemented safely.");
  });

  it("exposes semantic errors from successful JSON transports", () => {
    const antigravity = parseAntigravityJsonOutput(
      JSON.stringify({
        status: "FAILED",
        message: "Model unavailable",
        response: "",
      }),
    );
    expect(antigravity.error).toBe("Model unavailable");

    const claude = parseClaudeJsonOutput(
      JSON.stringify({
        session_id: "claude-12345678",
        is_error: true,
        result: "unrecognized model",
      }),
    );
    expect(claude.error).toBe("unrecognized model");
  });

  it("maps runs onto the exact codex MCP tool schemas", () => {
    const worker = buildCodexMcpToolCall({ task: "T" }, "PROMPT");
    expect(worker).toEqual({
      toolName: "codex",
      toolArguments: { prompt: "PROMPT", sandbox: "workspace-write" },
    });

    const reviewer = buildCodexMcpToolCall(
      { task: "T", role: "reviewer", cwd: "D:/repo" },
      "PROMPT",
    );
    expect(reviewer).toEqual({
      toolName: "codex",
      toolArguments: { prompt: "PROMPT", cwd: "D:/repo", sandbox: "read-only" },
    });

    const resume = buildCodexMcpToolCall({ task: "T", nativeSessionId: "th_123" }, "PROMPT");
    expect(resume).toEqual({
      toolName: "codex-reply",
      toolArguments: { threadId: "th_123", prompt: "PROMPT" },
    });
  });

  it("rejects Claude MCP mode because the vendor server has no one-shot task tool", async () => {
    const result = await new ClaudeAdapter().run({ task: "Probe transport", mode: "mcp" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("MCP mode is not supported by Anthropic Claude Code");
    expect(new ClaudeAdapter().supportedModes).toEqual(["cli"]);
  });
});
