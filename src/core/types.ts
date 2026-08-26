import type {
  AgentName,
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyReport,
  ReviewFinding,
  TransportFallbackEvidence,
} from "../agents/types.js";
import path from "node:path";

export interface RepositoryStateEvidence {
  capturedAt: string;
  repositoryRoot: string;
  head?: string;
  dirty: boolean;
  fingerprint: string;
  changedPaths: string[];
  pathFingerprints?: Record<string, string>;
}

/**
 * Machine-readable normalized failure reason codes (P1 T1.2). Naming style
 * follows the existing cancelReason classification in
 * SessionExecutionEvidence. A code is attached only when classification is
 * confident; absence means "unclassified", never a guessed default.
 *
 * Signal semantics align with codex exec exit status (exit 0 = success,
 * exit 1 = failed turn including turn.failed / stream_error / server request
 * rejection) plus transport-level spawn and timeout evidence.
 */
export type ErrorCode =
  /** Vendor-side transient failure before/around model I/O (HTTP 5xx, stream_error, connection refused/reset, rate limit). */
  | "TRANSIENT_5XX"
  /** The vendor process could not be started at all (binary missing, spawn EPERM/EACCES/ENOENT on the executable). */
  | "SPAWN_FAILED"
  /** The configured execution timeout elapsed and the process tree was terminated. */
  | "TIMEOUT"
  /** The vendor definitively rejected the requested model or request (account/model-id level refusal, turn.failed rejection). */
  | "MODEL_REJECTED"
  /** A required OS/MCP sandbox is unavailable or blocked the operation. */
  | "SANDBOX_UNAVAILABLE"
  /** Structured output could not be parsed (malformed JSONL/JSON, half-written output). */
  | "PARSE_FAILURE"
  /** Caller-supplied arguments were rejected before execution (disallowed extraArgs, unsupported mode). */
  | "ARG_REJECTED"
  /** The run was cancelled by the caller or an abort signal. */
  | "CANCELLED"
  /** Fail-fast response while this adapter's circuit breaker is open (P1 T1.3). */
  | "CIRCUIT_OPEN"
  /** Fail-fast response because a token budget cap is exhausted (P5 T5.4). */
  | "BUDGET_EXHAUSTED";

/**
 * Terminal-outcome tombstone recorded for an idempotency key (P1 T1.1).
 *
 * After a keyed dispatch reaches a terminal state, the tombstone is kept for a
 * TTL (20 minutes) so a late retry with the same key replays the recorded
 * result instead of re-executing. Expired tombstones are treated as absent and
 * the dispatch executes normally. Tombstones are process-local by design:
 * losing them across a bridge restart degrades to honest re-execution.
 */
export interface IdempotencyTombstone {
  /** Caller-supplied idempotency key within the scope it was registered under. */
  key: string;
  /** Bridge session that owns the executed turn referenced by `turnNumber`. */
  sessionId: string;
  /** 1-based index of the executed turn inside the session history. */
  turnNumber: number;
  /** Terminal outcome of the referenced turn. */
  outcome: "completed" | "failed";
  /** Repository fingerprint observed when the turn completed; enables STALE checks on replay. */
  repositoryFingerprint?: string;
  /** Normalized failure reason when outcome is "failed". */
  errorCode?: ErrorCode;
  /** Completion timestamp (epoch ms, per the injectable clock). */
  completedAtMs: number;
  /** Absolute expiry (epoch ms); a lookup at/after this instant treats the tombstone as absent. */
  expiresAtMs: number;
}

/**
 * In-memory tombstone store shape: composite idempotency scope key
 * (`<resolvedCwd>\u0000<agent>\u0000<key>`) → tombstone. Scope includes cwd so
 * the same key used against different working directories executes normally.
 */
export type IdempotencyTombstoneStore = Map<string, IdempotencyTombstone>;

/** Builds the composite store key for one idempotency scope. */
export function idempotencyScopeKey(cwd: string, agent: string, key: string): string {
  // NUL cannot occur in any component, so the composite cannot collide.
  return `${path.resolve(cwd)}\u0000${agent}\u0000${key}`;
}

export interface ResourceEvidence {
  collection: "none" | "process" | "process-tree" | "external";
  cpuUserMs?: number;
  cpuSystemMs?: number;
  peakRssBytes?: number;
  processTreePeakRssBytes?: number;
  orphanProcessesDetected?: boolean;
  note?: string;
  limitations?: string;
}

export interface SessionExecutionEvidence {
  repositoryBefore?: RepositoryStateEvidence;
  repositoryAfter?: RepositoryStateEvidence;
  transportUsed?: "mcp" | "cli";
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  cancelReason?: "timeout" | "client_cancel" | "client_disconnect" | "unknown";
  /** Machine-readable normalized failure reason for failed turns (P1 T1.2). */
  errorCode?: ErrorCode;
  cleanupMethod?: "taskkill-tree" | "signal" | "unknown";
  cleanupSucceeded?: boolean;
  resourceEvidence?: ResourceEvidence;
  /** Present when the executed turn switched transports via auto-mode fallback. */
  transportFallback?: TransportFallbackEvidence;
}

/** Verbatim-audit record for the shared context injected into one turn's prompt. */
export interface SharedContextAudit {
  /** Sidecar file holding the exact rendered block (relative to the sessions storage directory). */
  file?: string;
  bytes: number;
  sha256: string;
  totalChars: number;
  sources: Array<{ sessionId: string; chars: number; truncated: boolean }>;
}

export interface SessionHistoryEntry {
  role: AgentRole;
  task: string;
  timestamp: string;
  status: "success" | "failed";
  summary?: string;
  finalAnswer?: string;
  findings?: ReviewFinding[];
  nativeSessionId?: string;
  evidence?: SessionExecutionEvidence;
  reviewerSafety?: ReviewerSafetyReport;
  /** Bridge sessions whose normalized history was injected into this turn's prompt. */
  contextSources?: string[];
  requestedModel?: string;
  requestedReasoningEffort?: ReasoningEffort;
  /** Structured diagnostics for requested model/reasoning options the executed transport ignored. */
  capabilityDiagnostics?: string[];
  /** Audit metadata for the rendered shared-context block injected into this turn. */
  sharedContextAudit?: SharedContextAudit;
}

export interface BridgeSession {
  id: string;
  agent: AgentName;
  nativeSessionId?: string;
  cwd: string;
  role: AgentRole;
  createdAt: string;
  updatedAt: string;
  history: SessionHistoryEntry[];
  metadata?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  storagePath?: string;
  persist?: boolean;
  /**
   * Maximum history turns retained per session; older turns are dropped as
   * new ones are appended. `0` disables the cap.
   */
  maxHistoryTurnsPerSession?: number;
  /**
   * Maximum number of sessions retained; the least recently updated sessions
   * are evicted first. `0` disables the cap.
   */
  maxSessions?: number;
}

export interface RunnerOptions {
  defaultTimeoutMs?: number;
  sessionStoragePath?: string;
  /** Injectable clock for idempotency TTL/expiry decisions (tests). Default Date.now. */
  now?: () => number;
  /** Terminal-result tombstone TTL for idempotency keys. Default 20 minutes. */
  idempotencyTtlMs?: number;
}
