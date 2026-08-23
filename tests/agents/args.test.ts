import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { CodexAdapter, parseCodexJsonLines } from "../../src/agents/codex.js";
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
});
