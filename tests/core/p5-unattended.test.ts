import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import { CheckpointStore } from "../../src/core/checkpoint.js";
import { evaluateBudgetGate, sumSessionUsage } from "../../src/core/budget.js";
import { parseProjectConfigText } from "../../src/core/config.js";
import { buildRolePrompt } from "../../src/core/prompts.js";
import { BackgroundDispatchService } from "../../src/mcp/tools.js";
import { BackgroundTaskRegistry } from "../../src/core/background.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

/**
 * P5 unattended-closed-loop suite (T5.1 rework loop, T5.2 checkpoints,
 * T5.3 watchdog termination, T5.4 budget gate).
 */

interface ScriptedTurn {
  status: "success" | "failed";
  summary: string;
  reviewOutcome?: "PASS" | "FAIL" | "UNKNOWN";
  findings?: AgentResult["findings"];
  usage?: AgentResult["usage"];
}

class ScriptedAdapter extends BaseAdapter {
  readonly name: AgentName;
  readonly displayName: string;
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "SCRIPTED_P5_BIN";
  readonly defaultExecutableName = "node";

  public runs = 0;
  public receivedTasks: string[] = [];
  private queue: ScriptedTurn[] = [];

  constructor(name: AgentName) {
    super();
    this.name = name;
    this.displayName = `Scripted ${name}`;
  }

