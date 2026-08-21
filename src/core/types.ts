import type { AgentName, AgentRole, ReviewFinding } from "../agents/types.js";

export interface SessionHistoryEntry {
  role: AgentRole;
  task: string;
  timestamp: string;
  status: "success" | "failed";
  summary?: string;
  finalAnswer?: string;
  findings?: ReviewFinding[];
  nativeSessionId?: string;
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
