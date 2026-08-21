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
import { GrokAdapter } from "../../src/agents/grok.js";
import {
  OpenCodeAdapter,
  parseOpenCodeJsonLines,
} from "../../src/agents/opencode.js";
import { ZCodeAdapter } from "../../src/agents/zcode.js";
import type { RunAgentOptions } from "../../src/agents/types.js";

// Subclass to expose runViaCli for argument inspection without executing external commands
class InspectableCodexAdapter extends CodexAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

class InspectableClaudeAdapter extends ClaudeAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

class InspectableAntigravityAdapter extends AntigravityAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

class InspectableGrokAdapter extends GrokAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

class InspectableOpenCodeAdapter extends OpenCodeAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

class InspectableZCodeAdapter extends ZCodeAdapter {
  public async testRunViaCli(options: RunAgentOptions) {
    return this.runViaCli(options);
  }
}

describe("agents/args construction", () => {
  it("should configure CodexAdapter binary and environment overrides", async () => {
    process.env.CODEX_BIN = "D:/custom/bin/codex.exe";
    const adapter = new InspectableCodexAdapter();
    const binPath = await adapter.getExecutablePath();
    expect(binPath).toBe("D:/custom/bin/codex.exe");
    delete process.env.CODEX_BIN;
  });

  it("should configure ClaudeAdapter binary and environment overrides", async () => {
    process.env.CLAUDE_BIN = "/usr/local/bin/claude";
    const adapter = new InspectableClaudeAdapter();
    const binPath = await adapter.getExecutablePath();
    expect(binPath).toBe("/usr/local/bin/claude");
    delete process.env.CLAUDE_BIN;
  });

  it("should configure AntigravityAdapter binary with GEMINI_BIN or AGY_BIN fallback", async () => {
    process.env.GEMINI_BIN = "gemini-pro-cli";
    const adapter = new InspectableAntigravityAdapter();
    const binPath = await adapter.getExecutablePath();
    expect(binPath).toBe("gemini-pro-cli");
    delete process.env.GEMINI_BIN;

    process.env.AGY_BIN = "agy-custom";
    const binPath2 = await adapter.getExecutablePath();
    expect(binPath2).toBe("agy-custom");
    delete process.env.AGY_BIN;
  });

  it("should discover Antigravity installed in the WinGet package directory", () => {
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-winget-"));
    try {
      const packageDir = path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Packages",
        "Google.AntigravityCLI_Microsoft.Winget.Source_test"
      );
      fs.mkdirSync(packageDir, { recursive: true });
      const binary = path.join(packageDir, "agy.exe");
      fs.writeFileSync(binary, "test");
      expect(findWinGetAntigravityBinary(localAppData)).toBe(binary);
    } finally {
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it("should configure GrokAdapter binary and environment overrides", async () => {
    process.env.GROK_BIN = "grok-build";
    const adapter = new InspectableGrokAdapter();
    const binPath = await adapter.getExecutablePath();
    expect(binPath).toBe("grok-build");
    delete process.env.GROK_BIN;
  });

  it("should configure OpenCodeAdapter and ZCodeAdapter environment overrides", async () => {
    process.env.OPENCODE_BIN = "opencode-nightly";
    const opencode = new InspectableOpenCodeAdapter();
    expect(await opencode.getExecutablePath()).toBe("opencode-nightly");
    delete process.env.OPENCODE_BIN;

    process.env.ZCODE_BIN = "zcode-enterprise";
    const zcode = new InspectableZCodeAdapter();
    expect(await zcode.getExecutablePath()).toBe("zcode-enterprise");
    delete process.env.ZCODE_BIN;
  });

  it("should generate correct Codex CLI args for Reviewer without invalid --session", () => {
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

  it("should generate correct Codex CLI args for Worker and Session Resume", () => {
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

  it("should generate correct Claude CLI args for Reviewer and Worker", () => {
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

  it("should generate structured Antigravity args with native resume and reviewer sandbox", () => {
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

  it("should generate structured OpenCode args and avoid auto approval for reviewers", () => {
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

    expect(adapter.buildCliArgs({ task: "Implement", role: "worker" })).toContain("--auto");
  });

  it("should parse native session IDs from structured Codex and Claude output", () => {
    const codex = parseCodexJsonLines(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-12345678" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Implemented safely." },
        }),
      ].join("\n")
    );
    expect(codex.sessionId).toBe("thread-12345678");
    expect(codex.output).toBe("Implemented safely.");

    const codexError = parseCodexJsonLines(
      JSON.stringify({ type: "error", message: "workspace write rejected" })
    );
    expect(codexError.error).toBe("workspace write rejected");

    const claude = parseClaudeJsonOutput(
      JSON.stringify({ session_id: "claude-12345678", result: "Review complete." })
    );
    expect(claude.sessionId).toBe("claude-12345678");
    expect(claude.output).toBe("Review complete.");

    expect(
      findClaudeSessionId({ content: [{ metadata: { session_id: "claude-mcp-87654321" } }] })
    ).toBe("claude-mcp-87654321");
  });

  it("should parse normalized Antigravity and OpenCode final answers", () => {
    const antigravity = parseAntigravityJsonOutput(JSON.stringify({
      conversation_id: "agy-conversation-12345678",
      status: "SUCCESS",
      response: "Implemented safely.\n",
    }));
    expect(antigravity.sessionId).toBe("agy-conversation-12345678");
    expect(antigravity.output).toBe("Implemented safely.");
    expect(antigravity.error).toBeUndefined();

    const opencode = parseOpenCodeJsonLines([
      JSON.stringify({ type: "step_start", sessionID: "ses_opencode_12345678" }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_opencode_12345678",
        part: { type: "text", text: "Implemented safely." },
      }),
    ].join("\n"));
    expect(opencode.sessionId).toBe("ses_opencode_12345678");
    expect(opencode.output).toBe("Implemented safely.");
  });

  it("should expose semantic errors from successful JSON transports", () => {
    const antigravity = parseAntigravityJsonOutput(JSON.stringify({
      status: "FAILED",
      message: "Model unavailable",
      response: "",
    }));
    expect(antigravity.error).toBe("Model unavailable");

    const claude = parseClaudeJsonOutput(JSON.stringify({
      session_id: "claude-12345678",
      is_error: true,
      result: "unrecognized model",
    }));
    expect(claude.error).toBe("unrecognized model");
  });
});
