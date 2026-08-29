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
  buildSharedContextDetailed,
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

  it("renders a structured handoff for the latest turn with one-line indexes for older turns", async () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: "First setup turn",
      timestamp: new Date().toISOString(),
      status: "success",
    });
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: "Implement login fix",
      timestamp: new Date().toISOString(),
      status: "success",
      finalAnswer: "SECRET_LONG_BODY_SHOULD_NOT_BE_REPLAYED",
      handoff: {
        goal: "Fix the login redirect loop",
        outcome: "success",
        keyDecisions: ["Parameterize the auth lookup"],
        artifacts: { files: ["src/auth/login.ts"], commands: ["npm test -- auth"] },
        openItems: ["Rate limiting still in-memory"],
      },
    });

    await runner.delegateTask({
      agent: "codex",
      task: "Consume handoff",
      contextSessionId: created.id,
    });

    const context = mock.lastRunOptions?.historyContext ?? "";
    expect(context).toContain("## Shared Context");
    expect(context).toContain("Goal: Fix the login redirect loop");
    expect(context).toContain("Decisions:");
    expect(context).toContain("- Parameterize the auth lookup");
    expect(context).toContain("Files: src/auth/login.ts");
    expect(context).toContain("Commands: npm test -- auth");
    expect(context).toContain("Open Items:");
    expect(context).not.toContain("SECRET_LONG_BODY_SHOULD_NOT_BE_REPLAYED");
    expect(context).toContain("[Turn 1 | worker | success] First setup turn");
    expect(context).toContain("get_session_context");
  });

  it("records a structured handoff parsed from a contract-style final answer", async () => {
    class ReportingAdapter extends MockAdapter {
      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        const result = await super.runViaCli(options);
        return {
          ...result,
          finalAnswer: [
            "Implemented the feature.",
            "## Decisions",
            "- Event-driven update path",
            "## Files",
            "- src/feature.ts",
            "## Commands",
            "- npm test",
            "## Tests",
            "5 passed",
            "## Open Items",
            "- Docs pending",
          ].join("\n"),
        };
      }
    }
    registry.register(new ReportingAdapter());

    const result = await runner.delegateTask({ agent: "codex", task: "Build feature" });

    const entry = runner.getSession(result.sessionId!)?.history[0];
    expect(entry?.handoff).toMatchObject({
      goal: "Build feature",
      outcome: "success",
      keyDecisions: ["Event-driven update path"],
      artifacts: { files: ["src/feature.ts"], commands: ["npm test"], tests: "5 passed" },
      openItems: ["Docs pending"],
    });
  });

  it("records the handoff injection strategy and audit metadata", async () => {
    const handoffSource = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(handoffSource.id, {
      role: "worker",
      task: "With handoff",
      timestamp: new Date().toISOString(),
      status: "success",
      handoff: {
        goal: "Deliver the fix",
        outcome: "success",
        keyDecisions: [],
        artifacts: {},
        openItems: [],
      },
    });
    const legacySource = sessionManager.createSession({
      agent: "claude",
      cwd: process.cwd(),
      role: "worker",
    });
    sessionManager.addHistory(legacySource.id, {
      role: "worker",
      task: "Legacy turn",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "legacy",
    });

    const mixed = await runner.delegateTask({
      agent: "codex",
      task: "Consume both",
      contextSessionIds: [handoffSource.id, legacySource.id],
    });
    const mixedAudit = runner.getSession(mixed.sessionId!)?.history.at(-1)?.sharedContextAudit;
    expect(mixedAudit?.strategy).toBe("handoff");
    expect(mixedAudit?.estimatedTokens).toBeGreaterThan(0);
    expect(mixedAudit?.injectedOwnHistory).toBe(false);
    expect(mixedAudit?.sources).toHaveLength(2);

    const legacyOnly = await runner.delegateTask({
      agent: "codex",
      task: "Consume legacy",
      contextSessionIds: [legacySource.id],
    });
    const legacyAudit = runner
      .getSession(legacyOnly.sessionId!)
      ?.history.at(-1)?.sharedContextAudit;
    expect(legacyAudit?.strategy).toBe("legacy");
    expect(legacyAudit?.estimatedTokens).toBeGreaterThan(0);
    expect(legacyAudit?.droppedSections).toBeUndefined();
  });

  it("drops handoff sections by priority under a tight token budget", () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: process.cwd(),
      role: "worker",
    });
    const filler = (label: string): string[] =>
      Array.from({ length: 10 }, (_, i) => `${label} item ${i + 1}: ${"detail".repeat(60)}`);
    sessionManager.addHistory(created.id, {
      role: "worker",
      task: "Migrate the storage layer",
      timestamp: new Date().toISOString(),
      status: "success",
      handoff: {
        goal: "Ship the migration",
        outcome: "success",
        keyDecisions: filler("decision"),
        artifacts: {
          files: filler("file"),
          commands: filler("command"),
          tests: "10 passed",
        },
        openItems: filler("open"),
      },
    });
    const session = sessionManager.getSession(created.id)!;

    const render = buildSharedContextDetailed([session], undefined, { budgetTokens: 1_400 });

    expect(render).toBeDefined();
    expect(render!.strategy).toBe("handoff");
    // Reproducibility detail goes before conclusions: Tests first, Decisions kept.
    const dropped = render!.droppedSections;
    expect(dropped).toEqual([
      "turn 1 Tests",
      "turn 1 Open Items",
      "turn 1 Commands",
      "turn 1 Files",
    ]);
    expect(render!.text).toContain("Goal: Ship the migration");
    expect(render!.text).toContain("Decisions:");
    expect(render!.text).toContain("decision item 1");
    expect(render!.text).not.toContain("Tests: 10 passed");
    expect(render!.text).toContain("Context freshness: UNKNOWN");
  });

  it("applies the role-level context budget override from the project config", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-budget-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".git"));
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({
          version: 1,
          roles: { worker: { agent: "codex", contextBudgetTokens: 1_300 } },
        }),
      );

      const created = sessionManager.createSession({
        agent: "codex",
        cwd: projectRoot,
        role: "worker",
      });
      const filler = (label: string): string[] =>
        Array.from({ length: 10 }, (_, i) => `${label} item ${i + 1}: ${"detail".repeat(60)}`);
      sessionManager.addHistory(created.id, {
        role: "worker",
        task: "Big handoff",
        timestamp: new Date().toISOString(),
        status: "success",
        handoff: {
          goal: "Ship the migration",
          outcome: "success",
          keyDecisions: filler("decision"),
          artifacts: { files: filler("file"), commands: filler("command") },
          openItems: filler("open"),
        },
      });

      const result = await runner.delegateTask({
        agent: "codex",
        task: "Consume budgeted context",
        cwd: projectRoot,
        contextSessionId: created.id,
      });

      const audit = runner.getSession(result.sessionId!)?.history.at(-1)?.sharedContextAudit;
      expect(audit?.budgetTokens).toBe(1_300);
      expect(audit?.droppedSections?.length ?? 0).toBeGreaterThan(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("applies the role-level budget on continuations from the session's project config", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentmesh-budget-cont-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".git"));
      fs.mkdirSync(path.join(projectRoot, ".agentmesh"));
      fs.writeFileSync(
        path.join(projectRoot, ".agentmesh", "config.json"),
        JSON.stringify({
          version: 1,
          roles: { tester: { agent: "codex", contextBudgetTokens: 1_300 } },
        }),
      );

      const created = sessionManager.createSession({
        agent: "codex",
        cwd: projectRoot,
        role: "tester",
      });
      const filler = (label: string): string[] =>
        Array.from({ length: 10 }, (_, i) => `${label} item ${i + 1}: ${"detail".repeat(60)}`);
      sessionManager.addHistory(created.id, {
        role: "tester",
        task: "Big tester handoff",
        timestamp: new Date().toISOString(),
        status: "success",
        handoff: {
          goal: "Verify the release build",
          outcome: "success",
          keyDecisions: filler("decision"),
          artifacts: { files: filler("file"), commands: filler("command") },
          openItems: filler("open"),
        },
      });

      await runner.continueTask({ sessionId: created.id, task: "Keep testing" });

      const audit = runner.getSession(created.id)?.history.at(-1)?.sharedContextAudit;
      expect(audit?.budgetTokens).toBe(1_300);
      expect(audit?.injectedOwnHistory).toBe(true);
      expect(audit?.droppedSections?.length ?? 0).toBeGreaterThan(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("derives a reviewer handoff from the verdict and injects it downstream", async () => {
    class FailingReviewerAdapter extends MockAdapter {
      override readonly name: AgentName = "claude";

      protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
        this.lastRunOptions = options;
        return this.formatSuccessResult(
          [
            "FAIL",
            "- severity: high",
            "  file: src/auth.ts",
            "  line: 42",
            "  issue: SQL injection in login lookup",
            "  suggestion: Use parameterized queries",
          ].join("\n"),
          Date.now(),
          { nativeSessionId: "native_rev_fail_derived", exitCode: 0, role: "reviewer" },
        );
      }
    }
    registry.register(new FailingReviewerAdapter());

    const review = await runner.reviewChanges({
      agent: "claude",
      cwd: process.cwd(),
      task: "Review login changes",
    });
    const entry = runner.getSession(review.sessionId!)?.history[0];
    expect(entry?.handoff).toMatchObject({ outcome: "failed" });
    expect(entry?.handoff?.keyDecisions).toEqual(["Review FAILED: 1 issue(s) detected."]);
    expect(entry?.handoff?.artifacts.files).toEqual(["src/auth.ts"]);
    expect(entry?.handoff?.openItems[0]).toContain("high: src/auth.ts:42");

    // The downstream injection renders the derived handoff, not the review body.
    await runner.delegateTask({
      agent: "codex",
      task: "Fix the findings",
      cwd: process.cwd(),
      contextSessionId: review.sessionId,
    });
    const context = mock.lastRunOptions?.historyContext ?? "";
    expect(context).toContain("Goal: Review login changes");
    expect(context).toContain("high: src/auth.ts:42");
    expect(context).not.toContain("suggestion: Use parameterized queries");
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
});
