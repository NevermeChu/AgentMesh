import type {
  AgentName,
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyReport,
  ReviewFinding,
  TransportFallbackEvidence,
} from "../agents/types.js";

export interface RepositoryStateEvidence {
  capturedAt: string;
  repositoryRoot: string;
  head?: string;
  dirty: boolean;
  fingerprint: string;
  changedPaths: string[];
  pathFingerprints?: Record<string, string>;
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
}
