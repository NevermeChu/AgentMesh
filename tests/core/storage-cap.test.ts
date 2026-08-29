import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../../src/core/session.js";

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function makeStorageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmesh-cap-"));
  tempRoots.push(dir);
  return dir;
}

function minimalSession(id: string, updatedAt: string) {
  return {
    id,
    agent: "opencode",
    cwd: "D:/tmp",
    role: "worker",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt,
    history: [],
  };
}

// P-R14-2: a disk file exceeding the cap (possible because deferred-create
// evictions are not always persisted) must be capped on load, and the next
// flush must shrink the file — otherwise every reload re-grows the map.
describe("session storage cap (P-R14-2)", () => {
  it("enforces the session cap after loading an oversized file", () => {
    const dir = makeStorageDir();
    const storagePath = join(dir, "sessions.json");
    const sessions = Array.from({ length: 12 }, (_, i) =>
      minimalSession(
        `bridge-sess_cap${String(i).padStart(2, "0")}`,
        `2026-08-29T00:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    );
    writeFileSync(storagePath, JSON.stringify(sessions));

    const manager = new SessionManager({
      storagePath,
      maxSessions: 5,
      maxHistoryTurnsPerSession: 50,
    });
    // listSessions triggers the disk reload path.
    const listed = manager.listSessions();
    // enforceSessionCap makes room (size < max), matching createSession semantics.
    expect(listed.length).toBe(4);
    // LRU: the oldest must be evicted first.
    expect(listed.some((s) => s.id === "bridge-sess_cap00")).toBe(false);
    expect(listed.some((s) => s.id === "bridge-sess_cap11")).toBe(true);
  });

  it("shrinks the oversized disk file on the next flush", () => {
    const dir = makeStorageDir();
    const storagePath = join(dir, "sessions.json");
    const sessions = Array.from({ length: 12 }, (_, i) =>
      minimalSession(
        `bridge-sess_cap${String(i).padStart(2, "0")}`,
        `2026-08-29T00:00:${String(i).padStart(2, "0")}.000Z`,
      ),
    );
    writeFileSync(storagePath, JSON.stringify(sessions));

    const manager = new SessionManager({
      storagePath,
      maxSessions: 5,
      maxHistoryTurnsPerSession: 50,
    });
    manager.listSessions();
    // A mutation flushes the capped in-memory map back to disk.
    const kept = manager.listSessions()[0]!;
    manager.updateSession(kept.id, { cwd: "D:/tmp2" });

    const onDisk = JSON.parse(readFileSync(storagePath, "utf-8")) as unknown[];
    expect(onDisk.length).toBeLessThanOrEqual(5);
  });
});

// P-R14-2b: usage was missing from SessionHistoryEntrySchema, so zod silently
// stripped it on every disk reload and the T5.4 budget gate went blind.
describe("usage persistence (P-R14-2b)", () => {
  it("keeps turn usage across a disk reload", () => {
    const dir = makeStorageDir();
    const storagePath = join(dir, "sessions.json");
    const manager = new SessionManager({
      storagePath,
      maxSessions: 10,
      maxHistoryTurnsPerSession: 50,
    });
    const session = manager.createSession({ agent: "opencode", cwd: "D:/tmp", role: "worker" });
    manager.addHistory(session.id, {
      role: "worker",
      task: "metered task",
      timestamp: "2026-08-29T00:00:00.000Z",
      status: "success",
      summary: "ok",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    // A second manager instance = a fresh process reading the same file.
    const reloaded = new SessionManager({
      storagePath,
      maxSessions: 10,
      maxHistoryTurnsPerSession: 50,
    });
    const seen = reloaded.getSession(session.id);
    expect(seen?.history[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
  });
});