  public enqueue(turn: ScriptedTurn): void {
    this.queue.push(turn);
  }

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.runs += 1;
    this.receivedTasks.push(options.task);
    const turn = this.queue.shift() ?? { status: "success" as const, summary: "ok" };
    return {
      status: turn.status,
      agent: this.name,
      summary: turn.summary,
      output: `Executed: ${options.task}`,
      finalAnswer: turn.summary,
      exitCode: turn.status === "success" ? 0 : 1,
      ...(turn.reviewOutcome ? { reviewOutcome: turn.reviewOutcome } : {}),
      ...(turn.findings ? { findings: turn.findings } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
      durationMs: 5,
    };
  }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRepo(): string {
  const root = makeTempDir("agentmesh-p5-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  fs.writeFileSync(path.join(root, "feature.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "feature.ts"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init"],
    { cwd: root },
  );
  return root;
}

function writeConfig(root: string, config: unknown): void {
  fs.mkdirSync(path.join(root, ".agentmesh"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentmesh", "config.json"), JSON.stringify(config));
}

const FAIL_FINDINGS: AgentResult["findings"] = [
  {
    severity: "high",
    file: "src/broken.ts",
    line: 12,
    issue: "Off-by-one in the loop bound",
    suggestion: "Use < instead of <=",
  },
];

const FAIL_TURN: ScriptedTurn = {
  status: "failed",
  summary: "Review FAILED: 1 issue(s) detected.",
  reviewOutcome: "FAIL",
  findings: FAIL_FINDINGS,
};

describe("core/checkpoint (P5 T5.2)", () => {
  let home: string;
  let store: CheckpointStore;

  beforeEach(() => {
    home = makeTempDir("agentmesh-p5-ckpt-");
    store = new CheckpointStore({ homeDir: home, now: () => 1_000 });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("saves, reads and consumes a checkpoint exactly once", async () => {
    const saved = await store.saveCheckpoint({
      bridgeSessionId: "sess-1",
      reason: "failed",
      partialAnswer: "partial work output",
    });
    expect(saved.checkpointId).toMatch(/^ckpt_/);
    expect(saved.partialAnswer).toBe("partial work output");

    const read = await store.readCheckpoint(saved.checkpointId);
    expect(read.consumedAtMs).toBeUndefined();

    const consumed = await store.consumeCheckpoint(saved.checkpointId);
    expect(consumed.consumedAtMs).toBe(1_000);

    await expect(store.consumeCheckpoint(saved.checkpointId)).rejects.toThrow(/already consumed/);
  });

  it("resolves the bucket from the index when the consumer omits it", async () => {
    const saved = await store.saveCheckpoint({
      taskId: "bgtask_x",
      reason: "stalled-terminated",
      partialAnswer: "tail",
    });
    const consumed = await store.consumeCheckpoint(saved.checkpointId);
    expect(consumed.taskId).toBe("bgtask_x");
  });

  it("keeps only the tail of oversized partial answers", async () => {
    const saved = await store.saveCheckpoint({
      reason: "failed",
      partialAnswer: "x".repeat(40_000) + "END",
    });
    expect(saved.partialAnswer.length).toBeLessThan(40_000);
    expect(saved.partialAnswer.endsWith("END")).toBe(true);
  });

  it("fails closed for unknown checkpoints", async () => {
    await expect(store.readCheckpoint("ckpt_missing")).rejects.toThrow(/not found/);
  });
});

describe("core/budget (P5 T5.4)", () => {
  const usage = (total: number) => ({ inputTokens: total, outputTokens: 0, totalTokens: total });

  it("sums only metered turns", () => {
    const totals = sumSessionUsage([
      { usage: usage(100) } as never,
      {} as never,
      { usage: usage(50) } as never,
    ]);
    expect(totals.totalTokens).toBe(150);
    expect(totals.meteredTurns).toBe(2);
  });

  it("warns at or above 80% of the cap", () => {
    const decision = evaluateBudgetGate({
      config: { perSessionTokenCap: 1000 },
      session: { history: [{ usage: usage(850) } as never] },
    });
    expect(decision.action).toBe("warn");
    expect(decision.warning).toContain("80%");
  });

  it("rejects new dispatches at the cap only under rejectNew", () => {
    const reject = evaluateBudgetGate({
      config: { perSessionTokenCap: 1000, onExceed: "rejectNew" },
      session: { history: [{ usage: usage(1000) } as never] },
    });
    expect(reject.action).toBe("reject");

    const warnOnly = evaluateBudgetGate({
      config: { perSessionTokenCap: 1000 },
      session: { history: [{ usage: usage(1000) } as never] },
    });
    expect(warnOnly.action).toBe("warn");
  });

  it("allows sessions below the watermark and unmetered sessions", () => {
    const below = evaluateBudgetGate({
      config: { perSessionTokenCap: 1000, onExceed: "rejectNew" },
      session: { history: [{ usage: usage(100) } as never] },
    });
    expect(below.action).toBe("allow");

    const unmetered = evaluateBudgetGate({
      config: { perSessionTokenCap: 1000, onExceed: "rejectNew" },
      session: { history: [{} as never] },
    });
    expect(unmetered.action).toBe("allow");
  });

  it("parses the budget config section with field-level rejection", () => {
    const ok = parseProjectConfigText(
      JSON.stringify({
        version: 1,
        roles: {},
        budget: { perSessionTokenCap: 5000, onExceed: "rejectNew" },
      }),
    );
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.config.budget?.perSessionTokenCap).toBe(5000);

    const bad = parseProjectConfigText(
      JSON.stringify({ version: 1, roles: {}, budget: { perSessionTokenCap: -1 } }),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.issues.some((i) => i.field.includes("budget"))).toBe(true);
  });
});

describe("runner budget gate (P5 T5.4)", () => {
  let registry: AgentRegistry;
  let sessionManager: SessionManager;
  let runner: MultiAgentRunner;
  let adapter: ScriptedAdapter;
  let repo: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    adapter = new ScriptedAdapter("codex");
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, sessionManager);
    repo = makeGitRepo();
    tempDirs.push(repo);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails a new dispatch with BUDGET_EXHAUSTED once the cap is reached under rejectNew", async () => {
    writeConfig(repo, {
      version: 1,
      roles: { worker: "codex" },
      budget: { perSessionTokenCap: 1000, onExceed: "rejectNew" },
    });
    adapter.enqueue({
      status: "success",
      summary: "spent tokens",
      usage: { inputTokens: 600, outputTokens: 400, totalTokens: 1000 },
    });
    const first = await runner.delegateTask({ task: "t1", cwd: repo, role: "worker" });
    expect(first.status).toBe("success");

    adapter.enqueue({ status: "success", summary: "should never run" });
    const second = await runner.delegateTask({
      task: "t2",
      cwd: repo,
      role: "worker",
      sessionId: first.sessionId,
    });
    expect(second.status).toBe("failed");
    expect(second.errorCode).toBe("BUDGET_EXHAUSTED");
    expect(adapter.runs).toBe(1);
  });

  it("warns (but allows) at 80% and under warn-only mode", async () => {
    writeConfig(repo, {
      version: 1,
      roles: { worker: "codex" },
      budget: { perSessionTokenCap: 1000 },
    });
    adapter.enqueue({
      status: "success",
      summary: "spent tokens",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 850 },
    });
    adapter.enqueue({ status: "success", summary: "still allowed" });
    const first = await runner.delegateTask({ task: "t1", cwd: repo, role: "worker" });
    expect(first.warning).toContain("80%");
    const second = await runner.delegateTask({
      task: "t2",
      cwd: repo,
      role: "worker",
      sessionId: first.sessionId,
    });
    expect(second.status).toBe("success");
    expect(adapter.runs).toBe(2);
  });
});

