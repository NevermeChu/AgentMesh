import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach } from "vitest";
import { MultiAgentRunner, DEFAULT_RUN_TIMEOUT_MS } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

// Mock adapter for deterministic testing
class MockAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Mock Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
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
      finalAnswer: `Final: ${options.task}`,
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

  it("returns a structured error for an unknown agent", async () => {
    const res = await runner.delegateTask({
      agent: "non_existent_agent",
      task: "Do something",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Unknown agent");
  });

  it("creates and continues a native-backed Bridge session", async () => {
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
    expect(firstRes.nativeSessionId).toBe("native_sess_999");

    // Native resume avoids redundantly injecting the Bridge transcript.
    expect(mock.lastRunOptions).toBeDefined();
    expect(mock.lastRunOptions?.nativeSessionId).toBe("native_sess_999");
    expect(mock.lastRunOptions?.historyContext).toBeUndefined();

    const session = runner.getSession(firstRes.sessionId!);
    expect(session?.history.length).toBe(2);
  });

  it("returns failure when continuing a missing session", async () => {
    const res = await runner.continueTask({
      sessionId: "invalid-session-id",
      task: "Next step",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("not found");
  });

  it("returns failure when delegating to a missing session", async () => {
    const res = await runner.delegateTask({
      agent: "codex",
      task: "Next step",
      sessionId: "invalid-session-id-456",
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Session 'invalid-session-id-456' not found");
  });

  it("rejects session transfer when agent mismatches", async () => {
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

  it("rejects session transfer when cwd mismatches", async () => {
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

  it("rejects session transfer when role mismatches", async () => {
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

  it("accepts a matching session binding and records history", async () => {
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

  it("inherits cwd and role from a reused session", async () => {
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

  it("shares normalized context without transferring native sessions", async () => {
    class MockClaudeAdapter extends MockAdapter {
      override readonly name: AgentName = "claude";
    }
    const claude = new MockClaudeAdapter();
    registry.register(claude);

    const workerResult = await runner.delegateTask({
      agent: "codex",
      task: "Inspect authentication flow",
      cwd: process.cwd(),
    });
    const receiverResult = await runner.delegateTask({
      agent: "claude",
      task: "Use prior evidence and review the result",
      cwd: process.cwd(),
      contextSessionId: workerResult.sessionId,
    });

    expect(receiverResult.status).toBe("success");
    expect(claude.lastRunOptions?.nativeSessionId).toBeUndefined();
    expect(claude.lastRunOptions?.historyContext).toContain("Shared Context");
    expect(claude.lastRunOptions?.historyContext).toContain("Inspect authentication flow");
    expect(claude.lastRunOptions?.historyContext).toContain("Final: Inspect authentication flow");
  });

  it("reports best-effort Reviewer protection without blocking prompt-only agents", async () => {
    const result = await runner.delegateTask({
      agent: "codex",
      task: "Review current changes",
      role: "reviewer",
      cwd: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(result.reviewerSafety).toMatchObject({
      requested: "best-effort",
      mechanism: "prompt-only",
      enforced: false,
      workspaceChanged: false,
    });
    expect(result.reviewerSafety?.warning).toContain("prompt-level constraints");
    expect(runner.getSession(result.sessionId!)?.history[0]?.reviewerSafety).toEqual(
      result.reviewerSafety,
    );
  });

  it("rejects prompt-only Reviewers when project safety is enforced", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-safety-policy-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".git"));
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({
          version: 1,
          roles: { reviewer: { agent: "codex", safety: "enforced" } },
        }),
      );

      const result = await runner.reviewChanges({ cwd: projectRoot });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("rejects prompt-only protection");
      expect(result.reviewerSafety).toMatchObject({
        requested: "enforced",
        mechanism: "prompt-only",
        enforced: false,
      });
      expect(runner.listSessions()).toHaveLength(0);

      class NativeReviewerAdapter extends MockAdapter {
        override readonly sandboxMechanism = "native-sandbox" as const;
      }
      registry.register(new NativeReviewerAdapter());
      const allowed = await runner.reviewChanges({ cwd: projectRoot });
      expect(allowed.status).toBe("success");
      expect(allowed.reviewerSafety).toMatchObject({
        requested: "enforced",
        mechanism: "native-sandbox",
        enforced: true,
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails a Review when the working tree changes during execution", async () => {
    class MutatingReviewerAdapter extends MockAdapter {
      override readonly name: AgentName = "claude";

      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        if (!options.cwd) throw new Error("Test Reviewer requires cwd");
        fs.appendFileSync(path.join(options.cwd, "feature.ts"), "export const changed = true;\n");
        return super.runViaCli(options);
      }
    }
    const mutatingReviewer = new MutatingReviewerAdapter();
    registry.register(mutatingReviewer);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-review-write-"));

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
      fs.writeFileSync(path.join(projectRoot, "feature.ts"), "export const value = 1;\n");
      fs.writeFileSync(path.join(projectRoot, "other.ts"), "export const other = 1;\n");
      execFileSync("git", ["add", "feature.ts", "other.ts"], { cwd: projectRoot });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=AgentMesh Test",
          "-c",
          "user.email=agentmesh@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "initial",
        ],
        { cwd: projectRoot },
      );
      fs.appendFileSync(path.join(projectRoot, "other.ts"), "// pre-existing user change\n");

      const result = await runner.reviewChanges({
        agent: "claude",
        cwd: projectRoot,
        task: "Review without editing",
      });

      expect(result.status).toBe("failed");
      expect(result.reviewOutcome).toBe("FAIL");
      expect(result.error).toContain("working tree changed");
      expect(result.reviewerSafety).toMatchObject({
        workspaceChanged: true,
        changedPaths: ["feature.ts"],
      });
      expect(result.findings?.at(-1)?.file).toBe("feature.ts");
      expect(fs.readFileSync(path.join(projectRoot, "feature.ts"), "utf8")).toContain("changed");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("marks shared context stale when the repository fingerprint changes", async () => {
    class MockClaudeAdapter extends MockAdapter {
      override readonly name: AgentName = "claude";
    }
    const claude = new MockClaudeAdapter();
    registry.register(claude);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-evidence-"));

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
      fs.writeFileSync(path.join(projectRoot, "feature.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "feature.ts"], { cwd: projectRoot });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=AgentMesh Test",
          "-c",
          "user.email=agentmesh@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "initial",
        ],
        { cwd: projectRoot },
      );

      const source = await runner.delegateTask({
        agent: "codex",
        task: "Inspect feature",
        cwd: projectRoot,
      });
      await runner.delegateTask({
        agent: "claude",
        task: "Review unchanged evidence",
        cwd: projectRoot,
        contextSessionId: source.sessionId,
      });
      expect(claude.lastRunOptions?.historyContext).toContain("Context freshness: MATCHED");
      expect(claude.lastRunOptions?.historyContext).toContain("Execution evidence: transport=cli");

      fs.writeFileSync(path.join(projectRoot, "feature.ts"), "export const value = 2;\n");
      await runner.delegateTask({
        agent: "claude",
        task: "Review changed evidence",
        cwd: projectRoot,
        contextSessionId: source.sessionId,
      });
      expect(claude.lastRunOptions?.historyContext).toContain("Context freshness: STALE");
      expect(claude.lastRunOptions?.historyContext).toContain("feature.ts");

      const stored = runner.getSession(source.sessionId!);
      expect(stored?.history[0]?.evidence?.repositoryAfter?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("maps multiple roles to one agent with isolated sessions", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-role-map-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".git"));
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({
          version: 1,
          roles: {
            orchestrator: "codex",
            worker: "codex",
            reviewer: { agent: "codex", mode: "cli", timeoutMs: 4321 },
            tester: "codex",
          },
        }),
      );

      const worker = await runner.delegateTask({
        task: "Implement",
        cwd: projectRoot,
        role: "worker",
      });
      const reviewer = await runner.delegateTask({
        task: "Review",
        cwd: projectRoot,
        role: "reviewer",
      });
      expect(mock.lastRunOptions?.mode).toBe("cli");
      expect(mock.lastRunOptions?.timeoutMs).toBe(4321);
      const tester = await runner.delegateTask({ task: "Test", cwd: projectRoot, role: "tester" });

      expect([worker.agent, reviewer.agent, tester.agent]).toEqual(["codex", "codex", "codex"]);
      expect(new Set([worker.sessionId, reviewer.sessionId, tester.sessionId]).size).toBe(3);
      expect(runner.getSession(worker.sessionId!)?.role).toBe("worker");
      expect(runner.getSession(reviewer.sessionId!)?.role).toBe("reviewer");
      expect(runner.getSession(reviewer.sessionId!)?.metadata?.reviewerSafetyPolicy).toBe(
        "best-effort",
      );
      expect(runner.getSession(tester.sessionId!)?.role).toBe("tester");
      expect(runner.getSession(worker.sessionId!)?.metadata?.orchestratorAgent).toBe("codex");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("lets an explicit agent override the project role assignment", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-role-override-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".git"));
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({ version: 1, roles: { worker: "claude" } }),
      );
      const result = await runner.delegateTask({
        agent: "codex",
        task: "Use explicit override",
        cwd: projectRoot,
      });
      expect(result.status).toBe("success");
      expect(result.agent).toBe("codex");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects shared context from a different working directory", async () => {
    const source = sessionManager.createSession({
      agent: "codex",
      cwd: "D:/Project/FirstRepo",
      role: "worker",
    });
    const result = await runner.delegateTask({
      agent: "codex",
      task: "Reuse stale context",
      cwd: "D:/Project/SecondRepo",
      contextSessionId: source.id,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Context session cwd mismatch");
    expect(runner.listSessions()).toHaveLength(1);
  });

  it("normalizes errors thrown by an adapter", async () => {
    const res = await runner.delegateTask({
      agent: "codex",
      task: "TRIGGER_ERROR",
    });

    expect(res.status).toBe("failed");
    expect(res.error).toContain("Simulated agent error");
  });

  it("applies the default run timeout when none is configured", async () => {
    await runner.delegateTask({ agent: "codex", task: "Default timeout" });

    expect(mock.lastRunOptions?.timeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("forwards the cancellation signal to the adapter", async () => {
    const controller = new AbortController();
    await runner.delegateTask({
      agent: "codex",
      task: "Signal passthrough",
      signal: controller.signal,
    });

    expect(mock.lastRunOptions?.signal).toBe(controller.signal);

    const sessionId = runner.listSessions()[0]!.id;
    const contRes = await runner.continueTask({
      sessionId,
      task: "Signal passthrough continue",
      signal: controller.signal,
    });
    expect(contRes.status).toBe("success");
    expect(mock.lastRunOptions?.signal).toBe(controller.signal);
  });

  function seededSession(agent: AgentName, role: "worker" | "reviewer" | "tester", task: string) {
    const created = sessionManager.createSession({
      agent,
      cwd: process.cwd(),
      role,
    });
    sessionManager.addHistory(created.id, {
      role,
      task,
      timestamp: new Date().toISOString(),
      status: "success",
      summary: `Summary for ${task}`,
      finalAnswer: `Final answer for ${task}`,
    });
    return sessionManager.getSession(created.id)!;
  }

  it("injects multiple context sources first-hand with per-source freshness", async () => {
    const workerSource = seededSession("codex", "worker", "Worker implemented the feature");
    const testerSource = seededSession("claude", "tester", "Tester ran the suite");

    const result = await runner.delegateTask({
      agent: "codex",
      task: "Consume two sources",
      contextSessionIds: [workerSource.id, testerSource.id],
    });

    expect(result.status).toBe("success");
    const context = mock.lastRunOptions?.historyContext ?? "";
    expect(context).toContain("## Shared Context (2 sources)");
    expect(context).toContain(`### Source 1 of 2 [Session: ${workerSource.id}`);
    expect(context).toContain(`### Source 2 of 2 [Session: ${testerSource.id}`);
    expect(context.match(/Context freshness:/g)?.length).toBe(2);
    expect(context.indexOf(workerSource.id)).toBeLessThan(context.indexOf(testerSource.id));

    const target = runner.getSession(result.sessionId!)!;
    expect(target.history[0]?.contextSources).toEqual([workerSource.id, testerSource.id]);
  });

  it("injects multiple sources through reviewChanges", async () => {
    const workerSource = seededSession("codex", "worker", "Worker result");
    const testerSource = seededSession("claude", "tester", "Tester result");

    const result = await runner.reviewChanges({
      agent: "codex",
      cwd: process.cwd(),
      task: "Review both handoffs",
      contextSessionIds: [workerSource.id, testerSource.id],
    });

    expect(result.status).toBe("success");
    expect(mock.lastRunOptions?.historyContext).toContain("## Shared Context (2 sources)");
    expect(mock.lastRunOptions?.historyContext).toContain(workerSource.id);
    expect(mock.lastRunOptions?.historyContext).toContain(testerSource.id);
    expect(runner.getSession(result.sessionId!)?.history.at(-1)?.contextSources).toEqual([
      workerSource.id,
      testerSource.id,
    ]);
  });
  it("fails fast when one of several context sessions is missing", async () => {
    const source = seededSession("codex", "worker", "Valid source");
    const res = await runner.delegateTask({
      agent: "codex",
      task: "Invalid reference",
      contextSessionIds: [source.id, "bridge-sess_missing"],
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("Context session 'bridge-sess_missing' not found");
  });

  it("rejects more context sources than supported", async () => {
    const source = seededSession("codex", "worker", "Valid source");
    const res = await runner.delegateTask({
      agent: "codex",
      task: "Too many sources",
      contextSessionIds: [source.id, source.id, source.id, source.id, source.id],
    });

    expect(res.status).toBe("failed");
    expect(res.summary).toContain("At most 4 context sessions");
  });

  it("continues with injected sources alongside a native resume", async () => {
    const first = await runner.delegateTask({ agent: "codex", task: "Initial feature" });
    const reviewerSource = seededSession("claude", "reviewer", "Review found edge cases");

    await runner.continueTask({
      sessionId: first.sessionId!,
      task: "Apply reviewer feedback",
      contextSessionIds: [reviewerSource.id],
    });

    // The worker session has a native id, so only the reviewer source injects.
    const context = mock.lastRunOptions?.historyContext ?? "";
    expect(context).toContain(reviewerSource.id);
    expect(context).not.toContain("Initial feature");
    const session = runner.getSession(first.sessionId!)!;
    expect(session.history.at(-1)?.contextSources).toEqual([reviewerSource.id]);
  });

  it("marks truncated shared answers explicitly", async () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: "Long report",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "Long",
      finalAnswer: "x".repeat(5_000),
    });

    await runner.delegateTask({
      agent: "codex",
      task: "Consume long source",
      contextSessionId: created.id,
    });

    expect(mock.lastRunOptions?.historyContext).toContain("[truncated]");
  });

  it("honors RunnerOptions timeout and session storage overrides", async () => {
    const sessionStoragePath = path.join(
      os.tmpdir(),
      `agentmesh_runner_opts_${Date.now()}_${Math.random().toString(36).slice(2)}.json`,
    );
    try {
      const customRunner = new MultiAgentRunner(registry, undefined, {
        defaultTimeoutMs: 12_345,
        sessionStoragePath,
      });
      const res = await customRunner.delegateTask({ agent: "codex", task: "Custom timeout" });

      expect(mock.lastRunOptions?.timeoutMs).toBe(12_345);
      expect(fs.existsSync(sessionStoragePath)).toBe(true);
      expect(customRunner.getSession(res.sessionId!)?.agent).toBe("codex");
    } finally {
      for (const suffix of ["", ".lock"]) {
        try {
          fs.unlinkSync(`${sessionStoragePath}${suffix}`);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });
});
