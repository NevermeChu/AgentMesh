import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MultiAgentRunner, DEFAULT_IDEMPOTENCY_TTL_MS } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import { BaseAdapter } from "../../src/agents/base.js";
import { DelegateTaskInputSchema } from "../../src/mcp/tools.js";
import type {
  AgentName,
  AgentResult,
  RunAgentOptions,
  SandboxMechanism,
  TransportMode,
} from "../../src/agents/types.js";

class ScriptedAdapter extends BaseAdapter {
  readonly name: AgentName = "codex";
  readonly displayName = "Scripted Codex";
  readonly supportedModes: readonly TransportMode[] = ["cli"];
  readonly sandboxMechanism: SandboxMechanism = "prompt-only";
  readonly envBinOverride = "SCRIPTED_CODEX_BIN";
  readonly defaultExecutableName = "node";

  public executions = 0;
  private notifyEntered?: () => void;
  private releaseHeld?: () => void;
  private heldPromise: Promise<void> = Promise.resolve();
  private failures: string[] = [];

  /** Resolves once the next execution has entered the adapter; holds it until releaseHold(). */
  public armHold(): Promise<void> {
    this.heldPromise = new Promise<void>((resolveRelease) => {
      this.releaseHeld = resolveRelease;
    });
    return new Promise<void>((resolveEnter) => {
      this.notifyEntered = resolveEnter;
    });
  }

  public releaseHold(): void {
    this.releaseHeld?.();
  }

  /** Makes the next execution(s) terminate as failures with the given summary. */
  public enqueueFailures(count: number, summary = "Scripted vendor failure"): void {
    for (let i = 0; i < count; i++) this.failures.push(summary);
  }

  protected override async runViaCli(options: RunAgentOptions): Promise<AgentResult> {
    this.executions += 1;
    this.notifyEntered?.();
    this.notifyEntered = undefined;
    await this.heldPromise;
    const failureSummary = this.failures.shift();
    if (failureSummary) {
      return {
        status: "failed",
        agent: this.name,
        summary: failureSummary,
        output: failureSummary,
        error: failureSummary,
        exitCode: 1,
        durationMs: 5,
      };
    }
    return {
      status: "success",
      agent: this.name,
      summary: "Mock task executed successfully",
      output: `Executed: ${options.task}`,
      finalAnswer: `Final: ${options.task}`,
      nativeSessionId: `native_${this.executions}`,
      exitCode: 0,
      durationMs: 15,
    };
  }
}

