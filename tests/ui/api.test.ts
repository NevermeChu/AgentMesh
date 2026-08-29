import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleUiApiRequest } from "../../src/ui/api.js";

// ---------------------------------------------------------------------------
// Helpers to build seed data inside a throwaway homeDir.
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<{
    id: string;
    agent: string;
    role: string;
    cwd: string;
    createdAt: string;
    updatedAt: string;
    history: unknown[];
  }> = {},
) {
  return {
    id: overrides.id ?? "sess_1",
    agent: (overrides.agent as string) ?? "codex",
    role: (overrides.role as string) ?? "worker",
    cwd: overrides.cwd ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:01:00.000Z",
    history: overrides.history ?? [
      {
        role: "worker",
        task: "implement feature X",
        timestamp: "2026-01-01T00:00:30.000Z",
        status: "success",
        summary: "done",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    ],
  };
}

function makeRegistryLine(
  taskId: string,
  overrides: Partial<{
    pid: number;
    startedAtMs: number;
    outputFile: string;
    orphanedAtMs: number;
  }> = {},
) {
  return JSON.stringify({
    taskId,
    pid: overrides.pid ?? process.pid,
    startedAtMs: overrides.startedAtMs ?? 1_000_000,
    outputFile: overrides.outputFile ?? "",
    ...(overrides.orphanedAtMs !== undefined ? { orphanedAtMs: overrides.orphanedAtMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ui/api", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = path.join(
      os.tmpdir(),
      `agentmesh_ui_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const call = (method: string, pathname: string, query: Record<string, string> = {}) => {
    const params = new URLSearchParams(query);
    return handleUiApiRequest({ method, pathname, query: params, homeDir });
  };

  // -----------------------------------------------------------------------
  // /api/sessions — list + sorting
  // -----------------------------------------------------------------------

  it("returns sessions sorted by updatedAt descending", async () => {
    const sessions = [
      makeSession({ id: "older", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeSession({ id: "newer", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/sessions");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { sessions: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]!.id).toBe("newer");
    expect(body.sessions[1]!.id).toBe("older");
  });

  // -----------------------------------------------------------------------
  // /api/sessions/{id} — detail with full history
  // -----------------------------------------------------------------------

  it("returns full session detail including all history turns", async () => {
    const session = makeSession({
      id: "detail_test",
      history: [
        {
          role: "worker",
          task: "step 1",
          timestamp: "2026-01-01T00:00:00Z",
          status: "success",
          usage: { totalTokens: 100 },
        },
        {
          role: "reviewer",
          task: "review step 1",
          timestamp: "2026-01-01T00:01:00Z",
          status: "success",
          usage: { totalTokens: 200 },
        },
      ],
    });
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify([session]), "utf-8");

    const res = await call("GET", "/api/sessions/detail_test");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { history: unknown[]; id: string };
    expect(body.id).toBe("detail_test");
    expect(body.history).toHaveLength(2);
  });

  it("returns 404 for a non-existent session", async () => {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), "[]", "utf-8");
    const res = await call("GET", "/api/sessions/missing");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // /api/tasks — status derivation
  // -----------------------------------------------------------------------

  it("derives interrupted status for an orphaned task", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_orphan.output");
    fs.writeFileSync(outputFile, "partial output", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_orphan", { orphanedAtMs: 2_000_000, outputFile }) + "\n",
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { tasks: Array<{ taskId: string; status: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.taskId).toBe("task_orphan");
    expect(body.tasks[0]!.status).toBe("interrupted");
  });

  it("derives completed status from a stored result file", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_done.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_done", { outputFile }) + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "task_done.result.json"),
      JSON.stringify({
        taskId: "task_done",
        status: "completed",
        summary: "all good",
        completedAtMs: 3_000_000,
      }),
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      tasks: Array<{ taskId: string; status: string; result: unknown }>;
    };
    expect(body.tasks[0]!.status).toBe("completed");
    expect(body.tasks[0]!.result).toBeDefined();
  });

  it("lets a terminal result win over the orphan dead-letter mark (bridge restart after completion)", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_late.output");
    fs.writeFileSync(outputFile, "done output", "utf-8");
    // Duplicate registry lines mirror the append-only orphan scan: the task
    // finished, then a bridge restart dead-lettered its record anyway.
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      [
        makeRegistryLine("task_late", { outputFile, startedAtMs: 1_000_000 }),
        makeRegistryLine("task_late", {
          outputFile,
          startedAtMs: 1_000_000,
          orphanedAtMs: 2_000_000,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tasksDir, "task_late.result.json"),
      JSON.stringify({
        taskId: "task_late",
        status: "completed",
        summary: "finished before restart",
        completedAtMs: 1_500_000,
      }),
      "utf-8",
    );

    const res = await call("GET", "/api/tasks");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { tasks: Array<{ taskId: string; status: string }> };
    // Deduped to one entry, and the finished work is not mislabeled as interrupted.
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.taskId).toBe("task_late");
    expect(body.tasks[0]!.status).toBe("completed");
  });

  // -----------------------------------------------------------------------
  // /api/file — directory traversal rejection
  // -----------------------------------------------------------------------

  it("rejects directory traversal with 403", async () => {
    const res = await call("GET", "/api/file", { path: "../../secret.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = JSON.parse(res!.body) as { error: string };
    expect(body.error).toBe("FORBIDDEN");
  });

  it("rejects absolute paths with 403", async () => {
    const res = await call("GET", "/api/file", { path: "/etc/passwd" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 404 for a non-existent file", async () => {
    const res = await call("GET", "/api/file", { path: "no-such-file.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 400 for a directory path", async () => {
    fs.mkdirSync(path.join(homeDir, "adir"), { recursive: true });
    const res = await call("GET", "/api/file", { path: "adir" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  it("returns file content for a valid path", async () => {
    fs.writeFileSync(path.join(homeDir, "artifact.txt"), "hello world", "utf-8");
    const res = await call("GET", "/api/file", { path: "artifact.txt" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { path: string; content: string };
    expect(body.content).toBe("hello world");
    expect(body.path).toBe("artifact.txt");
  });

  it("rejects empty path parameter", async () => {
    const res = await call("GET", "/api/file", { path: "" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // /api/tasks/{id}/output — incremental read with offset
  // -----------------------------------------------------------------------

  it("reads output incrementally respecting byte offset", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_inc.output");
    fs.writeFileSync(outputFile, "hello\nworld\n", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_inc", { outputFile }) + "\n",
      "utf-8",
    );

    // First read from offset 0.
    const first = await call("GET", "/api/tasks/task_inc/output", { offset: "0" });
    expect(first).not.toBeNull();
    expect(first!.status).toBe(200);
    const body1 = JSON.parse(first!.body) as {
      output: string;
      nextOffset: number;
      hasMore: boolean;
    };
    expect(body1.output).toBe("hello\nworld\n");
    expect(body1.hasMore).toBe(false);

    // Write more data.
    fs.appendFileSync(outputFile, "again", "utf-8");

    // Second read from previous nextOffset.
    const second = await call("GET", "/api/tasks/task_inc/output", {
      offset: String(body1.nextOffset),
    });
    expect(second).not.toBeNull();
    expect(second!.status).toBe(200);
    const body2 = JSON.parse(second!.body) as {
      output: string;
      nextOffset: number;
      hasMore: boolean;
    };
    expect(body2.output).toBe("again");
    expect(body2.hasMore).toBe(false);
  });

  it("returns 404 for a non-existent task output", async () => {
    fs.mkdirSync(path.join(homeDir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, "tasks", "registry.jsonl"), "", "utf-8");
    const res = await call("GET", "/api/tasks/missing_task/output");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("rejects negative offset with 400", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const outputFile = path.join(tasksDir, "task_neg.output");
    fs.writeFileSync(outputFile, "", "utf-8");
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_neg", { outputFile }) + "\n",
      "utf-8",
    );

    const res = await call("GET", "/api/tasks/task_neg/output", { offset: "-1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Non-GET method → 405
  // -----------------------------------------------------------------------

  it("returns 405 for non-GET methods on API routes", async () => {
    const post = await call("POST", "/api/sessions");
    expect(post).not.toBeNull();
    expect(post!.status).toBe(405);

    const put = await call("PUT", "/api/tasks");
    expect(put).not.toBeNull();
    expect(put!.status).toBe(405);

    const del = await call("DELETE", "/api/summary");
    expect(del).not.toBeNull();
    expect(del!.status).toBe(405);
  });

  // -----------------------------------------------------------------------
  // Non-API path → null (server fallback)
  // -----------------------------------------------------------------------

  it("returns null for non-API paths", async () => {
    const res = await call("GET", "/not/api/route");
    expect(res).toBeNull();
  });

  // -----------------------------------------------------------------------
  // /api/summary
  // -----------------------------------------------------------------------

  it("returns summary with session and task counts", async () => {
    const sessions = [
      makeSession({
        id: "sum_s1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [
          {
            role: "worker",
            task: "t",
            timestamp: "2026-01-01T00:00:00Z",
            status: "success",
            usage: { totalTokens: 42 },
          },
        ],
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "registry.jsonl"), "", "utf-8");

    const res = await call("GET", "/api/summary");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      sessionCount: number;
      totalTokens: number;
      taskCounts: { total: number };
      dataHome: string;
    };
    expect(body.sessionCount).toBe(1);
    expect(body.totalTokens).toBe(42);
    expect(body.dataHome).toBe(homeDir);
  });

  // -----------------------------------------------------------------------
  // /api/stats — agent x role aggregation
  // -----------------------------------------------------------------------

  it("aggregates stats by agent and role with success rate, avg duration and tokens", async () => {
    const history = (statuses: string[], durations: number[], tokens: number[]) =>
      statuses.map((status, i) => ({
        role: "worker",
        task: `t${i}`,
        timestamp: "2026-01-01T00:00:00Z",
        status,
        ...(durations[i] !== undefined ? { evidence: { durationMs: durations[i] } } : {}),
        ...(tokens[i] !== undefined ? { usage: { totalTokens: tokens[i] } } : {}),
      }));
    const sessions = [
      makeSession({
        id: "s1",
        agent: "opencode",
        role: "worker",
        history: history(["success", "failed"], [1000, 3000], [100, 200]),
      }),
      makeSession({
        id: "s2",
        agent: "opencode",
        role: "reviewer",
        history: history(["success"], [2000], [50]),
      }),
      makeSession({
        id: "s3",
        agent: "codex",
        role: "worker",
        history: history(["success"], [], [10]),
      }),
    ];
    fs.writeFileSync(path.join(homeDir, "sessions.json"), JSON.stringify(sessions), "utf-8");

    const res = await call("GET", "/api/stats");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as {
      stats: Array<{
        agent: string;
        role: string;
        turns: number;
        successCount: number;
        successRate: number;
        avgDurationMs: number | null;
        totalTokens: number;
      }>;
    };
    expect(body.stats).toHaveLength(3);
    const byKey = new Map(body.stats.map((s) => [`${s.agent}/${s.role}`, s]));
    const ocWorker = byKey.get("opencode/worker");
    expect(ocWorker).toMatchObject({
      turns: 2,
      successCount: 1,
      successRate: 0.5,
      avgDurationMs: 2000,
      totalTokens: 300,
    });
    const ocReviewer = byKey.get("opencode/reviewer");
    expect(ocReviewer).toMatchObject({
      turns: 1,
      successRate: 1,
      avgDurationMs: 2000,
      totalTokens: 50,
    });
    // Turns without duration evidence must not count toward the average.
    const codexWorker = byKey.get("codex/worker");
    expect(codexWorker).toMatchObject({
      turns: 1,
      successRate: 1,
      avgDurationMs: null,
      totalTokens: 10,
    });
  });

  it("returns an empty stats list for an empty session store", async () => {
    fs.writeFileSync(path.join(homeDir, "sessions.json"), "[]", "utf-8");
    const res = await call("GET", "/api/stats");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = JSON.parse(res!.body) as { stats: unknown[] };
    expect(body.stats).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // /api/tasks/{taskId} — detail convenience endpoint
  // -----------------------------------------------------------------------

  it("returns task detail by id and 404 for unknown ids", async () => {
    const tasksDir = path.join(homeDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, "registry.jsonl"),
      makeRegistryLine("task_detail") + "\n",
      "utf-8",
    );

    const found = await call("GET", "/api/tasks/task_detail");
    expect(found).not.toBeNull();
    expect(found!.status).toBe(200);
    const body = JSON.parse(found!.body) as { taskId: string; status: string };
    expect(body.taskId).toBe("task_detail");

    const missing = await call("GET", "/api/tasks/task_missing");
    expect(missing).not.toBeNull();
    expect(missing!.status).toBe(404);
  });
});
