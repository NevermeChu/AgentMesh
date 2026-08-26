import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackgroundTaskNotFoundError,
  BackgroundTaskRegistry,
  isPidAlive,
} from "../../src/core/background.js";
import {
  executeCommand,
  forgetActivityHandle,
  getActivityHandle,
} from "../../src/core/executor.js";

describe("core/background registry", () => {
  let homeDir: string;
  let nowMs: number;
  const alivePids = new Set<number>();

  const makeRegistry = () =>
    new BackgroundTaskRegistry({
      homeDir,
      now: () => nowMs,
      isPidAlive: (pid) => alivePids.has(pid),
    });

  const register = (
    registry: BackgroundTaskRegistry,
    taskId: string,
    overrides: Partial<{ pid: number; outputFile: string }> = {},
  ) => {
    const record = {
      taskId,
      pid: overrides.pid ?? process.pid,
      startedAtMs: nowMs,
      outputFile: overrides.outputFile ?? path.join(registry.tasksDirectory, `${taskId}.output`),
    };
    fs.mkdirSync(path.dirname(record.outputFile), { recursive: true });
    if (!fs.existsSync(record.outputFile)) {
      fs.writeFileSync(record.outputFile, "", "utf-8");
    }
    registry.registerTask(record);
    return record;
  };

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_bg_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    nowMs = 1_000_000;
    alivePids.clear();
    alivePids.add(process.pid);
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists registrations as JSONL under <home>/tasks/registry.jsonl", () => {
    const registry = makeRegistry();
    register(registry, "bg_a1");

    const raw = fs.readFileSync(registry.registryFilePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ taskId: "bg_a1", pid: process.pid });
  });

  it("resolves tasks across registry instances (restart recovery)", () => {
    const first = makeRegistry();
    register(first, "bg_restart");

    const second = makeRegistry();
    expect(second.getRegisteredTask("bg_restart")?.outputFile).toContain("bg_restart.output");
  });

  it("reaps only entries whose owning pid died and returns the cleanup list", async () => {
    const registry = makeRegistry();
    register(registry, "bg_live", { pid: process.pid });
    register(registry, "bg_dead", { pid: 999_999 });

    const reaped = await registry.scanAndReapOrphans();

    expect(reaped.map((entry) => entry.taskId)).toEqual(["bg_dead"]);
    const remaining = fs
      .readFileSync(registry.registryFilePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { taskId: string })
      .map((parsed) => parsed.taskId);
    expect(remaining).toEqual(["bg_live"]);
  });

  it("reads output incrementally at a byte offset", async () => {
    const registry = makeRegistry();
    const record = register(registry, "bg_inc");
    await fsp.appendFile(record.outputFile, "hello\n", "utf-8");

    const first = await registry.pollOnce("bg_inc", 0);
    expect(first).toMatchObject({
      status: "running",
      outputSinceOffset: "hello\n",
      nextOffset: 6,
      hasMore: false,
    });

    await fsp.appendFile(record.outputFile, "world", "utf-8");
    const second = await registry.pollOnce("bg_inc", first.nextOffset);
    expect(second.outputSinceOffset).toBe("world");
    expect(second.nextOffset).toBe(11);
  });

  it("returns an empty delta with hasMore:false when the offset exceeds the file", async () => {
    const registry = makeRegistry();
    const record = register(registry, "bg_short");
    await fsp.appendFile(record.outputFile, "abc", "utf-8");

    const outcome = await registry.pollTask({ taskId: "bg_short", sinceOffset: 9999 });

    expect(outcome.outputSinceOffset).toBe("");
    expect(outcome.hasMore).toBe(false);
    expect(outcome.nextOffset).toBe(9999);
  });

  it("reports running before completion and completed after the result record", async () => {
    const registry = makeRegistry();
    register(registry, "bg_term");

    const running = await registry.pollOnce("bg_term", 0);
    expect(running.status).toBe("running");
    expect(running.result).toBeUndefined();

    await registry.writeStoredResult({
      taskId: "bg_term",
      status: "completed",
      summary: "done",
      completedAtMs: nowMs,
    });

    const done = await registry.pollOnce("bg_term", 0);
    expect(done.status).toBe("completed");
    expect(done.result?.summary).toBe("done");
  });

  it("infers failed when a registered task's owning process died without a result", async () => {
    const registry = makeRegistry();
    const deadPid = 123_456;
    register(registry, "bg_crash", { pid: deadPid });

    // Not tracked in this instance's active map: restart-style lookup only.
    const otherView = makeRegistry();
    const outcome = await otherView.pollOnce("bg_crash", 0);
    expect(outcome.status).toBe("failed");
    expect(alivePids.has(deadPid)).toBe(false);
  });

  it("flags stalled exactly once per task at the threshold boundary (injectable clock)", () => {
    const registry = makeRegistry();
    const notified: string[] = [];
    const lastOutputAtByTask = new Map<string, number>();
    registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => ({
        getLastOutputAtMs: () => lastOutputAtByTask.get(taskId),
      }),
      thresholdMs: 600_000,
      onStalled: (taskId) => notified.push(taskId),
    });
    lastOutputAtByTask.set("bg_stall", nowMs);
    register(registry, "bg_stall");

    // 1ms short of the threshold: no stall yet.
    expect(registry.checkStalledTasks(nowMs + 599_999)).toEqual([]);
    expect(registry.isStallNotified("bg_stall")).toBe(false);

    expect(registry.checkStalledTasks(nowMs + 600_000)).toEqual(["bg_stall"]);
    expect(notified).toEqual(["bg_stall"]);
    // Deduped: the same task never notifies twice.
    expect(registry.checkStalledTasks(nowMs + 1_200_000)).toEqual([]);
    expect(notified).toEqual(["bg_stall"]);

    const polled = registry.getRegisteredTask("bg_stall");
    expect(polled).toBeDefined();
  });

  it("surfaces the stall flag through poll_task status", async () => {
    const registry = makeRegistry();
    const lastOutputAtByTask = new Map<string, number>();
    registry.enableStalledWatchdog({
      getActivityHandle: (taskId) => ({
        getLastOutputAtMs: () => lastOutputAtByTask.get(taskId),
      }),
      thresholdMs: 100,
    });
    lastOutputAtByTask.set("bg_pollstall", nowMs);
    register(registry, "bg_pollstall");

    registry.checkStalledTasks(nowMs + 100);
    const outcome = await registry.pollOnce("bg_pollstall", 0);
    expect(outcome.status).toBe("stalled");
  });

  it("runs the watchdog timer only while active tasks exist", () => {
    const registry = makeRegistry();
    registry.enableStalledWatchdog({});
    expect(registry.isWatchdogRunning).toBe(false);

    register(registry, "bg_timer");
    expect(registry.isWatchdogRunning).toBe(true);

    // A tick with no active tasks stops the timer.
    registry.releaseTask("bg_timer");
    registry.checkStalledTasks(nowMs);
    expect(registry.isWatchdogRunning).toBe(false);
  });

  it("throws a structured NOT_FOUND error for an unknown taskId", async () => {
    const registry = makeRegistry();
    await expect(registry.pollOnce("bg_missing", 0)).rejects.toBeInstanceOf(
      BackgroundTaskNotFoundError,
    );
  });

  it("keeps scanning when the registry file contains corrupt lines", async () => {
    const registry = makeRegistry();
    register(registry, "bg_ok");
    fs.appendFileSync(registry.registryFilePath, "{broken json\n", "utf-8");

    expect(registry.getRegisteredTask("bg_ok")).toBeDefined();
    const reaped = await registry.scanAndReapOrphans();
    expect(reaped).toHaveLength(0);
  });

  it("uses the cross-platform liveness probe idiom", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // Pids near the theoretical maximum are safe to treat as absent.
    expect(isPidAlive(4_000_000_000)).toBe(false);
  });
});

