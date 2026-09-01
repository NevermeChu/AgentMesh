import type { AgentRole } from "../agents/types.js";
import { truncateText } from "./text.js";
import type { BlockerRequirement, BridgeSession, SessionHistoryEntry } from "./types.js";

/**
 * Append-only event projection over a Bridge Session's turn history.
 *
 * This is deliberately a PROJECTION, not a store: every event is derived
 * deterministically from recorded turns, so no mutable event state exists and
 * the projection can never drift from the history it describes. Each appended
 * turn deterministically appends its events, which makes `eventId` a usable
 * incremental-delivery cursor (`afterEventId`) for orchestrators that poll a
 * session without replaying it. Event payloads carry indexes and small
 * actionable fields only — full detail stays in the turn and is fetched
 * on demand via `get_session_context`.
 *
 * Caveat: when a session's history is trimmed by `maxHistoryTurnsPerSession`,
 * the projection renumbers (`totalTurns` in query results lets callers detect
 * this and resynchronize with a full snapshot).
 */

export type SessionEventType =
  | "turn.recorded"
  | "handoff.recorded"
  | "findings.recorded"
  | "evidence.recorded"
  | "safety.recorded";

interface SessionEventBase {
  /** Monotonic 1-based position in the projection; stable while history is append-only. */
  eventId: number;
  /** 1-based index of the turn that produced the event. */
  turnIndex: number;
  /** The turn's recorded timestamp; all events of one turn share it. */
  timestamp: string;
  type: SessionEventType;
}

export interface TurnRecordedEvent extends SessionEventBase {
  type: "turn.recorded";
  role: AgentRole;
  status: "success" | "failed";
  taskPreview: string;
}

export interface HandoffRecordedEvent extends SessionEventBase {
  type: "handoff.recorded";
  goalPreview: string;
  outcome: "success" | "failed";
  keyDecisions: number;
  openItems: number;
  /** Machine-readable escalation targets of the turn's declared blockers. */
  blockerRequires: BlockerRequirement[];
  hasArtifacts: boolean;
}

export interface FindingsRecordedEvent extends SessionEventBase {
  type: "findings.recorded";
  count: number;
  severities: string[];
}

export interface EvidenceRecordedEvent extends SessionEventBase {
  type: "evidence.recorded";
  transport?: "mcp" | "cli";
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  cancelReason?: "timeout" | "client_cancel" | "client_disconnect" | "unknown";
  repositoryFingerprint?: string;
  changedPathCount?: number;
}

export interface SafetyRecordedEvent extends SessionEventBase {
  type: "safety.recorded";
  enforced: boolean;
  mechanism: string;
}

export type SessionEvent =
  | TurnRecordedEvent
  | HandoffRecordedEvent
  | FindingsRecordedEvent
  | EvidenceRecordedEvent
  | SafetyRecordedEvent;

/** Preview cap for task/goal text inside event payloads. */
const MAX_EVENT_PREVIEW_CHARS = 120;

export function projectSessionEvents(session: BridgeSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  let eventId = 0;
  const base = (entry: SessionHistoryEntry, turnIndex: number) => ({
    eventId: ++eventId,
    turnIndex,
    timestamp: entry.timestamp,
  });

  session.history.forEach((entry, offset) => {
    const turnIndex = offset + 1;

    events.push({
      type: "turn.recorded",
      ...base(entry, turnIndex),
      role: entry.role,
      status: entry.status,
      taskPreview: truncateText(entry.task.replace(/\s+/g, " "), MAX_EVENT_PREVIEW_CHARS),
    });

    if (entry.handoff) {
      events.push({
        type: "handoff.recorded",
        ...base(entry, turnIndex),
        goalPreview: truncateText(entry.handoff.goal, MAX_EVENT_PREVIEW_CHARS),
        outcome: entry.handoff.outcome,
        keyDecisions: entry.handoff.keyDecisions.length,
        openItems: entry.handoff.openItems.length,
        blockerRequires: (entry.handoff.blockers ?? []).map((blocker) => blocker.requires),
        hasArtifacts: Boolean(
          entry.handoff.artifacts.files?.length ||
            entry.handoff.artifacts.commands?.length ||
            entry.handoff.artifacts.tests,
        ),
      });
    }

    if (entry.findings?.length) {
      events.push({
        type: "findings.recorded",
        ...base(entry, turnIndex),
        count: entry.findings.length,
        severities: [...new Set(entry.findings.map((finding) => finding.severity))],
      });
    }

    const evidence = entry.evidence;
    if (
      evidence &&
      (evidence.repositoryAfter ||
        evidence.repositoryBefore ||
        evidence.transportUsed !== undefined ||
        evidence.exitCode !== undefined ||
        evidence.durationMs !== undefined ||
        evidence.timedOut ||
        evidence.aborted)
    ) {
      events.push({
        type: "evidence.recorded",
        ...base(entry, turnIndex),
        ...(evidence.transportUsed ? { transport: evidence.transportUsed } : {}),
        ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
        ...(evidence.durationMs !== undefined ? { durationMs: evidence.durationMs } : {}),
        ...(evidence.timedOut ? { timedOut: true } : {}),
        ...(evidence.aborted ? { aborted: true } : {}),
        ...(evidence.cancelReason ? { cancelReason: evidence.cancelReason } : {}),
        ...(evidence.repositoryAfter
          ? { repositoryFingerprint: evidence.repositoryAfter.fingerprint }
          : {}),
        ...(evidence.repositoryAfter
          ? { changedPathCount: evidence.repositoryAfter.changedPaths.length }
          : {}),
      });
    }

    if (entry.reviewerSafety) {
      events.push({
        type: "safety.recorded",
        ...base(entry, turnIndex),
        enforced: entry.reviewerSafety.enforced,
        mechanism: entry.reviewerSafety.mechanism,
      });
    }
  });

  return events;
}
