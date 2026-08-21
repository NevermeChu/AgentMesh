import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SessionManager } from "../../src/core/session.js";

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
  });

  it("preserves updates from concurrent manager instances", () => {
    const manager1 = new SessionManager({ storagePath: tempStoragePath, persist: true });
    const manager2 = new SessionManager({ storagePath: tempStoragePath, persist: true });

    const first = manager1.createSession({ agent: "codex", cwd: "/first" });
    const second = manager2.createSession({ agent: "grok", cwd: "/second" });

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
  ])("rejects %s in persistent storage", (_case, contents) => {
    fs.writeFileSync(tempStoragePath, contents, "utf-8");
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
});