describe("core/executor task activity tee", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_tee_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("tees stdout/stderr to the task output file and tracks activity", async () => {
    const taskId = "bg_tee_1";
    const outputFile = path.join(homeDir, "tasks", `${taskId}.output`);
    const script = [
      "process.stdout.write('OUT-1\\n');",
      "setTimeout(() => { process.stderr.write('ERR-1\\n'); }, 80);",
      "setTimeout(() => { process.stdout.write('OUT-2\\n'); }, 160);",
    ].join("");

    try {
      await executeCommand(process.execPath, ["-e", script], {
        taskActivity: { taskId, outputFile },
      });

      const teeContent = await fsp.readFile(outputFile, "utf-8");
      expect(teeContent).toContain("OUT-1\n");
      expect(teeContent).toContain("ERR-1\n");
      expect(teeContent).toContain("OUT-2\n");

      const handle = getActivityHandle(taskId);
      expect(handle).toBeDefined();
      expect(handle?.getLastOutputAtMs()).toBeGreaterThan(0);
      expect(handle?.getChildPid()).toBeGreaterThan(0);
    } finally {
      forgetActivityHandle(taskId);
    }
    expect(getActivityHandle(taskId)).toBeUndefined();
  });

  it("keeps no activity record when the spawn itself fails", async () => {
    const taskId = "bg_tee_missing";
    await expect(
      executeCommand("definitely-missing-executable-agentmesh", [], {}),
    ).rejects.toBeInstanceOf(Error);
    expect(getActivityHandle(taskId)).toBeUndefined();
  });
});