describe("reviewChanges rework loop (P5 T5.1)", () => {
  let registry: AgentRegistry;
  let sessionManager: SessionManager;
  let runner: MultiAgentRunner;
  let reviewer: ScriptedAdapter;
  let worker: ScriptedAdapter;
  let repo: string;
  const tempDirs: string[] = [];

  beforeEach(() => {
    registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    reviewer = new ScriptedAdapter("codex");
    worker = new ScriptedAdapter("claude");
    registry.register(reviewer);
    registry.register(worker);
    runner = new MultiAgentRunner(registry, sessionManager);
    repo = makeGitRepo();
    tempDirs.push(repo);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maxReworkRounds=0 keeps the v0.1 single-pass behavior", async () => {
    reviewer.enqueue(FAIL_TURN);
    const result = await runner.reviewChanges({
      cwd: repo,
      agent: "codex",
      maxReworkRounds: 0,
      workerSessionId: "sess-whatever",
    });
    expect(result.reviewOutcome).toBe("FAIL");
    expect(result.rework).toBeUndefined();
    expect(reviewer.runs).toBe(1);
    expect(worker.runs).toBe(0);
  });

  it("injects findings into the worker and re-reviews until PASS", async () => {
    reviewer.enqueue(FAIL_TURN);
    reviewer.enqueue({
      status: "success",
      summary: "Review PASSED: Changes are clean and verified.",
      reviewOutcome: "PASS",
    });

    const workerSession = sessionManager.createSession({
      agent: "claude",
      cwd: repo,
      role: "worker",
    });
    const result = await runner.reviewChanges({
      cwd: repo,
      agent: "codex",
      maxReworkRounds: 3,
      workerSessionId: workerSession.id,
    });

    expect(result.reviewOutcome).toBe("PASS");
    expect(result.rework?.rounds).toBe(1);
    expect(result.rework?.workerSessionId).toBe(workerSession.id);
    expect(result.rework?.log).toEqual([{ round: 1, fixStatus: "success", reviewOutcome: "PASS" }]);
    expect(worker.runs).toBe(1);
    // The fix prompt carries the machine-parsed finding verbatim.
    expect(worker.receivedTasks[0]).toContain("src/broken.ts:12");
    expect(worker.receivedTasks[0]).toContain("Off-by-one");
    expect(worker.receivedTasks[0]).toContain("REWORK ROUND 1 OF 3");
    expect(reviewer.runs).toBe(2);
  });

  it("stops with evidence when rounds are exhausted", async () => {
    for (let i = 0; i < 4; i++) reviewer.enqueue(FAIL_TURN);
    const workerSession = sessionManager.createSession({
      agent: "claude",
      cwd: repo,
      role: "worker",
    });
    const result = await runner.reviewChanges({
      cwd: repo,
      agent: "codex",
      maxReworkRounds: 3,
      workerSessionId: workerSession.id,
    });
    expect(result.reviewOutcome).toBe("FAIL");
    expect(result.rework?.rounds).toBe(3);
    expect(result.rework?.log).toHaveLength(3);
    expect(reviewer.runs).toBe(4);
    expect(worker.runs).toBe(3);
  });

  it("reports a missing worker session instead of guessing", async () => {
    reviewer.enqueue(FAIL_TURN);
    const result = await runner.reviewChanges({
      cwd: repo,
      agent: "codex",
      maxReworkRounds: 2,
    });
    expect(result.reviewOutcome).toBe("FAIL");
    expect(result.rework?.rounds).toBe(0);
    expect(result.warning).toContain("no worker session was identified");
    expect(worker.runs).toBe(0);
  });

  it("rubric rides the strict review contract into the role prompt", () => {
    const withRubric = buildRolePrompt("inspect", "reviewer", { rubric: true });
    expect(withRubric).toContain("Review Rubric");
    expect(withRubric).toContain("P0");
    const plain = buildRolePrompt("inspect", "reviewer");
    expect(plain).not.toContain("Review Rubric");
  });
});

