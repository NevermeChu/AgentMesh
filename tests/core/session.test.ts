import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager } from "../../src/core/session.js";
import { defaultRegistry } from "../../src/agents/registry.js";

describe("core/session", () => {
  let sessionManager: SessionManager;
  let tempStoragePath: string;

  beforeEach(() => {
    sessionManager = new SessionManager({ persist: false });
    tempStoragePath = path.join(
      os.tmpdir(),
      `agentmesh_test_sess_${Date.now()}_${Math.random().toString(36).slice(2)}.json`,
    );
  });

  afterEach(() => {
    for (const candidate of [tempStoragePath, `${tempStoragePath}.lock`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        fs.unlinkSync(candidate);
      } catch {
        // ignore
      }
    }
  });

  it("maintains an in-memory session through its lifecycle", () => {
    const session = sessionManager.createSession({
      agent: "codex",
      cwd: "/test/path",
      role: "worker",
    });

    expect(session.id).toMatch(/^bridge-sess_[a-f0-9]+$/);
    expect(session.agent).toBe("codex");
    expect(session.cwd).toBe("/test/path");
    expect(session.role).toBe("worker");
    expect(session.history).toEqual([]);
    expect(session.createdAt).toBeDefined();

    sessionManager.updateSession(session.id, {
      nativeSessionId: "native-12345",
    });
    sessionManager.addHistory(session.id, {
      role: "worker",
      task: "Fix bug #42",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "Fixed",
    });

    const current = sessionManager.getSession(session.id);
    expect(current).toMatchObject({
      id: session.id,
      nativeSessionId: "native-12345",
      history: [{ task: "Fix bug #42", status: "success" }],
    });

    expect(sessionManager.deleteSession(session.id)).toBe(true);
    expect(sessionManager.getSession(session.id)).toBeUndefined();
  });

  it("reloads a persisted session across manager instances", () => {
    const manager1 = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    });

    const created = manager1.createSession({
      agent: "codex",
      cwd: "/my/project",
      role: "worker",
      nativeSessionId: "native_thread_456",
    });

    manager1.addHistory(created.id, {
      role: "worker",
      task: "Write unit tests",
      timestamp: new Date().toISOString(),
      status: "success",
      summary: "Created 5 tests",
      evidence: {
        transportUsed: "cli",
        exitCode: 0,
        durationMs: 125,
        repositoryAfter: {
          capturedAt: new Date().toISOString(),
          repositoryRoot: "/my/project",
          head: "abc123",
          dirty: false,
          fingerprint: "a".repeat(64),
          changedPaths: [],
        },
      },
      reviewerSafety: {
        requested: "best-effort",
        mechanism: "tool-filtering",
        enforced: true,
        workspaceChanged: false,
      },
    });

    expect(fs.existsSync(tempStoragePath)).toBe(true);

    // Simulate separate CLI command execution in a brand new process
    const manager2 = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    });

    const reloaded = manager2.getSession(created.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.id).toBe(created.id);
    expect(reloaded?.agent).toBe("codex");
    expect(reloaded?.nativeSessionId).toBe("native_thread_456");
    expect(reloaded?.history.length).toBe(1);
    expect(reloaded?.history[0]?.summary).toBe("Created 5 tests");
    expect(reloaded?.history[0]?.evidence?.repositoryAfter?.fingerprint).toBe("a".repeat(64));
    expect(reloaded?.history[0]?.reviewerSafety?.mechanism).toBe("tool-filtering");
  });

  it("round-trips disconnect cancellation and transport-fallback evidence (schema sync guard)", () => {
    const manager1 = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    });

    const created = manager1.createSession({
      agent: "opencode",
      cwd: "/my/project",
      role: "reviewer",
    });

    manager1.addHistory(created.id, {
      role: "reviewer",
      task: "Discuss fix plan",
      timestamp: new Date().toISOString(),
      status: "failed",
      summary: "Client disconnected from the AgentMesh server.",
      evidence: {
        transportUsed: "cli",
        exitCode: 1,
        durationMs: 40,
        aborted: true,
        cancelReason: "client_disconnect",
        cleanupMethod: "signal",
        cleanupSucceeded: true,
        transportFallback: {
          from: "mcp",
          to: "cli",
          reason: "MCP handshake failed: vendor socket closed",
        },
      },
    });

    const manager2 = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    });
    const reloaded = manager2.getSession(created.id);
    expect(reloaded?.history).toHaveLength(1);
    expect(reloaded?.history[0]?.evidence?.cancelReason).toBe("client_disconnect");
    expect(reloaded?.history[0]?.evidence?.transportFallback).toEqual({
      from: "mcp",
      to: "cli",
      reason: "MCP handshake failed: vendor socket closed",
    });
  });

  it("preserves updates from concurrent manager instances", () => {
    const manager1 = new SessionManager({ storagePath: tempStoragePath, persist: true });
    const manager2 = new SessionManager({ storagePath: tempStoragePath, persist: true });

    const first = manager1.createSession({ agent: "codex", cwd: "/first" });
    const second = manager2.createSession({ agent: "grok", cwd: "/second" });

    // Regression (P-REAL-008): sessions with no recorded turn are not durable,
    // so a client disconnect that kills the server mid-run cannot leave a
    // permanent zero-turn husk in shared storage.
    const beforeFirstTurn = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    }).listSessions();
    expect(beforeFirstTurn.map((session) => session.id)).not.toContain(first.id);
    expect(beforeFirstTurn.map((session) => session.id)).not.toContain(second.id);

    const entry = {
      role: "worker" as const,
      task: "record first turn",
      timestamp: new Date().toISOString(),
      status: "success" as const,
      summary: "flushed",
    };
    manager1.addHistory(first.id, entry);
    manager2.addHistory(second.id, { ...entry, task: "second flush" });

    const sessions = new SessionManager({
      storagePath: tempStoragePath,
      persist: true,
    }).listSessions();
    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });

  it.each([
    ["malformed JSON", "{not valid json"],
    ["invalid schema", JSON.stringify([{ id: "bridge-sess_invalid", agent: "codex" }])],
  ])("quarantines %s in persistent storage instead of failing to load", (_case, contents) => {
    fs.writeFileSync(tempStoragePath, contents, "utf-8");
    const manager = new SessionManager({ storagePath: tempStoragePath, persist: true });

    expect(manager.listSessions()).toEqual([]);
    const quarantined = fs
      .readdirSync(path.dirname(tempStoragePath))
      .filter(
        (name) => name.startsWith(path.basename(tempStoragePath)) && name.includes(".corrupt-"),
      );
    expect(quarantined.length).toBe(1);
  });

  it("rejects unreadable persistent storage that is not corrupt", () => {
    // A directory at the storage path fails reads for IO reasons, not corruption,
    // so it must keep failing loudly instead of being quarantined.
    fs.mkdirSync(tempStoragePath);
    expect(() => new SessionManager({ storagePath: tempStoragePath, persist: true })).toThrow(
      "Failed to load AgentMesh sessions",
    );
  });

  it("returns detached snapshots that cannot mutate stored state", () => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: "/bound/project",
      role: "reviewer",
      metadata: { nested: { trusted: true } },
    });
    created.role = "worker";
    created.history.push({
      role: "worker",
      task: "Injected history",
      timestamp: new Date().toISOString(),
      status: "success",
    });
    (created.metadata?.nested as { trusted: boolean }).trusted = false;

    const stored = sessionManager.getSession(created.id);
    expect(stored?.role).toBe("reviewer");
    expect(stored?.history).toEqual([]);
    expect(stored?.metadata).toEqual({ nested: { trusted: true } });
  });

  it("caps history turns per session and drops the oldest turns first", () => {
    const capped = new SessionManager({ persist: false, maxHistoryTurnsPerSession: 3 });
    const session = capped.createSession({ agent: "codex", cwd: "/test/path" });

    for (let turn = 1; turn <= 5; turn++) {
      capped.addHistory(session.id, {
        role: "worker",
        task: `turn ${turn}`,
        timestamp: new Date().toISOString(),
        status: "success",
      });
    }

    expect(capped.getSession(session.id)?.history.map((entry) => entry.task)).toEqual([
      "turn 3",
      "turn 4",
      "turn 5",
    ]);
  });

  it("evicts the least recently updated sessions beyond the storage cap", () => {
    const capped = new SessionManager({ persist: false, maxSessions: 2 });
    const first = capped.createSession({ agent: "codex", cwd: "/a" });
    const second = capped.createSession({ agent: "claude", cwd: "/b" });

    const third = capped.createSession({ agent: "grok", cwd: "/c" });

    // Ties break by insertion order, so the very first session is evicted.
    expect(capped.getSession(first.id)).toBeUndefined();
    expect(capped.getSession(second.id)).toBeDefined();
    expect(capped.getSession(third.id)).toBeDefined();
  });

  it("accepts persisted sessions for every supported registry adapter (schema sync guard)", () => {
    const names = defaultRegistry.getAllAdapters().map((adapter) => adapter.name as string);
    expect(names.length).toBeGreaterThan(0);
    const now = new Date().toISOString();
    const sessions = names.map((agent, index) => ({
      id: `bridge-sess_${index.toString().padStart(12, "0")}`,
      agent,
      cwd: "/test/path",
      role: "worker",
      createdAt: now,
      updatedAt: now,
      history: [],
    }));
    fs.writeFileSync(tempStoragePath, JSON.stringify(sessions), "utf-8");

    const reloaded = new SessionManager({ storagePath: tempStoragePath });
    expect(reloaded.listSessions()).toHaveLength(names.length);
    // A schema/registry drift would have quarantined this storage file instead.
    const corruptSiblings = fs
      .readdirSync(path.dirname(tempStoragePath))
      .filter((file) => file.startsWith(`${path.basename(tempStoragePath)}.corrupt-`));
    expect(corruptSiblings).toHaveLength(0);
  });
});
