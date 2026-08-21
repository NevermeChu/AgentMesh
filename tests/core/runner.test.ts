import { describe, it, expect, beforeEach } from "vitest";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  TransportMode,
} from "../../src/agents/types.js";

// Mock adapter for deterministic testing
class MockAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Mock Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism = "prompt-only" as const;
  readonly envBinOverride = "MOCK_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public lastRunOptions?: RunAgentOptions;

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.lastRunOptions = options;
    if (options.task.includes("TRIGGER_ERROR")) {
      throw new Error("Simulated agent error");
    }
    return {
      status: "success",
      agent: this.name,
      summary: "Mock task executed successfully",
      output: `Executed: ${options.task} (role: ${options.role})`,
      nativeSessionId: options.nativeSessionId || "native_sess_999",
      exitCode: 0,
      durationMs: 15,
    };
  }
}

describe("core/runner", () => {
  let runner: MultiAgentRunner;
  let registry: AgentRegistry;
  let sessionManager: SessionManager;
  let mock: MockAdapter;

  beforeEach(() => {
    registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    mock = new MockAdapter();
    registry.register(mock);
    runner = new MultiAgentRunner(registry, sessionManager);
  });

  it("should handle unknown agent gracefully without crashing", async () => {
    const res = await runner.delegateTask({
      agent: "non_existent_agent",
      task: "Do something",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Unknown agent");
  });

  it("should delegate task, create session, and record history", async () => {
    const res = await runner.delegateTask({
      agent: "codex",
      task: "Implement login",
      role: "worker",
    });

    expect(res.status).toBe("success");
    expect(res.sessionId).toBeDefined();
    expect(res.nativeSessionId).toBe("native_sess_999");

    const session = runner.getSession(res.sessionId!);
    expect(session).toBeDefined();
    expect(session?.history.length).toBe(1);
    expect(session?.history[0]?.task).toBe("Implement login");
  });

  it("should perform reviewChanges and assign reviewer role", async () => {
    const res = await runner.reviewChanges({
      agent: "codex",
      task: "Review PR #12",
    });

    expect(res.status).toBe("success");
    expect(res.output).toContain("role: reviewer");
  });

  it("should handle continueTask, forward historyContext and nativeSessionId to adapter", async () => {
    const firstRes = await runner.delegateTask({
      agent: "codex",
      task: "Initial feature",
    });

    const contRes = await runner.continueTask({
      sessionId: firstRes.sessionId!,
      task: "Fix review comments",
    });

    expect(contRes.status).toBe("success");
    expect(contRes.sessionId).toBe(firstRes.sessionId);

    // Verify historyContext was generated and forwarded
    expect(mock.lastRunOptions).toBeDefined();
    expect(mock.lastRunOptions?.nativeSessionId).toBe("native_sess_999");
    expect(mock.lastRunOptions?.historyContext).toContain("Turn 1");
    expect(mock.lastRunOptions?.historyContext).toContain("Initial feature");

    const session = runner.getSession(firstRes.sessionId!);
    expect(session?.history.length).toBe(2);
  });

  it("should return failure when continuing non-existent session", async () => {
    const res = await runner.continueTask({
      sessionId: "invalid-session-id",
      task: "Next step",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("not found");
  });

  it("should return failure when delegating to non-existent session", async () => {
    const res = await runner.delegateTask({
      agent: "codex",
      task: "Next step",
      sessionId: "invalid-session-id-456",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Session 'invalid-session-id-456' not found");
  });

  it("should reject session transfer when agent mismatches", async () => {
    const createdSession = sessionManager.createSession({
      agent: "claude",
      cwd: process.cwd(),
      role: "worker",
    });

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Attempt cross-agent reuse",
      sessionId: createdSession.id,
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Session agent mismatch");
    expect(res.error).toContain("expected 'claude', got 'codex'");
  });

  it("should reject session transfer when cwd mismatches", async () => {
    const createdSession = sessionManager.createSession({
      agent: "codex",
      cwd: "D:/Project/FirstRepo",
      role: "worker",
    });

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Attempt cross-cwd reuse",
      cwd: "D:/Project/SecondRepo",
      sessionId: createdSession.id,
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Session cwd mismatch");
  });

  it("should reject session transfer when role mismatches", async () => {
    const createdSession = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Attempt cross-role reuse",
      role: "reviewer",
      sessionId: createdSession.id,
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Session role mismatch");
    expect(res.error).toContain("expected 'worker', got 'reviewer'");
  });

  it("should accept valid matching sessionId in delegateTask and update history", async () => {
    const createdSession = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
      nativeSessionId: "native_thread_initial",
    });

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Follow-up worker task",
      role: "worker",
      sessionId: createdSession.id,
    });

    expect(res.status).toBe("success");
    expect(res.sessionId).toBe(createdSession.id);
    expect(mock.lastRunOptions?.nativeSessionId).toBe("native_thread_initial");

    const session = sessionManager.getSession(createdSession.id);
    expect(session?.history.length).toBe(1);
    expect(session?.history[0]?.task).toBe("Follow-up worker task");
  });

  it("should inherit cwd and role from a reused session when omitted", async () => {
    const createdSession = sessionManager.createSession({
      agent: "codex",
      cwd: "D:/Project/BoundRepo",
      role: "reviewer",
    });

    await runner.delegateTask({
      agent: "codex",
      task: "Continue bound review",
      sessionId: createdSession.id,
    });

    expect(mock.lastRunOptions?.cwd).toBe("D:/Project/BoundRepo");
    expect(mock.lastRunOptions?.role).toBe("reviewer");
    expect(sessionManager.getSession(createdSession.id)?.history[0]?.role).toBe("reviewer");
  });

  it("should catch errors thrown by adapter and not crash", async () => {
    const res = await runner.delegateTask({
      agent: "codex",
      task: "TRIGGER_ERROR",
    });

    expect(res.status).toBe("failed");
    expect(res.error).toContain("Simulated agent error");
  });
});
