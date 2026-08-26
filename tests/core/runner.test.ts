import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach } from "vitest";
import {
  MultiAgentRunner,
  DEFAULT_RUN_TIMEOUT_MS,
  modelRejectionDiagnostic,
  sandboxSpawnHint,
} from "../../src/core/runner.js";
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

const COMPACT_SUMMARY_FIXTURE =
  "<analysis>\nprivate scratch that must not reach the sidecar\n</analysis>\n" +
  "<summary>\n1. Original Intent: mocked intent\n7. Current State and Key Data: STATE_SENTINEL\n" +
  "完整原文存于 Bridge session 'src' ，需要细节请按需读取。\n</summary>";

/** Serves a fixed eight-section summary whenever it receives a summary task. */
class SummarizerAdapter extends MockAdapter {
  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    if (options.task.includes("TRIGGER_ERROR")) {
      throw new Error("Simulated agent error");
    }
    this.lastRunOptions = options;
    if (!options.task.includes("<summary>")) return super.runViaCli(options);
    return {
      status: "success",
      agent: this.name,
      summary: "Produced handoff summary",
      output: "summary written",
      finalAnswer: COMPACT_SUMMARY_FIXTURE,
      exitCode: 0,
      durationMs: 5,
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

    // The runner composes external + server-shutdown signals into one parent
    // signal; the adapter must observe aborts of the caller's controller.
    const observed = mock.lastRunOptions?.signal;
    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);
    controller.abort();
    expect(observed?.aborted).toBe(true);

    const sessionId = runner.listSessions()[0]!.id;
    const freshController = new AbortController();
    const contRes = await runner.continueTask({
      sessionId,
      task: "Signal passthrough continue",
      signal: freshController.signal,
    });
    expect(contRes.status).toBe("success");
    expect(mock.lastRunOptions?.signal?.aborted).toBe(false);
    freshController.abort();
    expect(mock.lastRunOptions?.signal?.aborted).toBe(true);
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

