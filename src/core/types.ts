import type { AgentName, AgentRole, ReviewerSafetyReport, ReviewFinding } from "../agents/types.js";

export interface RepositoryStateEvidence {
  capturedAt: string;
  repositoryRoot: string;
  head?: string;
  dirty: boolean;
  fingerprint: string;
  changedPaths: string[];
  pathFingerprints?: Record<string, string>;
}

export interface SessionExecutionEvidence {
  repositoryBefore?: RepositoryStateEvidence;
  repositoryAfter?: RepositoryStateEvidence;
  transportUsed?: "mcp" | "cli";
  exitCode?: number;
  durationMs?: number;
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
