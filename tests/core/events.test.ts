import { describe, expect, it } from "vitest";
import { projectSessionEvents } from "../../src/core/events.js";
import { MultiAgentRunner } from "../../src/core/runner.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/core/session.js";
import type { BridgeSession, SessionHistoryEntry } from "../../src/core/types.js";

const baseEntry = (overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry => ({
  role: "worker",
  task: "Do the thing",
  timestamp: "2026-08-30T00:00:00.000Z",
  status: "success",
  ...overrides,
});

const sessionWith = (history: SessionHistoryEntry[]): BridgeSession => ({
  id: "bridge-sess_events",
  agent: "codex",
  cwd: "/repo",
  role: "worker",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  history,
});

const fullEntry = (): SessionHistoryEntry =>
  baseEntry({
    handoff: {
      goal: "Ship the migration",
      outcome: "success",
      keyDecisions: ["D1", "D2"],
      artifacts: { files: ["src/a.ts"], commands: ["npm test"] },
      openItems: ["O1"],
      blockers: [
        { summary: "Need SSH credentials", requires: "environment" },
        { summary: "Human sign-off", requires: "user" },
      ],
    },
    findings: [
      { severity: "high", file: "src/a.ts", issue: "Bug A" },
      { severity: "high", file: "src/b.ts", issue: "Bug B" },
      { severity: "low", file: "src/c.ts", issue: "Nit" },
    ],
    evidence: {
      repositoryAfter: {
        capturedAt: "2026-08-30T00:00:00.000Z",
        repositoryRoot: "/repo",
        dirty: false,
        fingerprint: "a".repeat(64),
        changedPaths: ["src/a.ts", "src/b.ts"],
      },
      transportUsed: "cli",
      exitCode: 0,
      durationMs: 1200,
    },
    reviewerSafety: {
      requested: "best-effort",
      mechanism: "prompt-only",
      enforced: false,
    },
  });

describe("core/events projectSessionEvents", () => {
  it("projects one turn into ordered events with contiguous ids", () => {
    const events = projectSessionEvents(sessionWith([fullEntry()]));

    expect(events.map((event) => event.type)).toEqual([
      "turn.recorded",
      "handoff.recorded",
      "findings.recorded",
      "evidence.recorded",
      "safety.recorded",
    ]);
    expect(events.map((event) => event.eventId)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((event) => event.turnIndex === 1)).toBe(true);
    expect(events.every((event) => event.timestamp === "2026-08-30T00:00:00.000Z")).toBe(true);
  });

  it("is deterministic and append-only stable across polls", () => {
    const first = projectSessionEvents(sessionWith([fullEntry()]));
    expect(projectSessionEvents(sessionWith([fullEntry()]))).toEqual(first);

    const grown = projectSessionEvents(
      sessionWith([fullEntry(), baseEntry({ task: "Follow-up turn" })]),
    );
    expect(grown.slice(0, first.length)).toEqual(first);
    expect(grown.at(-1)?.type).toBe("turn.recorded");
    expect(grown.at(-1)?.turnIndex).toBe(2);
  });

  it("carries machine-readable counts and blocker escalation targets", () => {
    const events = projectSessionEvents(sessionWith([fullEntry()]));
    const turn = events[0]!;
    if (turn.type !== "turn.recorded") throw new Error("expected turn.recorded");
    expect(turn.role).toBe("worker");
    expect(turn.status).toBe("success");
    expect(turn.taskPreview).toBe("Do the thing");

    const handoff = events[1]!;
    if (handoff.type !== "handoff.recorded") throw new Error("expected handoff.recorded");
    expect(handoff.goalPreview).toBe("Ship the migration");
    expect(handoff.outcome).toBe("success");
    expect(handoff.keyDecisions).toBe(2);
    expect(handoff.openItems).toBe(1);
    expect(handoff.blockerRequires).toEqual(["environment", "user"]);
    expect(handoff.hasArtifacts).toBe(true);
  });

  it("dedupes finding severities and indexes evidence without full paths", () => {
    const events = projectSessionEvents(sessionWith([fullEntry()]));
    const findings = events[2]!;
    if (findings.type !== "findings.recorded") throw new Error("expected findings.recorded");
    expect(findings.count).toBe(3);
    expect(findings.severities).toEqual(["high", "low"]);

    const evidence = events[3]!;
    if (evidence.type !== "evidence.recorded") throw new Error("expected evidence.recorded");
    expect(evidence.transport).toBe("cli");
    expect(evidence.exitCode).toBe(0);
    expect(evidence.repositoryFingerprint).toBe("a".repeat(64));
    expect(evidence.changedPathCount).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain("src/a.ts");
  });

  it("skips a turn with no knowledge, evidence, or safety payload beyond the turn event", () => {
    const events = projectSessionEvents(
      sessionWith([baseEntry({ evidence: { repositoryBefore: undefined } })]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("turn.recorded");
  });
});

describe("core/runner getSessionEvents cursor", () => {
  const sessionManager = new SessionManager({ persist: false });
  const runner = new MultiAgentRunner(new AgentRegistry(), sessionManager);

  const makeSession = (turns: number): string => {
    const created = sessionManager.createSession({
      agent: "codex",
      cwd: "/repo",
      role: "worker",
    });
    for (let index = 0; index < turns; index++) {
      sessionManager.addHistory(created.id, baseEntry({ task: `Turn ${index + 1}` }));
    }
    return created.id;
  };

  it("returns a structured miss for an unknown session and an invalid cursor", () => {
    expect(runner.getSessionEvents({ sessionId: "bridge-sess_missing" })).toMatchObject({
      code: "CONTEXT_INSUFFICIENT",
      missing: ["session"],
    });

    const sessionId = makeSession(1);
    expect(runner.getSessionEvents({ sessionId, afterEventId: -1 })).toMatchObject({
      code: "CONTEXT_INSUFFICIENT",
      missing: ["afterEventId"],
    });
    expect(runner.getSessionEvents({ sessionId, afterEventId: 1.5 })).toMatchObject({
      code: "CONTEXT_INSUFFICIENT",
      missing: ["afterEventId"],
    });
  });

  it("treats a session without turns as a legitimate empty projection", () => {
    const sessionId = makeSession(0);
    const result = runner.getSessionEvents({ sessionId });
    if ("error" in result) throw new Error("empty session should be an empty projection");
    expect(result.totalEvents).toBe(0);
    expect(result.lastEventId).toBe(0);
    expect(result.totalTurns).toBe(0);
    expect(result.events).toEqual([]);
  });

  it("serves full snapshots, exclusive cursors, and limits", () => {
    const sessionId = makeSession(3);
    const full = runner.getSessionEvents({ sessionId });
    if ("error" in full) throw new Error("expected events result");
    expect(full.totalTurns).toBe(3);
    expect(full.totalEvents).toBe(3);
    expect(full.lastEventId).toBe(3);
    expect(full.events.map((event) => event.eventId)).toEqual([1, 2, 3]);
    expect(full.events.map((event) => event.turnIndex)).toEqual([1, 2, 3]);

    const afterFirst = runner.getSessionEvents({ sessionId, afterEventId: 1 });
    if ("error" in afterFirst) throw new Error("expected events result");
    expect(afterFirst.events.map((event) => event.eventId)).toEqual([2, 3]);
    // The cursor response still reports the whole projection so callers can
    // keep polling until lastEventId.
    expect(afterFirst.totalEvents).toBe(3);
    expect(afterFirst.lastEventId).toBe(3);

    const limited = runner.getSessionEvents({ sessionId, afterEventId: 0, limit: 2 });
    if ("error" in limited) throw new Error("expected events result");
    expect(limited.events.map((event) => event.eventId)).toEqual([1, 2]);

    // A cursor past the end is an empty page, not an error.
    const drained = runner.getSessionEvents({ sessionId, afterEventId: 99 });
    if ("error" in drained) throw new Error("expected events result");
    expect(drained.events).toEqual([]);
    expect(drained.lastEventId).toBe(3);
  });
});