  it("keeps the environment snapshot intact while upstream conclusions saturate their own budget (T2.4)", async () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: "Oversized upstream report",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "big",
      finalAnswer: "y".repeat(30_000),
    });

    await runner.delegateTask({
      agent: "codex",
      task: "Consume saturated upstream",
      contextSessionId: created.id,
    });

    const context = mock.lastRunOptions?.historyContext ?? "";
    // Upstream conclusions are capped at their own 12k segment (single source).
    expect(context).toContain("[truncated]");
    expect(context.length).toBeLessThan(16_000);
    // The environment snapshot survives intact regardless of upstream bloat.
    expect(context).toContain("Current repository: head=");
    expect(context.match(/Current repository:/g)).toHaveLength(1);
    expect(context).not.toContain("run git status for full detail");
  });

  it("caps each shared turn's task-description echo with an explicit marker (T2.4)", async () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    const oversizedTask = `${"t".repeat(5_900)}TAIL_SENTINEL`;
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: oversizedTask,
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "done",
    });

    await runner.delegateTask({
      agent: "codex",
      task: "Consume long historical task text",
      contextSessionId: created.id,
    });

    const context = mock.lastRunOptions?.historyContext ?? "";
    expect(context).toContain("... [truncated]");
    expect(context).not.toContain("TAIL_SENTINEL");
    const taskLine = context.split("\n").find((line) => line.startsWith("Task: "));
    expect(taskLine!.length).toBeLessThanOrEqual("Task: ".length + 4_000);
  });

  it("truncates an oversized environment snapshot and appends the git-status remediation hint (T2.4)", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-envsnap-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
      fs.writeFileSync(path.join(projectRoot, "seed.ts"), "export const seed = 1;\n");
      execFileSync("git", ["add", "seed.ts"], { cwd: projectRoot });
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
      // ~45 long untracked paths push the rendered evidence line past 2k chars.
      for (let i = 0; i < 45; i++) {
        fs.writeFileSync(
          path.join(projectRoot, `untracked-${"p".repeat(48)}-${i}.ts`),
          `export const v${i} = ${i};\n`,
        );
      }

      const source = await runner.delegateTask({
        agent: "codex",
        task: "Seed source in dirty repo",
        cwd: projectRoot,
      });
      await runner.delegateTask({
        agent: "codex",
        task: "Consume from the same dirty repo",
        cwd: projectRoot,
        contextSessionId: source.sessionId,
      });

      const context = mock.lastRunOptions?.historyContext ?? "";
      expect(context).toContain("... [truncated]");
      expect(context).toContain("run git status for full detail");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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

  it("attaches structured capability diagnostics when the executed transport ignores model options (P-REAL-007)", async () => {
    class McpOnlyAdapter extends BaseAdapter {
      readonly name: AgentName = "codex";
      readonly displayName = "Mock MCP Codex";
      readonly supportedModes: readonly TransportMode[] = ["mcp"];
      readonly sandboxMechanism: SandboxMechanism = "prompt-only";
      readonly envBinOverride = "MOCK_MCP_CODEX_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        void options;
        throw new Error("CLI transport is not exercised by this mock");
      }

      protected override async runViaMcp(options: RunAgentOptions): Promise<AgentResult> {
        void options;
        return {
          status: "success",
          agent: this.name,
          summary: "MCP task done",
          output: "done",
          finalAnswer: "done",
          exitCode: 0,
          durationMs: 5,
        };
      }
    }
    const mcpMock = new McpOnlyAdapter();
    registry.register(mcpMock);

    const res = await runner.delegateTask({
      agent: "codex",
      task: "Use the requested vendor model",
      model: "gpt-5-codex",
      reasoningEffort: "high",
    });

    expect(res.status).toBe("success");
    expect(res.transportUsed).toBe("mcp");
    expect(res.warning).toContain("Capability diagnostic");
    expect(res.warning).toContain("model 'gpt-5-codex'");
    expect(res.warning).toContain("reasoningEffort='high'");

    const entry = runner.getSession(res.sessionId!)?.history.at(-1);
    expect(entry?.capabilityDiagnostics).toHaveLength(2);
    expect(entry?.requestedModel).toBe("gpt-5-codex");
  });

  it("reports context handoff problems before unrelated role-resolution errors (error precedence)", async () => {
    const invalidConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh_badconfig_"));
    fs.mkdirSync(path.join(invalidConfigRoot, ".agentmesh"));
    fs.writeFileSync(
      path.join(invalidConfigRoot, ".agentmesh", "config.json"),
      "{not valid json",
      "utf-8",
    );
    try {
      const sourceSession = sessionManager.createSession({
        agent: "codex",
        cwd: process.cwd(),
        role: "worker",
      });
      sessionManager.addHistory(sourceSession.id, {
        role: "worker",
        task: "seed turn",
        timestamp: new Date().toISOString(),
        status: "success",
        summary: "seeded",
      });

      const res = await runner.delegateTask({
        agent: "codex",
        task: "Cross-repo handoff probe",
        cwd: invalidConfigRoot,
        contextSessionIds: [sourceSession.id],
      });

      expect(res.status).toBe("failed");
      // Without precedence ordering, the invalid-config error would mask the
      // actual cross-repo context problem being debugged.
      expect(res.summary).toContain("Context session cwd mismatch");
    } finally {
      fs.rmSync(invalidConfigRoot, { recursive: true, force: true });
    }
  });

  it("persists a verbatim shared-context audit with truncation metadata (injected-context observability)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh_audit_"));
    const sessionStoragePath = path.join(tempDir, "sessions.json");
    const persistedManager = new SessionManager({ storagePath: sessionStoragePath });
    const auditRunner = new MultiAgentRunner(registry, persistedManager);
    try {
      const longAnswer = "x".repeat(4_600);
      const firstRes = await auditRunner.delegateTask({
        agent: "codex",
        task: "Source of truth",
      });
      // Give the source session an oversized final answer (>4000 chars).
      persistedManager.addHistory(firstRes.sessionId!, {
        role: "worker",
        task: "oversized report",
        timestamp: new Date().toISOString(),
        status: "success",
        summary: "big report",
        finalAnswer: longAnswer,
      });

      const secondRes = await auditRunner.delegateTask({
        agent: "codex",
        task: "Consumer turn",
        contextSessionIds: [firstRes.sessionId!],
      });

      const entry = auditRunner.getSession(secondRes.sessionId!)?.history.at(-1);
      const audit = entry?.sharedContextAudit;
      expect(audit).toBeDefined();
      expect(audit?.sources).toHaveLength(1);
      expect(audit?.sources[0]?.sessionId).toBe(firstRes.sessionId);
      expect(audit?.sources[0]?.truncated).toBe(true);
      expect(entry?.contextSources).toEqual([firstRes.sessionId]);

      const artifactPath = path.join(tempDir, audit!.file!);
      expect(fs.existsSync(artifactPath)).toBe(true);
      const { createHash } = await import("node:crypto");
      const stored = fs.readFileSync(artifactPath, "utf-8");
      expect(audit!.sha256).toBe(createHash("sha256").update(stored, "utf-8").digest("hex"));
      expect(stored).toContain("[truncated]");
      expect(audit!.bytes).toBe(Buffer.byteLength(stored, "utf-8"));

      // The consumer actually received the truncated rendering.
      expect(mock.lastRunOptions?.historyContext).toContain("[truncated]");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records structured fallback evidence when auto mode falls back from MCP to CLI (N-R10-C)", async () => {
    class FallbackAdapter extends BaseAdapter {
      readonly name: AgentName = "codex";
      readonly displayName = "Fallback Codex";
      readonly supportedModes: readonly TransportMode[] = ["mcp", "cli"];
      readonly sandboxMechanism: SandboxMechanism = "prompt-only";
      readonly envBinOverride = "MOCK_FALLBACK_BIN";
      readonly defaultExecutableName = "node";

      protected override async runViaCli(): Promise<AgentResult> {
        return {
          status: "success",
          agent: this.name,
          summary: "CLI execution succeeded",
          output: "cli output",
          finalAnswer: "cli answer",
          exitCode: 0,
          durationMs: 5,
        };
      }

      protected override async runViaMcp(): Promise<AgentResult> {
        throw new Error("MCP handshake failed: vendor socket closed");
      }
    }
    const previous = registry.getAdapter("codex");
    registry.register(new FallbackAdapter());
    try {
      const res = await runner.delegateTask({
        agent: "codex",
        task: "fallback probe",
        mode: "auto",
      });

      expect(res.status).toBe("success");
      expect(res.transportUsed).toBe("cli");
      expect(res.transportFallback).toEqual({
        from: "mcp",
        to: "cli",
        reason: "MCP handshake failed: vendor socket closed",
      });
      expect(res.warning).toContain("Transport fallback");

      const entry = runner.getSession(res.sessionId!)?.history.at(-1);
      expect(entry?.evidence?.transportUsed).toBe("cli");
      expect(entry?.evidence?.transportFallback?.reason).toContain("vendor socket closed");
    } finally {
      if (previous) registry.register(previous);
    }
  });

  it("merges context-source failures with independent role-resolution problems (S4 aggregation)", async () => {
    const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh_noconfig_"));
    try {
      const sourceSession = sessionManager.createSession({
        agent: "codex",
        cwd: process.cwd(),
        role: "worker",
      });
      sessionManager.addHistory(sourceSession.id, {
        role: "worker",
        task: "seed turn",
        timestamp: new Date().toISOString(),
        status: "success",
        summary: "seeded",
      });

      const res = await runner.delegateTask({
        task: "Aggregated validation probe",
        cwd: plainRoot,
        contextSessionIds: [sourceSession.id],
      });

      expect(res.status).toBe("failed");
      expect(res.summary).toContain("Context session cwd mismatch");
      expect(res.summary).toContain("; additionally:");
      expect(res.summary).toContain("role 'worker' is not configured");
    } finally {
      fs.rmSync(plainRoot, { recursive: true, force: true });
    }
  });

  it("records a terminal failed turn with disconnect evidence on server shutdown (P-REAL-009)", async () => {
    class SlowAdapter extends MockAdapter {
      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        this.lastRunOptions = options;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 15_000);
        });
        return {
          status: "failed",
          agent: this.name,
          summary: "Run cancelled by the requesting client.",
          output: "cancelled",
          error: "Client disconnected from the AgentMesh server.",
          aborted: true,
          cleanupMethod: "signal" as const,
          exitCode: 1,
          durationMs: 5,
        };
      }
    }
    const slow = new SlowAdapter();
    registry.register(slow);

    const pending = runner.delegateTask({ agent: "codex", task: "Long running analysis" });
    for (let waited = 0; runner.activeExecutionCount === 0 && waited < 5_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runner.activeExecutionCount).toBe(1);
    await runner.abortAllInFlight();
    const res = await pending;

    expect(res.status).toBe("failed");
    expect(res.aborted).toBe(true);
    const entry = runner.getSession(res.sessionId!)?.history.at(-1);
    expect(entry?.status).toBe("failed");
    expect(entry?.evidence?.cancelReason).toBe("client_disconnect");
    expect(entry?.evidence?.aborted).toBe(true);
  }, 20_000);

  it("classifies vendor model rejections conservatively (P-REAL-007c)", () => {
    expect(
      modelRejectionDiagnostic({
        model: "gpt-5-codex",
        text: 'Error from vendor: model "gpt-5-codex" was rejected with status 403',
      }),
    ).toHaveLength(1);
    expect(
      modelRejectionDiagnostic({ model: "gpt-5-codex", text: "unrelated timeout" }),
    ).toHaveLength(0);
    expect(modelRejectionDiagnostic({ model: undefined, text: "400 bad request" })).toHaveLength(0);
  });

  it("hints the codex sandbox mitigation when MCP spawns are rejected (P6/P-036)", () => {
    const hint = sandboxSpawnHint("codex", "mcp", {
      output: "node --test failed with spawn EPERM",
    });
    expect(hint).toContain("--test-isolation=none");
    expect(sandboxSpawnHint("codex", "cli", { output: "spawn EPERM" })).toBeUndefined();
    expect(sandboxSpawnHint("codex", "mcp", { output: "all good" })).toBeUndefined();
  });

  it("compacts a source session into a fresh sidecar and injects summary plus pointer downstream (T2.3)", async () => {
    const summarizer = new SummarizerAdapter();
    registry.register(summarizer);
    const source = await runner.delegateTask({ agent: "codex", task: "Build the feature" });
    sessionManager.addHistory(source.sessionId!, {
      role: "worker",
      task: "Original detailed work",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "did things",
      finalAnswer: "FULL_TEXT_SENTINEL only visible without a fresh summary",
    });
    const sessionsBefore = runner.listSessions().length;

    const { outcomes } = await runner.compactContext({
      sourceSessionIds: [source.sessionId!],
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("summarized");
    expect(outcomes[0]?.truncated).toBe(false);
    expect(outcomes[0]?.summarizedTurns).toBe(2);

    // The sidecar lives on the SOURCE session; analysis draft was stripped.
    const stored = sessionManager.getSummary(source.sessionId!);
    expect(stored?.text).toContain("mocked intent");
    expect(stored?.text).not.toContain("private scratch");
    expect(stored?.text).toContain("需要细节请按需读取");

    // The throwaway summarization session left no residue.
    expect(runner.listSessions()).toHaveLength(sessionsBefore);

    await runner.delegateTask({
      agent: "codex",
      task: "Consume compacted source",
      contextSessionIds: [source.sessionId!],
    });
    const context = summarizer.lastRunOptions?.historyContext ?? "";
    expect(context).toContain(
      "[Semantic summary via compact_context covering all 2 recorded turn(s)]",
    );
    expect(context).toContain("STATE_SENTINEL");
    expect(context).toContain("use get_session to read specifics on demand");
    expect(context).not.toContain("FULL_TEXT_SENTINEL");
  });

  it("falls back to full transcript injection when the source gains turns after compaction (T2.3 STALE)", async () => {
    const summarizer = new SummarizerAdapter();
    registry.register(summarizer);
    const source = await runner.delegateTask({ agent: "codex", task: "Seed work" });
    sessionManager.addHistory(source.sessionId!, {
      role: "worker",
      task: "Original detailed work",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "did things",
      finalAnswer: "FULL_TEXT_SENTINEL",
    });
    const first = await runner.compactContext({ sourceSessionIds: [source.sessionId!] });
    expect(first.outcomes[0]?.status).toBe("summarized");

    // A new turn invalidates the snapshot: rendering returns to full history.
    sessionManager.addHistory(source.sessionId!, {
      role: "worker",
      task: "NEW_TURN_AFTER_COMPACT",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "progressed",
    });
    await runner.delegateTask({
      agent: "codex",
      task: "Consume grown source",
      contextSessionIds: [source.sessionId!],
    });
    const context = summarizer.lastRunOptions?.historyContext ?? "";
    expect(context).not.toContain("[Semantic summary via compact_context");
    expect(context).toContain("NEW_TURN_AFTER_COMPACT");
    expect(context).toContain("FULL_TEXT_SENTINEL");
  });

  it("marks and truncates oversized summaries at the token budget (T2.3)", async () => {
    class GiantSummarizer extends MockAdapter {
      override readonly name: AgentName = "claude";

      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        this.lastRunOptions = options;
        return {
          status: "success",
          agent: this.name,
          summary: "giant summary",
          output: "giant",
          finalAnswer: `<analysis>x</analysis><summary>${"G".repeat(9_000)}</summary>`,
          exitCode: 0,
          durationMs: 5,
        };
      }
    }
    registry.register(new GiantSummarizer());
    const source = sessionManager.createSession({
      agent: "claude",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(source.id, {
      role: "worker",
      task: "seed",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "seeded",
    });

    const { outcomes } = await runner.compactContext({ sourceSessionIds: [source.id] });

    expect(outcomes[0]?.status).toBe("summarized");
    expect(outcomes[0]?.truncated).toBe(true);
    const stored = sessionManager.getSummary(source.id);
    expect(stored?.text.length).toBeLessThanOrEqual(8_000);
    expect(stored?.text).toContain("[summary truncated]");
    expect(stored?.text).not.toContain("<analysis>");
  });

  it("deduplicates concurrent compactions of the same source session with an in-flight notice (T2.3)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class BlockingSummarizer extends SummarizerAdapter {
      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        if (options.task.includes("<summary>")) {
          await gate;
        }
        return super.runViaCli(options);
      }
    }
    registry.register(new BlockingSummarizer());

    const source = await runner.delegateTask({ agent: "codex", task: "Seed for concurrency" });
    sessionManager.addHistory(source.sessionId!, {
      role: "worker",
      task: "extra turn",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "ok",
    });

    const first = runner.compactContext({ sourceSessionIds: [source.sessionId!] });
    const second = await runner.compactContext({ sourceSessionIds: [source.sessionId!] });
    expect(second.outcomes[0]?.status).toBe("in-flight");
    expect(second.outcomes[0]?.reason).toContain("already running");

    release();
    const firstOutcome = (await first).outcomes[0];
    expect(firstOutcome?.status).toBe("summarized");
    expect(sessionManager.getSummary(source.sessionId!)).toBeDefined();
  });

  it("records failed compaction without writing a sidecar or leaving scratch sessions", async () => {
    registry.register(new SummarizerAdapter());
    // The failing marker rides inside the source turn, so the summarization
    // prompt carries it into the mock adapter's rejection branch.
    const source = await runner.delegateTask({ agent: "codex", task: "TRIGGER_ERROR seed" });
    expect(source.status).toBe("failed");

    const { outcomes } = await runner.compactContext({ sourceSessionIds: [source.sessionId!] });

    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.reason).toContain("Simulated agent error");
    expect(sessionManager.getSummary(source.sessionId!)).toBeUndefined();
    expect(runner.listSessions()).toHaveLength(1);
  });
});
