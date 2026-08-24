import type {
  AgentName,
  AgentRole,
  ReasoningEffort,
  ReviewerSafetyReport,
  ReviewFinding,
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
  cancelReason?: "timeout" | "client_cancel" | "unknown";
  cleanupMethod?: "taskkill-tree" | "signal" | "unknown";
  cleanupSucceeded?: boolean;
  resourceEvidence?: ResourceEvidence;
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
}

export interface RunnerOptions {
  defaultTimeoutMs?: number;
  sessionStoragePath?: string;
}