describe("core/idempotency (P1 T1.1)", () => {
  let registry: AgentRegistry;
  let sessionManager: SessionManager;
  let runner: MultiAgentRunner;
  let adapter: ScriptedAdapter;
  let workdir: string;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function makeGitRepo(): string {
    const root = makeTempDir("agentmesh-idem-git-");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, "feature.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "feature.ts"], { cwd: root });
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
      { cwd: root },
    );
    return root;
  }

  beforeEach(() => {
    registry = new AgentRegistry();
    sessionManager = new SessionManager({ persist: false });
    adapter = new ScriptedAdapter();
    registry.register(adapter);
    runner = new MultiAgentRunner(registry, sessionManager);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes a keyed dispatch exactly once under concurrency; duplicates get an in-flight reference", async () => {
    workdir = makeTempDir("agentmesh-idem-conc-");
    const entered = adapter.armHold();

    const params = {
      agent: "codex",
      task: "Ship the feature",
      cwd: workdir,
      idempotencyKey: "deploy-001",
    };
    const first = runner.delegateTask(params);
    await entered;

    // Two concurrent duplicates arrive while the first execution is held open.
    const duplicateA = runner.delegateTask(params);
    const duplicateB = runner.delegateTask(params);

    // Resolving the duplicates proves they passed the idempotency gate while
    // the first execution was still registered as in flight.
    const [refA, refB] = await Promise.all([duplicateA, duplicateB]);
    expect(adapter.executions).toBe(1);

    adapter.releaseHold();
    const original = await first;

    expect(original.status).toBe("success");
    for (const ref of [refA, refB]) {
      expect(ref.replayed).toBeUndefined();
      expect(ref.sessionId).toBe(original.sessionId);
      expect(ref.summary).toContain("already in flight");
      expect(ref.error).toContain("duplicate_in_flight");
      expect(ref.error).toContain("deploy-001");
    }
    expect(runner.activeIdempotencyDispatches).toBe(0);
  });

  it("replays the recorded terminal result within the tombstone TTL instead of re-executing", async () => {
    workdir = makeTempDir("agentmesh-idem-replay-");

    const params = { agent: "codex", task: "Analyze module", cwd: workdir, idempotencyKey: "k" };
    const first = await runner.delegateTask(params);
    const replay = await runner.delegateTask(params);

    expect(adapter.executions).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("success");
    expect(replay.finalAnswer).toBe(first.finalAnswer);
    expect(replay.summary).toContain("[idempotent replay]");
    expect(replay.sessionId).toBe(first.sessionId);
    expect(replay.warning).toContain("no new agent execution was started");
  });

  it("flags a replayed result STALE when the repository changed since the recorded turn", async () => {
    const repo = makeGitRepo();

    const params = { agent: "codex", task: "Inspect tree", cwd: repo, idempotencyKey: "audit-1" };
    await runner.delegateTask(params);
    fs.writeFileSync(path.join(repo, "feature.ts"), "export const value = 2;\n");

    const replay = await runner.delegateTask(params);

    expect(adapter.executions).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.warning).toContain("Freshness STALE");
  });

  it("executes normally once the tombstone TTL has expired (injectable clock)", async () => {
    workdir = makeTempDir("agentmesh-idem-ttl-");
    let currentMs = 1_000_000;
    const timedRunner = new MultiAgentRunner(registry, sessionManager, { now: () => currentMs });

    const params = { agent: "codex", task: "T", cwd: workdir, idempotencyKey: "ttl-key" };
    await timedRunner.delegateTask(params);
    expect(adapter.executions).toBe(1);

    currentMs += DEFAULT_IDEMPOTENCY_TTL_MS - 60_000;
    const withinTtl = await timedRunner.delegateTask(params);
    expect(withinTtl.replayed).toBe(true);
    expect(adapter.executions).toBe(1);

    currentMs += 2 * 60_000;
    const afterTtl = await timedRunner.delegateTask(params);
    expect(afterTtl.replayed).toBeUndefined();
    expect(afterTtl.status).toBe("success");
    expect(adapter.executions).toBe(2);
  });

  it("scopes keys per working directory so the same key executes once per cwd", async () => {
    const cwdA = makeTempDir("agentmesh-idem-a-");
    const cwdB = makeTempDir("agentmesh-idem-b-");

    const first = await runner.delegateTask({
      agent: "codex",
      task: "T",
      cwd: cwdA,
      idempotencyKey: "shared",
    });
    const second = await runner.delegateTask({
      agent: "codex",
      task: "T",
      cwd: cwdB,
      idempotencyKey: "shared",
    });

    expect(adapter.executions).toBe(2);
    expect(second.replayed).toBeUndefined();
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("tombstones failed executions too and replays the failure verbatim", async () => {
    workdir = makeTempDir("agentmesh-idem-fail-");
    adapter.enqueueFailures(1, "Vendor exploded");

    const params = { agent: "codex", task: "Risky op", cwd: workdir, idempotencyKey: "fail-key" };
    const first = await runner.delegateTask(params);
    expect(first.status).toBe("failed");

    const replay = await runner.delegateTask(params);

    expect(adapter.executions).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("failed");
    expect(replay.summary).toContain("[idempotent replay]");
    expect(replay.summary).toContain("Vendor exploded");
    expect(replay.exitCode).toBe(1);
  });

  it("rejects blank idempotency keys at the MCP schema boundary", () => {
    expect(DelegateTaskInputSchema.safeParse({ task: "x" }).success).toBe(true);
    expect(
      DelegateTaskInputSchema.safeParse({ task: "x", idempotencyKey: "deploy-001" }).success,
    ).toBe(true);
    expect(DelegateTaskInputSchema.safeParse({ task: "x", idempotencyKey: "" }).success).toBe(
      false,
    );
    expect(DelegateTaskInputSchema.safeParse({ task: "x", idempotencyKey: "   " }).success).toBe(
      false,
    );
  });
});