describe("continueTask fromCheckpoint (P5 T5.2)", () => {
  let registry: AgentRegistry;
  let sessionManager: SessionManager;
  let runner: MultiAgentRunner;
  let adapter: ScriptedAdapter;
  let home: string;
  let store: CheckpointStore;
  const tempDirs: string[] = [];

  beforeEach(() => {
    registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    adapter = new ScriptedAdapter("codex");
    registry.register(adapter);
    home = makeTempDir("agentmesh-p5-continue-");
    store = new CheckpointStore({ homeDir: home });
    runner = new MultiAgentRunner(registry, sessionManager, { checkpointStore: store });
    tempDirs.push(home);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("injects the salvaged output and consumes the baton once", async () => {
    const cwd = makeTempDir("agentmesh-p5-cwd-");
    tempDirs.push(cwd);
    const session = sessionManager.createSession({ agent: "codex", cwd, role: "worker" });
    const saved = await store.saveCheckpoint({
      bridgeSessionId: session.id,
      reason: "stalled-terminated",
      partialAnswer: "half-written implementation of divide()",
    });

    const result = await runner.continueTask({
      sessionId: session.id,
      task: "resume the work",
      fromCheckpoint: saved.checkpointId,
    });
    expect(result.status).toBe("success");
    expect(adapter.receivedTasks[0]).toContain("half-written implementation of divide()");
    expect(adapter.receivedTasks[0]).toContain("resume the work");

    const second = await runner.continueTask({
      sessionId: session.id,
      task: "again",
      fromCheckpoint: saved.checkpointId,
    });
    expect(second.status).toBe("failed");
    expect(second.error).toContain("already consumed");
    expect(adapter.runs).toBe(1);
  });

  it("fails closed when the checkpoint is unknown", async () => {
    const cwd = makeTempDir("agentmesh-p5-cwd2-");
    tempDirs.push(cwd);
    const session = sessionManager.createSession({ agent: "codex", cwd, role: "worker" });
    const result = await runner.continueTask({
      sessionId: session.id,
      task: "resume",
      fromCheckpoint: "ckpt_missing",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not found");
    expect(adapter.runs).toBe(0);
  });
});

describe("background watchdog termination (P5 T5.3)", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempDir("agentmesh-p5-watchdog-");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function listCheckpoints(): Promise<Array<{ reason: string; partialAnswer: string }>> {
    const root = path.join(home, "checkpoints");
    const out: Array<{ reason: string; partialAnswer: string }> = [];
    if (!fs.existsSync(root)) return out;
    for (const bucket of fs.readdirSync(root)) {
      const dir = path.join(root, bucket);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        out.push(
          JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as {
            reason: string;
            partialAnswer: string;
          },
        );
      }
    }
    return out;
  }

  it("aborts a silent task at the terminate threshold and spills a checkpoint", async () => {
    const nowMs = 1_000_000;
    const registry = new BackgroundTaskRegistry({ homeDir: home, now: () => nowMs });
    const checkpointStore = new CheckpointStore({ homeDir: home });
    const service = new BackgroundDispatchService(registry, { checkpointStore });

    const outputDir = path.join(home, "tasks");
    fs.mkdirSync(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, "bgtask_t.output");
    fs.writeFileSync(outputFile, "salvage me before termination");

    registry.registerTask({
      taskId: "bgtask_t",
      pid: process.pid,
      startedAtMs: nowMs,
      outputFile,
    });

    service.launch({
      taskId: "bgtask_t",
      outputFile,
      run: (signal) =>
        new Promise<AgentResult>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({
              status: "failed",
              agent: "codex",
              summary: "aborted",
              output: "aborted",
              error: signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
              aborted: true,
              exitCode: 1,
            }),
          );
        }),
    });

    // The service's constructor-installed watchdog stays wired (this is the
    // production wiring); the sweep is driven manually through the injectable
    // registry clock: stalled at +11min of silence, terminated at +41min.
    const stalledAt = nowMs + 11 * 60_000;
    registry.checkStalledTasks(stalledAt);
    expect(registry.isStallNotified("bgtask_t")).toBe(true);
    expect(registry.hasStoredResult("bgtask_t")).toBe(false);

    const terminatedAt = stalledAt + 31 * 60_000;
    registry.checkStalledTasks(terminatedAt);

    await waitFor(() => registry.hasStoredResult("bgtask_t"));
    const stored = await registry.readStoredResult("bgtask_t");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("stalled");

    const checkpoints = await listCheckpoints();
    const stalledCk = checkpoints.find((c) => c.reason === "stalled-terminated");
    expect(stalledCk?.partialAnswer).toContain("salvage me before termination");

    await service.abortAll("test teardown");
  }, 20_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}
